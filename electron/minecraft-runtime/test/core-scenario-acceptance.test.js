'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { nightBedFlat, nightBunkerFlat, verifyHomestead } = require('../scenarios/homestead.cjs');
const { createStarterHouse } = require('../core/blueprints/starterHouse');
const { scenarioResult, scenarioExitCode } = require('../tools/scenario-result.cjs');
const { installFurnitureEvidence } = require('../scenarios/furnitureEvidence.cjs');

function nightContext({ day = 1, daytime = 2000, health = 20, y = 64, slept = 1, deaths = 0, bunkerConfirmed = true } = {}) {
  return { username: 'Test', deaths, bot: { health, entity: { position: { y } } }, goal: { memory: { verified: { bed: true } } },
    state: { night: { initial: { day: 0, daytime: 11400 }, sawNight: true, bunkerConfirmed } },
    server: { async query(command, pattern) {
      const text = command === 'time query day' ? `The time is ${day}`
        : command === 'time query daytime' ? `The time is ${daytime}`
          : command.endsWith(' Health') ? `Test has the following entity data: ${health}f`
            : command.endsWith(' Pos') ? `Test has the following entity data: [0.5d, ${y}.0d, 0.5d]`
              : `Test has ${slept} [mcNightSleep]`;
      const match = text.match(pattern); assert.ok(match, `${command}: ${text}`); return match;
    } } };
}

test('night verifier rejects the original dusk/underground/no-server false positive', async () => {
  for (const scenario of [nightBedFlat, nightBunkerFlat]) {
    const verdict = await scenario.verify({ bot: { time: { timeOfDay: 11400 }, health: 20,
      entity: { position: { y: 50 } } }, deaths: 0, goal: { memory: {} } });
    assert.equal(verdict.pass, false);
  }
});

test('night requires a new server day, daylight, surface, life and no death', async () => {
  for (const options of [{ day: 0 }, { daytime: 11400 }, { y: 50 }, { health: 0 }, { deaths: 1 }, { slept: 0 }]) {
    assert.equal((await nightBedFlat.verify(nightContext(options))).pass, false, JSON.stringify(options));
  }
  assert.equal((await nightBedFlat.verify(nightContext())).pass, true);
  assert.equal((await nightBunkerFlat.verify(nightContext({ slept: 0 }))).pass, true);
  assert.equal((await nightBunkerFlat.verify(nightContext({ bunkerConfirmed: false }))).pass, false);
});

test('night does not finish because morning-like client time repeats on its starting day', () => {
  const ctx = nightContext();
  ctx.state.night.latest = { day: 0, daytime: 2000 };
  assert.equal(nightBedFlat.finishWhen(ctx), false);
  ctx.state.night.latest.day = 1;
  assert.equal(nightBedFlat.finishWhen(ctx), true);
});

test('serverPass cannot erase timeout, terminal brain failure, hook failure or override result fields', () => {
  const base = { run: 1, verdict: { pass: true, details: { pass: true, timedOut: false, reason: null } },
    durationMs: 10, deaths: 0, timedOut: false };
  for (const extra of [{ timedOut: true }, { outcome: { type: 'goal_failed', reasons: ['blocked'] } },
    { outcome: { type: 'stopped', reason: 'cancelled' } }, { harnessFailures: ['readback unavailable'] }]) {
    const result = scenarioResult({ ...base, ...extra });
    assert.equal(result.pass, false); assert.equal(result.serverPass, true); assert.ok(result.reason);
  }
  const timed = scenarioResult({ ...base, timedOut: true });
  assert.equal(timed.timedOut, true); assert.equal(timed.reason, 'timeout');
});

test('autonomous earlier failed attempts remain visible while a final successful retry may pass', () => {
  const history = [{ type: 'goal_failed', reasons: ['blocked'] }, { type: 'goal_set' }, { type: 'goal_done' }];
  const result = scenarioResult({ run: 1, verdict: { pass: true }, timedOut: false, durationMs: 1, deaths: 0,
    outcome: history[2], goalEvents: history });
  assert.equal(result.pass, true); assert.deepEqual(result.goalEvents, history);
  assert.equal(scenarioExitCode([{ runs: 2, passed: 1 }]), 1);
  assert.equal(scenarioExitCode([{ runs: 1, passed: 1 }, { runs: 1, passed: 0 }]), 1);
  assert.equal(scenarioExitCode([{ runs: 2, passed: 2 }]), 0);
});

