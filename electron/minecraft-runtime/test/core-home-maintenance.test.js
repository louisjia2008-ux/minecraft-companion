'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createBrain, BAND } = require('../core/brain');
const { sleep } = require('../core/confirm');
const { createHomesteadGoal } = require('../core/goals/homestead');
const { createHomeMaintenance } = require('../core/behaviors/homeMaintenance');
const { createSurvivalBehaviors } = require('../core/behaviors/survival');

const RECIPES = {
  stone_sword: { cobblestone: 2, stick: 1 }, stone_pickaxe: { cobblestone: 3, stick: 2 },
  iron_sword: { iron_ingot: 2, stick: 1 }, iron_pickaxe: { iron_ingot: 3, stick: 2 },
  shield: { iron_ingot: 1, oak_planks: 6 },
};

function fixture() {
  const world = new Map();
  const unloaded = new Set();
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const inventory = { iron_sword: 1, iron_pickaxe: 1, shield: 1, cooked_beef: 8,
    cobblestone: 64, oak_planks: 64, dirt: 4, stick: 20, iron_ingot: 6 };
  const log = { placements: [], digs: [], crafts: [], uses: [], travels: [] };
  const blockAt = (p) => {
    if (unloaded.has(key(p))) return null;
    const name = world.get(key(p)) || 'air';
    return { name, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
      boundingBox: ['air', 'torch'].includes(name) ? 'empty' : 'block' };
  };
  const bot = { entity: { position: new Vec3(3.5, 64, 3.5) }, blockAt,
    pathfinder: { movements: { exclusionAreasBreak: [] } } };
  const skills = {
    async placeAt(_bot, _ctx, position, match) {
      if (match(blockAt(position)?.name)) return { ok: true, already: true };
      const item = Object.keys(inventory).find((name) => inventory[name] > 0 && match(name));
      if (!item) return { ok: false, reason: 'no_material' };
      inventory[item] -= 1;
      world.set(key(position), item);
      if (item.endsWith('_bed')) world.set(key({ ...position, z: position.z - 1 }), item);
      if (item.endsWith('_door')) world.set(key({ ...position, y: position.y + 1 }), item);
      log.placements.push(key(position));
      return { ok: true };
    },
    async craft(_bot, _ctx, { item, times, tablePosition }) {
      assert.equal(blockAt(tablePosition).name, 'crafting_table');
      const recipe = RECIPES[item];
      assert.ok(recipe, `unexpected recipe ${item}`);
      for (let i = 0; i < times; i += 1) {
        for (const [name, count] of Object.entries(recipe)) {
          assert.ok(inventory[name] >= count, `${item} needs ${name}`);
          inventory[name] -= count;
        }
        inventory[item] = (inventory[item] || 0) + 1;
      }
      log.crafts.push(item);
      return { ok: true, usedTable: true };
    },
    async useBed() { log.uses.push('bed'); return { ok: true, spawnSet: true }; },
    async useChest() { log.uses.push('chest'); return { ok: true }; },
  };
  const actions = {
    async goNear(_bot, _ctx, p) { log.travels.push(key(p)); bot.entity.position = p.clone(); return { ok: true }; },
    async goToDig() { return { ok: true }; },
    async digBlock(_bot, _ctx, block) { log.digs.push(key(block.position)); world.set(key(block.position), 'air'); return { ok: true }; },
    async collectDrops() { return { ok: true }; },
    withinReach: () => true,
  };
  const home = createHomesteadGoal({ bot, anchor: { x: 0, y: 64, z: 0 }, skills, actions });
  const house = home.memory.house;
  for (const p of house.foundation) world.set(key(p), 'dirt');
  for (const b of house.blocks) world.set(key(b.position), b.family === 'cobblestone' ? 'cobblestone' : 'oak_planks');
  for (const name of ['crafting_table', 'furnace', 'chest']) world.set(key(house.furniture[name].position), name);
  for (const p of [house.furniture.bed.position, house.furniture.bed.head]) world.set(key(p), 'white_bed');
  for (const p of [house.furniture.door.position, house.furniture.door.upper]) world.set(key(p), 'oak_door');
  for (const p of house.furniture.torches) world.set(key(p), 'torch');
  for (const name of Object.keys(home.memory.verified)) home.memory.verified[name] = true;
  const perceive = () => ({ alive: true, health: 20, food: 20, inventory: { ...inventory },
    position: bot.entity.position, hostiles: [], isDay: true, timeOfDay: 6000 });
  const ctx = { perceive, record() {}, signal: new AbortController().signal };
  return { bot, home, house, inventory, world, unloaded, key, perceive, ctx, log };
}

