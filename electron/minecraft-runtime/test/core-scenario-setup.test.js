'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { setupChunks, expectedOreCells, validateResponse, runSetup } = require('../tools/scenario-setup.cjs');
const { runOnce, mulberry32 } = require('../tools/run-scenarios.cjs');
const { SCENARIOS } = require('../scenarios/index.cjs');
const { createOutputBuffer } = require('../scenarios/serverOutput.cjs');

test('setup preloads every iron fixture chunk including the original unloaded eastern veins', () => {
  const scenario = SCENARIOS['branch-mine-iron-flat'];
  const setup = scenario.setup({ username: 'Test', run: 0, rng: mulberry32(101), difficulty: 'peaceful' });
  const chunks = setupChunks(setup.commands);
  const cells = expectedOreCells(setup.commands, scenario.serverProperties);
  assert.equal(setup.commands.filter((c) => /iron_ore$/.test(c)).length, 40);
  assert.ok(cells.length > 280, `expected complete veins, got ${cells.length} cells`);
  assert.ok(cells.some((p) => p.x > 96));
  for (const p of cells) assert.ok(chunks.some((c) => c.x === Math.floor(p.x / 16) && c.z === Math.floor(p.z / 16)));
});

test('final fixture map preserves ore overlap, replace filters and later overwrites', () => {
  const properties = { 'generator-settings': JSON.stringify({ layers: [{ block: 'minecraft:deepslate', height: 128 }] }) };
  const cells = expectedOreCells(['fill 0 0 0 1 0 1 deepslate_redstone_ore replace deepslate',
    'fill 0 0 0 1 0 1 deepslate_diamond_ore replace deepslate', 'setblock 1 0 1 lava'], properties);
  assert.equal(cells.length, 3); assert.ok(cells.every((p) => p.block === 'deepslate_redstone_ore'));
});

test('setup refuses explicit errors, unknown feedback and missing targets even with a list barrier', () => {
  assert.doesNotThrow(() => validateResponse('advancement revoke Test only minecraft_companion:fishing_catch',
    "Couldn't revoke advancement minecraft_companion:fishing_catch from Test as they don't have it"));
  for (const response of ['That position is not loaded\nThere are 1 players online',
    'Unknown or incomplete command', 'Too many blocks in the specified area', 'There are 1 players online']) {
    assert.throws(() => validateResponse('fill 0 0 0 1 1 1 iron_ore', response));
  }
  assert.throws(() => validateResponse('tp Test 0 64 0', 'No entity was found'));
  for (const response of ['Successfully filled 8 block(s)', 'No blocks were filled']) {
    assert.doesNotThrow(() => validateResponse('fill 0 0 0 1 1 1 iron_ore', response));
  }
  assert.doesNotThrow(() => validateResponse('kill @e[type=item]', 'No entity was found'));
});

function fakeServer({ unloaded = false, corruptOre = false } = {}) {
  const commands = [];
  return { commands,
    async execute(command) {
      commands.push(command);
      if (command.includes('forceload')) return 'Marked chunk [0, 0] to be force loaded';
      if (command.startsWith('gamemode')) return 'There are 1 players online';
      return unloaded ? 'That position is not loaded' : 'Successfully filled 8 block(s)';
    },
    async query(command, pattern) {
      commands.push(command);
      return (command.includes('playerGameType') ? 'Test has the following entity data: 0'
        : command.includes('if block') && corruptOre ? 'Test failed' : 'Test passed').match(pattern);
    } };
}

test('checked setup retains every response and independently rejects corrupt ore readback', async () => {
  const setup = { commands: ['gamemode survival Test', 'fill 0 0 0 1 1 1 iron_ore'] };
  const events = []; const server = fakeServer();
  const result = await runSetup({ server, setup, properties: {}, write: (type, data) => events.push({ type, ...data }) });
  assert.equal(result.distribution.iron_ore, 8);
  assert.equal(events.filter((e) => e.type === 'setup_command').length, 2);
  assert.ok(server.commands[0].includes('forceload add'));
  await assert.rejects(runSetup({ server: fakeServer({ unloaded: true }), setup, properties: {} }), /setup_command_failed/);
  await assert.rejects(runSetup({ server: fakeServer({ corruptOre: true }), setup, properties: {} }), /setup_ore_readback_failed/);
});

