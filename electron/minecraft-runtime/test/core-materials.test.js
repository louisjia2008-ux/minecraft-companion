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
const { gatherOne } = require('../core/skills');

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

test('surface resupply skips deep and buried stone and refuses a branch-mining requirement', async () => {
  const sim = simulate({ failRate: 0 });
  sim.inventory.stone_pickaxe = 1;
  const exposed = new Vec3(1, -1, 2);
  sim.bot.blockAt = (p) => {
    const name = p.x === 0 && p.y === 0 && p.z === 0 ? 'chest'
      : p.equals(exposed) || p.x >= 3 && p.y <= 0 || p.y < -1 ? 'stone' : 'air';
    return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: p,
      shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] };
  };
  const ctx = { perceive: sim.perceive, record() {}, signal: new AbortController().signal };
  let gathered = 0;
  const skills = { ...sim.skills, gatherOne: async (_bot, _ctx, { targetFilter, acceptStand }) => {
    gathered += 1;
    assert.equal(targetFilter(exposed), true, 'a dry supported cell reaches the exposed face');
    assert.equal(targetFilter(new Vec3(1, -9, 2)), false);
    assert.equal(targetFilter(new Vec3(4, -1, 2)), false, 'no dry exposed face');
    assert.equal(acceptStand(exposed.offset(0, 1, 0), exposed), false, 'the bot cannot mine its own support');
    return { ok: true };
  } };
  const goal = (key) => createGatherMaterialsGoal({
    bot: sim.bot, chest: { x: 0, y: 0, z: 0 }, requirements: [{ key, count: 1 }],
    stations: STATIONS, skills, actions: sim.actions, surfaceOnly: true,
  });
  const stone = goal('cobblestone');
  await stone.run(ctx);
  assert.equal((await stone.run(ctx)).ok, true);
  const iron = goal('raw_iron');
  await iron.run(ctx);
  assert.equal((await iron.run(ctx)).reason, 'surface_supply_requires_mine');
  assert.equal(gathered, 1);
});

test('surface resupply filters buried blocks before Mineflayer caps the stone search', async () => {
  const sim = simulate({ failRate: 0 });
  const exposed = new Vec3(8, 0, 2);
  const buried = Array.from({ length: 64 }, (_, i) => new Vec3(1 + i % 8, -2 - Math.floor(i / 32), 1 + Math.floor(i / 8) % 4));
  sim.inventory.stone_pickaxe = 1;
  sim.bot.registry = { blocksByName: { stone: { name: 'stone', id: 1 } } };
  sim.bot.entity.onGround = true;
  sim.bot.world = { raycast: () => ({ position: exposed }) };
  sim.bot.entities = {};
  sim.bot.blockAt = (p) => {
    const at = p.floored();
    const name = at.x === 0 && at.y === 0 && at.z === 0 ? 'chest' : at.equals(exposed) || at.y < 0 ? 'stone' : 'air';
    return { name, position: at, type: name === 'stone' ? 1 : 0, boundingBox: name === 'air' ? 'empty' : 'block',
      shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] };
  };
  sim.bot.findBlocks = ({ matching, count, useExtraInfo }) => {
    assert.deepEqual(matching, [1]);
    assert.equal(count, 64);
    assert.equal(typeof useExtraInfo, 'function');
    const found = [...buried, exposed].filter((p) => useExtraInfo(sim.bot.blockAt(p))).slice(0, count);
    assert.deepEqual(found, [exposed]);
    return found;
  };
  sim.bot.pathfinder = { goto: async (goal) => {
    const stance = new Vec3(7, 0, 2);
    assert.ok(goal.isEnd(stance));
    sim.bot.entity.position = stance.offset(.5, 0, .5);
  } };
  // Stop after the native selector and stance have run. Mining is covered by
  // the action tests; the rejected dig must not be replaced with exploration.
  sim.bot.canDigBlock = () => false;
  const skills = { ...sim.skills, gatherOne, explore: async () => assert.fail('exposed stone survived the native count limit') };
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 },
    requirements: [{ key: 'cobblestone', count: 1 }], surfaceOnly: true, skills });
  const selected = [];
  const ctx = { perceive: sim.perceive, record: (type, data) => { if (type === 'target_selected') selected.push(data.position); } };
  await goal.run(ctx);
  assert.equal((await goal.run(ctx)).reason, 'cannot_dig');
  assert.deepEqual(selected, ['8,0,2']);
});

