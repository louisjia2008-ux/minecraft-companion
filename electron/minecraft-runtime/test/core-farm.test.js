'use strict';
// Farm plot choice against a voxel world, and the farm goal driven through the
// real brain with simulated skills: hoe, seeds, till, sow, harvest, bread.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createBrain } = require('../core/brain');
const { createFarmGoal } = require('../core/goals/farm');
const { choosePlots } = require('../core/farming');

function voxels(extra = {}) {
  return (p) => {
    const key = `${p.x},${p.y},${p.z}`;
    const name = extra[key] ?? (p.y < 0 ? 'dirt' : p.y === 0 ? 'grass_block' : 'air');
    return { name, boundingBox: ['air', 'short_grass', 'water'].includes(name) ? 'empty' : 'block' };
  };
}

test('plots sit beside water at its level, hydrated plots first', () => {
  const world = voxels({ '10,0,10': 'water' });
  const plots = choosePlots(world, { x: 0, y: 1, z: 0 }, { count: 12, findWater: () => [{ x: 10, y: 0, z: 10 }] });
  assert.equal(plots.length, 12);
  for (const p of plots) {
    assert.ok(p.hydrated);
    assert.ok(Math.abs(p.x - 10) <= 4 && Math.abs(p.z - 10) <= 4 && p.y === 0);
  }
});

test('without water, dry plots around the centre are used', () => {
  const plots = choosePlots(voxels(), { x: 0, y: 1, z: 0 }, { count: 6, findWater: () => [] });
  assert.equal(plots.length, 6);
  assert.ok(plots.every((p) => !p.hydrated && p.y === 0));
});

test('a farm asked for again picks its own sown farmland, not new ground', () => {
  const first = choosePlots(voxels(), { x: 0, y: 1, z: 0 }, { count: 6, findWater: () => [] });
  const extra = {};
  for (const p of first) { extra[`${p.x},${p.y},${p.z}`] = 'farmland'; extra[`${p.x},${p.y + 1},${p.z}`] = 'short_grass'; }
  const again = choosePlots(voxels(extra), { x: 0, y: 1, z: 0 }, { count: 6, findWater: () => [] });
  assert.deepEqual(again.map((p) => `${p.x},${p.y},${p.z}`).sort(), first.map((p) => `${p.x},${p.y},${p.z}`).sort());
});

