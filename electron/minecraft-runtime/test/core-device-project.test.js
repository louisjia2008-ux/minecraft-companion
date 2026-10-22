'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createDeviceProjectGoal } = require('../core/goals/deviceProject');
const { createDefaultCards } = require('../core/goals/registry');
const { createNightRest } = require('../core/behaviors/nightRest');

const ctx = (inventory = {}) => ({ signal: new AbortController().signal, record() {}, perceive: () => ({ inventory }) });

// A device that needs two hoppers until it has been built once.
function fakeDevice() {
  const memory = { device: null, built: false };
  return {
    name: 'fake_device',
    memory,
    needs: () => (memory.built ? [] : [{ key: 'hopper', count: 2 }]),
    isDone: () => memory.built,
    progress: () => (memory.built ? 10 : 0),
    run: async () => { memory.device = {}; memory.built = true; return { ok: true }; },
  };
}

function fakeGather(log) {
  return ({ requirements }) => {
    let runs = 0;
    log.push(requirements);
    return { isDone: () => runs >= 2, progress: () => runs, run: async () => { runs += 1; return { ok: true }; } };
  };
}

const home = { chest: { x: 0, y: 64, z: 0 }, centre: { x: 3, y: 64, z: 3 }, stations: {} };

test('a device project gathers what the bag lacks into the chest, takes it out, then builds', async () => {
  const gathered = [];
  const taken = [];
  const device = fakeDevice();
  const bot = { entity: { position: new Vec3(17, 64, 3) } };
  const skills = { takeItems: async (b, c, options) => { taken.push(options); return { ok: true, taken: 2 }; } };
  const actions = { goNear: async () => ({ ok: true }) };
  const goal = createDeviceProjectGoal({ bot, name: 'build_fake', device, home, skills, actions, createGather: fakeGather(gathered) });
  // One hopper carried: only the other one is gathered.
  for (let i = 0; i < 3; i += 1) assert.equal((await goal.run(ctx({ hopper: 1 }))).ok, true);
  assert.deepEqual(gathered, [[{ key: 'hopper', count: 1 }]]);
  assert.equal(taken.length, 1);
  assert.equal(taken[0].itemMatch('hopper'), true);
  assert.equal(taken[0].itemMatch('dirt'), false);
  // Both in the bag now: the device itself runs (the site spot is right here).
  await goal.run(ctx({ hopper: 2 }));
  assert.equal(goal.isDone({}), true);
  assert.ok(goal.progress({}) >= 13);
});

test('the mine dug by one gather is handed to the next', async () => {
  const device = fakeDevice();
  const made = [];
  const createGather = () => {
    let runs = 0;
    const memory = { mine: null };
    made.push(memory);
    return { memory, isDone: () => runs >= 1, progress: () => runs,
      run: async () => { runs += 1; memory.mine = memory.mine || { surfaceY: 64, dug: made.length }; return { ok: true }; } };
  };
  const bot = { entity: { position: new Vec3(17, 64, 3) } };
  const skills = { takeItems: async () => ({ ok: true }) };
  const goal = createDeviceProjectGoal({ bot, name: 'x', device, home, skills, actions: {}, createGather });
  await goal.run(ctx()); // first gather digs its mine
  await goal.run(ctx()); // done: take out (on the surface, nothing to climb)
  await goal.run(ctx()); // a second gather: same mine
  assert.equal(made.length, 2);
  assert.deepEqual(made[1].mine, { surfaceY: 64, dug: 1 });
});

test('a project walks to the next site spot when the device finds no site', async () => {
  const device = fakeDevice();
  device.needs = () => [];
  device.run = async () => ({ ok: false, reason: 'no_site' });
  const spots = [];
  const bot = { entity: { position: new Vec3(17, 64, 3) } };
  const actions = { goNear: async (b, c, spot) => { spots.push(spot); bot.entity.position = spot.clone(); return { ok: true }; } };
  const goal = createDeviceProjectGoal({ bot, name: 'build_fake', device, home, actions, skills: {} });
  await goal.run(ctx()); // at the first spot already: tries there, no site
  await goal.run(ctx()); // walks to the second heading
  assert.equal(spots.length, 1);
  assert.ok(spots[0].distanceTo(new Vec3(17, 64, 3)) > 5);
});