test('surface resupply replaces failed exposed stone pickup with a nearby quarry and exits before crafting', async () => {
  const sim = simulate({ failRate: 0 });
  const chest = new Vec3(0, 72, 0);
  const table = chest.offset(1, 0, 0);
  const origin = new Vec3(5, 72, -5);
  const remote = new Vec3(27, 72, -5);
  const position = (p) => `${p.x},${p.y},${p.z}`;
  const placed = new Map([[position(chest), 'chest'], [position(table), 'crafting_table']]);
  const pick = { name: 'wooden_pickaxe', type: 1 };
  const columns = [];
  const touched = [];
  const events = [];
  const cuts = [];
  sim.bot.entity = { position: origin.offset(.5, 0, .5), onGround: true };
  const inventoryItems = sim.bot.inventory.items;
  sim.bot.inventory.items = () => inventoryItems().map((item) => item.name === pick.name ? { ...item, type: pick.type } : item);
  Object.assign(sim.inventory, { wooden_pickaxe: 1, stick: 1 });
  sim.bot.companionHomeSite = (p) => Math.abs(p.x) <= 2 && Math.abs(p.z) <= 2;
  sim.bot.blockAt = (p) => {
    const name = placed.get(position(p)) || (p.y >= 72 ? 'air' : p.y >= 70 ? 'dirt' : 'stone');
    return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', diggable: name !== 'air',
      shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], ...(name === 'stone' ? { harvestTools: { [pick.type]: true } } : {}) };
  };
  const neighbors = () => columns;
  const movements = { canDig: true, getNeighbors: neighbors };
  sim.bot.pathfinder = { movements };
  const actions = {
    goTo: async (_bot, _ctx, goal, options) => {
      const at = new Vec3(goal.x, goal.y, goal.z);
      columns.splice(0, columns.length, at, remote);
      assert.ok(movements.getNeighbors(sim.bot.entity.position.floored()).includes(at));
      assert.equal(movements.getNeighbors(sim.bot.entity.position.floored()).includes(remote), false);
      assert.equal(options.retryNoProgress, false);
      touched.push(at);
      sim.bot.entity.position = at.offset(.5, 0, .5);
      return { ok: true };
    },
    digBlock: async (_bot, _ctx, block) => {
      assert.ok(movements.companionWalkOnly);
      assert.ok(!block.position.equals(sim.bot.entity.position.floored().offset(0, -1, 0)));
      assert.ok(!sim.bot.companionHomeSite(block.position));
      assert.ok(Math.hypot(block.position.x, block.position.z) <= 24);
      cuts.push(block.position);
      placed.set(position(block.position), 'air');
      return { ok: true };
    },
    collectDrops: async (_bot, _ctx, p, match) => {
      assert.ok(match('cobblestone'));
      assert.ok(sim.bot.entity.position.distanceTo(p) <= 2);
      sim.inventory.cobblestone = (sim.inventory.cobblestone || 0) + 1;
      return { ok: true, gained: 1 };
    },
    unstick: async () => assert.fail('recovery quarry must retain its own approach'),
  };
  let exposedAttempts = 0;
  const skills = { ...sim.skills,
    storeInChest: async (_bot, _ctx, { wants }) => {
      assert.deepEqual(wants, []);
      return { ok: true, contents: {} };
    },
    gatherOne: async (_bot, _ctx, options) => {
      exposedAttempts += 1;
      assert.ok(options.blocks('stone'));
      assert.ok(movements.companionWalkOnly);
      assert.equal(options.targetFilter(remote.offset(0, -1, 0)), false);
      return { ok: false, reason: 'drops_not_collected' };
    },
    craft: async (_bot, _ctx, { item }) => {
      assert.equal(item, 'stone_sword');
      assert.equal(sim.bot.entity.position.y, 72, 'craft only after the quarry stairs were retraced');
      assert.ok(sim.inventory.cobblestone >= 2);
      sim.inventory.stone_sword = 1;
      return { ok: true };
    },
    explore: async () => assert.fail('an unarmed resupply should not explore for cobblestone'),
  };
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest, stations: { crafting_table: table },
    requirements: [{ key: 'stone_sword', count: 1 }], surfaceOnly: true, skills, actions, carry: (key) => key === 'stone_sword' });
  const ctx = { perceive: sim.perceive, record: (type, data) => events.push([type, data]), signal: new AbortController().signal };
  for (let n = 0; n < 25 && !goal.isDone(ctx.perceive()); n++) {
    const result = await goal.run(ctx);
    assert.equal(result.ok, true, JSON.stringify({ result, last: events.slice(-2) }));
  }
  assert.equal(goal.isDone(ctx.perceive()), true);
  assert.equal(exposedAttempts, 1);
  assert.equal(events.filter(([type]) => type === 'quarry_start').length, 1);
  assert.ok(events.some(([type]) => type === 'quarry_exit'));
  assert.ok(touched.some((p) => p.y < origin.y));
  assert.ok(cuts.every((p) => p.y >= chest.y - 8));
  assert.equal(movements.canDig, true);
  assert.equal(movements.getNeighbors, neighbors);
});

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
  // Quartz trip fixtures carry the new safe-food reserve; dedicated supply
  // tests cover the real post-death empty-food state separately.
  Object.assign(sim.inventory, { cooked_beef: 4 }, inventory);
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
  delete sim.inventory.cooked_beef;
  sim.actions.pickFood = () => null;
  const hurt = await runOnceWith(sim, goal);
  assert.ok(hurt.records.some((r) => r.type === 'retreat'));
  assert.equal(hurt.result.reason, 'nether_portal_lost');
});

