'use strict';
// Recovery shared by every goal: unsticking a body that cannot move, emptying
// a full bag, leaving a place the bot keeps dying in, and digging out of a pit.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createBrain } = require('../core/brain');
const { createRecovery, discardable } = require('../core/behaviors/recovery');
const { digStairsUp } = require('../core/actions');
const { sleep } = require('../core/confirm');

function fakeBot({ position = new Vec3(0.5, 64, 0.5), freeSlots = 10, inventory = {} } = {}) {
  const bot = new EventEmitter();
  bot.entity = { position: position.clone(), onGround: true, isInWater: false };
  bot.health = 20;
  bot.registry = { itemsByName: { gravel: { id: 1 }, cobblestone: { id: 2 }, dirt: { id: 3 } } };
  bot.tossed = [];
  bot.inventory = {
    items: () => Object.entries(inventory).map(([name, count]) => ({ name, count, type: bot.registry.itemsByName[name]?.id })),
    emptySlotCount: () => freeSlots,
  };
  bot.toss = async (type, _meta, count) => {
    bot.tossed.push({ type, count });
    freeSlots += 1;
  };
  bot.tossStack = async (item) => bot.toss(item.type, null, item.count);
  bot.setFree = (n) => { freeSlots = n; };
  bot.inv = inventory;
  return bot;
}

function perceiveFor(bot, extra = {}) {
  return () => ({
    alive: true,
    position: bot.entity.position.clone(),
    inventory: { ...bot.inv },
    freeSlots: bot.inventory.emptySlotCount(),
    hostiles: [],
    isDay: true,
    sheltered: false,
    ...(typeof extra === 'function' ? extra() : extra),
  });
}

function failingGoal(reason, { onRun } = {}) {
  return {
    name: 'stuck_goal',
    isDone: () => false,
    progress: () => 0,
    noProgressLimit: 1000,
    async run(ctx) {
      onRun?.();
      await sleep(1, ctx.signal);
      return { ok: false, reason };
    },
  };
}

function wire({ bot, perceive, actions = {}, skills = {}, now = Date.now, thresholds }) {
  const recovery = createRecovery({ bot, actions, skills, now, thresholds });
  const events = [];
  const brain = createBrain({
    perceive,
    behaviors: recovery.behaviors,
    goalRetryDelayMs: 0,
    now,
    onEvent: (e) => { recovery.observe(e); events.push(e); },
  });
  recovery.attach(brain);
  return { recovery, brain, events };
}

async function ticks(brain, n) {
  for (let i = 0; i < n; i += 1) {
    await brain.tick();
    await brain.idle();
    // A run that finished re-ticks on its own; let that one settle too.
    await sleep(1);
    await brain.idle();
  }
}

test('discardable lists junk first, then whatever exceeds one stack, never what the goal keeps', () => {
  const list = discardable({ gravel: 5, cobblestone: 100, dirt: 30, oak_sapling: 12, stone_pickaxe: 1, flint: 2 },
    (name) => name === 'flint');
  assert.deepEqual(list, [{ name: 'gravel', count: 5 }, { name: 'cobblestone', count: 36 }, { name: 'oak_sapling', count: 4 }]);
  assert.deepEqual(discardable({ stone_pickaxe: 1, bread: 3, dirt: 64 }), []);
  // Ground cover picked up on the way, and sticks past a stack.
  assert.deepEqual(discardable({ wildflowers: 37, leaf_litter: 20, stick: 208, bread: 3 }),
    [{ name: 'wildflowers', count: 37 }, { name: 'leaf_litter', count: 20 }, { name: 'stick', count: 144 }]);
});

test('two path failures in a row unstick the body, for any goal', async () => {
  const bot = fakeBot();
  let unsticks = 0;
  const actions = { unstick: async () => { unsticks += 1; bot.entity.position = bot.entity.position.offset(5, 0, 0); return { ok: true, moved: 'walked' }; } };
  const { brain, events } = wire({ bot, perceive: perceiveFor(bot), actions });
  brain.setGoal(failingGoal('NoPath'));
  await ticks(brain, 3);
  assert.ok(unsticks >= 1);
  const order = events.filter((e) => e.type === 'behavior_started').map((e) => e.behavior);
  assert.deepEqual(order.slice(0, 3), ['goal:stuck_goal', 'goal:stuck_goal', 'unstick']);
  assert.ok(events.some((e) => e.type === 'unstick' && e.why === 'path_failures'));
  await brain.dispose();
});

