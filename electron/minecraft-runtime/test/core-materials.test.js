'use strict';
// Material lists for redstone machines: planner chains for the new parts,
// blueprint-derived requirements, and the gather-materials goal driven through
// the real brain against a simulated world with failures and a death.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { planNext } = require('../core/planner');
const { materialsFor } = require('../core/materials');
const { createBrain } = require('../core/brain');
const { createGatherMaterialsGoal } = require('../core/goals/gatherMaterials');

test('a water bucket needs a bucket, which needs three iron at the table', () => {
  const water = [{ key: 'water_bucket', count: 1 }];
  const craft = planNext({ requirements: water, inventory: { iron_ingot: 3 }, stations: { crafting_table: true } });
  assert.deepEqual([craft.kind, craft.item], ['craft', 'bucket']);
  const fill = planNext({ requirements: water, inventory: { bucket: 1 } });
  assert.deepEqual([fill.kind, fill.liquid, fill.key], ['fill', 'water', 'water_bucket']);
  assert.equal(planNext({ requirements: water, inventory: { water_bucket: 1 } }), null);
});

test('one bucket is not counted twice for water and lava', () => {
  const both = [{ key: 'water_bucket', count: 1 }, { key: 'lava_bucket', count: 1 }];
  const step = planNext({ requirements: both, inventory: { bucket: 1, iron_ingot: 2 }, stations: { crafting_table: true } });
  assert.deepEqual([step.kind, step.liquid], ['fill', 'water']);
  const second = planNext({ requirements: both, inventory: { water_bucket: 1, iron_ingot: 2, stone_pickaxe: 1, coal: 1 },
    stations: { crafting_table: true, furnace: true } });
  // Two ingots are one short of the second bucket: mine more iron.
  assert.deepEqual([second.kind, second.key], ['gather', 'raw_iron']);
});

test('a hopper takes five iron and a chest', () => {
  const step = planNext({ requirements: [{ key: 'hopper', count: 1 }], inventory: { iron_ingot: 5, oak_planks: 8 },
    stations: { crafting_table: true } });
  assert.deepEqual([step.kind, step.item], ['craft', 'chest']);
  const hopper = planNext({ requirements: [{ key: 'hopper', count: 1 }], inventory: { iron_ingot: 5, chest: 1 },
    stations: { crafting_table: true } });
  assert.deepEqual([hopper.kind, hopper.item], ['craft', 'hopper']);
});

test('redstone needs an iron pickaxe; quartz is gathered in the Nether', () => {
  const red = planNext({ requirements: [{ key: 'piston', count: 1 }],
    inventory: { stone_pickaxe: 1, oak_planks: 3, cobblestone: 4, iron_ingot: 1 }, stations: { crafting_table: true, furnace: true } });
  assert.deepEqual([red.kind, red.key], ['gather', 'raw_iron']);
  const mine = planNext({ requirements: [{ key: 'piston', count: 1 }],
    inventory: { iron_pickaxe: 1, oak_planks: 3, cobblestone: 4, iron_ingot: 1 }, stations: { crafting_table: true } });
  assert.deepEqual([mine.kind, mine.key, mine.tool], ['gather', 'redstone', 'iron_tier_pickaxe']);
  const quartz = planNext({ requirements: [{ key: 'observer', count: 1 }],
    inventory: { iron_pickaxe: 1, cobblestone: 6, redstone: 2 }, stations: { crafting_table: true } });
  assert.deepEqual([quartz.kind, quartz.key, quartz.dimension], ['gather', 'quartz', 'the_nether']);
});

test('every machine part can be planned from an empty inventory', () => {
  for (const key of ['bucket', 'water_bucket', 'lava_bucket', 'hopper', 'redstone', 'stone', 'glass', 'sugar_cane',
    'redstone_torch', 'repeater', 'piston', 'observer', 'bow', 'dispenser', 'obsidian', 'flint_and_steel']) {
    const step = planNext({ requirements: [{ key, count: 1 }], inventory: {} });
    assert.notEqual(step.kind, 'unplannable', `${key}: ${JSON.stringify(step)}`);
  }
});

