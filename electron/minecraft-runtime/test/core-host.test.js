'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createCoreHost } = require('../core-host');
const { TOOLS, validateTool } = require('../core-tools');
const config = { host: '127.0.0.1', port: 25565, username: 'CoreHost', auth: 'offline', version: '1.21.8' };
const turn = () => new Promise((resolve) => setImmediate(resolve));
const message = (id, type, fields = {}) => ({ version: 1, id, type, ...fields });
const tool = (id, name, args = {}, rest = {}) => message(id, 'tool', { name, arguments: args, ...rest });
function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-host-'));
  const output = []; const bots = []; const engines = []; const calls = [];
  const host = createCoreHost({ dataDir, emit: (row) => output.push(row),
    createBot: () => {
      const bot = new EventEmitter(); bot.quit = () => { bot.quitCalls = (bot.quitCalls || 0) + 1; };
      bot.waitForChunksToLoad = async () => {};
      bots.push(bot); return bot;
    },
    createCompanion: ({ onEvent }) => {
      const engine = { emit: onEvent, taskId: null, disposed: false, paused: false,
        async submitTask(name, args, meta) { this.taskId = meta.taskId; calls.push({ name, args, ...meta });
          onEvent({ type: 'goal_set', goal: name, taskId: meta.taskId }); },
        async cancelTask(reason) { onEvent({ type: 'goal_cleared', taskId: this.taskId, reason }); this.taskId = null; },
        async pauseTask() { this.paused = true; }, async resumeTask() { this.paused = false; },
        status() { return { paused: this.paused, disposed: this.disposed }; }, async dispose() { this.disposed = true; },
      };
      engines.push(engine); return engine;
    }, ...options });
  t.after(async () => { try { await host.close(); } catch { /* tests may inject failed teardown */ }
    fs.rmSync(dataDir, { recursive: true, force: true }); });
  async function ready(id = 'connect') {
    assert.equal((await host.handle(message(id, 'connect', { config }))).ok, true);
    bots.at(-1).emit('spawn'); await turn();
    assert.equal(host.status().connection.state, 'ready');
  }
  return { host, output, bots, engines, calls, ready, dataDir };
}

test('history limit reserves room for controls alongside a pinned active request', async (t) => {
  assert.throws(() => createCoreHost({ dataDir: path.join(os.tmpdir(), 'unused-core-history'), historyLimit: 1 }),
    /Invalid host limits/);
  const f = fixture(t, { historyLimit: 2 });
  await f.ready();
  const receipt = await f.host.handle(tool('goal', 'gatherLogs', { count: 1 }));
  const taskId = receipt.result.task.taskId;
  assert.equal((await f.host.handle(tool('status', 'getStatus'))).ok, true);
  const cancelled = await f.host.handle(tool('cancel', 'cancel', { taskId }));
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.result.task.status, 'cancelled');
});

test('tools are bounded data schemas and cannot inject bot/actions or arbitrary goals', () => {
  assert.equal(TOOLS.filter((entry) => entry.kind === 'goal').length, 18);
  for (const [name, args] of [['gatherLogs', { count: 0 }], ['gatherLogs', { count: '3' }],
    ['gatherLogs', { count: 1, bot: {} }], ['homestead', { actions: {} }], ['setGoal', {}],
    ['__proto__', {}], [['gatherLogs'], { count: 1 }], [['getStatus'], {}], ['pause', {}],
    ['gatherMaterials', { chest: { x: 1.5, y: 64, z: 0 }, requirements: [] }]]) {
    assert.throws(() => validateTool(name, args), TypeError);
  }
  validateTool('gatherLogs', { count: 3 });
  validateTool('fishing', { count: 5, anchor: { x: 1, y: 64, z: 2 }, facing: 'east' });
});