test('farm goal goes from an empty inventory to bread and leaves the plots sown', async () => {
  const blocks = new Map();
  const ages = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const inventory = {};
  const add = (n, c = 1) => { inventory[n] = (inventory[n] || 0) + c; };
  const take = (n, c = 1) => { inventory[n] -= c; if (!inventory[n]) delete inventory[n]; };
  const bot = {
    entity: { position: new Vec3(0.5, 1, 0.5) },
    blockAt: (p) => {
      const name = blocks.get(key(p)) ?? (p.y === 0 ? 'grass_block' : 'air');
      return { name, position: new Vec3(p.x, p.y, p.z), boundingBox: name === 'air' || name === 'wheat' ? 'empty' : 'block' };
    },
  };
  let seedRoll = 0;
  const farming = {
    choosePlots: () => Array.from({ length: 6 }, (_, i) => ({ x: i, y: 0, z: 3, hydrated: true })),
    findWater: () => [],
    plotState(_bot, p) {
      const ground = blocks.get(key(p)) ?? 'grass_block';
      const crop = blocks.get(key({ ...p, y: 1 }));
      if (ground !== 'farmland') return 'untilled';
      if (crop === 'wheat') return ages.get(key(p)) >= 7 ? 'ripe' : 'growing';
      return 'empty';
    },
    till: async (_b, _c, p) => { if (!inventory.stone_hoe) return { ok: false, reason: 'no_hoe' }; blocks.set(key(p), 'farmland'); return { ok: true }; },
    plant: async (_b, _c, p) => { take('wheat_seeds'); blocks.set(key({ ...p, y: 1 }), 'wheat'); ages.set(key(p), 0); return { ok: true }; },
    harvest: async (_b, _c, p) => { blocks.delete(key({ ...p, y: 1 })); add('wheat'); add('wheat_seeds', 2); return { ok: true, gained: 1 }; },
    gatherSeeds: async () => { seedRoll += 1; if (seedRoll % 3 === 0) add('wheat_seeds'); return { ok: true }; },
  };
  const recipes = { oak_planks: [{ oak_log: 1 }, 4], stick: [{ oak_planks: 2 }, 4], crafting_table: [{ oak_planks: 4 }, 1],
    wooden_pickaxe: [{ oak_planks: 3, stick: 2 }, 1], stone_hoe: [{ cobblestone: 2, stick: 2 }, 1], bread: [{ wheat: 3 }, 1] };
  const skills = {
    gatherOne: async (_b, _c, { blocks: match }) => {
      if (match('oak_log')) add('oak_log'); else if (match('stone')) add('cobblestone'); else return { ok: false, reason: 'no_target_in_range' };
      return { ok: true };
    },
    craft: async (_b, _c, { item, times }) => {
      const [needs, yields] = recipes[item];
      for (let i = 0; i < times; i += 1) { for (const [n, c] of Object.entries(needs)) take(n, c); add(item, yields); }
      return { ok: true, usedTable: true };
    },
    placeAt: async (_b, _c, p) => { take('crafting_table'); blocks.set(key(p), 'crafting_table'); return { ok: true }; },
    explore: async () => ({ ok: true, moved: 32 }),
  };
  // Crops grow one stage every four brain ticks: slower than a harvest round,
  // as in the game, so the farm settles fully sown between harvests.
  let ticks = 0;
  const perceive = () => {
    ticks += 1;
    if (ticks % 4 === 0) for (const [k, age] of ages) ages.set(k, age + 1);
    return { alive: true, position: bot.entity.position, inventory: { ...inventory }, hostiles: [] };
  };
  const goal = createFarmGoal({ bot, bread: 3, skills, farming, waitMs: 0 });
  const events = [];
  const brain = createBrain({ perceive, goalRetryDelayMs: 0, onEvent: (e) => events.push(e) });
  brain.setGoal(goal);
  for (let i = 0; i < 3000 && !events.some((e) => e.type === 'goal_done' || e.type === 'goal_failed'); i += 1) {
    await brain.tick();
    await brain.idle();
  }
  await brain.dispose();
  assert.ok(events.some((e) => e.type === 'goal_done'), JSON.stringify(events.filter((e) => e.type === 'goal_failed')));
  assert.ok(inventory.bread >= 3);
  // Harvested plots were sown again.
  const sown = goal.memory.plots.filter((p) => blocks.get(key({ ...p, y: 1 })) === 'wheat').length;
  assert.ok(sown >= 3, `only ${sown} plots sown`);
  await brain.dispose();
});

test('farm goal walks back when its plots are out of sight instead of waiting', async () => {
  let away = true;
  const returns = [];
  const plots = Array.from({ length: 4 }, (_, i) => ({ x: i, y: 0, z: 3, hydrated: true }));
  const farming = {
    choosePlots: () => plots,
    findWater: () => [],
    plotState: () => (away ? 'unknown' : 'growing'),
    returnTo: async (_b, _c, p) => { returns.push(p); away = false; bot.entity.position = new Vec3(p.x + 0.5, 1, p.z + 0.5); return { ok: true }; },
  };
  const bot = { entity: { position: new Vec3(190.5, 1, 190.5) }, blockAt: () => null };
  const goal = createFarmGoal({ bot, center: new Vec3(0, 1, 0), farming, skills: {}, waitMs: 0 });
  const ctx = { perceive: () => ({ inventory: {} }), record: () => {}, signal: new AbortController().signal };
  const first = await goal.run(ctx);
  assert.equal(returns.length, 1);
  assert.ok(first.ok && !first.waited);
  // Back in sight with everything growing: now it waits.
  const second = await goal.run(ctx);
  assert.equal(returns.length, 1);
  assert.ok(second.waited);
});

test('farm goal asked for from far off walks back before choosing plots', async () => {
  const plots = Array.from({ length: 4 }, (_, i) => ({ x: i, y: 0, z: 3, hydrated: true }));
  const bot = { entity: { position: new Vec3(900.5, 64, -700.5) }, blockAt: () => null };
  const returns = [];
  let explored = 0;
  const farming = {
    // Out of view, no ground reads as a plot.
    choosePlots: () => (bot.entity.position.x > 100 ? [] : plots),
    findWater: () => [],
    plotState: () => 'growing',
    returnTo: async (_b, _c, p) => { returns.push(p); bot.entity.position = new Vec3(p.x + 0.5, 64, p.z + 0.5); return { ok: true }; },
  };
  const skills = { explore: async () => { explored += 1; return { ok: true }; } };
  const goal = createFarmGoal({ bot, center: new Vec3(0, 64, 0), farming, skills, waitMs: 0 });
  const ctx = { perceive: () => ({ inventory: {} }), record: () => {}, signal: new AbortController().signal };
  assert.ok((await goal.run(ctx)).ok);
  assert.equal(returns.length, 1);
  // Back home the plots are seen, all growing: it waits, never explores.
  assert.ok((await goal.run(ctx)).waited);
  assert.equal(explored, 0);
});