test('furniture usage requires server interaction statistics rather than forged goal flags', async () => {
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  let interactions = 0;
  const server = { async query(command, pattern) {
    const text = command.startsWith('forceload') ? 'Marked chunk [0, 0] to be force loaded'
      : command.startsWith('execute if block') ? 'Test passed'
        : command.startsWith('scoreboard') ? `Test has ${interactions} [mcUseTable]`
          : command.startsWith('clear ') ? 'Found 1 matching item on player Test'
            : command.includes('respawn.pos') ? `Test has the following entity data: [I; ${house.furniture.bed.position.x}, 64, ${house.furniture.bed.position.z}]`
              : 'Chest has the following block data: [{count: 1, id: "minecraft:dirt"}]';
    const match = text.match(pattern); assert.ok(match, `${command}: ${text}`); return match;
  } };
  const context = { server, username: 'Test', goal: { memory: { house, verified: { crafting_table: true, furnace: true } } } };
  assert.equal((await verifyHomestead(context)).pass, false);
  interactions = 1;
  assert.equal((await verifyHomestead(context)).pass, false, 'global early workstation interactions do not prove house furniture use');
  context.state = { furnitureEvidence: { verify: async () => ({ tableUsed: true, furnaceUsed: true }) } };
  assert.equal((await verifyHomestead(context)).pass, true);
});

test('furniture proof binds native table and furnace use to their actual server block coordinates', async () => {
  const counts = { table: 0, furnace: 0 };
  const table = { position: { x: 1, y: 64, z: 1 } }, furnace = { position: { x: 2, y: 64, z: 1 } };
  const bot = { craft(_recipe, _count, block) { assert.equal(this, bot); if (block) counts.table += 1; return Promise.resolve('crafted'); },
    openFurnace() { assert.equal(this, bot); counts.furnace += 1; return Promise.resolve('opened'); } };
  const native = bot.craft;
  const server = { async query(command, pattern) {
    return (command.startsWith('scoreboard') ? `Test has ${command.endsWith('mcUseTable') ? counts.table : counts.furnace} [score]`
      : 'Test passed').match(pattern);
  } };
  const ledger = await installFurnitureEvidence({ bot, server, username: 'Test' });
  assert.equal(await bot.craft({}, 1, table), 'crafted');
  assert.equal(await bot.openFurnace(furnace), 'opened');
  const furniture = { crafting_table: table, furnace };
  assert.equal((await ledger.verify(furniture)).tableUsed, true);
  assert.equal((await ledger.verify(furniture)).furnaceUsed, true);
  assert.equal((await ledger.verify({ ...furniture, crafting_table: { position: { x: 9, y: 64, z: 9 } } })).tableUsed, false);
  await ledger.dispose(); assert.equal(bot.craft, native);
});