test('a project stays done once its device was seen done, even out of range', () => {
  const device = fakeDevice();
  const goal = createDeviceProjectGoal({ bot: { entity: { position: new Vec3(0, 0, 0) } }, name: 'x', device, home });
  device.memory.built = true;
  assert.equal(goal.isDone({}), true);
  device.memory.built = false;
  assert.equal(goal.isDone({}), true);
});

test('machine cards wait for the house and come one after the other', () => {
  const bot = { entity: { position: new Vec3(0, 64, 0) }, blockAt: () => null, inventory: { items: () => [] } };
  const { cards } = createDefaultCards({ bot });
  const generator = cards.find((c) => c.id === 'cobble_generator');
  const smelter = cards.find((c) => c.id === 'auto_smelter');
  const state = { inventory: {} };
  assert.equal(generator.requires(state, {}), false);
  const house = { anchor: { x: 0, y: 64, z: 0 }, interiorCenter: { x: 3, y: 64, z: 3 },
    furniture: { chest: { position: { x: 4, y: 64, z: 5 } }, crafting_table: { position: { x: 1, y: 64, z: 5 } },
      furnace: { position: { x: 2, y: 64, z: 5 } } } };
  const memory = { homestead: { memory: { house }, isDone: () => true } };
  assert.equal(generator.requires(state, memory), true);
  assert.equal(smelter.requires(state, memory), false);
  const goal = generator.create(memory);
  assert.equal(goal.name, 'build_cobble_generator');
  assert.equal(generator.create(memory), goal);
  assert.ok(generator.need(state, memory) > 0);
  goal.memory.done = true;
  assert.equal(generator.need(state, memory), 0);
  assert.equal(smelter.requires(state, memory), true);
});

test('night rest sleeps at home after dark and leaves underground work alone', async () => {
  const bot = { entity: { position: new Vec3(40, 64, 0) }, game: { dimension: 'overworld' }, on() {}, removeListener() {} };
  const calls = [];
  let underground = false;
  const actions = { underground: () => underground,
    goNear: async (b, c, p) => { calls.push('go'); bot.entity.position = p.clone(); return { ok: true }; } };
  const skills = { useBed: async () => { calls.push('sleep'); return { ok: true, slept: true }; } };
  let house = null;
  const rest = createNightRest({ bot, home: () => house, actions, skills });
  const night = { isDay: false, sheltered: false };
  assert.equal(rest.want(night), 0); // no house yet
  house = { bed: { x: 5, y: 64, z: 1 }, centre: { x: 3, y: 64, z: 3 } };
  assert.equal(rest.want({ ...night, isDay: true }), 0);
  underground = true;
  assert.equal(rest.want(night), 0);
  underground = false;
  assert.ok(rest.want(night) > 0);
  const context = { signal: new AbortController().signal, record() {}, perceive: () => night };
  await rest.run(context);
  await rest.run(context);
  assert.deepEqual(calls, ['go', 'sleep']);
});

test('night rest shelters in the house when the bed is gone', async () => {
  const bot = { entity: { position: new Vec3(40, 64, 0) }, game: { dimension: 'overworld' }, on() {}, removeListener() {} };
  const went = [];
  const actions = { underground: () => false,
    goNear: async (b, c, p) => { went.push(p.clone()); bot.entity.position = p.clone(); return { ok: true }; } };
  const skills = { useBed: async () => { throw new Error('no bed to use'); } };
  const rest = createNightRest({ bot, home: () => ({ bed: null, centre: { x: 3, y: 64, z: 3 } }), actions, skills });
  const night = { isDay: false, sheltered: false };
  const context = { signal: AbortSignal.timeout(10000), record() {}, perceive: () => night };
  assert.ok(rest.want(night) > 0);
  await rest.run(context);
  assert.deepEqual(went.map((p) => [p.x, p.z]), [[3.5, 3.5]]);
});