test('completed homes repair loaded shell/furniture damage and consumed gear while retaining the device goal', async () => {
  const s = fixture();
  assert.equal(s.home.isDone(s.perceive()), true);
  const wall = s.house.blocks.find((b) => b.phase === 'walls');
  s.world.set(s.key(wall.position), 'air');
  s.world.set(s.key(s.house.foundation[0]), 'air');
  s.world.set(s.key(s.house.furniture.bed.head), 'air');
  s.world.set(s.key(s.house.furniture.door.upper), 'air');
  s.inventory.white_bed = 1;
  s.inventory.oak_door = 1;
  for (const name of ['iron_sword', 'iron_pickaxe', 'shield']) delete s.inventory[name];
  let brain;
  let deviceSteps = 0;
  const events = [];
  const maintenance = createHomeMaintenance({ bot: s.bot, home: () => s.home,
    activeGoal: () => brain?.status().goal?.name, missingGearDelayMs: 0 });
  brain = createBrain({ perceive: s.perceive, behaviors: [maintenance], goalRetryDelayMs: 0,
    onEvent: (e) => events.push(e) });
  brain.setGoal({ name: 'build_auto_smelter', isDone: () => deviceSteps >= 1,
    progress: () => deviceSteps, async run() { deviceSteps += 1; return { ok: true }; } });
  try {
    await brain.tick();
    for (let i = 0; i < 500 && !events.some((e) => e.type === 'goal_done'); i += 1) await sleep(1);
    assert.equal(s.home.isDone(s.perceive()), true);
    assert.equal(s.bot.blockAt(wall.position).name, 'cobblestone');
    assert.equal(s.bot.blockAt(s.house.foundation[0]).boundingBox, 'block');
    assert.equal(s.bot.blockAt(s.house.furniture.bed.head).name, 'white_bed');
    assert.equal(s.bot.blockAt(s.house.furniture.door.upper).name, 'oak_door');
    assert.ok(s.log.uses.includes('bed'), 'replacement bed must set spawn again');
    assert.ok(['iron_sword', 'iron_pickaxe', 'shield'].every((name) => s.inventory[name] > 0));
    assert.equal(deviceSteps, 1);
    assert.equal(events.filter((e) => e.type === 'goal_set').length, 1);
    assert.ok(events.some((e) => e.type === 'behavior_started' && e.behavior === 'home_maintenance'));
    assert.equal(events.some((e) => e.type === 'goal_failed'), false);
  } finally { await brain.dispose(); }
});