test('a goal failing while the bot has not moved for a while is treated as stuck', async () => {
  const bot = fakeBot();
  let clock = 0;
  let unsticks = 0;
  const actions = { unstick: async () => { unsticks += 1; return { ok: true }; } };
  const { brain, events } = wire({ bot, perceive: perceiveFor(bot), actions, now: () => clock });
  brain.setGoal(failingGoal('drops_not_collected'));
  await ticks(brain, 3);
  assert.equal(unsticks, 0, 'not a path failure and not long enough');
  clock += 46000;
  await ticks(brain, 2);
  assert.equal(unsticks, 1);
  assert.ok(events.some((e) => e.type === 'unstick' && e.why === 'not_moving'));
  await brain.dispose();
});

test('a goal that fails while the bot keeps moving is not stuck', async () => {
  const bot = fakeBot();
  let clock = 0;
  let unsticks = 0;
  const actions = { unstick: async () => { unsticks += 1; return { ok: true }; } };
  const { brain } = wire({ bot, perceive: perceiveFor(bot), actions, now: () => clock });
  brain.setGoal(failingGoal('drops_not_collected', { onRun: () => { bot.entity.position = bot.entity.position.offset(3, 0, 0); } }));
  for (let i = 0; i < 6; i += 1) {
    clock += 20000;
    await ticks(brain, 1);
  }
  assert.equal(unsticks, 0);
  await brain.dispose();
});

test('a full bag is thrown away even next to the house chest, which stays free for materials', async () => {
  const bot = fakeBot({ freeSlots: 0, inventory: { gravel: 10, stone_pickaxe: 1 } });
  bot.companionChest = { x: 3, y: 64, z: 0 };
  const skills = { storeItems: async () => assert.fail('junk must not go into the house chest') };
  const { brain } = wire({ bot, perceive: perceiveFor(bot), skills, actions: { fleeFrom: async () => ({ ok: true }) } });
  await ticks(brain, 1);
  assert.deepEqual(bot.tossed[0], { type: 1, count: 10 });
  await brain.dispose();
});

test('a full bag waits until the bot is out of the tunnel, where thrown junk is not walked over again', async () => {
  const bot = fakeBot({ freeSlots: 0, inventory: { gravel: 10 } });
  let below = true;
  const actions = { underground: () => below, fleeFrom: async () => ({ ok: true }) };
  const { brain } = wire({ bot, perceive: perceiveFor(bot), actions });
  await ticks(brain, 1);
  assert.equal(bot.tossed.length, 0);
  below = false;
  await ticks(brain, 1);
  assert.deepEqual(bot.tossed[0], { type: 1, count: 10 });
  await brain.dispose();
});

test('without a chest, junk is thrown away and the bot walks off before it can be picked up again', async () => {
  const bot = fakeBot({ freeSlots: 1, inventory: { gravel: 10, oak_log: 20 } });
  bot.registry.itemsByName.oak_log = { id: 9 };
  let walkedOff = 0;
  const actions = { fleeFrom: async () => { walkedOff += 1; return { ok: true }; } };
  const { brain, events } = wire({ bot, perceive: perceiveFor(bot), actions });
  await ticks(brain, 1);
  assert.deepEqual(bot.tossed, [{ type: 1, count: 10 }]);
  assert.equal(walkedOff, 1);
  assert.ok(events.some((e) => e.type === 'behavior_finished' && e.behavior === 'tidy_inventory' && e.ok));
  await brain.dispose();
});

test('a full bag with nothing to discard is left alone instead of looping', async () => {
  const bot = fakeBot({ freeSlots: 0, inventory: { oak_log: 64, stone_pickaxe: 1 } });
  const { brain, events } = wire({ bot, perceive: perceiveFor(bot) });
  await ticks(brain, 2);
  assert.ok(!events.some((e) => e.type === 'behavior_started'));
  await brain.dispose();
});