for (const trigger of ['recovery', 'pathFailures']) {
  test(`material ${trigger} in the Nether delegates to its trip instead of overworld chest coordinates`, async () => {
    const sim = simulate({ failRate: 0 });
    sim.bot.game.dimension = 'the_nether';
    sim.bot.entity.position = new Vec3(101627.5, 70, -35.5);
    const chest = { x: 813000, y: 3, z: 0 };
    const goal = createGatherMaterialsGoal({ bot: sim.bot, chest, requirements: [{ key: 'quartz', count: 8 }],
      skills: sim.skills, actions: sim.actions });
    sim.actions.unstick = async () => { throw new Error('generic unstick must not bypass the Nether trip'); };
    sim.actions.goNear = async () => { throw new Error('overworld chest cannot be a Nether waypoint'); };
    let calls = 0;
    const expected = { ok: false, reason: 'nether_route_blocked' };
    const trip = { target: 8, run: async () => { calls += 1; return expected; } };
    goal.memory.trip = trip;
    if (trigger === 'recovery') goal.recover();
    else goal.memory.pathFailures = 2;
    const { result, records } = await runOnceWith(sim, goal);
    assert.equal(result, expected);
    assert.equal(calls, 1);
    assert.equal(goal.memory.trip, trip);
    assert.equal(goal.memory.recovery, false);
    assert.equal(goal.memory.pathFailures, 0);
    assert.ok(records.some((r) => r.type === 'recovery' && r.dimension === 'the_nether' && r.delegate === 'nether_trip'));
  });
}

test('material recovery in the overworld still unsticks and walks home', async () => {
  const sim = simulate({ failRate: 0 });
  const chest = { x: 120, y: 3, z: 40 };
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest, requirements: [{ key: 'quartz', count: 8 }],
    skills: sim.skills, actions: sim.actions });
  const calls = [];
  sim.actions.unstick = async () => { calls.push('unstick'); return { ok: true }; };
  sim.actions.goNear = async (_bot, _ctx, p, range) => { calls.push([p.x, p.y, p.z, range]); return { ok: true }; };
  goal.recover();
  assert.equal((await runOnceWith(sim, goal)).result.ok, true);
  assert.deepEqual(calls, ['unstick', [120, 3, 40, 3]]);
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

