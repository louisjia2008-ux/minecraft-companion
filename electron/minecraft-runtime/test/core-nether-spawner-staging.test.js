'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { Vec3 } = require('vec3');
const { RaycastIterator } = require('prismarine-world').iterators;
const { createNetherSpawnerStaging } = require('../core/netherSpawnerStaging');

const rock = { name: 'nether_bricks', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
const air = { name: 'air', boundingBox: 'empty', shapes: [] };
const lava = { ...air, name: 'lava' };
const fill = { ...rock, name: 'netherrack' };
const point = (x, y, z) => new Vec3(x, y, z);

function fixture() {
  const bot = new EventEmitter();
  const from = point(0, 76, 0);
  const spawner = point(-6, 75, 0);
  const support = point(-1, 74, 0);
  const world = new Map();
  const put = (p, b) => world.set(p.toString(), b);
  const item = { name: 'netherrack', count: 10 };
  bot.entity = { position: from.offset(.5, 0, .5), onGround: true, velocity: point(0, 0, 0) };
  bot.game = { dimension: 'the_nether' };
  bot.entities = { 1: { name: 'blaze', position: point(-4.5, 74, .5), width: .6, height: 1.8, isValid: true } };
  bot.inventory = { items: () => [item] };
  bot.controlState = {};
  bot.pathfinder = { movements: { getNeighbors: () => [] }, setGoal() {} };
  bot.blockAt = (p) => {
    const cell = p.floored();
    const b = world.get(cell.toString());
    return { ...(b || (cell.y <= 73 ? rock : air)), position: cell };
  };
  bot.world = { raycast(eye, dir, distance) {
    const ray = new RaycastIterator(eye, dir, distance);
    for (let cell = ray.next(); cell; cell = ray.next()) {
      const at = point(cell.x, cell.y, cell.z);
      const b = bot.blockAt(at);
      if (b.shapes.length && ray.intersect(b.shapes, at)) return b;
    }
    return null;
  } };
  bot.lookAt = async () => {};
  bot.setControlState = (name, value) => {
    bot.controlState[name] = value;
    if (name === 'forward' && value) {
      if (bot.blockAt(support).name === 'netherrack') bot.entity.position = support.offset(.5, 1, .5);
      else bot.entity.position.x = .35;
    }
  };
  bot.clearControlStates = () => { bot.controlState = {}; };
  bot.equip = async () => {};
  bot.placeBlock = async (reference, face) => {
    assert.deepEqual(reference.position, support.offset(0, -1, 0));
    assert.deepEqual(face, point(0, 1, 0));
    assert.equal(bot.controlState.sneak, true);
    assert.ok(bot.entity.position.x - .3 >= 0);
    put(support, fill);
  };
  const actions = {
    haltBody: () => bot.clearControlStates(),
    recentre: async () => { bot.entity.position = bot.entity.position.floored().offset(.5, 0, .5); },
    goTo: async (_bot, _ctx, goal) => {
      const target = point(goal.x, goal.y, goal.z);
      assert.ok(Math.abs(target.y - bot.entity.position.y) <= 1);
      bot.entity.position = target.offset(.5, 0, .5);
      return { ok: true };
    },
  };
  put(spawner, { ...rock, name: 'spawner' });
  put(from.offset(0, -1, 0), rock);
  put(from.offset(0, -2, 0), rock);
  for (const [x, z] of [[1, 0], [0, -1], [0, 1]]) {
    put(point(x, 74, z), rock);
    put(point(x, 75, z), rock);
    put(point(x, 76, z), rock);
  }
  return { bot, actions, spawner, support, put };
}

test('an accessible two-block descent uses one confirmed supported step then a true staging position', async () => {
  const { bot, actions, spawner, support } = fixture();
  const recorded = [];
  const ctx = { record: (kind, value) => recorded.push([kind, value]) };
  const staging = createNetherSpawnerStaging({ bot, actions });
  let result;
  for (let i = 0; i < 8; i += 1) {
    result = await staging.run(ctx, { spawner });
    if (result?.staged) break;
    assert.ok(result?.staging, JSON.stringify(result));
  }
  assert.ok(result?.staged);
  assert.equal(staging.pending(), false);
  assert.deepEqual(recorded.map(([kind]) => kind), ['spawner_staging_plan', 'spawner_staging_support', 'spawner_staging_arrived']);
  assert.deepEqual(recorded[1][1].block, support);
  assert.equal(bot.blockAt(support).name, 'netherrack');
  assert.ok(bot.entity.position.y <= spawner.y);
});

test('a liquid landing floor never authorizes support placement', async () => {
  const { bot, actions, spawner, support, put } = fixture();
  for (const [x, z] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) put(point(x, 73, z), lava);
  bot.placeBlock = () => assert.fail('liquid floor must not acquire a support');
  const staging = createNetherSpawnerStaging({ bot, actions });
  assert.equal(await staging.run({}, { spawner }), null);
  assert.equal(bot.blockAt(support).name, 'air');
});
