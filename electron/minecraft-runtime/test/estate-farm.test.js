/* global require, setTimeout, structuredClone */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { createEstateFarm, normalizeFarmSpec } = require('../vendor/server/minecraft/estateFarm');
const key = p => `${p.x},${p.y},${p.z}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Injected-action unit contract. Real installed Block states/shapes are used;
// simulated server mutations and pickup callbacks are not live-game evidence.
function fixture(options = {}) {
  const plots = [0, 8].map((x, index) => {
    const water = { x, y: 63, z: 0 };
    const soil = [];
    for (let dx = -2; dx <= 2; dx += 1) for (let dz = -2; dz <= 2; dz += 1) if (dx || dz) soil.push({ x: x + dx, y: 63, z: dz });
    return { id: `plot-${index}`, water, soil, crops: soil.map(p => ({ soilPosition: p, position: { ...p, y: 64 }, item: 'wheat_seeds', block: 'wheat' })), access: [] };
  });
  const spec = { schema: 1, id: 'farm-two-plots', plots };
  const cells = new Map(), writes = [], saved = [], loot = new Map();
  const inventory = { water_bucket: 2, iron_hoe: 1, wheat_seeds: 48, dirt: 1, ...options.inventory };
  const state = { cancelled: false, checkpoint: {}, aim: null };
  function block(name, position, properties = {}) {
    const type = registry.blocksByName[name];
    for (let id = type.minStateId; id <= type.maxStateId; id += 1) {
      const actual = Block.fromStateId(id, 0);
      if (Object.entries(properties).every(([p, value]) => String(actual.getProperties()[p]) === String(value))) {
        actual.position = new Vec3(position.x, position.y, position.z); return actual;
      }
    }
    throw new Error(`No real ${name} state matches requested fixture properties`);
  }
  const put = (p, name, properties) => cells.set(key(p), block(name, p, properties));
  const at = p => options.unloaded === key(p) ? null : cells.get(key(p)) || block(p.y <= 63 ? 'grass_block' : 'air', p);
  const bot = { registry, entity: { position: options.position || new Vec3(-5.5, 64, 0.5), onGround: true, width: 0.6, height: 1.8 },
    blockAt: at, heldItem: null, inventory: { items: () => Object.entries(inventory).filter(([, n]) => n > 0)
      .map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id })) } };
  const active = () => { if (state.cancelled) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); };
  const write = value => { active(); writes.push(value); };
  const deps = { getBot: () => bot, assertActive: active, getCheckpoint: () => state.checkpoint,
    setCheckpoint: next => { active(); state.checkpoint = structuredClone(next); saved.push(state.checkpoint); }, report: () => {}, worldTimeoutMs: 35,
    reach: async (p, opts) => { write({ kind: 'reach', position: p, options: opts }); },
    equip: async name => { write({ kind: 'equip', name }); bot.heldItem = { name }; if (options.cancelAfter === `equip_${name}`) state.cancelled = true; },
    lookAt: async p => { write({ kind: 'lookAt', position: p }); state.aim = p; },
    dig: async actual => {
      write({ kind: 'dig', name: actual.name, position: actual.position });
      if (actual.name === 'wheat') loot.set(key(actual.position), { wheat: 1, wheat_seeds: options.seedDrops ?? 2 });
      put(actual.position, 'air');
    },
    placeBlock: async ({ position, item }) => { write({ kind: 'place', position, item }); inventory[item] -= 1; put(position, item); },
    activateItem: async () => {
      write({ kind: 'pour', held: bot.heldItem.name });
      const p = { x: Math.floor(state.aim.x), y: Math.floor(state.aim.y), z: Math.floor(state.aim.z) };
      const update = () => { put(p, 'water', { level: options.flowingWater ? 1 : 0 }); inventory.water_bucket -= 1;
        if (!options.missingEmptyBucket) inventory.bucket = (inventory.bucket || 0) + 1; };
      if (options.delayedWater) { setTimeout(update, 20); setTimeout(() => { state.cancelled = true; }, 5); }
      else update();
    },
    activateBlock: async actual => {
      const held = bot.heldItem.name;
      write({ kind: 'activate', held, position: actual.position });
      if (held.endsWith('_hoe')) { if (!options.noTill) put(actual.position, 'farmland', { moisture: 0 }); }
      else if (held === 'wheat_seeds') {
        if (!options.noSeedDebit) inventory.wheat_seeds -= 1;
        if (!options.noCrop) put(actual.position.offset(0, 1, 0), 'wheat', { age: 0 });
        if (options.cancelAfter === 'seed') state.cancelled = true;
      } else if (held === 'bone_meal') {
        inventory.bone_meal -= 1;
        if (!options.noGrowth) put(actual.position, 'wheat', { age: Math.min(7, Number(actual.getProperties().age) + 3) });
      }
    },
    collectDrops: async p => {
      write({ kind: 'collect', position: p });
      if (options.noPickup) return;
      const drops = loot.get(key(p));
      if (drops) for (const [name, amount] of Object.entries(drops)) inventory[name] = (inventory[name] || 0) + amount;
      loot.delete(key(p));
      if (options.cancelAfter === 'collect') state.cancelled = true;
    },
  };
  return { spec, plots, cells, writes, saved, inventory, state, bot, put, at, deps, farm: () => createEstateFarm(deps) };
}

test('build uses native water, hoe and 48 seed actions with actual world/inventory confirmation', async () => {
  const f = fixture(), original = JSON.stringify(f.spec);
  const summary = await f.farm().build(f.spec);
  assert.equal(summary.farmVerified, true);
  assert.equal(summary.waterSourceCount, 2);
  assert.equal(summary.soilCount, 48);
  assert.equal(summary.plantedCount, 48);
  assert.ok(summary.moisture.every(m => m.value === 0), 'Initial genuine farmland moisture need not be hydrated yet');
  assert.equal(f.writes.filter(w => w.kind === 'dig').length, 2);
  assert.equal(f.writes.filter(w => w.kind === 'pour').length, 2);
  assert.equal(f.writes.filter(w => w.kind === 'activate' && w.held.endsWith('_hoe')).length, 48);
  assert.equal(f.writes.filter(w => w.kind === 'activate' && w.held === 'wheat_seeds').length, 48);
  assert.equal(f.writes.filter(w => w.kind === 'place').length, 0, 'Natural dirt/grass needs no replacement material');
  assert.equal(f.writes.filter(w => w.kind === 'activate' && w.held === 'bone_meal').length, 0);
  assert.equal(f.inventory.water_bucket, 0); assert.equal(f.inventory.bucket, 2); assert.equal(f.inventory.wheat_seeds, 0);
  assert.equal(f.state.checkpoint.phase, 'complete');
  assert.equal(JSON.stringify(f.spec), original);
  const oldWrites = f.writes.length;
  await f.farm().build(f.spec);
  assert.equal(f.writes.length, oldWrites, 'Verified restart must not pour again or consume another seed');
});

test('only missing soil is filled using real dirt consumption; all other natural soil is tilled directly', async () => {
  const f = fixture(); const p = f.plots[0].soil.find(s => s.x === 1 && s.z === 0); f.put(p, 'air');
  await f.farm().build(f.spec);
  assert.deepEqual(f.writes.filter(w => w.kind === 'place').map(w => ({ position: w.position, item: w.item })), [{ position: p, item: 'dirt' }]);
  assert.equal(f.inventory.dirt, 0); assert.equal(f.at(p).name, 'farmland');
  assert.ok(f.writes.findIndex(w => w.kind === 'place') < f.writes.findIndex(w => w.kind === 'pour'), 'A hole adjacent to the source must be closed before water can flow into it');
});

test('a foreign center or waterloggable/missing bottom is rejected before pouring or altering any other plot', async () => {
  for (const name of ['chest', 'air']) {
    const f = fixture(); f.put({ ...f.plots[1].water, y: 62 }, name);
    await assert.rejects(f.farm().build(f.spec), e => e.code === 'farm_water_support_missing');
    assert.equal(f.writes.length, 0);
  }
  const f = fixture(); f.put(f.plots[1].water, 'furnace');
  await assert.rejects(f.farm().build(f.spec), e => e.code === 'farm_terrain_obstructed');
  assert.equal(f.writes.length, 0);
});

test('missing consumables, unknown terrain, unloaded chunks and invalid owned coordinates fail before native writes', async () => {
  for (const inv of [{ water_bucket: 1 }, { wheat_seeds: 47 }, { iron_hoe: 0 }]) {
    const f = fixture({ inventory: inv });
    await assert.rejects(f.farm().build(f.spec), e => e.code === 'farm_materials_missing'); assert.equal(f.writes.length, 0);
  }
  const foreign = fixture(); foreign.put(foreign.plots[0].soil[0], 'chest');
  await assert.rejects(foreign.farm().build(foreign.spec), e => e.code === 'farm_terrain_obstructed'); assert.equal(foreign.writes.length, 0);
  const unloaded = fixture({ unloaded: '-2,63,-2' });
  await assert.rejects(unloaded.farm().build(unloaded.spec), e => e.code === 'farm_unloaded'); assert.equal(unloaded.writes.length, 0);
  const invalid = fixture(); invalid.spec.plots[0].soil[0] = { x: 100, y: 63, z: 100 };
  assert.throws(() => normalizeFarmSpec(invalid.spec), e => e.code === 'farm_invalid_spec'); assert.equal(invalid.writes.length, 0);
});

test('flowing water or a missing emptied bucket never counts as successful irrigation', async () => {
  for (const options of [{ flowingWater: true }, { missingEmptyBucket: true }]) {
    const f = fixture(options);
    await assert.rejects(f.farm().build(f.spec), e => e.code === 'farm_water_source_failed');
    assert.equal(f.state.checkpoint.waterSources.length, 0);
    assert.equal(f.writes.filter(w => w.kind === 'pour').length, 1);
    assert.equal(f.writes.filter(w => w.kind === 'activate').length, 0);
  }
});

test('farmland and crop appearance alone cannot fabricate successful native till or seed consumption', async () => {
  const untilled = fixture({ noTill: true });
  await assert.rejects(untilled.farm().build(untilled.spec), e => e.code === 'farm_till_not_confirmed');
  for (const options of [{ noSeedDebit: true }, { noCrop: true }]) {
    const f = fixture(options);
    await assert.rejects(f.farm().build(f.spec), e => e.code === 'farm_seed_not_confirmed');
    assert.equal(f.state.checkpoint.plantedCrops.length, 0);
  }
});

test('water permission never permits standing in water or digging the player support', async () => {
  const support = fixture({ position: new Vec3(0.5, 64, 0.5) });
  await assert.rejects(support.farm().build(support.spec), e => e.code === 'farm_supporting_player');
  assert.equal(support.writes.filter(w => w.kind === 'dig').length, 0);
  const water = fixture({ position: new Vec3(0.5, 64, 0.5) }); water.put(water.plots[0].water, 'water', { level: 0 });
  await assert.rejects(water.farm().build(water.spec), e => e.code === 'farm_unsafe_stance');
  assert.equal(water.writes.filter(w => w.kind === 'dig').length, 0);
});

test('cancel after equip issues no use or late checkpoint writes; restart continues from the real dug hole', async () => {
  const options = { cancelAfter: 'equip_water_bucket' }; const f = fixture(options);
  await assert.rejects(f.farm().build(f.spec), e => e.code === 'cancelled');
  const writes = f.writes.length, saved = f.saved.length;
  await sleep(20); assert.equal(f.writes.length, writes); assert.equal(f.saved.length, saved);
  assert.equal(f.writes.filter(w => w.kind === 'pour').length, 0);
  options.cancelAfter = ''; f.state.cancelled = false;
  await f.farm().build(f.spec);
  assert.equal(f.writes.filter(w => w.kind === 'dig').length, 2, 'Restart must not dig the already empty hole again');
  assert.equal(f.inventory.wheat_seeds, 0);
});

test('cancellation during actual-world wait allows an already sent server response but no new action or checkpoint', async () => {
  const f = fixture({ delayedWater: true });
  await assert.rejects(f.farm().build(f.spec), e => e.code === 'cancelled');
  const writes = f.writes.length, saved = f.saved.length;
  await sleep(40);
  assert.equal(f.writes.length, writes); assert.equal(f.saved.length, saved);
  assert.equal(f.state.checkpoint.waterSources.length, 0);
});

test('independent validation explicitly authorizes native growth, harvest, genuine pickup and replant, even with zero seed drops', async () => {
  const f = fixture({ seedDrops: 0 }); await f.farm().build(f.spec);
  f.inventory.bone_meal = 8; f.inventory.wheat_seeds = 2; // Explicit post-public fixture, never construction resources.
  const before = f.writes.length;
  await assert.rejects(f.farm().validate(f.spec, {}), e => e.code === 'farm_validation_not_authorized');
  assert.equal(f.writes.length, before);
  const result = await f.farm().validate(f.spec, { postPublicTask: true, allowBoneMeal: true });
  assert.equal(result.validationVerified, true); assert.equal(result.cycles.length, 2);
  assert.equal(result.harvestedWheat, 2); assert.equal(f.inventory.wheat, 2); assert.equal(f.inventory.wheat_seeds, 0);
  assert.ok(result.cycles.every(c => c.ageMature === 7 && c.ageAfterReplant === 0 && c.seedConsumedForReplant === 1 && c.seedsCollected === 0));
  assert.equal(f.writes.filter(w => w.kind === 'collect').length, 2);
});

test('bone meal consumption without actual growth and harvest without actual pickup stay explicit failures', async () => {
  for (const options of [{ noGrowth: true }, { noPickup: true }]) {
    const f = fixture(options); await f.farm().build(f.spec); f.inventory.bone_meal = 8; f.inventory.wheat_seeds = 2;
    await assert.rejects(f.farm().validate(f.spec, { postPublicTask: true, allowBoneMeal: true }),
      e => e.code === (options.noGrowth ? 'farm_growth_not_confirmed' : 'farm_pickup_not_confirmed'));
    assert.notEqual(f.state.checkpoint.phase, 'validated');
  }
});

test('foreign validation targets and changed task coordinates cannot expand farm ownership', async () => {
  const f = fixture(); await f.farm().build(f.spec); const before = f.writes.length;
  await assert.rejects(f.farm().validate(f.spec, { postPublicTask: true, allowBoneMeal: true, targets: [{ x: 100, y: 64, z: 100 }] }),
    e => e.code === 'farm_invalid_validation');
  const different = structuredClone(f.spec); different.id = 'other-task';
  await assert.rejects(f.farm().build(different), e => e.code === 'farm_checkpoint_mismatch');
  assert.equal(f.writes.length, before);
});

test('post-harvest and post-replant cancellation resume from confirmed native effects without duplicate pickup or seed use', async () => {
  for (const boundary of ['collect', 'seed']) {
    const options = { seedDrops: 0 }; const f = fixture(options);
    await f.farm().build(f.spec); f.inventory.bone_meal = 8; f.inventory.wheat_seeds = 2;
    options.cancelAfter = boundary;
    await assert.rejects(f.farm().validate(f.spec, { postPublicTask: true, allowBoneMeal: true }), e => e.code === 'cancelled');
    const saved = f.saved.length, writes = f.writes.length;
    await sleep(20); assert.equal(f.saved.length, saved); assert.equal(f.writes.length, writes);
    options.cancelAfter = ''; f.state.cancelled = false;
    const result = await f.farm().validate(f.spec, { postPublicTask: true, allowBoneMeal: true });
    assert.equal(result.validationVerified, true); assert.equal(result.harvestedWheat, 2);
    assert.equal(f.writes.filter(w => w.kind === 'collect').length, 2);
    assert.equal(f.writes.filter(w => w.kind === 'activate' && w.held === 'wheat_seeds').length, 50);
    assert.equal(f.inventory.wheat_seeds, 0);
  }
});