function bowFixture({ health = 20, food = 20 } = {}) {
  const sim = simulate({ failRate: 0 });
  const local = { id: 1, name: 'spider', position: new Vec3(8.5, 0, .5) };
  const far = { id: 2, name: 'spider', position: new Vec3(55.5, 0, .5) };
  const underground = { id: 3, name: 'spider', position: new Vec3(7.5, -9, .5) };
  const caveSpider = { id: 4, name: 'cave_spider', position: new Vec3(6.5, 0, .5) };
  const aboveCave = new Vec3(9, 2, 0);
  sim.inventory.stick = 3;
  const original = sim.bot.blockAt;
  sim.bot.blockAt = (p) => {
    const name = p.equals(aboveCave) ? 'stone' : original(p).name;
    return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block',
      shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] };
  };
  const dry = new Vec3(8, 0, 0);
  const tooFar = new Vec3(55, 0, 0);
  const underRoof = new Vec3(9, 0, 0);
  const breaking = { x: 6, y: 0, z: 0, toBreak: [new Vec3(6, 0, 0)] };
  const neighbors = () => [dry, tooFar, underRoof, breaking];
  const movements = { canDig: true, getNeighbors: neighbors };
  const records = [];
  Object.assign(sim.bot, { health, food, entities: { 1: local, 2: far, 3: underground, 4: caveSpider },
    pathfinder: { movements } });
  const ctx = { perceive: () => ({ ...sim.perceive(), health: sim.bot.health, food: sim.bot.food }),
    record: (name) => records.push(name), signal: new AbortController().signal };
  const create = () => createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 },
    stations: STATIONS, requirements: [{ key: 'bow', count: 1 }], countWorn: true, actions: sim.actions,
    skills: { ...sim.skills, explore: () => assert.fail('bow hunt must not roam'), ...sim.bowSkills } });
  return { sim, local, far, underground, caveSpider, dry, neighbors, movements, ctx, create, records };
}

test('outfit hunts only local surface spiders along a walk-only route and releases the profile', async () => {
  const f = bowFixture();
  f.sim.bowSkills = { huntOne: async (_bot, _ctx, options) => {
    assert.deepEqual(options.mobs, ['spider']);
    assert.ok(options.accept(f.local));
    for (const blocked of [f.far, f.underground, f.caveSpider]) assert.equal(options.accept(blocked), false);
    assert.equal(f.movements.canDig, false);
    assert.deepEqual(f.movements.getNeighbors(f.sim.bot.entity.position.floored()), [f.dry]);
    assert.equal(f.sim.bot.companionNightHunt?.key, 'string');
    return { ok: true, gained: 1 };
  } };
  const goal = f.create();
  await goal.run(f.ctx);
  assert.equal((await goal.run(f.ctx)).gained, 1);
  assert.equal(goal.ownsRouteRecovery(), true);
  assert.equal(f.sim.bot.companionNightHunt, null);
  assert.equal(f.movements.getNeighbors, f.neighbors);
  assert.equal(f.movements.canDig, true);
});

test('low health returns by a dry route and uses available food before bow hunts', async () => {
  const f = bowFixture({ health: 3, food: 17 });
  f.sim.bot.entity.position = new Vec3(9.5, 0, 1.5);
  let took = 0;
  f.sim.bowSkills = { huntOne: () => assert.fail('low health forbids a bow hunt'),
    takeItems: async (_bot, _ctx, { itemMatch }) => {
      assert.equal(itemMatch('bread'), true);
      assert.equal(itemMatch('chicken'), false);
      took += 1;
      return { ok: true, taken: 1 };
    } };
  f.sim.actions.goNear = async (_bot, _ctx, target, _radius, options) => {
    assert.deepEqual(target, new Vec3(.5, 0, .5));
    assert.equal(options.retryNoProgress, false);
    assert.equal(f.movements.canDig, false);
    f.sim.bot.entity.position = target;
    return { ok: true };
  };
  const goal = f.create();
  await goal.run(f.ctx);
  assert.equal((await goal.run(f.ctx)).progress, false);
  assert.equal((await goal.run(f.ctx)).taken, 1);
  assert.equal(took, 1);
  assert.equal(f.sim.bot.companionNightHunt, null);
  assert.equal(f.movements.getNeighbors, f.neighbors);
});