test('furniture disposal does not wait for a native window operation abandoned before its window opened', async () => {
  let complete;
  const bot = { openFurnace() { return new Promise((resolve) => { complete = resolve; }); } };
  const events = [];
  const server = { async query(command, pattern) { return 'Test has 0 [score]'.match(pattern); } };
  const ledger = await installFurnitureEvidence({ bot, server, username: 'Test', write: (...args) => events.push(args) });
  const operation = bot.openFurnace({ position: { x: 1, y: 64, z: 1 } });
  await ledger.dispose(); complete('native later');
  assert.equal(await operation, 'native later'); assert.deepEqual(events, []);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { main } = require('../tools/run-scenarios.cjs');
function cliFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-cli-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jar = path.join(dir, 'fake.jar'); fs.writeFileSync(jar, 'test fixture');
  const target = new EventEmitter(), order = [];
  const bot = Object.assign(new EventEmitter(), { quit() {} });
  const options = { argv: ['--accept-eula', '--installation', dir, '--server-jar', jar,
    '--scenario', 'one,two', '--runs', '3', '--batch', 'controlled'], processTarget: target,
    scenarios: { one: { description: 'first' }, two: { description: 'must not start' } },
    startServer: async () => { order.push('start'); return { port: 25565, stop: async () => { order.push('stop'); return { closed: true, logClosed: true, forced: false }; } }; },
    connect: async () => { order.push('connect'); return bot; },
    disconnect: async (value) => { if (value) order.push('disconnect'); },
    runScenario: async ({ run }) => { order.push('run'); return { run: run + 1, pass: true, serverPass: true, durationMs: 1, deaths: 0 }; } };
  const report = () => JSON.parse(fs.readFileSync(path.join(dir, 'scenario-runs/controlled/one/summary.json'), 'utf8'));
  const events = () => fs.readFileSync(path.join(dir, 'scenario-runs/controlled/one/run-01.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { dir, target, order, options, report, events };
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) test(`CLI ${signal} joins cleanup, keeps first signal and starts no next round or scenario`, async (t) => {
  const f = cliFixture(t);
  f.options.runScenario = async ({ signal: active }) => {
    f.order.push('run'); f.target.emit(signal); f.target.emit(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
    assert.equal(active.aborted, true); assert.equal(active.reason, signal);
    return { run: 1, pass: false, reason: `interrupted:${signal}`, interrupted: true, serverPass: true, durationMs: 1, deaths: 0 };
  };
  const result = await main(f.options);
  assert.equal(result.exitCode, code); assert.equal(f.target.exitCode, code);
  assert.deepEqual(f.order, ['start', 'connect', 'run', 'disconnect', 'stop']);
  assert.equal(f.report().summary.runs, 1); assert.equal(f.report().summary.passed, 0);
  assert.equal(f.report().results[0].reason, `interrupted:${signal}`);
  assert.equal(f.events().at(-1).pass, false); assert.equal(f.events().at(-1).interrupted, true);
  assert.equal(f.target.listenerCount('SIGINT'), 0); assert.equal(f.target.listenerCount('SIGTERM'), 0);
});

test('CLI startup interruption writes closed summary and never connects a bot', async (t) => {
  const f = cliFixture(t);
  f.options.startServer = async ({ signal }) => {
    f.order.push('start'); f.target.emit('SIGINT'); assert.equal(signal.aborted, true);
    throw Object.assign(new Error('startup interrupted'), { cleanup: { closed: true, logClosed: true, forced: false, failures: [] } });
  };
  const result = await main(f.options);
  assert.equal(result.exitCode, 130); assert.deepEqual(f.order, ['start']);
  assert.equal(f.report().results[0].interrupted, true); assert.equal(f.report().cleanup.server.closed, true);
  assert.equal(f.events().at(-1).reason, 'interrupted:SIGINT');
});

test('CLI pre-abort installs no server and removes its signal listeners', async (t) => {
  const f = cliFixture(t); const abort = new AbortController(); abort.abort('SIGTERM');
  const result = await main({ ...f.options, signal: abort.signal });
  assert.equal(result.exitCode, 143); assert.deepEqual(f.order, []); assert.deepEqual(result.summaries, []);
  assert.deepEqual(f.target.eventNames(), []);
});

test('CLI cleanup failure preserves completed round evidence but fails the batch and starts no next scenario', async (t) => {
  const f = cliFixture(t); f.options.argv[f.options.argv.indexOf('--runs') + 1] = '1';
  f.options.startServer = async () => ({ port: 25565, stop: async () => {
    f.order.push('stop'); throw Object.assign(new Error('server_cleanup_failed:console_stop_timeout'),
      { cleanup: { forced: true, closed: true, logClosed: true, failures: ['console_stop_timeout'] } });
  } });
  const result = await main(f.options);
  assert.equal(result.exitCode, 1); assert.equal(result.reports.length, 1);
  assert.equal(f.report().summary.passed, 1); assert.equal(f.report().results[0].pass, true); assert.equal(f.report().results[0].serverPass, true);
  assert.equal(f.report().cleanup.pass, false); assert.equal(f.report().cleanup.server.forced, true);
  assert.equal(f.events().at(-1).pass, true); assert.equal(f.report().batchFailures.length, 1);
  assert.match(f.report().batchFailures[0], /console_stop_timeout/);
});

test('a signal during cleanup preserves an already completed round and still interrupts the batch', async (t) => {
  const f = cliFixture(t); f.options.argv[f.options.argv.indexOf('--runs') + 1] = '1';
  f.options.startServer = async () => ({ port: 25565, stop: async () => { f.target.emit('SIGTERM'); return { closed: true, logClosed: true }; } });
  const result = await main(f.options);
  assert.equal(result.exitCode, 143); assert.equal(f.report().results[0].pass, true);
  assert.equal(f.report().results[0].interrupted, undefined); assert.equal(f.report().interrupted, true);
  assert.equal(f.events().at(-1).pass, true); assert.equal(result.reports.length, 1);
});

test('post-round cleanup failure leaves the existing terminal JSONL byte-for-byte unchanged', async (t) => {
  const f = cliFixture(t); f.options.argv[f.options.argv.indexOf('--runs') + 1] = '1'; let file;
  const original = JSON.stringify({ type: 'result', pass: true, run: 1, marker: 'completed before stop' }) + '\n';
  f.options.runScenario = async ({ runDir }) => {
    file = path.join(runDir, 'run-01.jsonl'); fs.writeFileSync(file, original);
    return { run: 1, pass: true, serverPass: true, durationMs: 1, deaths: 0 };
  };
  f.options.startServer = async () => ({ port: 25565, stop: async () => { throw new Error('stop failed'); } });
  const result = await main(f.options);
  assert.equal(result.exitCode, 1); assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(f.report().results[0].pass, true); assert.deepEqual(f.report().batchFailures, ['stop failed']);
});

test('signal just before runScenario returns keeps its already-written terminal round result', async (t) => {
  const f = cliFixture(t); let file;
  const original = JSON.stringify({ type: 'result', run: 1, pass: true, marker: 'terminal before signal' }) + '\n';
  f.options.runScenario = async ({ runDir }) => {
    file = path.join(runDir, 'run-01.jsonl'); fs.writeFileSync(file, original);
    f.target.emit('SIGINT'); return { run: 1, pass: true, serverPass: true, durationMs: 1, deaths: 0 };
  };
  const result = await main(f.options);
  assert.equal(result.exitCode, 130); assert.equal(f.report().interrupted, true);
  assert.equal(f.report().summary.passed, 1); assert.equal(f.report().results[0].pass, true);
  assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(result.reports.length, 1);
});