test('the material list counts only blueprint blocks not yet in place', () => {
  const world = { '0,0,0': 'cobblestone', '1,0,0': 'water', '2,0,0': 'air' };
  const nameAt = (p) => world[`${p.x},${p.y},${p.z}`] || 'air';
  const blocks = [
    { position: { x: 0, y: 0, z: 0 }, family: 'cobblestone' },
    { position: { x: 0, y: 1, z: 0 }, family: 'cobblestone' },
    { position: { x: 1, y: 0, z: 0 }, family: 'water_bucket' },
    { position: { x: 2, y: 0, z: 0 }, family: 'lava_bucket' },
    { position: { x: 3, y: 0, z: 0 }, family: 'hopper' },
  ];
  assert.deepEqual(materialsFor(blocks, nameAt), [
    { key: 'cobblestone', count: 1 }, { key: 'lava_bucket', count: 1 }, { key: 'hopper', count: 1 },
  ]);
  assert.throws(() => materialsFor([{ position: { x: 0, y: 0, z: 0 }, family: 'unobtainium' }], nameAt), /Unknown material/);
});

const RECIPES = {
  oak_planks: [{ oak_log: 1 }, 4], stick: [{ oak_planks: 2 }, 4], crafting_table: [{ oak_planks: 4 }, 1],
  wooden_pickaxe: [{ oak_planks: 3, stick: 2 }, 1], stone_pickaxe: [{ cobblestone: 3, stick: 2 }, 1],
  furnace: [{ cobblestone: 8 }, 1], bucket: [{ iron_ingot: 3 }, 1], chest: [{ oak_planks: 8 }, 1],
  hopper: [{ iron_ingot: 5, chest: 1 }, 1],
};
const TABLE_FREE = new Set(['oak_planks', 'stick', 'crafting_table']);

function simulate({ seed = 1, failRate = 0.15 } = {}) {
  let random = seed;
  const rng = () => { random = (random * 1103515245 + 12345) % 2147483648; return random / 2147483648; };
  const world = new Map([['0,0,0', 'chest']]);
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const blockAt = (p) => {
    const name = world.get(key(p)) ?? (p.y < 0 ? 'stone' : 'air');
    return { name, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) };
  };
  const inventory = {};
  const chest = {};
  const add = (bag, name, n = 1) => { bag[name] = (bag[name] || 0) + n; };
  const take = (bag, name, n = 1) => {
    assert.ok((bag[name] || 0) >= n, `missing ${n} ${name}`);
    bag[name] -= n;
    if (!bag[name]) delete bag[name];
  };
  const bot = {
    entity: { position: new Vec3(0.5, 0, 2.5) },
    game: { dimension: 'overworld' },
    blockAt,
    inventory: { items: () => Object.entries(inventory).map(([name, count]) => ({ name, count })), emptySlotCount: () => 30 },
  };
  const log = { fills: [], stores: 0, failures: 0 };
  const flaky = (result) => {
    if (rng() < failRate) { log.failures += 1; return { ok: false, reason: 'simulated_failure' }; }
    return result();
  };
  const has = (n) => (inventory[n] || 0) > 0;
  const skills = {
    gatherOne: async (_bot, _ctx, { blocks }) => flaky(() => {
      if (blocks('oak_log')) add(inventory, 'oak_log');
      else if (blocks('stone')) {
        if (!['wooden_pickaxe', 'stone_pickaxe'].some(has)) return { ok: false, reason: 'no_tool' };
        add(inventory, 'cobblestone');
      } else if (blocks('coal_ore')) add(inventory, 'coal');
      else if (blocks('iron_ore')) {
        if (!has('stone_pickaxe')) return { ok: false, reason: 'no_tool' };
        add(inventory, 'raw_iron');
      } else return { ok: false, reason: 'no_target_in_range' };
      return { ok: true };
    }),
    craft: async (_bot, _ctx, { item, times, tablePosition }) => flaky(() => {
      const [needs, yields] = RECIPES[item];
      if (!TABLE_FREE.has(item) && !tablePosition) return { ok: false, reason: 'no_recipe' };
      if (tablePosition && blockAt(tablePosition).name !== 'crafting_table') return { ok: false, reason: 'table_missing' };
      for (let i = 0; i < times; i += 1) {
        if (!Object.entries(needs).every(([n, c]) => (inventory[n] || 0) >= c)) break;
        for (const [n, c] of Object.entries(needs)) take(inventory, n, c);
        add(inventory, item, yields);
      }
      return { ok: true, usedTable: Boolean(tablePosition) };
    }),
    placeAt: async (_bot, _ctx, position, match) => flaky(() => {
      const item = Object.keys(inventory).find(match);
      if (!item) return { ok: false, reason: 'no_material' };
      take(inventory, item);
      world.set(key(position), item);
      return { ok: true };
    }),
    smelt: async (_bot, _ctx, { input, count, furnacePosition, memory }) => flaky(() => {
      if (blockAt(furnacePosition).name !== 'furnace') return { ok: false, reason: 'furnace_missing' };
      const n = Math.min(count, inventory[input] || 0);
      if (!n) return { ok: false, reason: 'smelt_no_output' };
      const fuel = ['coal', 'oak_log', 'oak_planks'].find(has);
      if (!fuel) return { ok: false, reason: 'no_fuel' };
      take(inventory, fuel);
      take(inventory, input, n);
      add(inventory, 'iron_ingot', n);
      memory.input = 0;
      memory.output = 0;
      return { ok: true, taken: n };
    }),
    fillBucket: async (_bot, _ctx, { liquid }) => flaky(() => {
      if (!has('bucket')) return { ok: false, reason: 'no_bucket' };
      take(inventory, 'bucket');
      add(inventory, `${liquid}_bucket`);
      log.fills.push(liquid);
      return { ok: true };
    }),
    storeInChest: async (_bot, _ctx, { position, wants }) => flaky(() => {
      if (blockAt(position).name !== 'chest') return { ok: false, reason: 'chest_missing' };
      for (const { match, count } of wants) {
        let left = count;
        for (const name of Object.keys(inventory).filter(match)) {
          const n = Math.min(left, inventory[name]);
          take(inventory, name, n);
          add(chest, name, n);
          left -= n;
        }
      }
      log.stores += 1;
      return { ok: true, contents: { ...chest } };
    }),
    huntOne: async () => ({ ok: false, reason: 'no_mob_in_range' }),
    explore: async () => ({ ok: true, moved: 32 }),
  };
  const actions = {
    goNear: async () => ({ ok: true }),
    unstick: async () => ({ ok: true }),
  };
  const perceive = () => ({ alive: true, position: bot.entity.position, inventory: { ...inventory }, hostiles: [] });
  const die = () => { for (const name of Object.keys(inventory)) delete inventory[name]; };
  return { bot, world, inventory, chest, skills, actions, perceive, log, die };
}

