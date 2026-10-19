import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { JAVA_MAJOR, MINECRAFT_VERSION, parseArgs, resolvePlatform, verifyFile } from './setup-minecraft-local.mjs';

test('provisioning pins the tested server and Java major', () => {
  assert.equal(MINECRAFT_VERSION, '1.21.8');
  assert.equal(JAVA_MAJOR, 21);
  assert.deepEqual(resolvePlatform('darwin', 'arm64'), { os: 'mac', architecture: 'aarch64' });
  assert.deepEqual(resolvePlatform('darwin', 'x64'), { os: 'mac', architecture: 'x64' });
  assert.deepEqual(resolvePlatform('linux', 'arm64'), { os: 'linux', architecture: 'aarch64' });
  assert.deepEqual(resolvePlatform('linux', 'x64'), { os: 'linux', architecture: 'x64' });
  assert.throws(() => resolvePlatform('win32', 'x64'), /does not support win32\/x64/u);
});

test('explicit roots and offline mode do not silently refresh metadata', () => {
  assert.deepEqual(parseArgs(['--root', './test-runtime', '--offline']), {
    root: resolve('./test-runtime'), offline: true, refresh: false, help: false,
  });
  assert.throws(() => parseArgs(['--offline', '--refresh']), /cannot be combined/u);
  assert.throws(() => parseArgs(['--root']), /requires a directory/u);
  assert.throws(() => parseArgs(['--root', '--offline']), /requires a directory/u);
  assert.throws(() => parseArgs(['--accept-eula']), /Unknown argument/u);
});

test('cached files must match both checksum and declared size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-java-checksum-'));
  try {
    const path = join(root, 'archive');
    const content = 'verified official download';
    await writeFile(path, content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const sha1 = createHash('sha1').update(content).digest('hex');
    assert.equal(await verifyFile(path, 'sha256', sha256, content.length), true);
    assert.equal(await verifyFile(path, 'sha1', sha1), true);
    assert.equal(await verifyFile(path, 'sha256', sha256, content.length + 1), false);
    await writeFile(path, 'corrupted');
    assert.equal(await verifyFile(path, 'sha256', sha256), false);
    assert.equal(await verifyFile(join(root, 'missing'), 'sha256', sha256), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