test('new damage interrupts an already running device step, and the same goal resumes after repair', async () => {
  const s = fixture();
  assert.equal(s.home.isDone(s.perceive()), true);
  let brain;
  let runs = 0;
  const events = [];
  const maintenance = createHomeMaintenance({ bot: s.bot, home: () => s.home,
    activeGoal: () => brain?.status().goal?.name });
  brain = createBrain({ perceive: s.perceive, behaviors: [maintenance], goalRetryDelayMs: 0,
    onEvent: (e) => events.push(e) });
  let done = false;
  brain.setGoal({ name: 'build_auto_smelter', isDone: () => done, progress: () => Number(done),
    async run(ctx) {
      runs += 1;
      if (runs === 1) {
        await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
        return { ok: false, reason: 'aborted' };
      }
      done = true;
      return { ok: true };
    } });
  try {
    await brain.tick();
    await sleep(1);
    assert.equal(brain.status().running, 'goal:build_auto_smelter');
    s.world.set(s.key(s.house.blocks[0].position), 'air');
    await brain.tick();
    for (let i = 0; i < 100 && !done; i += 1) await sleep(1);
    assert.equal(s.home.isDone(s.perceive()), true);
    assert.equal(runs, 2);
    assert.equal(events.filter((e) => e.type === 'goal_set').length, 1);
    assert.ok(events.some((e) => e.type === 'preempted' && e.by === 'home_maintenance'));
    assert.equal(events.some((e) => e.type === 'goal_failed'), false);
  } finally { await brain.dispose(); }
});

test('unloaded home cells are unknown, trigger no repair or travel, and cannot complete an initial home', () => {
  const s = fixture();
  const wall = s.house.blocks[0].position;
  s.unloaded.add(s.key(wall));
  assert.equal(s.home.isDone(s.perceive()), false);
  assert.equal(s.home.memory.established, false);
  s.unloaded.clear();
  assert.equal(s.home.isDone(s.perceive()), true);
  s.unloaded.add(s.key(wall));
  const maintenance = createHomeMaintenance({ bot: s.bot, home: () => s.home });
  assert.equal(maintenance.want(s.perceive()), 0);
  assert.equal(s.home.maintenance(s.perceive()).missing.length, 0);
  assert.equal(s.home.maintenance(s.perceive()).unknown.length, 1);
  assert.deepEqual(s.log.travels, []);
});

test('an established home keeps its site when recovering gear far away after losing its bed', async () => {
  const s = fixture();
  assert.equal(s.home.isDone(s.perceive()), true);
  const house = s.home.memory.house;
  s.home.memory.houseBed = false;
  s.home.memory.houseBuilt = 0;
  s.bot.entity.position = new Vec3(200.5, 64, 0.5);
  s.unloaded.add(s.key(s.house.furniture.bed.head));
  delete s.inventory.shield;
  await s.home.run(s.ctx);
  assert.equal(s.home.memory.house, house);
  assert.equal(s.home.memory.established, true);
  assert.deepEqual(s.log.travels, [s.key(house.entrance)]);
});

test('correct house blocks and foundation cannot be path-mined, while misplaced obstacles remain removable', async () => {
  const s = fixture();
  const obstacle = s.house.clearance.find((p) => p.x === 2 && p.z === 2 && p.y === 65);
  s.world.set(s.key(obstacle), 'stone');
  await s.home.run(s.ctx);
  const protect = s.bot.pathfinder.movements.exclusionAreasBreak[0];
  assert.equal(typeof protect, 'function');
  for (const p of [s.house.blocks[0].position, s.house.foundation[0], s.house.furniture.chest.position]) {
    const block = s.bot.blockAt(p);
    assert.equal(s.home.protects(p), true);
    assert.equal(s.bot.companionProtectBlock(block), true);
    assert.ok(protect(block) >= 100);
  }
  const wrong = { name: 'stone', position: new Vec3(obstacle.x, obstacle.y, obstacle.z), boundingBox: 'block' };
  s.world.set(s.key(obstacle), 'stone');
  assert.equal(s.home.protects(obstacle), false);
  assert.ok(protect(wrong) < 100);
  assert.ok(s.log.digs.includes(s.key(obstacle)), 'site work still removes the misplaced obstruction');
});

