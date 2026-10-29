/* global require, module, setTimeout, clearTimeout */
'use strict';
// Starts an isolated vanilla Java server and drives it through its console.
// Console commands only set up scenarios and read back results; during a run
// only the bot changes the world.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { once } = require('node:events');
const { finished } = require('node:stream/promises');
const { createOutputBuffer } = require('./serverOutput.cjs');

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function installDataPacks(dir, packs) {
  for (const [name, files] of Object.entries(packs || {})) {
    if (!/^[\w-]+$/.test(name)) throw new Error(`Invalid observer data-pack name: ${name}`);
    const root = path.resolve(dir, 'world/datapacks', name);
    for (const [file, contents] of Object.entries(files)) {
      const target = path.resolve(root, file);
      if (!target.startsWith(root + path.sep)) throw new Error(`Invalid observer data-pack path: ${file}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
  }
}

async function startVanillaServer({ java, jar, dir, properties = {}, dataPacks = {}, memory = '2G', log = () => {},
  signal, spawnProcess = spawn, reservePort = freePort, startupTimeoutMs = 240000, stopTimeoutMs = 30000, killTimeoutMs = 5000 }) {
  if (signal?.aborted) throw Object.assign(new Error(String(signal.reason || 'interrupted')), { code: 'interrupted' });
  fs.mkdirSync(dir, { recursive: true });
  installDataPacks(dir, dataPacks);
  const port = await reservePort();
  if (signal?.aborted) throw Object.assign(new Error(String(signal.reason || 'interrupted')), { code: 'interrupted' });
  const merged = {
    'server-ip': '127.0.0.1', 'server-port': port, 'online-mode': false, 'enforce-secure-profile': false,
    'enable-rcon': false, 'enable-query': false, 'level-name': 'world', 'max-players': 2,
    'view-distance': 8, 'simulation-distance': 6, 'spawn-protection': 0, 'sync-chunk-writes': false,
    'pause-when-empty-seconds': 0, motd: 'DeskPet scenario', gamemode: 'survival',
    ...properties,
  };
  fs.writeFileSync(path.join(dir, 'server.properties'),
    Object.entries(merged).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');

  const child = spawnProcess(java, [`-Xmx${memory}`, '-jar', jar, 'nogui'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const logStream = fs.createWriteStream(path.join(dir, 'server.log'));
  const output = createOutputBuffer();
  let logError = null;
  let consoleError = null;
  logStream.on('error', (error) => { logError = error; });
  child.stdin.on('error', (error) => { consoleError = error; });
  let queryQueue = Promise.resolve();
  const waiters = new Set();
  const onData = (chunk) => {
    const text = chunk.toString();
    logStream.write(chunk);
    output.append(text);
    for (const waiter of [...waiters]) waiter.check();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  let exited = false;
  let closed = false;
  let exitStatus = null;
  let spawnError = null;
  const closure = new Promise((resolve) => child.once('close', (code, signal) => {
    closed = true;
    exitStatus ||= { code, signal };
    resolve();
  }));
  child.on('error', (error) => {
    spawnError = error;
    exited = true;
    for (const waiter of [...waiters]) waiter.fail(error);
  });
  child.on('exit', (code, signal) => {
    exitStatus = { code, signal };
    exited = true;
    log('server_exit', { code, signal });
    for (const waiter of [...waiters]) waiter.fail(new Error(`Server exited (${code ?? signal})`));
  });

  /** Waits for `pattern` in output appearing after character offset `from`. */
  function waitFor(pattern, { from = 0, timeoutMs = 10000, signal } = {}) {
    return new Promise((resolve, reject) => {
      const waiter = {
        check() {
          const match = output.textFrom(from).match(pattern);
          if (match) { finish(); resolve(match); }
        },
        fail(error) { finish(); reject(error); },
      };
      const timer = setTimeout(() => waiter.fail(Object.assign(new Error(`Timed out waiting for ${pattern}`), { code: 'server_read_timeout' })), timeoutMs);
      const onAbort = () => waiter.fail(Object.assign(new Error(String(signal.reason || 'interrupted')), { code: 'interrupted' }));
      function finish() { clearTimeout(timer); waiters.delete(waiter); signal?.removeEventListener('abort', onAbort); }
      waiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else if (exited) waiter.fail(spawnError || new Error('Server is not running'));
      else waiter.check();
    });
  }

  let stopping = false;
  function command(text) {
    if (stopping) throw new Error('Server is stopping');
    if (exited) throw new Error('Server is not running');
    child.stdin.write(`${text}\n`);
  }

  /** Sends a command and returns the first output line matching `pattern`. */
  let queryFailure = null;
  function assertQueryChannel() { if (queryFailure) throw queryFailure; }
  async function queryNow(text, pattern, timeoutMs = 5000) {
    assertQueryChannel();
    const from = output.offset();
    command(text);
    try { return await waitFor(pattern, { from, timeoutMs }); }
    catch (error) {
      // A timed-out command may still reply later. Never let that response
      // satisfy another command with an identical pattern. Stop bypasses this.
      if (error.code === 'server_read_timeout') queryFailure = Object.assign(
        new Error('Server query channel desynchronized after response timeout'), { cause: error });
      throw error;
    }
  }

  function queued(action) {
    const result = queryQueue.then(action);
    queryQueue = result.catch(() => {});
    return result;
  }

  // Queries with the same reply pattern must never race (e.g. two block tests).
  function query(text, pattern, timeoutMs = 5000, { signal, deadline } = {}) {
    if (queryFailure) return Promise.reject(queryFailure);
    let abandoned = false;
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (fn, value) => {
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(value);
      };
      const cancel = (error) => { abandoned = true; finish(reject, error); };
      const onAbort = () => cancel(Object.assign(new Error(String(signal.reason || 'interrupted')), { code: 'interrupted' }));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      if (Number.isFinite(deadline)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { cancel(new Error('Server query caller deadline exceeded')); return; }
        timer = setTimeout(() => cancel(new Error('Server query caller deadline exceeded')), remaining);
      }
      // Cancellation skips a pending command, but never releases an active
      // command's queue slot before its response drains (or poisons the channel).
      const drain = queued(() => {
        if (abandoned) return undefined;
        if (signal?.aborted || (Number.isFinite(deadline) && Date.now() >= deadline)) {
          cancel(new Error('Server query canceled before dispatch')); return undefined;
        }
        assertQueryChannel();
        return queryNow(text, pattern, timeoutMs);
      });
      drain.then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
  }

  function execute(text, timeoutMs = 15000) {
    if (queryFailure) return Promise.reject(queryFailure);
    return queued(async () => {
      assertQueryChannel();
      const from = output.offset();
      command(text);
      // Console commands are processed in order. This barrier captures the
      // command's own response, including explicit failures, not just exit 0.
      await queryNow('list', /players online/, timeoutMs);
      return output.textFrom(from);
    });
  }

  let stopCall = null;
  function stop() {
    if (stopCall) return stopCall;
    stopping = true;
    stopCall = (async () => {
      const from = output.offset();
      const failures = [];
      const alreadyExited = exited;
      let forced = false;
      const boundedClose = (timeoutMs) => new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        closure.then(() => { clearTimeout(timer); resolve(true); });
      });
      if (!exited) {
        log('server_stop_requested', { method: 'console' });
        try { child.stdin.write('stop\n'); }
        catch (error) { failures.push(`console_stop:${error.message}`); }
      }
      if (!closed && !await boundedClose(stopTimeoutMs)) {
        forced = true;
        failures.push('console_stop_timeout');
        log('server_stop_forced', { signal: 'SIGKILL' });
        try { child.kill('SIGKILL'); } catch (error) { failures.push(`kill:${error.message}`); }
        if (!await boundedClose(killTimeoutMs)) failures.push('server_close_timeout_after_kill');
      }
      if (alreadyExited) failures.push('server_exited_before_stop');
      if (spawnError) failures.push(`spawn:${spawnError.message}`);
      if (exitStatus?.code !== 0 || exitStatus?.signal) failures.push(`server_exit:${exitStatus?.code ?? exitStatus?.signal ?? 'unknown'}`);
      child.stdout.removeListener('data', onData);
      child.stderr.removeListener('data', onData);
      // Child close follows all stdio close events; flush our own log too.
      const logClosed = finished(logStream);
      logStream.end();
      try { await logClosed; } catch (error) { failures.push(`log_close:${error.message}`); }
      if (consoleError) failures.push(`console:${consoleError.message}`);
      const saveObserved = /All dimensions are saved/.test(output.textFrom(from));
      if (!saveObserved) failures.push('final_save_unconfirmed');
      const receipt = { method: alreadyExited ? 'already_exited' : 'console', ...exitStatus, forced, closed,
        logClosed: !logError, saveObserved, failures };
      log('server_stopped', receipt);
      if (failures.length) throw Object.assign(new Error(`server_cleanup_failed:${failures.join(',')}`), { cleanup: receipt });
      return receipt;
    })();
    return stopCall;
  }

  try {
    await waitFor(/Done \([^)]+\)! For help/, { timeoutMs: startupTimeoutMs, signal });
    if (signal?.aborted) throw Object.assign(new Error(String(signal.reason || 'interrupted')), { code: 'interrupted' });
  } catch (error) {
    try { error.cleanup = await stop(); } catch (cleanupError) { error.cleanup = cleanupError.cleanup; }
    throw error;
  }
  return { port, command, query, execute, waitFor, stop, offset: () => output.offset() };
}

module.exports = { startVanillaServer, installDataPacks };
