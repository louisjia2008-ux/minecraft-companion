'use strict';
// Drives the full homestead goal through the real brain and planner against a
// simulated world, including random action failures and a death that wipes
// the inventory halfway. Checks the goal logic, not Minecraft physics.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createBrain } = require('../core/brain');
const { createHomesteadGoal } = require('../core/goals/homestead');
const { createStarterHouse } = require('../core/blueprints/starterHouse');

const RECIPES = {
  oak_planks: [{ oak_log: 1 }, 4], stick: [{ oak_planks: 2 }, 4], crafting_table: [{ oak_planks: 4 }, 1],
  wooden_pickaxe: [{ oak_planks: 3, stick: 2 }, 1], stone_pickaxe: [{ cobblestone: 3, stick: 2 }, 1],
  stone_sword: [{ cobblestone: 2, stick: 1 }, 1], furnace: [{ cobblestone: 8 }, 1],
  iron_sword: [{ iron_ingot: 2, stick: 1 }, 1], iron_pickaxe: [{ iron_ingot: 3, stick: 2 }, 1],
  shield: [{ iron_ingot: 1, oak_planks: 6 }, 1], torch: [{ coal: 1, stick: 1 }, 4],
  white_bed: [{ white_wool: 3, oak_planks: 3 }, 1], chest: [{ oak_planks: 8 }, 1], oak_door: [{ oak_planks: 6 }, 3],
};
const TABLE_FREE = new Set(['oak_planks', 'stick', 'crafting_table', 'torch']);