test('no soil around the centre (desert sand): the farm moves to the nearest soil, away from raiders', async () => {
  const { findGround } = require('../core/farming');
  // Sand everywhere but a patch of grass at x 20..30, a second one by a pillager outpost at x -42,
  // and a lone block of grass at x 8 that holds no farm.
  const world = (p) => {
    const ground = p.y === 0 && ((p.x >= 20 && p.x <= 30) || (p.x <= -40 && p.x >= -44) || (p.x === 8 && p.z === 0)) ? 'grass_block' : p.y <= 0 ? 'sand' : 'air';
    return { name: ground, boundingBox: ground === 'air' ? 'empty' : 'block' };
  };
  const bot = {
    entity: { position: new Vec3(0.5, 1, 0.5) },
    registry: { blocksByName: { grass_block: { id: 1 }, dirt: { id: 2 } } },
    blockAt: world,
    companionDanger: [{ x: -42, z: 0 }],
    findBlocks: ({ point, maxDistance }) => {
      const out = [];
      for (let x = -maxDistance; x <= maxDistance; x += 1) for (let z = -8; z <= 8; z += 1) {
        if (world({ x, y: 0, z }).name === 'grass_block' && Math.hypot(x - point.x, z - point.z) <= maxDistance) out.push(new Vec3(x, 0, z));
      }
      return out;
    },
  };
  assert.deepEqual(findGround(bot, { x: 0, y: 1, z: 0 }, 48), { x: 8, y: 1, z: 0 }, 'without a fit test, the nearest soil');
  const returns = [];
  const real = require('../core/farming');
  const farming = { ...real, returnTo: async (_b, _c, p) => { returns.push(p); return { ok: true }; } };
  let explored = 0;
  const goal = createFarmGoal({ bot, center: new Vec3(0, 1, 0), farming, skills: { explore: async () => { explored += 1; return { ok: true }; } }, waitMs: 0 });
  await goal.run({ perceive: () => ({ inventory: {} }), record: () => {}, signal: new AbortController().signal });
  assert.equal(explored, 0);
  assert.deepEqual(returns, [{ x: 20, y: 1, z: 0 }]);
  assert.deepEqual(goal.memory.center, { x: 20, y: 1, z: 0 });
});

test('no soil within reach of the centre: it explores on, and farms the first soil it finds out there', async () => {
  const real = require('../core/farming');
  let soilAt = null; // nothing anywhere until the bot has wandered
  const bot = {
    entity: { position: new Vec3(0.5, 1, 0.5) },
    registry: { blocksByName: { grass_block: { id: 1 } } },
    blockAt: (p) => {
      const grass = soilAt && p.y === 0 && Math.abs(p.x - soilAt.x) <= 6 && Math.abs(p.z - soilAt.z) <= 6;
      const name = p.y <= 0 ? (grass ? 'grass_block' : 'sand') : 'air';
      return { name, boundingBox: name === 'air' ? 'empty' : 'block' };
    },
    findBlocks: ({ point, maxDistance }) => {
      if (!soilAt) return [];
      const out = [];
      for (let dx = -6; dx <= 6; dx += 1) for (let dz = -6; dz <= 6; dz += 1) {
        const p = new Vec3(soilAt.x + dx, 0, soilAt.z + dz);
        if (p.distanceTo(point) <= maxDistance) out.push(p);
      }
      return out;
    },
  };
  const returns = [];
  let explored = 0;
  const farming = { ...real, returnTo: async (_b, _c, p) => { returns.push(p); return { ok: true }; } };
  const skills = { explore: async () => { explored += 1; bot.entity.position = new Vec3(80.5, 1, 0.5); return { ok: true }; } };
  const goal = createFarmGoal({ bot, center: new Vec3(0, 1, 0), farming, skills, waitMs: 0 });
  const ctx = { perceive: () => ({ inventory: {} }), record: () => {}, signal: new AbortController().signal };
  await goal.run(ctx);
  assert.equal(explored, 1);
  // Now 80 blocks out, with no soil yet: on, not back.
  await goal.run(ctx);
  assert.equal(explored, 2);
  assert.equal(returns.length, 0);
  soilAt = { x: 90, z: 0 };
  await goal.run(ctx);
  assert.equal(returns.length, 1);
  assert.ok(Math.abs(returns[0].x - 90) <= 6, JSON.stringify(returns[0]));
});