test('dispatch is not completion; correlated terminal event settles exactly once', async (t) => {
  const f = fixture(t);
  assert.equal((await f.host.handle(tool('too-early', 'gatherLogs', { count: 3 }))).error.code, 'not_ready');
  await f.ready();
  const reply = await f.host.handle(tool('gather', 'gatherLogs', { count: 3 }));
  assert.equal(reply.ok, true); assert.equal(reply.result.dispatchOnly, true);
  const id = reply.result.task.taskId;
  assert.equal(reply.result.task.status, 'running');
  assert.deepEqual(f.output.filter((e) => e.event?.type === 'task').map((e) => e.event.task.status), ['accepted', 'running']);
  f.engines[0].emit({ type: 'goal_done', taskId: 'not-this-task', progress: 9 });
  assert.equal(f.host.status().task.taskId, id);
  f.engines[0].emit({ type: 'goal_done', taskId: id, progress: 3 });
  f.engines[0].emit({ type: 'goal_failed', taskId: id, reasons: ['late'] });
  const result = await f.host.handle(tool('query', 'getTask', { taskId: id }));
  assert.equal(result.result.task.status, 'completed');
  assert.equal(f.output.filter((e) => e.event?.task?.status === 'completed').length, 1);
  assert.equal(f.host.status().task, null);
});

test('concurrent duplicate request joins dispatch; conflicting duplicate never executes', async (t) => {
  const f = fixture(t); await f.ready();
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const original = f.engines[0].submitTask;
  f.engines[0].submitTask = async function (...args) { await gate; return original.apply(this, args); };
  const request = tool('same', 'gatherLogs', { count: 3 });
  const first = f.host.handle(request); const duplicate = f.host.handle(request);
  const conflict = await f.host.handle(tool('same', 'gatherLogs', { count: 4 }));
  assert.equal(conflict.error.code, 'id_conflict');
  release(); assert.deepEqual(await first, await duplicate); assert.equal(f.calls.length, 1);
  const id = f.calls[0].taskId;
  f.engines[0].emit({ type: 'goal_done', taskId: id });
  assert.deepEqual(await f.host.handle(request), await first);
  assert.equal(f.calls.length, 1);
});

test('in-process caller mutation cannot rewrite a retained idempotent receipt', async (t) => {
  const f = fixture(t); await f.ready();
  const request = tool('one', 'gatherLogs', { count: 3 });
  const reply = await f.host.handle(request); const taskId = reply.result.task.taskId;
  reply.result.task.taskId = 'mutated'; reply.result.task.status = 'completed';
  const replay = await f.host.handle(request);
  assert.equal(replay.result.task.taskId, taskId); assert.equal(replay.result.task.status, 'running');
});

test('explicit single-owner replacement and late events cannot settle the new task', async (t) => {
  const f = fixture(t); await f.ready();
  const first = await f.host.handle(tool('one', 'gatherLogs', { count: 3 }));
  const oldId = first.result.task.taskId;
  const busy = await f.host.handle(tool('two', 'gatherLogs', { count: 1 }));
  assert.equal(busy.error.code, 'busy'); assert.equal(f.calls.length, 1);
  const next = await f.host.handle(tool('replace', 'gatherLogs', { count: 1 }, { replaceCurrent: true }));
  const newId = next.result.task.taskId;
  assert.notEqual(oldId, newId);
  f.engines[0].emit({ type: 'goal_done', taskId: oldId });
  f.engines[0].emit({ type: 'goal_failed', taskId: oldId, reasons: ['late failure'] });
  assert.equal(f.host.status().task.taskId, newId);
  assert.equal((await f.host.handle(tool('old', 'getTask', { taskId: oldId }))).result.task.status, 'cancelled');
  await f.host.handle(tool('stale-cancel', 'cancel', { taskId: oldId }));
  assert.equal(f.host.status().task.taskId, newId);
});