test('an ongoing outfit spider pursuit aborts on injury and lets recovery take over', async () => {
  const f = bowFixture();
  f.sim.bowSkills = { huntOne: async (_bot, ctx) => {
    f.sim.bot.health = 9;
    const { sleep } = require('../core/confirm');
    await sleep(500, ctx.signal);
    assert.fail('unsafe hunt should cancel its pursuit');
  } };
  const goal = f.create();
  await goal.run(f.ctx);
  assert.equal((await goal.run(f.ctx)).reason, 'bow_string_unsafe');
  assert.equal(f.sim.bot.companionNightHunt, null);
  assert.equal(f.movements.getNeighbors, f.neighbors);
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

test('a mine that comes to nothing is started again on another side of the house, farther out', async () => {
  const mining = require('../core/mining');
  const sim = simulate({ seed: 2, failRate: 0 });
  Object.assign(sim.inventory, { stone_pickaxe: 9, stick: 9, chest: 1, crafting_table: 1, torch: 4 });
  sim.chest.cobblestone = 1;
  sim.bot.entity.onGround = true;
  const read = sim.bot.blockAt;
  sim.bot.blockAt = (p) => {
    const block = read(p);
    return { ...block, skyLight: 15, boundingBox: block.name === 'air' ? 'empty' : 'block',
      shapes: block.name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] };
  };
  const targets = [];
  sim.actions.goNear = async (_b, _c, p) => {
    targets.push(p.clone());
    sim.bot.entity.position = p.offset(.5, 0, .5);
    return { ok: true };
  };
  // No ore in the open: it has to be mined.
  sim.skills.gatherOne = async () => ({ ok: false, reason: 'no_target_in_range' });
  const mineStep = mining.mineStep;
  // Sand everywhere: every staircase is blocked and the mine exhausted at once.
  mining.mineStep = async (_bot, _ctx, memory) => { memory.mineDir = ((memory.mineDir ?? 0) + 1) % 4; return { ok: false, reason: 'mine_exhausted' }; };
  try {
    const goal = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 }, requirements: [{ key: 'raw_iron', count: 1 }],
      stations: STATIONS, skills: sim.skills, actions: sim.actions });
    const ctx = { perceive: sim.perceive, record() {}, signal: new AbortController().signal };
    for (let i = 0; i < 12 && targets.length < 3; i += 1) await goal.run(ctx);
  } finally { mining.mineStep = mineStep; }
  assert.ok(targets.length >= 3, JSON.stringify(targets));
  const spots = targets.slice(0, 3).map((t) => `${t.x},${t.z}`);
  assert.equal(new Set(spots).size, 3, spots.join(' '));
  const reach = targets.slice(0, 3).map((t) => Math.hypot(t.x, t.z));
  assert.ok(reach[2] > reach[0], reach.join(' '));
});

