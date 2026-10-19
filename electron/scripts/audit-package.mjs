/* global process */
import { listPackage } from '@electron/asar';
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const forbidden = (path) => {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  return normalized.endsWith('/live2dcubismcore.min.js')
    || normalized.endsWith('.moc3')
    || normalized.endsWith('.model3.json')
    || normalized.endsWith('.zip')
    || normalized.includes('/managed/core/')
    || normalized.includes('/managed/models/');
};

const isForgeZipArtifact = (path) => {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  return normalized.includes('/out/make/zip/') && normalized.endsWith('.zip');
};

const archives = [];
const externalFiles = [];
const walk = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (extname(entry.name).toLowerCase() === '.asar') archives.push(path);
    else externalFiles.push(path);
  }
};

await walk(join(process.cwd(), 'out'));
// The macOS deliverable is itself a ZIP. Its source application tree and ASAR
// are both scanned below; only that known Forge container is exempted.
const violations = externalFiles.filter((path) => forbidden(path) && !isForgeZipArtifact(path));
for (const archive of archives) {
  for (const path of listPackage(archive, { isPack: false })) {
    if (forbidden(path)) violations.push(`${archive}:${path}`);
  }
}
if (archives.length === 0) throw new Error('No packaged ASAR archive was found.');
if (violations.length > 0) throw new Error(`Packaged output contains prohibited Core/model/archive content:\n${violations.join('\n')}`);
process.stdout.write(`Package audit passed: ${archives.length} ASAR archive(s), no Cubism Core, model, or model ZIP.\n`);