async function runGoal(sim, goal, { limit = 5000, dieWhen = () => false } = {}) {
  const events = [];
  const brain = createBrain({ perceive: sim.perceive, goalRetryDelayMs: 0, onEvent: (e) => events.push(e) });
  brain.setGoal(goal);
  let died = false;
  for (let i = 0; i < limit; i += 1) {
    if (events.some((e) => e.type === 'goal_done' || e.type === 'goal_failed')) break;
    if (!died && dieWhen()) { sim.die(); died = true; }
    await brain.tick();
    await brain.idle();
  }
  return { events, died };
}

const STATIONS = { crafting_table: { x: 1, y: 0, z: 0 }, furnace: { x: 2, y: 0, z: 0 } };
const COBBLEGEN = [{ key: 'water_bucket', count: 1 }, { key: 'lava_bucket', count: 1 }, { key: 'cobblestone', count: 10 }];

for (const seed of [1, 2, 3]) {
  test(`cobblestone generator materials end up in the chest from an empty inventory (seed ${seed})`, async () => {
    const sim = simulate({ seed });
    const goal = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 }, requirements: COBBLEGEN,
      stations: STATIONS, skills: sim.skills, actions: sim.actions });
    const { events } = await runGoal(sim, goal);
    assert.ok(events.some((e) => e.type === 'goal_done'), JSON.stringify(events.filter((e) => e.type === 'goal_failed')));
    assert.equal(sim.chest.water_bucket, 1);
    assert.equal(sim.chest.lava_bucket, 1);
    assert.ok(sim.chest.cobblestone >= 10);
    assert.deepEqual(sim.log.fills, ['water', 'lava']);
    assert.equal(sim.world.get('1,0,0'), 'crafting_table');
    assert.equal(sim.world.get('2,0,0'), 'furnace');
  });
}