test('pause/resume retains safety, cancel ends only task, stopAll disposes and disconnects', async (t) => {
  const f = fixture(t); await f.ready();
  const taskId = (await f.host.handle(tool('one', 'gatherLogs', { count: 3 }))).result.task.taskId;
  const paused = await f.host.handle(tool('pause', 'pause', { taskId }));
  assert.equal(paused.result.task.paused, true);
  assert.equal(f.host.status().safetyActive, true); assert.equal(f.engines[0].disposed, false);
  assert.equal((await f.host.handle(tool('resume', 'resume', { taskId }))).result.task.paused, false);
  assert.equal((await f.host.handle(tool('cancel', 'cancel', { taskId }))).result.task.status, 'cancelled');
  assert.equal(f.host.status().safetyActive, true);
  await f.host.handle(tool('another', 'gatherLogs', { count: 1 }));
  await f.host.handle(tool('all', 'stopAll'));
  assert.equal(f.engines[0].disposed, true); assert.equal(f.host.status().safetyActive, false);
  assert.equal(f.host.status().connection.state, 'disconnected'); assert.equal(f.bots[0].quitCalls, 1);
});

test('disconnect failure is structured; explicit reconnect never replays tasks or trusts old bot events', async (t) => {
  const f = fixture(t); await f.ready();
  const original = tool('one', 'gatherLogs', { count: 3 });
  const taskId = (await f.host.handle(original)).result.task.taskId;
  f.bots[0].emit('end', 'socketClosed'); await turn();
  assert.equal(f.host.status().connection.state, 'error');
  assert.equal(f.host.status().connection.error.retryable, true);
  const failed = (await f.host.handle(tool('query', 'getTask', { taskId }))).result.task;
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.retryable, true);
  assert.equal(f.bots.length, 1);
  await f.host.handle(message('reconnect', 'reconnect')); f.bots[1].emit('spawn'); await turn();
  f.bots[0].emit('spawn'); f.bots[0].emit('error', new Error('late')); f.bots[0].emit('end', 'late');
  f.engines[0].emit({ type: 'goal_done', taskId }); await turn();
  assert.equal(f.host.status().connection.state, 'ready'); assert.equal(f.calls.length, 1);
  assert.equal((await f.host.handle(original)).result.task.taskId, taskId);
  assert.equal(f.calls.length, 1);
  const newTask = await f.host.handle(tool('new', 'gatherLogs', { count: 1 }));
  assert.equal(newTask.ok, true); assert.notEqual(newTask.result.task.taskId, taskId);
});

test('old asynchronous world-ready callback cannot create a companion after reconnect', async (t) => {
  const f = fixture(t);
  await f.host.handle(message('connect', 'connect', { config }));
  let release; f.bots[0].waitForChunksToLoad = () => new Promise((resolve) => { release = resolve; });
  f.bots[0].emit('spawn');
  await f.host.handle(message('reconnect', 'reconnect'));
  f.bots[1].emit('spawn'); await turn(); release(); await turn();
  assert.equal(f.engines.length, 1); assert.equal(f.host.status().connection.state, 'ready');
});

test('failed teardown is explicitly nonretryable and cannot silently admit another engine', async (t) => {
  const f = fixture(t); await f.ready();
  f.engines[0].dispose = async () => { throw new Error('cleanup_probe'); };
  f.bots[0].emit('end', 'socketClosed'); await turn();
  assert.equal(f.host.status().connection.error.code, 'cleanup_failed');
  assert.equal(f.host.status().connection.error.retryable, false);
  const reconnect = await f.host.handle(message('again', 'reconnect'));
  assert.equal(reconnect.error.code, 'cleanup_failed'); assert.equal(reconnect.error.retryable, false);
  assert.equal(f.bots.length, 1); assert.equal(f.bots[0].quitCalls, 1);
  await assert.rejects(f.host.close(), { code: 'cleanup_failed' });
});

test('goal resource cleanup errors close the owned connection rather than report ready', async (t) => {
  const f = fixture(t); await f.ready();
  f.engines[0].emit({ type: 'goal_cleanup_error', reason: 'old movement hooks failed to restore' });
  await turn();
  assert.equal(f.host.status().connection.error.code, 'goal_cleanup_failed');
  assert.equal(f.host.status().connection.error.retryable, false);
  assert.equal(f.host.status().safetyActive, false); assert.equal(f.bots[0].quitCalls, 1);
});

