'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fishingDataPacks, fishingSetup, installFishingEvidence, LOOT } = require('../scenarios/fishingEvidence.cjs');
const { fishingFlat, ironFarmFlat } = require('../scenarios/devices.cjs');
const { installDataPacks } = require('../scenarios/vanillaServer.cjs');
const { SCENARIOS } = require('../scenarios/index.cjs');
const { SUITES } = require('../scenarios/regression.cjs');

function fixture() {
  const world = { catches: 0, pickedUp: 0, fail: false };
  let complete;
  const bot = { fish() { assert.equal(this, bot); return new Promise((resolve, reject) => { complete = { resolve, reject }; }); } };
  const native = bot.fish;
  const server = {
    async execute() { if (world.fail) throw new Error('readback lost'); return 'Executed 23 commands from function minecraft_companion:read_pickups'; },
    async query(command, pattern) { return `Test has ${command.endsWith('mcFishCatch') ? world.catches : world.pickedUp} [score]`.match(pattern); },
  };
  const ledger = installFishingEvidence({ bot, server, username: 'Test', pickupMs: 5, pollMs: 1 });
  async function cast({ catches = 1, pickup = 1, reject } = {}) {
    const pending = bot.fish();
    // Let the observer take its independent baseline while the real bite waits.
    await new Promise((resolve) => setImmediate(resolve));
    world.catches += catches; world.pickedUp += pickup;
    if (reject) complete.reject(reject); else complete.resolve('native catch');
    return pending;
  }
  return { world, bot, ledger, native, cast };
}

test('full regression manifest covers every registered scenario, retains repeats, and requires all 40 rounds', () => {
  const full = SUITES.full;
  assert.equal(Object.keys(SCENARIOS).length, 35);
  const experimental = Object.keys(SCENARIOS).filter((name) => SCENARIOS[name].experimental);
  assert.deepEqual(experimental, ['nether-structures-given', 'nether-fortress-given', 'ironfarm-village-flat']);
  assert.deepEqual(full.map((e) => e.scenario).sort(), Object.keys(SCENARIOS).filter((name) => !experimental.includes(name)).sort());
  assert.equal(full.reduce((n, e) => n + e.runs, 0), 40);
  for (const e of full) assert.equal(e.minPassRate, 1);
  for (const e of SUITES.quick) assert.equal(full.find((f) => f.scenario === e.scenario).runs, e.runs);
  assert.equal(full.find((e) => e.scenario === 'collect-logs-natural').runs, 3);
  assert.equal(full.find((e) => e.scenario === 'homestead-flat').runs, 1);
});

test('fishing observer counts junk and treasure as single catches, excludes soil and uses server pickup statistics', async () => {
  const pack = fishingDataPacks['minecraft-companion-observer'];
  const advancement = JSON.parse(pack['data/minecraft_companion/advancement/fishing_catch.json']);
  assert.equal(advancement.criteria.caught.trigger, 'minecraft:fishing_rod_hooked');
  for (const item of ['cod', 'ink_sac', 'potion', 'enchanted_book', 'fishing_rod', 'nautilus_shell']) assert.ok(LOOT.includes(item));
  assert.ok(!LOOT.includes('dirt'));
  for (const item of LOOT) assert.ok(fishingSetup('Test').some((c) => c.endsWith(`minecraft.picked_up:minecraft.${item}`)));
  const f = fixture(); f.world.pickedUp = 100; // old pickup counter is baseline, not a new catch
  await f.cast({ pickup: 10 }); // ten ink sacs still count as one catch
  assert.equal((await f.ledger.verify(5, 5)).pass, false);
  for (let i = 0; i < 4; i += 1) await f.cast();
  const result = await f.ledger.verify(5, 5);
  assert.equal(result.pass, true); assert.equal(result.confirmed, 5);
  assert.equal((await f.ledger.verify(99, 5)).pass, false);
  await f.ledger.dispose(); assert.equal(f.bot.fish, f.native);
});

test('native completion, server catch event and actual pickup are all necessary; cancelled casts stay uncredited', async () => {
  const f = fixture();
  await f.cast({ catches: 0, pickup: 20 });
  await f.cast({ catches: 1, pickup: 0 });
  const cancellation = new Error('native cancelled');
  await assert.rejects(f.cast({ catches: 1, pickup: 1, reject: cancellation }), (e) => e === cancellation);
  assert.equal((await f.ledger.verify(5, 5)).confirmed, 0);
  f.world.fail = true; await f.cast();
  assert.equal(f.ledger.evidence.errors.length, 1);
  await f.ledger.dispose();
  const error = new Error('native synchronous throw');
  const bot = { fish() { throw error; } };
  const ledger = installFishingEvidence({ bot });
  assert.throws(() => bot.fish(), (e) => e === error); await ledger.dispose();
});

test('fishing disposal joins readbacks while an abandoned native cast cannot block cleanup or write later', async () => {
  const f = fixture();
  const cast = f.cast();
  await f.ledger.dispose();
  await cast;
  assert.equal(f.ledger.evidence.confirmed, 0);
  assert.deepEqual(f.ledger.evidence.casts, []);
});

test('fishing cannot pass forged five-catch memory with only one independently collected catch', async () => {
  const server = { async query(command, pattern) {
    const response = command.startsWith('clear ') ? 'Found 1 matching items on player Test' : 'Test passed';
    return response.match(pattern);
  } };
  const goal = { memory: { pond: { anchor: { x: 0, y: 63, z: 0 }, facing: 'east' }, catches: 5 } };
  assert.equal((await fishingFlat.verify({ server, username: 'Test', goal, state: {} })).pass, false);
  const production = { verify: async () => ({ pass: false, confirmed: 1 }) };
  assert.equal((await fishingFlat.verify({ server, username: 'Test', goal, state: { fishingEvidence: production } })).pass, false);
});

test('iron farm needs its live zombie as well as villagers, structure, and iron', async () => {
  let zombies = 0;
  const server = { async query(command, pattern) {
    const response = command.startsWith('clear ') ? 'Found 3 matching items on player Test'
      : command.includes('type=zombie') ? `Test ${zombies ? 'passed, count: 1' : 'failed'}`
        : command.includes('type=villager') ? 'Test passed, count: 3' : 'Test passed';
    return response.match(pattern);
  } };
  const args = { server, username: 'Test', goal: { memory: { farm: { anchor: { x: 0, y: 63, z: 0 }, facing: 'east' } } } };
  assert.equal((await ironFarmFlat.verify(args)).pass, false);
  zombies = 1; assert.equal((await ironFarmFlat.verify(args)).pass, true);
});

test('observer data packs are installed in the fresh world and reject path escapes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-observer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  installDataPacks(dir, fishingDataPacks);
  assert.ok(fs.existsSync(path.join(dir, 'world/datapacks/minecraft-companion-observer/pack.mcmeta')));
  assert.throws(() => installDataPacks(dir, { '../escape': {} }), /Invalid observer data-pack name/);
  assert.throws(() => installDataPacks(dir, { okay: { '../../../escape': '' } }), /Invalid observer data-pack path/);
});