test('a death loses only what was carried: stored materials are not gathered again', async () => {
  const sim = simulate({ seed: 7, failRate: 0.05 });
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 },
    requirements: [{ key: 'cobblestone', count: 5 }, { key: 'hopper', count: 1 }],
    stations: STATIONS, skills: sim.skills, actions: sim.actions });
  // Die once the cobblestone is stored and the hopper is under way.
  const { events, died } = await runGoal(sim, goal,
    { dieWhen: () => sim.chest.cobblestone >= 5 && (sim.inventory.raw_iron || 0) >= 2 });
  assert.ok(died);
  assert.ok(events.some((e) => e.type === 'goal_done'));
  assert.equal(sim.chest.cobblestone, 5);
  assert.equal(sim.chest.hopper, 1);
});

test('a chest that takes nothing fails instead of counting as progress', async () => {
  const sim = simulate({ failRate: 0 });
  sim.inventory.cobblestone = 10;
  sim.skills.storeInChest = async (_bot, _ctx, { wants }) => (wants.length
    ? { ok: false, reason: 'chest_full', contents: {} } : { ok: true, contents: {} });
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 }, requirements: [{ key: 'cobblestone', count: 10 }],
    stations: STATIONS, skills: sim.skills, actions: sim.actions });
  const { events } = await runGoal(sim, goal, { limit: 2000 });
  const failed = events.find((e) => e.type === 'goal_failed');
  assert.ok(failed);
  assert.ok(failed.reasons.includes('chest_full'));
});

test('a requirement already in the chest is done after one look', async () => {
  const sim = simulate({ failRate: 0 });
  sim.chest.cobblestone = 12;
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 }, requirements: [{ key: 'cobblestone', count: 10 }],
    stations: STATIONS, skills: sim.skills, actions: sim.actions });
  const { events } = await runGoal(sim, goal);
  assert.ok(events.some((e) => e.type === 'goal_done'));
  assert.equal(sim.log.stores, 1);
});

test('obsidian is cast with a diamond pickaxe, a water bucket and a lava bucket', () => {
  const obsidian = [{ key: 'obsidian', count: 10 }];
  const table = { crafting_table: true };
  const pick = planNext({ requirements: obsidian, inventory: { diamond: 3, stick: 2 }, stations: table });
  assert.deepEqual([pick.kind, pick.item], ['craft', 'diamond_pickaxe']);
  // An iron pickaxe does not mine obsidian.
  const mine = planNext({ requirements: obsidian, inventory: { iron_pickaxe: 1, stick: 2 }, stations: table });
  assert.deepEqual([mine.kind, mine.key], ['gather', 'diamond']);
  const water = planNext({ requirements: obsidian, inventory: { diamond_pickaxe: 1, bucket: 2 } });
  assert.deepEqual([water.kind, water.liquid], ['fill', 'water']);
  const lava = planNext({ requirements: obsidian, inventory: { diamond_pickaxe: 1, bucket: 1, water_bucket: 1 } });
  assert.deepEqual([lava.kind, lava.liquid], ['fill', 'lava']);
  const cast = planNext({ requirements: obsidian, inventory: { diamond_pickaxe: 1, lava_bucket: 1, water_bucket: 1, obsidian: 3 } });
  assert.deepEqual([cast.kind, cast.key, cast.count], ['cast', 'obsidian', 7]);
});

test('flint and steel takes an iron ingot and flint, which gravel only sometimes drops', () => {
  const step = planNext({ requirements: [{ key: 'flint_and_steel', count: 1 }], inventory: { iron_ingot: 1 } });
  assert.deepEqual([step.kind, step.key, step.rare], ['gather', 'flint', true]);
  assert.ok(step.blocks('gravel'));
  const craft = planNext({ requirements: [{ key: 'flint_and_steel', count: 1 }], inventory: { iron_ingot: 1, flint: 1 } });
  assert.deepEqual([craft.kind, craft.item, craft.table], ['craft', 'flint_and_steel', false]);
});