test('maintenance waits out transient missing gear and gives survival/night/current homestead ownership precedence', () => {
  const s = fixture();
  assert.equal(s.home.isDone(s.perceive()), true);
  let clock = 0;
  let goal = 'build_auto_smelter';
  const maintenance = createHomeMaintenance({ bot: s.bot, home: () => s.home,
    activeGoal: () => goal, now: () => clock });
  delete s.inventory.shield;
  assert.equal(maintenance.want(s.perceive()), 0);
  clock = 4999;
  assert.equal(maintenance.want(s.perceive()), 0);
  s.inventory.shield = 1;
  assert.equal(maintenance.want(s.perceive()), 0);
  delete s.inventory.shield;
  clock = 10000;
  assert.equal(maintenance.want(s.perceive()), 0);
  clock = 15000;
  assert.ok(maintenance.want(s.perceive()) > 0);
  assert.ok(maintenance.band > BAND.GOAL && maintenance.band < BAND.MAINTENANCE);
  assert.ok(maintenance.want(s.perceive()) < 0.3);
  assert.equal(maintenance.want({ ...s.perceive(), health: 9 }), 0);
  assert.equal(maintenance.want({ ...s.perceive(), food: 12 }), 0);
  assert.equal(maintenance.want({ ...s.perceive(), isDay: false }), 0);
  assert.equal(maintenance.want({ ...s.perceive(), hostiles: [{ distance: 7 }] }), 0);
  goal = 'homestead';
  assert.equal(maintenance.want(s.perceive()), 0);
});

test('new hunger interrupts a running home repair before its long action finishes', async () => {
  const s = fixture();
  assert.equal(s.home.isDone(s.perceive()), true);
  s.world.set(s.key(s.house.blocks[0].position), 'air');
  const state = s.perceive();
  let calls = 0;
  let meals = 0;
  const originalRun = s.home.run;
  s.home.run = async (ctx) => {
    calls += 1;
    if (calls > 1) return originalRun(ctx);
    await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
    return { ok: false, reason: 'aborted' };
  };
  const eat = createSurvivalBehaviors({ bot: s.bot, isFood: (name) => name === 'cooked_beef',
    actions: { eat: async () => { meals += 1; state.food = 20; state.health = 20; return { ok: true }; } } })
    .find((behavior) => behavior.name === 'eat');
  const maintenance = createHomeMaintenance({ bot: s.bot, home: () => s.home });
  const events = [];
  const brain = createBrain({ perceive: () => ({ ...s.perceive(), health: state.health, food: state.food }),
    behaviors: [eat, maintenance], goalRetryDelayMs: 0, onEvent: (e) => events.push(e) });
  try {
    await brain.tick();
    await sleep(1);
    assert.equal(brain.status().running, 'home_maintenance');
    state.health = 2.5;
    state.food = 16;
    await brain.tick();
    for (let i = 0; i < 100 && !meals; i += 1) await sleep(1);
    assert.equal(meals, 1);
    assert.ok(events.some((e) => e.type === 'preempted' && e.behavior === 'home_maintenance' && e.by === 'eat'));
  } finally { await brain.dispose(); }
});

test('apparently successful repair steps with no observed change have a bounded streak and cooldown', async () => {
  const s = fixture();
  assert.equal(s.home.isDone(s.perceive()), true);
  s.world.set(s.key(s.house.blocks[0].position), 'air');
  let clock = 0;
  let calls = 0;
  s.home.run = async () => { calls += 1; s.home.memory.steps += 1; return { ok: true }; };
  const records = [];
  const maintenance = createHomeMaintenance({ bot: s.bot, home: () => s.home, now: () => clock });
  const ctx = { ...s.ctx, record: (name, data) => records.push({ name, ...data }) };
  for (let i = 0; i < 3; i += 1) {
    assert.ok(maintenance.want(s.perceive()) > 0);
    await maintenance.run(ctx);
  }
  assert.equal(calls, 3);
  assert.equal(maintenance.want(s.perceive()), 0);
  assert.ok(records.some((e) => e.name === 'home_maintenance_paused' && e.reason === 'no_observed_change'));
  clock = 60001;
  assert.ok(maintenance.want(s.perceive()) > 0);
});
