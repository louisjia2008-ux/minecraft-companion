import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ReadableStream } from 'node:stream/web';
import test from 'node:test';
import { DOWNLOAD_TIMEOUTS, JAVA_MAJOR, MINECRAFT_VERSION, download, parseArgs, resolvePlatform, verifiedDownload, verifyFile } from './setup-minecraft-local.mjs';

const hostSetTimeout = globalThis.setTimeout;
const hostClearTimeout = globalThis.clearTimeout;
const hostTurn = () => new Promise((done) => setImmediate(done));
const digest = (content) => createHash('sha256').update(content).digest('hex');

// Only the installer clock/fetch are controlled. Bytes still traverse the real web/Node
// streams, filesystem, checksum and atomic rename; an independent host watchdog bounds bugs.
async function downloadFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'minecraft-download-clock-'));
  let expired = false;
  let rejectWatchdog;
  const watchdog = new Promise((_, reject) => { rejectWatchdog = reject; });
  watchdog.catch(() => {});
  const hostTimer = hostSetTimeout(() => {
    expired = true;
    rejectWatchdog(new Error('Installer clock fixture exceeded its 8 second host watchdog.'));
  }, 8_000);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const timers = new Set();
  const clockSetTimeout = globalThis.setTimeout;
  const clockClearTimeout = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    let handle;
    handle = clockSetTimeout(() => { timers.delete(handle); callback(...args); }, delay);
    timers.add(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle) => {
    timers.delete(handle);
    return clockClearTimeout(handle);
  });
  let bodyController;
  const body = new ReadableStream({ start(controller) { bodyController = controller; } });
  let resolveHeaders, rejectHeaders;
  const headers = new Promise((yes, no) => { resolveHeaders = yes; rejectHeaders = no; });
  headers.catch(() => {});
  const requests = [];
  const fail = (error) => {
    rejectHeaders(error);
    try { bodyController.error(error); } catch { /* Already closed/errored. */ }
  };
  t.mock.method(globalThis, 'fetch', (url, { signal }) => {
    requests.push({ url, signal, startedAt: Date.now() });
    signal.addEventListener('abort', () => fail(signal.reason), { once: true });
    return headers;
  });
  t.after(async () => {
    fail(new Error('Fixture cleanup.'));
    hostClearTimeout(hostTimer);
    t.mock.restoreAll();
    t.mock.timers.reset();
    await rm(root, { recursive: true, force: true });
  });
  const tick = async (ms) => { t.mock.timers.tick(ms); await hostTurn(); };
  const waitFor = async (predicate) => {
    while (!(await predicate())) {
      if (expired) throw new Error('Installer clock fixture host watchdog expired.');
      await hostTurn();
    }
  };
  const file = join(root, 'archive');
  return {
    root, file, timers, requests, tick,
    requested: () => waitFor(() => requests.length === 1),
    respond: (response = { ok: true, status: 200, body }) => resolveHeaders(response),
    send: (value) => bodyController.enqueue(typeof value === 'string' ? Buffer.from(value) : value),
    end: () => bodyController.close(), fail,
    bytes: (count, path = `${file}.partial-${process.pid}`) => waitFor(async () => {
      try { return (await stat(path)).size >= count; } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }),
    observe: (promise) => {
      const result = { settled: false };
      result.done = promise.then((value) => { result.value = value; result.settled = true; },
        (error) => { result.error = error; result.settled = true; });
      return result;
    },
    finish: async (result) => {
      await Promise.race([result.done, watchdog]);
      if (result.error) throw result.error;
      return result.value;
    },
  };
}

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

test('download limits distinguish headers and idle from the finite absolute cap', () => {
  assert.deepEqual(DOWNLOAD_TIMEOUTS, { headersMs: 300_000, idleMs: 300_000, totalMs: 900_000 });
  assert.equal(Object.isFrozen(DOWNLOAD_TIMEOUTS), true);
});

test('active slow verified bytes can exceed the old five minute total without retry', { timeout: 10_000 }, async (t) => {
  const f = await downloadFixture(t);
  const result = f.observe(verifiedDownload('https://example.invalid/archive', f.file, 'sha256', digest('abc'), 3, false));
  await f.requested(); assert.equal(f.requests[0].startedAt, 1_000);
  f.respond(); await hostTurn();
  for (const [index, chunk] of ['a', 'b', 'c'].entries()) {
    await f.tick(240_000); f.send(chunk);
    await f.bytes(index + 1, `${f.file}.verified-${process.pid}.partial-${process.pid}`);
    assert.equal(f.requests[0].signal.aborted, false);
  }
  assert.equal(Date.now(), 721_000);
  f.end(); assert.equal(await f.finish(result), 'downloaded');
  assert.equal(await readFile(f.file, 'utf8'), 'abc');
  assert.deepEqual(await readdir(f.root), ['archive']);
  assert.equal(f.requests.length, 1);
  assert.equal(f.timers.size, 0);
  await f.tick(2 * DOWNLOAD_TIMEOUTS.totalMs);
  assert.equal(f.requests[0].signal.aborted, false);
});

test('missing response headers abort at the original five minute header limit', { timeout: 10_000 }, async (t) => {
  const f = await downloadFixture(t);
  const result = f.observe(download('https://example.invalid/archive', f.file));
  await f.tick(299_999); assert.equal(result.settled, false);
  await f.tick(1);
  await assert.rejects(f.finish(result), { code: 'download_headers_timeout' });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(await readdir(f.root), []);
});