test('an exhausted mine beyond the home boundary surfaces and confirms a different shaft before mining', async () => {
  const mining = require('../core/mining');
  const sim = simulate({ failRate: 0 });
  Object.assign(sim.inventory, { stone_pickaxe: 5 });
  const old = new Vec3(-5, 62, -41);
  const chest = new Vec3(-4, 72, -29);
  sim.bot.entity.position = old.clone();
  sim.bot.entity.onGround = true;
  sim.bot.blockAt = (p) => {
    const name = p.equals(chest) ? 'chest' : p.y < 72 ? 'stone' : 'air';
    return { name, skyLight: 15, boundingBox: name === 'air' ? 'empty' : 'block',
      shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] };
  };
  sim.skills.gatherOne = async () => ({ ok: false, reason: 'no_target_in_range' });
  const events = [];
  let health = 3;
  let walks = 0;
  sim.actions.underground = (bot) => bot.entity.position.y < 72;
  sim.actions.surface = async () => {
    events.push('surface');
    sim.bot.entity.position = old.offset(0, 10, 0);
    return { ok: true };
  };
  sim.actions.goNear = async (_bot, _ctx, target) => {
    events.push(target);
    walks += 1;
    // The first simulated navigation reports success but the body stayed at
    // the shaft; do not create a new mine at that position.
    if (walks > 1) sim.bot.entity.position = target.offset(.5, 0, .5);
    return { ok: true };
  };
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest, requirements: [{ key: 'raw_iron', count: 2 }],
    skills: sim.skills, actions: sim.actions });
  goal.memory.chest = {};
  goal.memory.mine = { entrance: old, front: old };
  const nativeMineStep = mining.mineStep;
  const starts = [];
  mining.mineStep = async (_bot, _ctx, memory, { start }) => {
    if (memory.mine) { memory.mine = null; memory.mineDir = 1; return { ok: false, reason: 'mine_exhausted' }; }
    starts.push(start);
    return { ok: true, progress: true };
  };
  try {
    const ctx = { perceive: () => ({ ...sim.perceive(), health }), record() {}, signal: new AbortController().signal };
    assert.equal((await goal.run(ctx)).reason, 'mine_exhausted');
    assert.equal((await goal.run(ctx)).reason, 'mine_restart_waiting_for_retreat');
    assert.deepEqual(events, []);
    health = 20;
    await goal.run(ctx);
    assert.deepEqual(events, ['surface']);
    assert.equal((await goal.run(ctx)).reason, 'mine_restart_site_unconfirmed');
    assert.deepEqual(starts, []);
    await goal.run(ctx);
    assert.deepEqual(starts, []);
    await goal.run(ctx);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].y, 72);
    assert.ok(Math.hypot(starts[0].x - old.x, starts[0].z - old.z) >= 8);
    assert.ok(Math.hypot(starts[0].x - chest.x, starts[0].z - chest.z) >= 8);
  } finally {
    mining.mineStep = nativeMineStep;
  }
});

test('a mine restart can walk out from an overhang where height-based surfacing has no route', async () => {
  const sim = simulate({ failRate: 0 });
  Object.assign(sim.inventory, { stone_pickaxe: 5 });
  const chest = new Vec3(-4, 72, -29);
  const old = new Vec3(-5, 71, -41);
  sim.bot.entity.position = old;
  sim.bot.entity.onGround = true;
  sim.bot.blockAt = (p) => {
    const name = p.equals(chest) ? 'chest' : p.y < 72 ? 'stone' : 'air';
    return { name, skyLight: 15, boundingBox: name === 'air' ? 'empty' : 'block',
      shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] };
  };
  sim.skills.gatherOne = async () => ({ ok: false, reason: 'no_target_in_range' });
  sim.actions.underground = () => true;
  sim.actions.surface = async () => null;
  let walks = 0;
  sim.actions.goNear = async (_bot, _ctx, target) => {
    walks += 1;
    sim.bot.entity.position = target.offset(.5, 0, .5);
    return { ok: true };
  };
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest, requirements: [{ key: 'raw_iron', count: 2 }],
    skills: sim.skills, actions: sim.actions });
  goal.memory.chest = {};
  goal.memory.mineRestart = { barren: 1, attempt: 0, avoid: [old] };
  const ctx = { perceive: () => ({ ...sim.perceive(), health: 20 }), record() {}, signal: new AbortController().signal };
  assert.deepEqual(await goal.run(ctx), { ok: true, progress: false });
  assert.equal(walks, 1);
  assert.equal(goal.memory.mineRestart.arrived.y, 72);
  assert.equal(goal.memory.mine, null);
});

test('far below the chest, the walk home starts by going up', async () => {
  const sim = simulate({ failRate: 0 });
  sim.bot.entity.position = new Vec3(-17, -40, -37);
  const calls = [];
  sim.actions.surface = async () => { calls.push('surface'); sim.bot.entity.position = new Vec3(-17, 2, -37); return { ok: true, surfaced: true }; };
  const storeInChest = sim.skills.storeInChest;
  sim.skills.storeInChest = async (...args) => { calls.push('store'); return storeInChest(...args); };
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 }, requirements: [{ key: 'cobblestone', count: 3 }],
    stations: STATIONS, skills: sim.skills, actions: sim.actions });
  const ctx = { perceive: sim.perceive, record() {}, signal: new AbortController().signal };
  await goal.run(ctx);
  assert.deepEqual(calls, ['surface']);
  await goal.run(ctx);
  assert.deepEqual(calls, ['surface', 'store']);
});

