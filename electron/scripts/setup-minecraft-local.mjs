/* global process, fetch, URL, AbortController, setTimeout, clearTimeout */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const MINECRAFT_VERSION = '1.21.8';
export const JAVA_MAJOR = 21;
export const DOWNLOAD_TIMEOUTS = Object.freeze({ headersMs: 300_000, idleMs: 300_000, totalMs: 900_000 });
const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = resolve(dirname(scriptPath), '..', '..', '.minecraft-local-test');
const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

export function resolvePlatform(platform = process.platform, architecture = process.arch) {
  const os = { darwin: 'mac', linux: 'linux' }[platform];
  const arch = { arm64: 'aarch64', x64: 'x64' }[architecture];
  if (!os || !arch) {
    throw new Error(`Local Java provisioning does not support ${platform}/${architecture}. Install Java 21 manually and use a supported host for this test harness.`);
  }
  return { os, architecture: arch };
}

export function parseArgs(args) {
  const options = { root: defaultRoot, offline: false, refresh: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--root') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('--root requires a directory.');
      options.root = resolve(value);
    } else if (arg === '--offline') options.offline = true;
    else if (arg === '--refresh') options.refresh = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.offline && options.refresh) throw new Error('--offline and --refresh cannot be combined.');
  return options;
}

export async function verifyFile(path, algorithm, expected, expectedSize) {
  try {
    if (expectedSize !== undefined && (await stat(path)).size !== expectedSize) return false;
    const hash = createHash(algorithm);
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex') === expected.toLowerCase();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function exists(path) {
  try { await access(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function download(url, path) {
  if (new URL(url).protocol !== 'https:') throw new Error('Downloads must use HTTPS.');
  const temporary = `${path}.partial-${process.pid}`;
  const controller = new AbortController();
  const abort = (code, message) => {
    if (controller.signal.aborted) return;
    const error = new Error(message);
    error.code = code;
    controller.abort(error);
  };
  // The absolute limit never moves. Only received bytes renew the separate idle limit.
  const totalTimer = setTimeout(() => abort('download_total_timeout', 'Download exceeded the 900 second total deadline.'), DOWNLOAD_TIMEOUTS.totalMs);
  let stageTimer = setTimeout(() => abort('download_headers_timeout', 'Download response headers timed out after 300 seconds.'), DOWNLOAD_TIMEOUTS.headersMs);
  const resetIdle = () => {
    clearTimeout(stageTimer);
    stageTimer = setTimeout(() => abort('download_idle_timeout', 'Download made no progress for 300 seconds.'), DOWNLOAD_TIMEOUTS.idleMs);
  };
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(stageTimer);
    if (!response.ok || !response.body) {
      const error = new Error(`Download failed (${response.status}): ${url}`);
      controller.abort(error);
      throw error;
    }
    resetIdle();
    const progress = new Transform({ transform(chunk, encoding, callback) {
      if (chunk.length > 0) resetIdle();
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(temporary, { flags: 'wx' }), { signal: controller.signal });
    controller.signal.throwIfAborted();
    await rename(temporary, path);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(stageTimer);
    await rm(temporary, { force: true });
  }
}

async function readMetadata(url, path, { offline, refresh }) {
  if (refresh || !(await exists(path))) {
    if (offline) throw new Error(`Offline metadata is missing: ${path}`);
    await download(url, path);
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function verifiedDownload(url, path, algorithm, expected, size, offline) {
  if (await verifyFile(path, algorithm, expected, size)) return 'reused';
  if (offline) throw new Error(`Offline checksum verification failed or the file is missing: ${path}`);
  const verified = `${path}.verified-${process.pid}`;
  try {
    await download(url, verified);
    if (!(await verifyFile(verified, algorithm, expected, size))) throw new Error(`Checksum verification failed: ${path}`);
    await rename(verified, path);
  } finally { await rm(verified, { force: true }); }
  return 'downloaded';
}

function checkArchivePaths(listing) {
  for (const name of listing.split('\n').filter(Boolean)) {
    if (isAbsolute(name) || name.split(/[\\/]/u).includes('..')) throw new Error('The JDK archive contains an unsafe path.');
  }
}

export async function provision(options) {
  const platform = resolvePlatform();
  const root = resolve(options.root);
  const downloads = join(root, 'downloads');
  const runtime = join(root, 'runtime');
  await mkdir(downloads, { recursive: true });
  await mkdir(runtime, { recursive: true });
  const assetsUrl = `https://api.adoptium.net/v3/assets/latest/${JAVA_MAJOR}/hotspot?architecture=${platform.architecture}&image_type=jdk&os=${platform.os}&vendor=eclipse`;
  const assetsPath = join(downloads, 'jdk-assets.json');
  let assets = await readMetadata(assetsUrl, assetsPath, options);
  let asset = assets.find((entry) => entry.version?.major === JAVA_MAJOR
    && entry.binary?.os === platform.os && entry.binary?.architecture === platform.architecture
    && entry.binary?.image_type === 'jdk' && entry.binary?.jvm_impl === 'hotspot');
  if (!asset && !options.offline) {
    assets = await readMetadata(assetsUrl, assetsPath, { ...options, refresh: true });
    asset = assets.find((entry) => entry.version?.major === JAVA_MAJOR
      && entry.binary?.os === platform.os && entry.binary?.architecture === platform.architecture
      && entry.binary?.image_type === 'jdk' && entry.binary?.jvm_impl === 'hotspot');
  }
  if (!asset) throw new Error(`No Java ${JAVA_MAJOR} JDK metadata for ${platform.os}/${platform.architecture}.`);
  const pkg = asset.binary.package;
  if (!/^[a-f\d]{64}$/iu.test(pkg.checksum) || !pkg.name.endsWith('.tar.gz')
    || pkg.name.includes('/') || pkg.name.includes('\\')) throw new Error('Invalid Adoptium JDK package metadata.');
  const archive = join(downloads, pkg.name);
  const jdkDownload = await verifiedDownload(pkg.link, archive, 'sha256', pkg.checksum, pkg.size, options.offline);

  const manifest = await readMetadata(manifestUrl, join(downloads, 'minecraft-manifest.json'), options);
  const version = manifest.versions.find((entry) => entry.id === MINECRAFT_VERSION && entry.type === 'release');
  if (!version || !/^[a-f\d]{40}$/iu.test(version.sha1)) throw new Error(`Minecraft ${MINECRAFT_VERSION} is absent from the official version manifest.`);
  const versionPath = join(downloads, `minecraft-${MINECRAFT_VERSION}.json`);
  await verifiedDownload(version.url, versionPath, 'sha1', version.sha1, undefined, options.offline);
  const minecraft = JSON.parse(await readFile(versionPath, 'utf8'));
  const server = minecraft.downloads?.server;
  if (minecraft.id !== MINECRAFT_VERSION || minecraft.javaVersion?.majorVersion !== JAVA_MAJOR
    || !server || !/^[a-f\d]{40}$/iu.test(server.sha1)) throw new Error('Invalid Minecraft server metadata or incompatible Java version.');
  const jar = join(root, 'server.jar');
  const serverDownload = await verifiedDownload(server.url, jar, 'sha1', server.sha1, server.size, options.offline);

  // Extract only a verified archive into a disposable directory. Existing runtimes stay intact.
  const listing = await run('tar', ['-tzf', archive], { maxBuffer: 16 * 1024 * 1024 });
  checkArchivePaths(listing.stdout);
  const topLevel = [...new Set(listing.stdout.split('\n').filter(Boolean).map((name) => name.split('/')[0]))];
  if (topLevel.length !== 1 || !topLevel[0].startsWith('jdk-')) throw new Error('Unexpected JDK archive layout.');
  const jdkDirectory = join(runtime, topLevel[0]);
  const java = platform.os === 'mac' ? join(jdkDirectory, 'Contents', 'Home', 'bin', 'java') : join(jdkDirectory, 'bin', 'java');
  if (!(await exists(java))) {
    if (await exists(jdkDirectory)) throw new Error(`An incomplete runtime already exists; preserve or remove it before retrying: ${jdkDirectory}`);
    const staging = join(runtime, `.extract-${process.pid}`);
    await mkdir(staging, { recursive: false });
    try {
      await run('tar', ['-xzf', archive, '-C', staging]);
      await rename(join(staging, topLevel[0]), jdkDirectory);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  const javaVersion = await run(java, ['-version'], { timeout: 20_000 });
  if (!/version "21(?:[."])/u.test(javaVersion.stderr + javaVersion.stdout)) throw new Error('The installed executable did not report Java 21.');
  const installation = {
    java,
    jdk: { release: asset.release_name, url: pkg.link, sha256: pkg.checksum },
    minecraft: { jar, version: minecraft.id, javaVersion: minecraft.javaVersion, serverDownload: server },
  };
  await writeFile(join(root, 'installation.json'), JSON.stringify(installation, null, 2) + '\n');
  const javaHome = dirname(dirname(java));
  const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(join(root, 'environment.sh'), `# Local test runtime; source this file in a shell.\nexport JAVA_HOME=${shellQuote(javaHome)}\nexport PATH="$JAVA_HOME/bin:$PATH"\n`);
  process.stdout.write(`Java ${JAVA_MAJOR}: ${jdkDownload}, SHA-256 verified; Minecraft ${MINECRAFT_VERSION}: ${serverDownload}, SHA-1 verified.\nInstallation: ${join(root, 'installation.json')}\nJava executable: ${java}\n`);
  return installation;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(`Usage: node scripts/setup-minecraft-local.mjs [--root DIRECTORY] [--offline | --refresh]\n\nInstalls a project-local Java 21 JDK and official Minecraft ${MINECRAFT_VERSION} server jar.\nDefault root: ${defaultRoot}\nCached metadata and checksum-verified downloads are reused by default.\n--offline requires valid cached files. --refresh fetches current official metadata.\nSupported hosts: macOS and Linux, arm64 and x64. No server is started or EULA accepted.\n`);
    else await provision(options);
  } catch (error) {
    process.stderr.write(`Minecraft local setup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