test('connection timeout and initialization failure expose structured retryable outcomes', async (t) => {
  const timeout = fixture(t, { connectTimeoutMs: 5 });
  await timeout.host.handle(message('connect', 'connect', { config }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(timeout.host.status().connection.error.code, 'connect_timeout');
  assert.equal(timeout.host.status().connection.error.retryable, true);
  assert.equal(timeout.bots[0].quitCalls, 1);
  const failed = fixture(t, { createCompanion: () => { throw new Error('init failed'); } });
  await failed.host.handle(message('connect', 'connect', { config }));
  failed.bots[0].emit('spawn'); await turn();
  assert.equal(failed.host.status().connection.error.code, 'initialization_failed');
  assert.equal(failed.bots[0].quitCalls, 1);
});

test('a connecting-event observer may close the host without creating a bot', async (t) => {
  let f;
  f = fixture(t, { emit: (row) => { if (row.event?.state === 'connecting') void f.host.close(); } });
  const result = await f.host.handle(message('connect', 'connect', { config }));
  assert.equal(result.error.code, 'disposed'); assert.equal(f.bots.length, 0);
  assert.equal(f.host.status().connection.state, 'disposed');
});

test('dispatch exception fails accepted task instead of leaving it busy', async (t) => {
  const f = fixture(t); await f.ready();
  f.engines[0].submitTask = async () => { throw new TypeError('invalid material'); };
  const result = await f.host.handle(tool('bad', 'gatherMaterials', { chest: { x: 1, y: 64, z: 2 }, requirements: [{ key: 'log', count: 1 }] }));
  assert.equal(result.ok, false); assert.equal(result.task.status, 'failed'); assert.equal(f.host.status().task, null);
});

test('disconnect during awaited replacement cannot accept work into a dead connection', async (t) => {
  const f = fixture(t); await f.ready();
  await f.host.handle(tool('one', 'gatherLogs', { count: 3 }));
  let release; f.engines[0].cancelTask = () => new Promise((resolve) => { release = resolve; });
  const replacement = f.host.handle(tool('replace', 'gatherLogs', { count: 1 }, { replaceCurrent: true }));
  await turn(); f.bots[0].emit('end', 'socketClosed'); release();
  assert.equal((await replacement).error.code, 'not_ready');
  assert.equal(f.calls.length, 1);
  assert.equal(f.output.filter((row) => row.event?.task?.status === 'accepted').length, 1);
});

test('close while reconnect awaits cleanup cannot resurrect a connection', async (t) => {
  const f = fixture(t); await f.ready();
  let release; f.engines[0].dispose = () => new Promise((resolve) => { release = resolve; });
  const reconnect = f.host.handle(message('again', 'reconnect'));
  await turn(); const closing = f.host.close(); release();
  await closing;
  assert.equal((await reconnect).error.code, 'disposed');
  assert.equal(f.bots.length, 1); assert.equal(f.host.status().connection.state, 'disposed');
});

test('bounded history evicts completed receipts but pins the active task request', async (t) => {
  let now = 100;
  const f = fixture(t, { historyLimit: 3, historyTtlMs: 20, now: () => now }); await f.ready();
  const request = tool('active', 'gatherLogs', { count: 3 });
  const first = await f.host.handle(request); const taskId = first.result.task.taskId;
  for (let i = 0; i < 8; i += 1) await f.host.handle(tool(`status-${i}`, 'getStatus'));
  now += 100; assert.deepEqual(await f.host.handle(request), first); assert.equal(f.calls.length, 1);
  f.engines[0].emit({ type: 'goal_done', taskId }); now += 100;
  assert.equal((await f.host.handle(tool('expired', 'getTask', { taskId }))).error.code, 'task_not_found');
  assert.equal((await f.host.handle(request)).ok, true); assert.equal(f.calls.length, 2);
});

test('close is idempotent, blocks queued/new work and clears the connection timer', async (t) => {
  const f = fixture(t); await f.ready();
  await f.host.close(); await f.host.close();
  assert.equal(f.bots[0].quitCalls, 1); assert.equal(f.engines[0].disposed, true);
  assert.equal((await f.host.handle(message('late-connect', 'connect', { config }))).error.code, 'disposed');
  assert.equal(f.host.status().connection.state, 'disposed');
});

test('core JSONL is opt-in, advertises schemas, rejects invalid inputs, and shuts down cleanly', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [path.resolve(__dirname, '../index.js'), '--engine', 'core', '--data-dir', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify(tool('list', 'listTools'))}\n${JSON.stringify(tool('bad', 'gatherLogs', { count: 0 }))}\n`);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  const rows = stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows[0].engine, 'core'); assert.equal(rows[0].capabilities.taskLifecycle, true);
  assert.equal(rows.find((row) => row.id === 'bad').ok, false);
});

test('rejected JSONL shutdown cannot close the process or execute an id conflict', { timeout: 5000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-cli-reject-'));
  const child = spawn(process.execPath, [path.resolve(__dirname, '../index.js'), '--engine', 'core', '--data-dir', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  let stdout = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.resume();
  const waitReply = async (id, count = 1) => {
    for (let i = 0; i < 200; i++) {
      const rows = stdout.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
      const replies = rows.filter((row) => row.type === 'reply' && row.id === id);
      if (replies.length >= count) return replies.at(-1);
      assert.equal(child.exitCode, null, 'Rejected shutdown must leave the host alive');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`No reply for ${id}`);
  };
  const send = (row) => child.stdin.write(`${JSON.stringify(row)}\n`);
  send(tool('same', 'getStatus')); assert.equal((await waitReply('same')).ok, true);
  send(message('same', 'shutdown')); assert.equal((await waitReply('same', 2)).error.code, 'id_conflict');
  send({ version: 2, id: 'invalid', type: 'shutdown' }); assert.equal((await waitReply('invalid')).ok, false);
  send(null); assert.equal((await waitReply(undefined)).ok, false);
  send(tool('still-alive', 'getStatus')); assert.equal((await waitReply('still-alive')).ok, true);
  const exited = once(child, 'exit'); send(message('valid', 'shutdown'));
  assert.equal((await exited)[0], 0);
});

for (const mode of ['hang', 'reject']) test(`authorized JSONL shutdown exits nonzero when teardown ${mode}s`, { timeout: 10000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-cli-teardown-'));
  // Inject only the transport and companion; exercise the real host queue,
  // validation, shutdown authorization, CLI watchdog and process exit.
  const preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `
    const { EventEmitter } = require('node:events');
    const mod = require(${JSON.stringify(path.resolve(__dirname, '../core-host.js'))});
    const original = mod.createCoreHost;
    mod.createCoreHost = (options) => original({ ...options,
      createBot() {
        const bot = new EventEmitter();
        bot.waitForChunksToLoad = async () => {};
        bot.quit = () => {};
        setImmediate(() => bot.emit('spawn'));
        return bot;
      },
      createCompanion() { return {
        status: () => ({}),
        dispose: () => ${mode === 'hang' ? 'new Promise(() => {})' : "Promise.reject(new Error('injected teardown failure'))"},
      }; },
    });
  `);
  const child = spawn(process.execPath, ['--require', preload, path.resolve(__dirname, '../index.js'),
    '--engine', 'core', '--data-dir', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  let stdout = ''; let stderr = ''; let sent = false;
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!sent && stdout.split('\n').some((line) => {
      try { const row = JSON.parse(line); return row.event?.type === 'connection' && row.event.state === 'ready'; }
      catch { return false; }
    })) {
      sent = true;
      // Leave stdin open: this is explicit shutdown, not EOF cleanup.
      child.stdin.write(`${JSON.stringify(message('shutdown', 'shutdown'))}\n`);
    }
  });
  const exited = once(child, 'exit');
  child.stdin.write(`${JSON.stringify(message('connect', 'connect', { config }))}\n`);
  const [code, signal] = await exited;
  assert.equal(sent, true, stderr);
  assert.equal(signal, null, stderr);
  assert.equal(code, 1, stdout + stderr);
});