test('a chest blown up is made again and put back where it stood', async () => {
  const sim = simulate({ failRate: 0 });
  sim.world.set('0,0,0', 'air');
  Object.assign(sim.inventory, { oak_planks: 8 });
  sim.world.set('1,0,0', 'crafting_table');
  const placed = [];
  const placeAt = sim.skills.placeAt;
  sim.skills.placeAt = async (b, c, spot, match, opts) => { placed.push(`${spot.x},${spot.y},${spot.z}`); return placeAt(b, c, spot, match, opts); };
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 }, requirements: [{ key: 'cobblestone', count: 3 }],
    stations: STATIONS, skills: sim.skills, actions: sim.actions });
  const ctx = { perceive: sim.perceive, record() {}, signal: new AbortController().signal };
  for (let i = 0; i < 4 && !placed.includes('0,0,0'); i += 1) await goal.run(ctx);
  assert.ok(placed.includes('0,0,0'), placed.join(' '));
  assert.equal(sim.world.get('0,0,0'), 'chest');
});

test('what the caller already counted in the bag is not stored as delivered', async () => {
  const sim = simulate({ seed: 5, failRate: 0 });
  sim.inventory.cobblestone = 57;
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 },
    requirements: [{ key: 'cobblestone', count: 7 }], reserved: { cobblestone: 57 },
    stations: STATIONS, skills: sim.skills, actions: sim.actions });
  const { events } = await runGoal(sim, goal);
  assert.ok(events.some((e) => e.type === 'goal_done'), JSON.stringify(events.filter((e) => e.type === 'goal_failed')));
  assert.ok(sim.chest.cobblestone >= 7);
  assert.ok(sim.inventory.cobblestone + sim.chest.cobblestone >= 64, 'seven more were gathered, not seven moved');
});

test('outfit opted-in armour already worn counts as delivered, not as something to store', async () => {
  const sim = simulate({ seed: 6, failRate: 0 });
  // Crafted, then put on at once by wear_armor: perception still lists it.
  sim.inventory.iron_helmet = 1;
  sim.bot.inventory.slots = [];
  sim.bot.inventory.slots[5] = { name: 'iron_helmet', count: 1 };
  const stores = [];
  const storeInChest = sim.skills.storeInChest;
  sim.skills.storeInChest = async (b, c, opts) => { stores.push(opts.wants.length); return storeInChest(b, c, opts); };
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 },
    requirements: [{ key: 'iron_helmet', count: 1 }], stations: STATIONS, skills: sim.skills, actions: sim.actions, countWorn: true });
  const { events } = await runGoal(sim, goal);
  assert.ok(events.some((e) => e.type === 'goal_done'), JSON.stringify(events.filter((e) => e.type === 'goal_failed')));
  assert.ok(stores.every((n) => n === 0), 'only the chest check, nothing stored');
});

test('ordinary chest-only armour collection gathers a separate helmet instead of delivering the worn one', async () => {
  const sim = simulate({ failRate: 0 });
  Object.assign(sim.inventory, { iron_helmet: 1, iron_ingot: 5 });
  sim.bot.inventory.slots = [];
  sim.bot.inventory.slots[5] = { name: 'iron_helmet', count: 1 };
  sim.world.set('1,0,0', 'crafting_table');
  let crafted = 0;
  sim.skills.craft = async (_bot, _ctx, { item }) => {
    assert.equal(item, 'iron_helmet');
    assert.equal(sim.inventory.iron_ingot, 5);
    sim.inventory.iron_ingot -= 5;
    sim.inventory.iron_helmet += 1;
    crafted += 1;
    return { ok: true };
  };
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 }, requirements: [{ key: 'iron_helmet', count: 1 }],
    stations: STATIONS, skills: sim.skills, actions: sim.actions });
  goal.memory.chest = {};
  assert.equal(goal.isDone(sim.perceive()), false, 'empty chest cannot be completed by a worn helmet');
  const ctx = { perceive: sim.perceive, record() {}, signal: new AbortController().signal };
  for (let i = 0; i < 3 && !goal.isDone(sim.perceive()); i += 1) await goal.run(ctx);
  assert.equal(goal.isDone(sim.perceive()), true);
  assert.equal(crafted, 1);
  assert.equal(sim.chest.iron_helmet, 1);
  assert.equal(sim.inventory.iron_helmet, 1, 'the equipped helmet stays owned');
  assert.equal(sim.bot.inventory.slots[5].name, 'iron_helmet');
});