test('empty body chunks do not extend the first byte idle deadline', { timeout: 10_000 }, async (t) => {
  const f = await downloadFixture(t);
  const result = f.observe(download('https://example.invalid/archive', f.file));
  f.respond(); await hostTurn();
  await f.tick(299_999); f.send(new Uint8Array(0)); await hostTurn();
  await f.tick(1);
  await assert.rejects(f.finish(result), { code: 'download_idle_timeout' });
  assert.equal(f.requests.length, 1);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(await readdir(f.root), []);
});

test('only actual bytes renew idle and a mid-body stall preserves the destination', { timeout: 10_000 }, async (t) => {
  const f = await downloadFixture(t);
  await writeFile(f.file, 'previous verified file');
  const result = f.observe(download('https://example.invalid/archive', f.file));
  f.respond(); await hostTurn();
  await f.tick(200_000); f.send('a'); await f.bytes(1);
  await f.tick(299_999); assert.equal(f.requests[0].signal.aborted, false);
  await f.tick(1);
  await assert.rejects(f.finish(result), { code: 'download_idle_timeout' });
  assert.equal(await readFile(f.file, 'utf8'), 'previous verified file');
  assert.deepEqual(await readdir(f.root), ['archive']);
  assert.equal(f.requests.length, 1);
  assert.equal(f.timers.size, 0);
});

test('the absolute cap includes header time and defeats a continuously progressing trickle', { timeout: 10_000 }, async (t) => {
  const f = await downloadFixture(t);
  const result = f.observe(download('https://example.invalid/archive', f.file));
  await f.tick(299_999); f.respond(); await hostTurn();
  for (const [index, delta] of [200_001, 200_000, 199_999].entries()) {
    await f.tick(delta); f.send('a'); await f.bytes(index + 1);
    assert.equal(f.requests[0].signal.aborted, false);
  }
  assert.equal(Date.now(), 900_999);
  await f.tick(1);
  await assert.rejects(f.finish(result), { code: 'download_total_timeout' });
  assert.equal(f.requests.length, 1);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(await readdir(f.root), []);
});

test('bad HTTP status and missing response body still fail without retry or partial files', async (t) => {
  for (const response of [{ ok: false, status: 503, body: null }, { ok: true, status: 200, body: null }]) {
    await t.test(`response ${response.status}, ok=${response.ok}`, { timeout: 10_000 }, async (child) => {
      const f = await downloadFixture(child);
      const result = f.observe(download('https://example.invalid/archive', f.file));
      f.respond(response);
      await assert.rejects(f.finish(result), /Download failed/u);
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0].signal.aborted, true);
      assert.equal(f.timers.size, 0);
      assert.deepEqual(await readdir(f.root), []);
    });
  }
});

test('native stream failure cleans partial files and keeps the original destination', { timeout: 10_000 }, async (t) => {
  const f = await downloadFixture(t);
  await writeFile(f.file, 'old verified bytes');
  const result = f.observe(download('https://example.invalid/archive', f.file));
  f.respond(); f.send('new'); await f.bytes(3);
  const failure = new Error('native stream failed');
  f.fail(failure);
  await assert.rejects(f.finish(result), (error) => error === failure);
  assert.equal(await readFile(f.file, 'utf8'), 'old verified bytes');
  assert.deepEqual(await readdir(f.root), ['archive']);
  assert.equal(f.requests.length, 1);
  assert.equal(f.timers.size, 0);
});

test('bad checksum or size never replaces a pre-existing file or leaves verified staging', async (t) => {
  for (const mode of ['checksum', 'size']) {
    await t.test(mode, { timeout: 10_000 }, async (child) => {
      const f = await downloadFixture(child);
      await writeFile(f.file, 'previous official cache');
      const result = f.observe(verifiedDownload('https://example.invalid/archive', f.file, 'sha256',
        digest('new official bytes'), mode === 'size' ? 19 : 18, false));
      f.respond(); f.send(mode === 'size' ? 'new official bytes' : 'incorrect content!'); f.end();
      await assert.rejects(f.finish(result), /Checksum verification failed/u);
      assert.equal(await readFile(f.file, 'utf8'), 'previous official cache');
      assert.deepEqual(await readdir(f.root), ['archive']);
      assert.equal(f.requests.length, 1);
      assert.equal(f.timers.size, 0);
    });
  }
});

test('verified cache reuse and offline rejection never make a request', { timeout: 10_000 }, async (t) => {
  const f = await downloadFixture(t);
  await writeFile(f.file, 'official cache');
  assert.equal(await verifiedDownload('https://example.invalid/archive', f.file, 'sha256', digest('official cache'), 14, false), 'reused');
  await assert.rejects(verifiedDownload('https://example.invalid/archive', f.file, 'sha256', digest('other'), 5, true), /Offline checksum verification failed/u);
  assert.equal(await readFile(f.file, 'utf8'), 'official cache');
  assert.equal(f.requests.length, 0);
  assert.equal(f.timers.size, 0);
});

test('the download still refuses plaintext transport before any request', { timeout: 10_000 }, async (t) => {
  const f = await downloadFixture(t);
  await assert.rejects(download('http://example.invalid/archive', f.file), /must use HTTPS/u);
  assert.equal(f.requests.length, 0);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(await readdir(f.root), []);
});