test('server absolute output offsets remain usable when a long run truncates its log buffer', () => {
  const output = createOutputBuffer({ limit: 100, retained: 40 });
  output.append('old Test failed\n' + 'x'.repeat(70));
  const start = output.offset();
  output.append('y'.repeat(30) + '\nTest passed\n');
  assert.ok(output.offset() > 100);
  assert.match(output.textFrom(start), /Test passed/);
  assert.doesNotMatch(output.textFrom(start), /Test failed/);
  const next = output.offset(); output.append('Test failed\n');
  assert.equal(output.textFrom(next), 'Test failed\n');
});

test('setup failure closes its JSONL and removes packet listeners without starting a companion', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-setup-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new EventEmitter();
  const result = await runOnce({ scenario: { setup: () => ({ commands: ['fill 0 0 0 1 1 1 iron_ore'] }), serverProperties: {} },
    server: fakeServer({ unloaded: true }), bot: { _client: client }, username: 'Test', run: 0, seed: 1,
    difficulty: 'peaceful', runDir: dir, lifecycle: 'fresh', traceInventory: false });
  assert.equal(result.pass, false); assert.match(result.reason, /setup_command_failed/);
  assert.equal(client.eventNames().length, 0);
  assert.ok(fs.readFileSync(path.join(dir, 'run-01.jsonl'), 'utf8').includes('"type":"setup"'));
});

function runtimeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bot = new EventEmitter();
  Object.assign(bot, { _client: new EventEmitter(), waitForChunksToLoad: async () => {},
    health: 20, inventory: { items: () => [], slots: [] } });
  const input = { bot, runDir: dir, username: 'Test', run: 0, seed: 1, difficulty: 'peaceful',
    lifecycle: 'fresh', traceInventory: false, settleMs: 0, hookIntervalMs: 5,
    server: { execute: async () => {}, query: async () => [] } };
  return { dir, bot, input };
}

test('timeout joins an in-flight hook before disposing or verifying and exposes the aborted signal', async (t) => {
  const { input } = runtimeFixture(t); const order = [];
  const result = await runOnce({ ...input, companionFactory: () => ({ dispose: async () => order.push('dispose') }),
    scenario: { setup: () => ({ commands: [] }), timeoutMs: 20, start: async () => ({}),
      async onTick({ signal }) { order.push('hook_start'); await sleep(40); assert.equal(signal.aborted, true); order.push('hook_end'); },
      async verify() { order.push('verify'); return { pass: true }; } } });
  assert.deepEqual(order, ['hook_start', 'hook_end', 'dispose', 'verify']);
  assert.equal(result.pass, false); assert.equal(result.timedOut, true); assert.equal(result.serverPass, true);
});

