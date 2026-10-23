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