test('dying three times in one place makes the bot leave it by day and bunker down by night', async () => {
  const bot = fakeBot();
  let clock = 0;
  let isDay = true;
  const moves = [];
  const actions = { goNear: async (_bot, _ctx, target) => { moves.push(target); bot.entity.position = new Vec3(target.x, 64, target.z); return { ok: true }; } };
  const dug = [];
  const skills = { digIn: async () => { dug.push('in'); return { ok: true, bunker: { top: { x: 0, y: 64, z: 0 } } }; },
    digOut: async () => { dug.push('out'); return { ok: true }; } };
  const { brain, recovery } = wire({ bot, perceive: perceiveFor(bot, () => ({ isDay, sheltered: bot.companionSheltered === true })),
    actions, skills, now: () => clock, thresholds: { bunkerPollMs: 5 } });
  for (let i = 0; i < 3; i += 1) {
    bot.entity.position = new Vec3(i, 64, 0);
    bot.emit('death');
    clock += 60000;
  }
  bot.entity.position = new Vec3(1, 64, 0);
  assert.ok(recovery.status().danger);
  isDay = false;
  await ticks(brain, 1);
  assert.deepEqual(dug, ['in']);
  assert.equal(bot.companionSheltered, true);
  await ticks(brain, 1);
  assert.deepEqual(dug, ['in'], 'stays in while it is dark');
  isDay = true;
  await ticks(brain, 1);
  assert.deepEqual(dug, ['in', 'out']);
  assert.equal(bot.companionSheltered, false);
  await ticks(brain, 1);
  assert.equal(moves.length, 1);
  const target = moves[0];
  assert.ok(Math.hypot(target.x - 1, target.z) >= 40, 'walks well away from the deaths');
  await ticks(brain, 1);
  assert.equal(moves.length, 1, 'leaves only once');
  await brain.dispose();
});

test('deaths in the nether do not mark the same coordinates in the overworld as dangerous', async () => {
  const bot = fakeBot();
  bot.game = { dimension: 'minecraft:the_nether' };
  let clock = 0;
  const { brain, recovery } = wire({ bot, perceive: perceiveFor(bot), now: () => clock });
  for (let i = 0; i < 3; i += 1) { bot.emit('death'); clock += 1000; }
  assert.ok(recovery.status().danger);
  bot.game.dimension = 'minecraft:overworld';
  assert.equal(recovery.status().danger, null);
  await brain.dispose();
});

test('deaths on the End island do not mark it as dangerous, so the drops are still picked up', async () => {
  const bot = fakeBot();
  bot.game = { dimension: 'minecraft:the_end' };
  let clock = 0;
  const { brain, recovery } = wire({ bot, perceive: perceiveFor(bot), now: () => clock });
  for (let i = 0; i < 3; i += 1) { bot.emit('death'); clock += 1000; }
  assert.equal(recovery.status().danger, null);
  assert.equal(bot.companionDeathDanger, undefined);
  await brain.dispose();
});

test('leaving a deadly place prefers dry land', async () => {
  // Water everywhere east of x=4.
  const bot = fakeBot();
  bot.blockAt = (p) => ({ name: p.y > 64 ? 'air' : p.x > 4 ? 'water' : 'grass_block', boundingBox: p.y > 64 || p.x > 4 ? 'empty' : 'block' });
  let clock = 0;
  const moves = [];
  const actions = { goNear: async (_bot, _ctx, target) => { moves.push(target); return { ok: true }; } };
  const { brain } = wire({ bot, perceive: perceiveFor(bot), actions, now: () => clock });
  for (let i = 0; i < 3; i += 1) { bot.emit('death'); clock += 1000; }
  // Standing east of the deaths, the naive "straight away" direction is the sea.
  bot.entity.position = new Vec3(3, 64, 0);
  await ticks(brain, 1);
  assert.equal(moves.length, 1);
  assert.ok(moves[0].x < 4, `went to x=${moves[0].x}, into the water`);
  await brain.dispose();
});

test('too many deaths in an hour end the goal as a death loop instead of dying forever', async () => {
  const bot = fakeBot();
  let clock = 0;
  const { brain, events } = wire({ bot, perceive: perceiveFor(bot), now: () => clock });
  brain.setGoal({ name: 'g', isDone: () => false, progress: () => 0, run: (ctx) => sleep(5, ctx.signal).then(() => ({ ok: true })) });
  for (let i = 0; i < 9; i += 1) {
    bot.entity.position = new Vec3(i * 100, 64, 0); // scattered: no single dangerous place
    bot.emit('death');
    clock += 5 * 60000;
  }
  await sleep(5);
  const failed = events.find((e) => e.type === 'goal_failed');
  assert.ok(failed);
  assert.deepEqual(failed.reasons, ['death_loop']);
  assert.equal(brain.status().goal, null);
  await brain.dispose();
});

test('a goal asked again after a death loop is not failed by the deaths before it', async () => {
  const bot = fakeBot();
  let clock = 0;
  const { brain, events } = wire({ bot, perceive: perceiveFor(bot), now: () => clock });
  const goal = () => ({ name: 'g', isDone: () => false, progress: () => 0, run: (ctx) => sleep(5, ctx.signal).then(() => ({ ok: true })) });
  brain.setGoal(goal());
  for (let i = 0; i < 9; i += 1) {
    bot.entity.position = new Vec3(i * 100, 64, 0);
    bot.emit('death');
    clock += 60000;
  }
  await sleep(5);
  assert.equal(events.filter((e) => e.type === 'goal_failed').length, 1);
  brain.setGoal(goal());
  bot.entity.position = new Vec3(1000, 64, 0);
  bot.emit('death');
  await sleep(5);
  assert.equal(events.filter((e) => e.type === 'goal_failed').length, 1);
  assert.equal(brain.status().goal?.name ?? brain.status().goal, 'g');
  await brain.dispose();
});