test('cleanup continues after dispose errors and emits the final failing result after all cleanup', async (t) => {
  const { input, dir, bot } = runtimeFixture(t); let released = false;
  const result = await runOnce({ ...input, companionFactory: () => ({ async dispose() { throw new Error('dispose failed'); } }),
    scenario: { setup: () => ({ commands: [] }), timeoutMs: 5, start: async () => ({}),
      dispose: () => { released = true; }, verify: async () => ({ pass: true }) } });
  assert.equal(result.pass, false); assert.equal(released, true);
  assert.ok(result.harnessFailures.some((s) => s.includes('cleanup:dispose failed')));
  const events = fs.readFileSync(path.join(dir, 'run-01.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'result'); assert.equal(events.at(-1).pass, false);
  assert.equal(bot.listenerCount('death'), 0);
});

test('an error path waits for pending inventory readback before closing its event file', async (t) => {
  const { input, dir } = runtimeFixture(t);
  input.server.query = async () => { await sleep(30); return ['has the following entity data: []']; };
  let emit;
  const result = await runOnce({ ...input, traceInventory: true,
    companionFactory: ({ onEvent }) => { emit = onEvent; return { dispose: async () => {} }; },
    scenario: { setup: () => ({ commands: [] }), start: async () => { emit({ type: 'diagnostic', reason: 'missing_ingredients' }); throw new Error('start failed'); } } });
  assert.equal(result.pass, false);
  const events = fs.readFileSync(path.join(dir, 'run-01.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.find((event) => event.type === 'server_inventory'));
  assert.equal(events.at(-1).type, 'result');
});

function eventsAt(dir, run = 1) {
  return fs.readFileSync(path.join(dir, `run-${String(run).padStart(2, '0')}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
}

test('pre-aborted run writes an interrupted terminal result without setup, companion or verification', async (t) => {
  const { input, dir } = runtimeFixture(t); const abort = new AbortController(); abort.abort('SIGINT');
  const forbidden = () => assert.fail('work started after interruption');
  const result = await runOnce({ ...input, signal: abort.signal, companionFactory: forbidden,
    scenario: { setup: forbidden, start: forbidden, verify: forbidden } });
  assert.equal(result.pass, false); assert.equal(result.interrupted, true); assert.equal(result.reason, 'interrupted:SIGINT');
  assert.equal(eventsAt(dir).at(-1).reason, result.reason);
});

test('interrupted setup drains its current command and starts no later setup command', async (t) => {
  const { input } = runtimeFixture(t); const abort = new AbortController(); const commands = [];
  input.server.execute = async (command) => { commands.push(command); abort.abort('SIGTERM'); await sleep(5); return 'Set the time to 0'; };
  const result = await runOnce({ ...input, signal: abort.signal,
    companionFactory: () => assert.fail('companion started after setup interruption'),
    scenario: { setup: () => ({ commands: ['time set 0', 'time set 1'] }), verify: () => assert.fail('verify after interruption') } });
  assert.deepEqual(commands, ['time set 0']); assert.equal(result.reason, 'interrupted:SIGTERM');
});

test('external interruption joins hooks and inventory readback before disposal and rejects later commands', async (t) => {
  const { input, dir } = runtimeFixture(t); const abort = new AbortController(); const order = []; let emit, calls = 0;
  input.server.command = () => assert.fail('late command reached real server');
  input.server.query = async () => { order.push('readback_start'); await sleep(25); order.push('readback_end'); return ['has the following entity data: []']; };
  const result = await runOnce({ ...input, signal: abort.signal, traceInventory: true,
    companionFactory: ({ onEvent }) => { emit = onEvent; return { dispose: async () => order.push('dispose') }; },
    scenario: { autonomous: true, setup: () => ({ commands: [] }), timeoutMs: 300000,
      start: async () => { emit({ type: 'diagnostic', reason: 'missing_ingredients' }); return {}; },
      async during() { calls += 1; order.push('during_start'); await sleep(20); order.push('during_end'); },
      async onTick({ signal, server }) {
        order.push('hook_start'); abort.abort('SIGINT'); await sleep(35);
        assert.equal(signal.aborted, true); assert.throws(() => server.command('late'), /SIGINT/); order.push('hook_end');
      }, verify: () => assert.fail('interrupted run must not start verify') } });
  assert.equal(result.reason, 'interrupted:SIGINT'); assert.equal(calls, 1, 'queued hooks are not started after interruption');
  for (const end of ['during_end', 'hook_end', 'readback_end']) assert.ok(order.indexOf(end) < order.indexOf('dispose'), order.join(','));
  assert.equal(eventsAt(dir).at(-1).type, 'result'); assert.equal(eventsAt(dir).at(-1).interrupted, true);
});

test('a verifier already in flight cannot turn a later interruption into PASS', async (t) => {
  const { input, dir } = runtimeFixture(t); const abort = new AbortController(); let emit;
  const result = await runOnce({ ...input, signal: abort.signal,
    companionFactory: ({ onEvent }) => { emit = onEvent; return { dispose: async () => {} }; },
    scenario: { setup: () => ({ commands: [] }), timeoutMs: 300000,
      start: async () => { emit({ type: 'goal_done' }); return {}; },
      verify: async () => { abort.abort('SIGTERM'); await sleep(5); return { pass: true, details: { pass: true, interrupted: false } }; } } });
  assert.equal(result.pass, false); assert.equal(result.serverPass, true); assert.equal(result.reason, 'interrupted:SIGTERM');
  assert.equal(result.interrupted, true); assert.equal(eventsAt(dir).at(-1).pass, false);
});

const { PassThrough } = require('node:stream');
const { startVanillaServer } = require('../scenarios/vanillaServer.cjs');
function serverProcess(t, { responds = true, ready = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-server-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const commands = [], kills = [];
  const close = (code = 0, signal = null) => {
    child.emit('exit', code, signal); child.stdout.end(); child.stderr.end(); child.emit('close', code, signal);
  };
  child.stdin.on('data', (chunk) => {
    commands.push(chunk.toString().trim());
    if (responds) setTimeout(() => { child.stdout.write('Stopping server\nAll dimensions are saved\n'); close(); }, 2);
  });
  child.kill = (signal) => { kills.push(signal); close(null, signal); return true; };
  const options = { java: 'fake-java', jar: 'fake.jar', dir, reservePort: async () => 25566,
    spawnProcess: () => { if (ready) queueMicrotask(() => child.stdout.write('Done (1.23s)! For help\n')); return child; },
    startupTimeoutMs: 100, stopTimeoutMs: 15, killTimeoutMs: 15 };
  return { child, close, commands, kills, dir, options };
}

test('console stop is idempotent and awaits Java close and the final saved log', async (t) => {
  const f = serverProcess(t); const server = await startVanillaServer(f.options);
  const first = server.stop(); assert.equal(server.stop(), first);
  const receipt = await first;
  assert.deepEqual(f.commands, ['stop']); assert.deepEqual(f.kills, []);
  assert.equal(receipt.closed, true); assert.equal(receipt.logClosed, true); assert.equal(receipt.saveObserved, true);
  assert.match(fs.readFileSync(path.join(f.dir, 'server.log'), 'utf8'), /All dimensions are saved/);
});

test('forced server termination is an explicit cleanup failure even if the process closes', async (t) => {
  const f = serverProcess(t, { responds: false }); const server = await startVanillaServer(f.options);
  await assert.rejects(server.stop(), (error) => {
    assert.equal(error.cleanup.forced, true); assert.equal(error.cleanup.logClosed, true);
    assert.equal(error.cleanup.signal, 'SIGKILL'); assert.ok(error.cleanup.failures.includes('console_stop_timeout')); return true;
  });
  assert.deepEqual(f.commands, ['stop']); assert.deepEqual(f.kills, ['SIGKILL']);
});

test('startup interruption still uses console stop and joins the server before rejecting', async (t) => {
  const f = serverProcess(t, { ready: false }); const abort = new AbortController();
  const starting = startVanillaServer({ ...f.options, signal: abort.signal });
  setTimeout(() => abort.abort('SIGTERM'), 5);
  await assert.rejects(starting, /SIGTERM/);
  assert.deepEqual(f.commands, ['stop']); assert.deepEqual(f.kills, []);
  assert.match(fs.readFileSync(path.join(f.dir, 'server.log'), 'utf8'), /All dimensions are saved/);
});

test('pre-aborted server startup spawns nothing and an unexpected prior exit fails cleanup', async (t) => {
  const abort = new AbortController(); abort.abort('SIGINT'); const f = serverProcess(t);
  await assert.rejects(startVanillaServer({ ...f.options, signal: abort.signal,
    spawnProcess: () => assert.fail('pre-aborted startup spawned Java') }), /SIGINT/);
  const server = await startVanillaServer(f.options); f.close(7);
  await assert.rejects(server.stop(), /server_exited_before_stop.*server_exit:7/);
});

test('server cleanup waits past exit for late stdout and close before closing its log', async (t) => {
  const f = serverProcess(t, { responds: false }); const server = await startVanillaServer({ ...f.options, stopTimeoutMs: 100 });
  f.child.stdin.removeAllListeners('data');
  f.child.stdin.on('data', () => {
    setTimeout(() => f.child.emit('exit', 0, null), 2);
    setTimeout(() => { f.child.stdout.write('All dimensions are saved\n'); f.child.stdout.end(); f.child.stderr.end(); f.child.emit('close', 0, null); }, 12);
  });
  let settled = false;
  const stopping = server.stop().then((value) => { settled = true; return value; });
  await sleep(5); assert.equal(settled, false, 'exit alone does not close output streams');
  const receipt = await stopping; assert.equal(receipt.saveObserved, true); assert.equal(receipt.logClosed, true);
});

test('failed Java spawn still closes its log and exposes startup cleanup failure', async (t) => {
  const f = serverProcess(t, { ready: false });
  await assert.rejects(startVanillaServer({ ...f.options, spawnProcess: () => {
    queueMicrotask(() => { f.child.emit('error', new Error('spawn ENOENT')); f.close(-2); }); return f.child;
  } }), (error) => {
    assert.match(error.message, /ENOENT/); assert.equal(error.cleanup.closed, true); assert.equal(error.cleanup.logClosed, true);
    assert.ok(error.cleanup.failures.some((reason) => reason.includes('spawn:'))); return true;
  });
});

test('console exit0 without the fixed-version final save acknowledgement fails cleanup', async (t) => {
  const f = serverProcess(t, { responds: false }); const server = await startVanillaServer(f.options);
  f.child.stdin.removeAllListeners('data');
  f.child.stdin.on('data', () => { f.child.stdout.write('Stopping server\nAll chunks are saved\n'); f.close(); });
  await assert.rejects(server.stop(), (error) => {
    assert.equal(error.cleanup.code, 0); assert.equal(error.cleanup.saveObserved, false);
    assert.ok(error.cleanup.failures.includes('final_save_unconfirmed')); return true;
  });
});

test('external interruption quiesces permanent brain ticks while hooks drain before full disposal', async (t) => {
  const { createBrain } = require('../core/brain');
  const { input } = runtimeFixture(t); const abort = new AbortController(); const order = []; let started = 0, atAbort;
  const brain = createBrain({ perceive: () => ({ alive: true }), behaviors: [{ name: 'permanent', band: 100, want: () => 1,
    async run({ signal }) { started += 1; await sleep(2, null, { signal }); return { ok: true }; } }] });
  const ticker = setInterval(() => brain.tick(), 1); t.after(async () => { clearInterval(ticker); await brain.dispose(); });
  const result = await runOnce({ ...input, signal: abort.signal,
    companionFactory: () => ({ brain, director: { disable() { order.push('director_disabled'); } },
      async dispose() { order.push('full_dispose'); clearInterval(ticker); await brain.dispose(); } }),
    scenario: { autonomous: true, setup: () => ({ commands: [] }), timeoutMs: 300000, start: async () => ({}),
      async onTick() { atAbort = started; abort.abort('SIGINT'); order.push('abort'); await sleep(25);
        assert.equal(started, atAbort, 'permanent survival cannot restart while an in-flight hook drains'); order.push('hook_end'); },
      verify: () => assert.fail('verify started after interruption') } });
  assert.ok(atAbort > 0); assert.equal(result.interrupted, true);
  assert.ok(order.indexOf('director_disabled') < order.indexOf('hook_end'));
  assert.ok(order.indexOf('hook_end') < order.indexOf('full_dispose'));
});

test('abort during companion registration quiesces the returned brain before starting scenario work', async (t) => {
  const { input } = runtimeFixture(t); const abort = new AbortController(); const order = [];
  const result = await runOnce({ ...input, signal: abort.signal,
    companionFactory: () => { abort.abort('SIGINT'); return { director: { disable() { order.push('director'); } },
      brain: { dispose() { order.push('brain'); } }, dispose() { order.push('full'); } }; },
    scenario: { setup: () => ({ commands: [] }), start: () => assert.fail('start after interrupted registration') } });
  assert.equal(result.interrupted, true); assert.deepEqual(order, ['director', 'brain', 'full']);
});

test('a rejected finishWhen still drains delayed inventory readback before terminal JSONL closes', async (t) => {
  const { input, dir } = runtimeFixture(t); const order = []; let emit;
  input.server.query = async () => { order.push('readback_start'); await sleep(80); order.push('readback_end'); return ['has the following entity data: []']; };
  const result = await runOnce({ ...input, traceInventory: true,
    companionFactory: ({ onEvent }) => { emit = onEvent; return { dispose: async () => order.push('dispose') }; },
    scenario: { setup: () => ({ commands: [] }), timeoutMs: 300000,
      start: async () => { emit({ type: 'diagnostic', reason: 'missing_ingredients' }); return {}; },
      finishWhen: async () => { throw new Error('finishWhen readback failed'); },
      verify: () => assert.fail('verify after rejected finishWhen') } });
  order.push('returned');
  assert.equal(result.pass, false); assert.match(result.reason, /finishWhen readback failed/);
  assert.deepEqual(order, ['readback_start', 'readback_end', 'dispose', 'returned']);
  const events = eventsAt(dir);
  assert.ok(events.some((event) => event.type === 'server_inventory'));
  assert.equal(events.at(-1).type, 'result');
});

async function queryProcess(t) {
  const f = serverProcess(t, { responds: false });
  f.child.stdin.removeAllListeners('data');
  f.child.stdin.on('data', (chunk) => {
    const command = chunk.toString().trim(); f.commands.push(command);
    if (command === 'stop') {
      f.child.stdout.write('Stopping server\nAll dimensions are saved\n'); f.close();
    }
  });
  const server = await startVanillaServer({ ...f.options, stopTimeoutMs: 100 });
  t.after(() => server.stop());
  return { ...f, server, reply: (text) => f.child.stdout.write(`${text}\n`) };
}
const queryTurn = () => new Promise((resolve) => setImmediate(resolve));

test('queued read abort or elapsed deadline skips dispatch without canceling another command', async (t) => {
  const f = await queryProcess(t);
  const first = f.server.query('first', /MATCH (\d+)/, 200);
  await queryTurn();
  const abort = new AbortController();
  const pending = f.server.query('canceled', /MATCH (\d+)/, 200, { signal: abort.signal, deadline: Date.now() + 100 });
  abort.abort('owned read canceled'); await assert.rejects(pending, /owned read canceled/);
  await assert.rejects(f.server.query('expired', /MATCH/, 200, { deadline: Date.now() - 1 }), /deadline/);
  assert.deepEqual(f.commands, ['first']);
  f.reply('MATCH 1'); assert.equal((await first)[1], '1'); await queryTurn();
  assert.deepEqual(f.commands, ['first']);
});

test('in-flight caller abort retains drain ownership so a late identical reply cannot satisfy next query', async (t) => {
  const f = await queryProcess(t); const abort = new AbortController();
  const first = f.server.query('first', /MATCH (\d+)/, 200, { signal: abort.signal });
  await queryTurn(); abort.abort('caller canceled'); await assert.rejects(first, /caller canceled/);
  let settled = false;
  const second = f.server.query('second', /MATCH (\d+)/, 200).then((value) => { settled = true; return value; });
  await queryTurn(); assert.deepEqual(f.commands, ['first']);
  f.reply('MATCH 1'); await queryTurn();
  assert.deepEqual(f.commands, ['first', 'second']); assert.equal(settled, false);
  f.reply('MATCH 2'); assert.equal((await second)[1], '2');
});

test('caller deadline includes queue and response time but does not poison a successfully drained channel', async (t) => {
  const f = await queryProcess(t);
  const first = f.server.query('first', /MATCH (\d+)/, 200, { deadline: Date.now() + 10 });
  await assert.rejects(first, /deadline/);
  const second = f.server.query('second', /MATCH (\d+)/, 200);
  await queryTurn(); assert.deepEqual(f.commands, ['first']);
  f.reply('MATCH 1'); await queryTurn(); f.reply('MATCH 2');
  assert.equal((await second)[1], '2');
});

test('underlying reply timeout poisons pending and future queries and execute but leaves stop independent', async (t) => {
  const f = await queryProcess(t);
  const first = f.server.query('first', /MATCH (\d+)/, 10);
  const second = f.server.query('second', /MATCH (\d+)/, 200);
  const rejected = Promise.all([assert.rejects(first, /Timed out/), assert.rejects(second, /desynchronized/)]);
  await rejected; f.reply('MATCH 1');
  await assert.rejects(f.server.query('third', /MATCH/), /desynchronized/);
  await assert.rejects(f.server.execute('must not execute'), /desynchronized/);
  assert.deepEqual(f.commands, ['first']);
  const receipt = await f.server.stop(); assert.equal(receipt.saveObserved, true);
  assert.deepEqual(f.commands, ['first', 'stop']);
});

test('execute internal barrier timeout also poisons the query channel', async (t) => {
  const f = await queryProcess(t);
  await assert.rejects(f.server.execute('setup command', 10), /Timed out/);
  await assert.rejects(f.server.query('later read', /anything/), /desynchronized/);
  assert.deepEqual(f.commands, ['setup command', 'list']);
});
