/* global process, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const packageRoot = join(process.cwd(), 'out', `DeskPet Electron-${process.platform}-${process.arch}`);
const macBundle = join(packageRoot, 'DeskPet Electron.app', 'Contents');
const executable = process.platform === 'darwin' ? join(macBundle, 'MacOS', 'deskpet-electron')
  : join(packageRoot, process.platform === 'win32' ? 'deskpet-electron.exe' : 'deskpet-electron');
const resources = process.platform === 'darwin' ? join(macBundle, 'Resources') : join(packageRoot, 'resources');
const profile = await mkdtemp(join(tmpdir(), 'deskpet-packaged-minecraft-'));
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
const child = spawn(executable, [join(resources, 'minecraft-runtime', 'bridge.js'), '--data-dir', profile], {
  env: { ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const exit = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
let buffer = '';
let ready = false;
let refused = false;
let timer;
try {
  await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Packaged Minecraft helper smoke timed out.')), 20_000);
    child.once('error', reject);
    child.once('exit', () => { if (!refused) reject(new Error('Packaged Minecraft helper exited before connection readback.')); });
    child.stderr.on('data', () => { /* Private dependency diagnostics are not printed. */ });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { reject(new Error('Packaged helper stdout is not JSONL.')); return; }
        if (message.type === 'ready') {
          ready = true;
          child.stdin.write(JSON.stringify({ version: 1, id: 'smoke-connect', type: 'connect', config: {
            host: '127.0.0.1', port: address.port, username: 'DeskPetSmoke', auth: 'offline',
            version: '1.21.8', ownerName: '', executorMode: 'strict',
          } }) + '\n');
        }
        if (message.type === 'event' && message.event?.type === 'mc_status' && message.event.status?.connected) {
          reject(new Error('A refused connection must never report a spawned player.')); return;
        }
        if (message.type === 'event' && message.event?.type === 'mc_error' && /ECONNREFUSED/u.test(message.event.message)) {
          refused = true; resolve();
        }
      }
    });
  });
  assert.ok(ready && refused);
  child.stdin.end(JSON.stringify({ version: 1, id: 'smoke-shutdown', type: 'shutdown' }) + '\n');
  assert.equal(await exit, 0);
  process.stdout.write('Packaged Minecraft smoke passed: Electron Node runtime, dependencies, refused connection and clean exit.\n');
} finally {
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
  await rm(profile, { recursive: true, force: true });
}