function simulate({ seed = 1, failRate = 0.15, deathAtStep = null } = {}) {
  let random = seed;
  const rng = () => { random = (random * 1103515245 + 12345) % 2147483648; return random / 2147483648; };
  const world = new Map();
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const blockAt = (p) => {
    const name = world.get(key(p)) ?? (p.y < -3 ? 'stone' : p.y < 0 ? 'dirt' : p.y === 0 ? 'grass_block' : 'air');
    return { name, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
      boundingBox: ['air', 'short_grass', 'torch'].includes(name) ? 'empty' : 'block' };
  };
  const inventory = {};
  const add = (name, n = 1) => { inventory[name] = (inventory[name] || 0) + n; };
  const take = (name, n = 1) => {
    assert.ok((inventory[name] || 0) >= n, `missing ${n} ${name}`);
    inventory[name] -= n;
    if (!inventory[name]) delete inventory[name];
  };
  const bot = {
    entity: { position: new Vec3(0.5, 1, 0.5) },
    blockAt,
    inventory: { items: () => Object.entries(inventory).map(([name, count]) => ({ name, count })) },
  };
  const log = { steps: 0, deaths: 0, failures: 0, chest: null, crafts: [] };
  const flaky = (result) => {
    if (rng() < failRate) { log.failures += 1; return { ok: false, reason: 'simulated_failure' }; }
    return result();
  };
  const has = (n) => (inventory[n] || 0) > 0;

  const skills = {
    gatherOne: async (_bot, _ctx, { blocks }) => flaky(() => {
      if (blocks('oak_log')) add('oak_log');
      else if (blocks('stone')) add('cobblestone');
      else if (blocks('coal_ore')) add('coal');
      else if (blocks('iron_ore')) {
        if (!['stone_pickaxe', 'iron_pickaxe'].some(has)) return { ok: false, reason: 'no_tool' };
        add('raw_iron');
      } else if (blocks('dirt')) add('dirt');
      else return { ok: false, reason: 'no_target_in_range' };
      return { ok: true };
    }),
    craft: async (_bot, _ctx, { item, times, tablePosition }) => flaky(() => {
      const [needs, yields] = RECIPES[item];
      if (!TABLE_FREE.has(item) && !tablePosition) return { ok: false, reason: 'no_recipe' };
      if (tablePosition && blockAt(tablePosition).name !== 'crafting_table') return { ok: false, reason: 'table_missing' };
      for (let i = 0; i < times; i += 1) {
        if (!Object.entries(needs).every(([n, c]) => (inventory[n] || 0) >= c)) break;
        for (const [n, c] of Object.entries(needs)) take(n, c);
        add(item, yields);
      }
      log.crafts.push(item);
      return { ok: true, usedTable: Boolean(tablePosition) };
    }),
    placeAt: async (_bot, _ctx, position, match, options = {}) => flaky(() => {
      if (match(blockAt(position).name)) return { ok: true, already: true };
      const item = Object.keys(inventory).find(match);
      if (!item) return { ok: false, reason: 'no_material' };
      take(item);
      world.set(key(position), item);
      if (item.endsWith('_bed')) world.set(key({ ...position, z: position.z - 1 }), item);
      if (item.endsWith('_door')) world.set(key({ ...position, y: position.y + 1 }), item);
      void options;
      return { ok: true };
    }),
    smelt: async (_bot, _ctx, { input, count, furnacePosition, memory }) => flaky(() => {
      if (blockAt(furnacePosition).name !== 'furnace') return { ok: false, reason: 'furnace_missing' };
      const n = Math.min(count, inventory[input] || 0);
      if (!n) return { ok: false, reason: 'smelt_no_output' };
      const fuel = ['coal', 'oak_log', 'oak_planks'].find(has);
      if (!fuel) return { ok: false, reason: 'no_fuel' };
      take(fuel);
      take(input, n);
      const cooked = { beef: 'cooked_beef', mutton: 'cooked_mutton', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken' };
      add(input === 'raw_iron' ? 'iron_ingot' : cooked[input] || 'charcoal', n);
      memory.input = 0;
      memory.output = 0;
      return { ok: true, taken: n };
    }),
    huntOne: async (_bot, _ctx, { mobs }) => flaky(() => {
      if (mobs.includes('sheep')) { add('white_wool'); add('mutton'); } else add('beef');
      return { ok: true };
    }),
    explore: async () => ({ ok: true, moved: 32 }),
    useChest: async (_bot, _ctx, { position, itemMatch }) => {
      if (blockAt(position).name !== 'chest') return { ok: false, reason: 'chest_missing' };
      const item = Object.keys(inventory).find(itemMatch);
      if (!item) return { ok: false, reason: 'nothing_to_store' };
      take(item);
      log.chest = item;
      return { ok: true };
    },
    useBed: async (_bot, _ctx, { position }) => (blockAt(position).name.endsWith('_bed') ? { ok: true, spawnSet: true }
      : { ok: false, reason: 'bed_missing' }),
  };
  const actions = {
    goToDig: async () => ({ ok: true }),
    digBlock: async (_bot, _ctx, block) => { world.set(key(block.position), 'air'); return { ok: true }; },
    collectDrops: async () => ({ ok: true }),
    goNear: async () => ({ ok: true }),
  };
  const perceive = () => ({ alive: true, position: bot.entity.position, inventory: { ...inventory }, hostiles: [] });
  return { bot, world, inventory, skills, actions, perceive, log, blockAt, die: () => {
    for (const name of Object.keys(inventory)) delete inventory[name];
    log.deaths += 1;
  }, deathAtStep };
}

async function runHomestead(sim, limit = 20000) {
  const goal = createHomesteadGoal({ bot: sim.bot, skills: sim.skills, actions: sim.actions });
  const events = [];
  const brain = createBrain({ perceive: sim.perceive, goalRetryDelayMs: 0, onEvent: (e) => events.push(e) });
  brain.setGoal(goal);
  let i = 0;
  for (; i < limit; i += 1) {
    if (events.some((e) => e.type === 'goal_done' || e.type === 'goal_failed')) break;
    if (sim.deathAtStep !== null && goal.memory.steps === sim.deathAtStep && sim.log.deaths === 0) sim.die();
    await brain.tick();
    await brain.idle();
  }
  return { goal, events, iterations: i };
}

for (const scenario of [
  { name: 'without failures', failRate: 0 },
  { name: 'with 15% random action failures', failRate: 0.15, seed: 7 },
  { name: 'with a death that wipes the inventory mid-way', failRate: 0.1, seed: 3, deathAtStep: 120 },
]) {
  test(`homestead completes from an empty inventory ${scenario.name}`, async () => {
    const sim = simulate(scenario);
    const { goal, events } = await runHomestead(sim);
    const failed = events.find((e) => e.type === 'goal_failed');
    assert.equal(failed, undefined, failed && JSON.stringify(failed));
    assert.ok(events.some((e) => e.type === 'goal_done'), 'goal did not finish');
    const house = createStarterHouse(goal.memory.house.anchor);
    for (const block of house.blocks) {
      const name = sim.blockAt(block.position).name;
      assert.ok(block.family === 'cobblestone' ? name === 'cobblestone' : name.endsWith('_planks'), `${block.family} at ${JSON.stringify(block.position)}`);
    }
    const f = house.furniture;
    assert.equal(sim.blockAt(f.crafting_table.position).name, 'crafting_table');
    assert.equal(sim.blockAt(f.furnace.position).name, 'furnace');
    assert.equal(sim.blockAt(f.chest.position).name, 'chest');
    assert.ok(sim.blockAt(f.bed.position).name.endsWith('_bed'));
    assert.ok(sim.blockAt(f.door.position).name.endsWith('_door'));
    assert.deepEqual(goal.memory.verified, { crafting_table: true, furnace: true, chest: true, bed: true });
    for (const item of ['iron_sword', 'iron_pickaxe', 'shield']) assert.ok(sim.inventory[item] > 0, item);
    if (scenario.deathAtStep) assert.equal(sim.log.deaths, 1);
  });
}

test('homestead completes across 12 random seeds with 25% failures and a death', async () => {
  const outcomes = [];
  for (let seed = 11; seed < 23; seed += 1) {
    const sim = simulate({ seed, failRate: 0.25, deathAtStep: 40 + seed * 9 });
    const { goal, events } = await runHomestead(sim);
    const failed = events.find((e) => e.type === 'goal_failed');
    outcomes.push({ seed, done: events.some((e) => e.type === 'goal_done'), steps: goal.memory.steps,
      failed: failed ? failed.reasons.slice(-3) : null });
  }
  const bad = outcomes.filter((o) => !o.done);
  assert.deepEqual(bad, [], JSON.stringify(bad));
});

test('the roof step is placed for the roof and removed once the roof is done', async () => {
  const sim = simulate({ seed: 5, failRate: 0 });
  const placedStair = [];
  const place = sim.skills.placeAt;
  sim.skills.placeAt = async (bot, ctx, position, match, options) => {
    const result = await place(bot, ctx, position, match, options);
    if (result.ok && !result.already && sim.blockAt(position).name === 'dirt') placedStair.push(position);
    return result;
  };
  const { goal, events } = await runHomestead(sim);
  assert.ok(events.some((e) => e.type === 'goal_done'));
  assert.equal(placedStair.length, 1);
  for (const p of goal.memory.house.scaffold) assert.equal(sim.blockAt(p).name, 'air');
});

test('a recovery starts the search for a site over, so a later ask is not failed at once', () => {
  const sim = simulate({ failRate: 0 });
  const goal = createHomesteadGoal({ bot: sim.bot, skills: sim.skills, actions: sim.actions });
  goal.memory.exploreStreak = 21;
  goal.recover();
  assert.equal(goal.memory.exploreStreak, 0);
});

test('homestead gathers hillside trees from dry standing cells and rejects mineshaft logs before pathing', async () => {
  const sim = simulate({ failRate: 0 });
  const anchor = { x: 0, y: 1, z: 0 };
  const shaft = new Vec3(12, -26, 0);
  const covered = new Vec3(20, -3, 0);
  const lowTree = new Vec3(30, -9, 0);
  const highTree = new Vec3(40, 8, 0);
  const ground = (x) => x >= 38 ? 7 : x >= 28 ? -10 : x >= 18 ? -4 : 0;
  sim.bot.blockAt = (p) => {
    const pos = p.floored();
    let name = pos.y <= ground(pos.x) ? 'stone' : 'air';
    if (pos.equals(shaft) || pos.equals(covered) || pos.equals(lowTree) || pos.equals(highTree)) name = 'oak_log';
    else if (pos.x >= 11 && pos.x <= 13 && pos.y >= -27 && pos.y <= -24) name = pos.y === -27 ? 'stone' : 'cave_air';
    else if (pos.x >= 17 && pos.x <= 23 && pos.y === 4) name = 'stone';
    else if (pos.x >= 39 && pos.x <= 42 && pos.y === 11) name = 'spruce_leaves';
    else if (pos.equals(highTree.offset(1, 0, 0))) name = 'snow';
    const isOpen = ['air', 'cave_air', 'snow'].includes(name);
    return { name, position: pos, boundingBox: isOpen ? 'empty' : 'block', shapes: isOpen ? [] : [[0, 0, 0, 1, 1, 1]] };
  };
  const safe = { x: 41, y: 8, z: 0 };
  const neighbor = () => [safe,
    { x: 42, y: 1, z: 0 }, // physical drop even though above the route floor
    { x: 42, y: 8, z: 0, toBreak: [new Vec3(42, 8, 0)] },
    { x: 42, y: 8, z: 0, toPlace: [new Vec3(42, 7, 0)] }];
  const movement = { getNeighbors: neighbor, exclusionAreasBreak: [], canDig: true, allowParkour: true, maxDropDown: 4 };
  sim.bot.pathfinder = { movements: movement };
  sim.skills.gatherOne = async (_bot, _ctx, { blocks, targetFilter, acceptStand, radius }) => {
    assert.ok(blocks('oak_log'));
    assert.equal(radius, undefined);
    assert.equal(targetFilter(shaft), false);
    assert.equal(targetFilter(covered), false);
    assert.equal(targetFilter(lowTree), true, 'lower exposed hillside is valid');
    assert.equal(targetFilter(highTree), true, 'higher hillside with canopy and thin snow is valid');
    assert.equal(acceptStand(highTree.offset(1, 0, 0), highTree), true);
    assert.equal(acceptStand(highTree.offset(0, 1, 0), highTree), false, 'the log itself cannot support the bot');
    assert.equal(movement.canDig, false);
    assert.equal(movement.allowParkour, false);
    assert.deepEqual(movement.getNeighbors({ y: 8 }), [safe]);
    return { ok: true };
  };
  const goal = createHomesteadGoal({ bot: sim.bot, anchor, skills: sim.skills, actions: sim.actions });
  const result = await goal.run({ perceive: sim.perceive, record() {} });
  assert.equal(result.ok, true);
  assert.equal(movement.getNeighbors, neighbor);
  assert.equal(movement.canDig, true);
  assert.equal(movement.allowParkour, true);
  assert.equal(movement.maxDropDown, 4);
});


test('homestead falls back to a guarded stone quarry after an exposed face path failure', async () => {
  const sim = simulate({ failRate: 0 });
  const anchor = { x: 0, y: 64, z: 0 };
  const legal = new Vec3(2, 64, -4);
  const low = new Vec3(20, 49, -4);
  sim.bot.entity.position = new Vec3(.5, 64, -3.5);
  sim.bot.entity.onGround = true;
  sim.inventory.wooden_pickaxe = 1;
  const key = (p) => p.floored().toString();
  sim.bot.blockAt = (p) => {
    const pos = p.floored();
    const name = sim.world.get(key(p)) || (pos.equals(legal) || pos.equals(low) || pos.y <= 61 ? 'stone'
      : pos.y < 64 && pos.x < 16 ? 'dirt' : 'air');
    return { name, position: pos, boundingBox: name === 'air' ? 'empty' : 'block', diggable: name !== 'air',
      shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] };
  };
  const operations = [];
  sim.skills.gatherOne = async (_bot, _ctx, { blocks, targetFilter, radius }) => {
    assert.ok(blocks('stone'));
    assert.equal(radius, 32);
    assert.ok(targetFilter(legal), 'near-house exposed stone is still eligible');
    assert.equal(targetFilter(low), false, 'deep visible stone is rejected');
    operations.push('exposed-path-failed');
    return { ok: false, reason: 'Timeout' };
  };
  sim.actions.digBlock = async (_bot, _ctx, block) => {
    operations.push('quarry-cut');
    sim.world.set(key(block.position), 'air');
    return { ok: true };
  };
  sim.actions.goTo = async (_bot, _ctx, target) => {
    sim.bot.entity.position = new Vec3(target.x + .5, target.y, target.z + .5);
    return { ok: true };
  };
  const goal = createHomesteadGoal({ bot: sim.bot, anchor, gear: ['stone_tier_pickaxe'], skills: sim.skills, actions: sim.actions });
  const result = await goal.run({ perceive: sim.perceive, record: (type) => {
    if (type === 'quarry_start') operations.push(type);
  } });
  assert.equal(result.ok, true);
  assert.deepEqual(operations, ['exposed-path-failed', 'quarry_start']);
  assert.equal((await goal.run({ perceive: sim.perceive, record() {} })).ok, true);
  assert.deepEqual(operations, ['exposed-path-failed', 'quarry_start', 'quarry-cut']);
});

test('homestead never gathers stone at the deep open-to-sky starting position', async () => {
  const sim = simulate({ failRate: 0 });
  const anchor = { x: 0, y: 64, z: 0 };
  sim.bot.entity.position = new Vec3(12.5, 33, 0.5);
  sim.inventory.wooden_pickaxe = 1;
  sim.skills.gatherOne = async () => assert.fail('a deep ravine must not rebase the stone floor');
  sim.skills.explore = async () => assert.fail('a deep ravine must not start stone exploration');
  const goal = createHomesteadGoal({ bot: sim.bot, anchor, gear: ['stone_tier_pickaxe'], skills: sim.skills, actions: sim.actions });
  const result = await goal.run({ perceive: sim.perceive, record() {} });
  assert.deepEqual(result, { ok: true, waited: true, reason: 'stone_surface_wait' });
});