test('deaths spread over more than an hour do not end the goal', async () => {
  const bot = fakeBot();
  let clock = 0;
  const { brain, events } = wire({ bot, perceive: perceiveFor(bot), now: () => clock });
  brain.setGoal({ name: 'g', isDone: () => false, progress: () => 0, run: (ctx) => sleep(5, ctx.signal).then(() => ({ ok: true })) });
  for (let i = 0; i < 12; i += 1) {
    bot.entity.position = new Vec3(i * 100, 64, 0);
    bot.emit('death');
    clock += 10 * 60000;
  }
  assert.ok(!events.some((e) => e.type === 'goal_failed'));
  await brain.dispose();
});

// A small voxel world for the staircase: solid dirt below y=64, the bot at the
// bottom of a 1x1 pit four blocks deep. Pathfinding is a teleport onto a
// standable target block; digging turns the block into air.
function pitWorld({ water = null } = {}) {
  const air = new Set();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  for (let y = 60; y < 64; y += 1) air.add(key({ x: 0, y, z: 0 }));
  const nameAt = (p) => {
    if (water && water(p)) return 'water';
    if (air.has(key(p)) || p.y >= 64) return 'air';
    return 'dirt';
  };
  const blockAt = (p) => {
    const q = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    const name = nameAt(q);
    return { name, position: q, boundingBox: name === 'dirt' ? 'block' : 'empty', diggable: name === 'dirt' };
  };
  const bot = new EventEmitter();
  bot.entity = { position: new Vec3(0.5, 60, 0.5), onGround: true, isInWater: false };
  bot.blockAt = blockAt;
  bot.canDigBlock = (b) => b.name === 'dirt';
  bot.dig = async (b) => { air.add(key(b.position)); };
  bot.stopDigging = () => {};
  bot.clearControlStates = () => {};
  bot.inventory = { items: () => [], slots: [] };
  bot.pathfinder = {
    setGoal: () => {},
    goto: async (goal) => {
      const t = new Vec3(goal.x, goal.y, goal.z);
      const standable = blockAt(t).boundingBox === 'empty' && blockAt(t.offset(0, 1, 0)).boundingBox === 'empty'
        && blockAt(t.offset(0, -1, 0)).boundingBox === 'block';
      const step = Math.abs(t.x - Math.floor(bot.entity.position.x)) + Math.abs(t.z - Math.floor(bot.entity.position.z)) <= 1;
      if (standable && step && t.y - Math.floor(bot.entity.position.y) <= 1) bot.entity.position = t.offset(0.5, 0, 0.5);
    },
  };
  return { bot, air };
}

test('with nothing to pillar with, the bot digs a staircase out of a pit', async () => {
  const { bot } = pitWorld();
  const ctx = { signal: new AbortController().signal };
  const climbed = await digStairsUp(bot, ctx, 64);
  assert.equal(climbed, 4);
  assert.equal(Math.floor(bot.entity.position.y), 64);
});

test('the staircase never digs next to water', async () => {
  // Water along x=2 and x=-2 and z=2 and z=-2 at every level: any step outward
  // past the first would open into it.
  const { bot } = pitWorld({ water: (p) => p.y < 64 && (Math.abs(p.x) >= 2 || Math.abs(p.z) >= 2) });
  const ctx = { signal: new AbortController().signal };
  const climbed = await digStairsUp(bot, ctx, 64);
  assert.equal(climbed, 0);
  assert.equal(Math.floor(bot.entity.position.y), 60);
});

test('brain.failGoal ends the goal with the given reason and stops its run', async () => {
  const events = [];
  const brain = createBrain({ perceive: () => ({ alive: true }), onEvent: (e) => events.push(e) });
  brain.setGoal({ name: 'g', isDone: () => false, progress: () => 0, run: (ctx) => sleep(200, ctx.signal).then(() => ({ ok: true })) });
  await brain.tick();
  assert.equal(brain.status().running, 'goal:g');
  await brain.failGoal('death_loop');
  assert.equal(brain.status().running, null);
  assert.equal(brain.status().goal, null);
  assert.deepEqual(events.find((e) => e.type === 'goal_failed').reasons, ['death_loop']);
  await brain.dispose();
});