// One run of the goal straight from its run(), with the steps it planned.
async function runOnceWith(sim, goal) {
  const records = [];
  const ctx = { perceive: sim.perceive, record: (type, data) => records.push({ type, ...data }), signal: new AbortController().signal };
  const result = await goal.run(ctx);
  return { result, records, steps: records.filter((r) => r.type === 'plan_step') };
}

function quartzSim(inventory) {
  const sim = simulate({ failRate: 0 });
  Object.assign(sim.bot, { registry: { blocksByName: {} }, findBlocks: () => [] });
  sim.bot.inventory.slots = [];
  Object.assign(sim.inventory, inventory);
  sim.world.set('1,0,0', 'crafting_table');
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 }, requirements: [{ key: 'observer', count: 1 }],
    stations: STATIONS, skills: sim.skills, actions: sim.actions });
  goal.memory.chest = {};
  return { sim, goal };
}

test('quartz with no portal around first gathers the frame: obsidian, corners, flint and steel', async () => {
  const { sim, goal } = quartzSim({ iron_pickaxe: 1, cobblestone: 6, redstone: 2, diamond_pickaxe: 1, water_bucket: 1, lava_bucket: 1 });
  const first = await runOnceWith(sim, goal);
  assert.deepEqual(first.steps.map((s) => [s.kind, s.key, s.for]), [['cast', 'obsidian', 'obsidian']]);
  // Kit in the bag: the trip itself starts (and here finds no flat ground for a portal).
  Object.assign(sim.inventory, { obsidian: 10, cobblestone: 10, flint_and_steel: 1, iron_sword: 1 });
  const trip = await runOnceWith(sim, goal);
  assert.deepEqual(trip.steps.map((s) => [s.kind, s.key]), [['gather', 'quartz']]);
  assert.equal(trip.result.reason, 'no_portal_site');
  assert.equal(goal.memory.trip.target, 1);
});

test('in the Nether the goal only runs the trip, never walks to the chest', async () => {
  const { sim, goal } = quartzSim({ iron_pickaxe: 1 });
  sim.bot.game.dimension = 'the_nether';
  let walked = false;
  sim.actions.goNear = async () => { walked = true; return { ok: true }; };
  sim.actions.goTo = async () => ({ ok: false, reason: 'NoPath' });
  sim.skills.gatherOne = async () => ({ ok: false, reason: 'no_target_in_range' });
  const { result, steps } = await runOnceWith(sim, goal);
  assert.equal(steps.length, 0);
  assert.ok(goal.memory.trip);
  assert.equal(result.ok, false);
  assert.equal(walked, false);
  // Badly hurt with nothing to eat: the trip heads home (here: no portal known to head for).
  sim.bot.health = 5;
  sim.actions.pickFood = () => null;
  const hurt = await runOnceWith(sim, goal);
  assert.ok(hurt.records.some((r) => r.type === 'retreat'));
  assert.equal(hurt.result.reason, 'nether_portal_lost');
});

test('hunting spiders for string marks a night hunt; other steps clear it', async () => {
  const sim = simulate({ failRate: 0 });
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 }, requirements: [{ key: 'string', count: 3 }],
    stations: STATIONS, skills: sim.skills, actions: sim.actions });
  await runGoal(sim, goal, { limit: 3 });
  assert.equal(sim.bot.companionNightHunt?.key, 'string');
  const other = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 }, requirements: [{ key: 'cobblestone', count: 3 }],
    stations: STATIONS, skills: sim.skills, actions: sim.actions });
  await runGoal(sim, other, { limit: 3 });
  assert.equal(sim.bot.companionNightHunt, null);
});

test('a carried requirement stays in the bag and counts there, never stored', async () => {
  const sim = simulate({ seed: 4, failRate: 0 });
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 },
    requirements: [{ key: 'stone_pickaxe', count: 1 }, { key: 'cobblestone', count: 3 }],
    stations: STATIONS, skills: sim.skills, actions: sim.actions, carry: (key) => key === 'stone_pickaxe' });
  const { events } = await runGoal(sim, goal);
  assert.ok(events.some((e) => e.type === 'goal_done'), JSON.stringify(events.filter((e) => e.type === 'goal_failed')));
  assert.ok(!sim.chest.stone_pickaxe, JSON.stringify(sim.chest));
  assert.ok(sim.inventory.stone_pickaxe >= 1);
  assert.ok(sim.chest.cobblestone >= 3);
});