for (const { name, key, slot, count, reserved = {}, carry = () => false } of [
  { name: 'reserved helmet already worn', key: 'iron_helmet', slot: 5, count: 1, reserved: { iron_helmet: 1 } },
  { name: 'reserved shield in offhand', key: 'shield', slot: 45, count: 1, reserved: { shield: 1 }, carry: () => true },
  { name: 'one offhand shield toward two', key: 'shield', slot: 45, count: 2, carry: () => true },
  { name: 'reserved carried sword', key: 'iron_sword', count: 1, reserved: { iron_sword: 1 }, carry: () => true },
]) {
  test(`delivery credit does not count ${name} twice`, () => {
    const sim = simulate({ failRate: 0 });
    sim.inventory[key] = 1;
    sim.bot.inventory.slots = [];
    if (slot) sim.bot.inventory.slots[slot] = { name: key, count: 1 };
    const goal = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 }, requirements: [{ key, count }],
      countWorn: true, reserved, carry, skills: sim.skills, actions: sim.actions });
    goal.memory.chest = {};
    assert.equal(goal.isDone(sim.perceive()), false);
    assert.deepEqual(goal.owed(sim.perceive().inventory), [{ key, count: 1 }]);
    sim.inventory[key] += 1;
    if (carry(key)) assert.equal(goal.isDone(sim.perceive()), true, 'exactly one new unreserved item discharges the shortfall');
  });
}

test('a carry request for two swords crafts the missing second one without reusing its delivery credit', async () => {
  const sim = simulate({ failRate: 0 });
  Object.assign(sim.inventory, { iron_sword: 1, iron_ingot: 2, stick: 1 });
  sim.world.set('1,0,0', 'crafting_table');
  let crafted = 0;
  sim.skills.craft = async (_bot, _ctx, { item }) => {
    assert.equal(item, 'iron_sword');
    sim.inventory.iron_ingot -= 2;
    sim.inventory.stick -= 1;
    sim.inventory.iron_sword += 1;
    crafted += 1;
    return { ok: true };
  };
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 }, requirements: [{ key: 'iron_sword', count: 2 }],
    carry: (key) => key === 'iron_sword', stations: STATIONS, skills: sim.skills, actions: sim.actions });
  goal.memory.chest = {};
  await goal.run({ perceive: sim.perceive, record() {}, signal: new AbortController().signal });
  assert.equal(crafted, 1);
  assert.equal(goal.isDone(sim.perceive()), true);
  assert.equal(sim.inventory.iron_sword, 2);
  assert.equal(sim.chest.iron_sword, undefined, 'carry semantics remain enabled');
});

test('reserved equipment is removed once, leaving a newly gathered bag item available for the chest', async () => {
  const sim = simulate({ failRate: 0 });
  sim.inventory.iron_helmet = 2; // one reserved worn, one newly made in the bag
  sim.bot.inventory.slots = [];
  sim.bot.inventory.slots[5] = { name: 'iron_helmet', count: 1 };
  const goal = createGatherMaterialsGoal({ bot: sim.bot, chest: { x: 0, y: 0, z: 0 }, requirements: [{ key: 'iron_helmet', count: 1 }],
    reserved: { iron_helmet: 1 }, countWorn: true, skills: sim.skills, actions: sim.actions });
  goal.memory.chest = {};
  await goal.run({ perceive: sim.perceive, record() {}, signal: new AbortController().signal });
  assert.equal(sim.chest.iron_helmet, 1);
  assert.equal(sim.inventory.iron_helmet, 1);
  assert.equal(goal.isDone(sim.perceive()), true);
});
