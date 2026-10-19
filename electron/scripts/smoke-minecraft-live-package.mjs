/* global process, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, stat, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Opt-in packaged-helper acceptance against an ALREADY RUNNING isolated vanilla
// server. Does not start/modify a world, submit mining work, or use an account.
const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const serverWorld = argument('--server-world');
assert.ok(serverWorld, 'Pass --server-world for an existing isolated local test-server directory. Start that server separately first.');
const worldRoot = resolve(serverWorld);
await stat(join(worldRoot, 'world', 'level.dat'));
const properties = Object.fromEntries((await readFile(join(worldRoot, 'server.properties'), 'utf8'))
  .split(/\r?\n/u).filter((line) => line && !line.startsWith('#')).map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
assert.equal(properties['server-ip'], '127.0.0.1', 'Live package smoke is restricted to the isolated localhost server.');
assert.equal(properties['online-mode'], 'false', 'This test uses the isolated offline server without account credentials.');
const port = Number(argument('--port', properties['server-port']));
assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'A valid running localhost server port is required.');
const installationRoot = resolve(sourceRoot, '../..', '.minecraft-local-test');
const installed = JSON.parse(await readFile(join(installationRoot, 'installation.json'), 'utf8'));
const version = argument('--version', installed.minecraft.version);
const packageRoot = resolve(argument('--package-root', join(sourceRoot, 'out', `DeskPet Electron-${process.platform}-${process.arch}`)));
const contents = join(packageRoot, 'DeskPet Electron.app', 'Contents');
const executable = process.platform === 'darwin' ? join(contents, 'MacOS', 'deskpet-electron')
  : join(packageRoot, process.platform === 'win32' ? 'deskpet-electron.exe' : 'deskpet-electron');
const resources = process.platform === 'darwin' ? join(contents, 'Resources') : join(packageRoot, 'resources');
const runtimeRoot = join(resources, 'minecraft-runtime');
const sourceHashes = {};
for (const relative of ['runtime.js', 'protocol.js', 'protocolCompatibility.js', 'index.js', 'bridge.js', 'vendor/server/minecraftTaskAgent.js',
  'vendor/server/minecraft/miningNavigation.js', 'vendor/server/minecraft/diamondExpedition.js',
  'vendor/server/minecraft/furnishedHouseBlueprints.js', 'vendor/server/minecraft/furnishedHouseBuilder.js',
  'vendor/server/action/actionRegistry.js', 'vendor/server/minecraft/commandPlanner.js']) {
  const source = await readFile(join(sourceRoot, 'minecraft-runtime', relative));
  const packaged = await readFile(join(runtimeRoot, relative));
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const packagedHash = createHash('sha256').update(packaged).digest('hex');
  assert.equal(packagedHash, sourceHash, `Refusing an obsolete package: ${relative} differs from current source. Repackage first.`);
  sourceHashes[relative] = { source: sourceHash, packaged: packagedHash };
}
const evidence = resolve(argument('--evidence', join(installationRoot, 'evidence', `packaged-live-${new Date().toISOString().replace(/[:.]/gu, '-')}`)));
await mkdir(evidence, { recursive: false });
const profile = join(evidence, 'offline-profile');
await mkdir(profile);
const metadata = { startedAt: new Date().toISOString(), serverWorld: worldRoot, serverHost: '127.0.0.1', serverPort: port,
  minecraftVersion: version, executable, runtimeRoot, sourceHashes, mode: 'packaged-electron-real-vanilla-localhost-offline' };
await writeFile(join(evidence, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
const child = spawn(executable, [join(runtimeRoot, 'bridge.js'), '--data-dir', profile], {
  env: { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const messages = [];
const waiters = new Set();
let buffer = '';
let ioError;
let exited = false;
let exitCode;
let writes = Promise.resolve();
const exit = new Promise((resolveExit) => child.once('close', (code) => { exited = true; exitCode = code; resolveExit(code); }));
child.once('error', (error) => { ioError = error; });
const persist = (file, text) => { writes = writes.then(() => appendFile(join(evidence, file), text)); };
const notify = () => {
  for (const waiter of waiters) {
    const match = messages.slice(waiter.after).find(waiter.predicate);
    if (!match) continue;
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
    waiter.resolve(match);
  }
};
child.stderr.on('data', (chunk) => persist('helper-stderr.log', chunk));
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      messages.push(message);
      persist('helper-events.jsonl', JSON.stringify({ observedAt: new Date().toISOString(), ...message }) + '\n');
    } catch { ioError = new Error('Packaged helper emitted non-JSONL stdout.'); }
  }
  notify();
});
function waitFor(predicate, after = 0, timeoutMs = 35_000) {
  if (ioError) return Promise.reject(ioError);
  const found = messages.slice(after).find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((resolveWait, rejectWait) => {
    const waiter = { predicate, after, resolve: resolveWait, reject: rejectWait };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      rejectWait(ioError || new Error(`Timed out waiting for packaged live helper readback (exit=${exited ? exitCode : 'running'}).`));
    }, timeoutMs);
    waiters.add(waiter);
  });
}
function send(id, type, payload = {}) {
  child.stdin.write(JSON.stringify({ version: 1, id, type, ...payload }) + '\n');
}

let result;
try {
  await waitFor((message) => message.type === 'ready');
  const connectAt = messages.length;
  send('live-connect', 'connect', { config: { host: '127.0.0.1', port, username: 'DeskPetPkgSmoke', auth: 'offline', version,
    ownerName: '', executorMode: 'strict' } });
  const acknowledgement = await waitFor((message) => message.type === 'reply' && message.id === 'live-connect', connectAt);
  assert.equal(acknowledgement.ok, true);
  const connected = await waitFor((message) => message.type === 'event' && message.event?.type === 'mc_status'
    && message.event.status?.connected === true, connectAt);
  assert.ok(connected.event.status.position && Number.isFinite(connected.event.status.position.y));
  assert.ok(Number.isFinite(connected.event.status.health));
  const queryAt = messages.length;
  send('live-query', 'command', { command: { type: 'mc_command_query' } });
  const query = await waitFor((message) => message.type === 'reply' && message.id === 'live-query', queryAt);
  assert.equal(query.ok, true);
  const inventory = await waitFor((message) => message.type === 'event' && message.event?.type === 'mc_inventory_snapshot', queryAt);
  const context = await waitFor((message) => message.type === 'event' && message.event?.type === 'mc_world_context'
    && message.event.context?.connected === true, queryAt);
  const disconnectAt = messages.length;
  send('live-disconnect', 'disconnect');
  const disconnected = await waitFor((message) => message.type === 'event' && message.event?.type === 'mc_status'
    && message.event.status?.connected === false, disconnectAt);
  assert.equal(disconnected.event.status.position, null);
  send('live-shutdown', 'shutdown');
  await waitFor((message) => message.type === 'reply' && message.id === 'live-shutdown' && message.ok === true, disconnectAt);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try { assert.equal(await exit, 0); } finally { clearTimeout(timeout); }
  assert.equal(messages.some((message) => message.type === 'planner_request'), false);
  assert.equal(messages.some((message) => message.type === 'event' && message.event?.type === 'mc_error'), false);
  result = { ...metadata, finishedAt: new Date().toISOString(), passed: true, exitCode,
    connected: connected.event.status, inventory: inventory.event.inventory, worldContext: context.event.context,
    disconnected: disconnected.event.status, providerRequests: 0, taskSubmission: false };
  process.stdout.write(JSON.stringify({ passed: true, exitCode, position: connected.event.status.position, evidence }) + '\n');
} catch (error) {
  result = { ...metadata, finishedAt: new Date().toISOString(), passed: false, exitCode,
    error: error.message, stack: error.stack };
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
} finally {
  for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('Live package smoke ended.')); }
  waiters.clear();
  if (!exited) {
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try { await exit; } finally { clearTimeout(timeout); }
  }
  await writes;
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
}
