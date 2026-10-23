'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const structures = require('../core/netherStructures');
const { createSurvivalBehaviors } = require('../core/behaviors/survival');
const { createNetherExpeditionGoal } = require('../core/goals/netherExpedition');

const NAMES = ['air', 'netherrack', 'nether_bricks', 'polished_blackstone_bricks', 'gilded_blackstone', 'spawner', 'lava'];
const registry = {
  blocksByName: Object.fromEntries(NAMES.map((name, id) => [name, { id, name }])),
  entitiesByName: { piglin: { metadataKeys: ['shared_flags', 'baby'] } },
  effects: { 11: { id: 11, name: 'FireResistance' } },
};

// A voxel world from a map of "x,y,z" -> name; everything else is air.
function world(cells) {
  const blocks = new Map(Object.entries(cells));
  const blockAt = (p) => {
    const position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    const name = blocks.get(`${position.x},${position.y},${position.z}`) || 'air';
    return { name, position, boundingBox: /^(air|lava)$/.test(name) ? 'empty' : 'block' };
  };
  const findBlocks = ({ matching, maxDistance, count, point }) => {
    const ids = new Set([].concat(matching));
    const here = point || bot.entity.position;
    return [...blocks.entries()]
      .filter(([, name]) => ids.has(registry.blocksByName[name].id))
      .map(([key]) => new Vec3(...key.split(',').map(Number)))
      .filter((p) => p.distanceTo(here) <= maxDistance)
      .sort((a, b) => a.distanceTo(here) - b.distanceTo(here))
      .slice(0, count);
  };
  const bot = { registry, blockAt, findBlocks, entity: { position: new Vec3(0, 65, 0) }, entities: {} };
  return bot;
}

const row = (name, from, n, y = 64, z = 0) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${from + i},${y},${z}`, name]));

test('a fortress needs a cluster of nether bricks; a few stray blocks are not one', () => {
  assert.equal(structures.findStructure(world(row('nether_bricks', 40, 10)), 'fortress'), null);
  const found = structures.findStructure(world(row('nether_bricks', 40, 30)), 'fortress');
  assert.deepEqual(found.position, new Vec3(40, 64, 0));
});

test('a bastion needs many blackstone bricks: a ruined portal\'s handful does not count', () => {
  assert.equal(structures.findStructure(world(row('polished_blackstone_bricks', 10, 12)), 'bastion'), null);
  const cells = { ...row('polished_blackstone_bricks', 10, 30), ...row('gilded_blackstone', 10, 30, 65) };
  assert.ok(structures.findStructure(world(cells), 'bastion'));
});

test('the fortress floor is searched around the given point, not around the bot', () => {
  const bot = world(row('nether_bricks', 200, 4));
  assert.equal(structures.fortressFloor(bot, new Vec3(201, 64, 0), 8).length, 4);
});

test('the fortress floor is nether bricks with two open cells above', () => {
  const bot = world({ ...row('nether_bricks', 0, 4), '1,65,0': 'nether_bricks', '2,66,0': 'netherrack' });
  const floor = structures.fortressFloor(bot, new Vec3(0, 64, 0), 10).map((p) => `${p.x},${p.y}`).sort();
  assert.deepEqual(floor, ['0,64', '1,65', '3,64']);
});

test('baby piglins and busy piglins are told apart', () => {
  const bot = world({});
  assert.equal(structures.isAdultPiglin(bot, { name: 'piglin', metadata: {} }), true);
  assert.equal(structures.isAdultPiglin(bot, { name: 'piglin', metadata: { 1: true } }), false);
  assert.equal(structures.isAdultPiglin(bot, { name: 'piglin_brute', metadata: {} }), false);
  assert.equal(structures.piglinBusy({ equipment: [null, { name: 'gold_ingot' }] }), true);
  assert.equal(structures.piglinBusy({ equipment: [] }), false);
});

test('fire resistance potions are recognised by their contents', () => {
  const potion = (data) => ({ name: 'potion', components: [{ type: 'potion_contents', data }] });
  assert.equal(structures.isFireResistancePotion(potion({ potionId: 12 })), true);
  assert.equal(structures.isFireResistancePotion(potion({ potionId: 0 })), false, 'water bottle');
  assert.equal(structures.isFireResistancePotion({ name: 'cooked_beef' }), false);
});

test('a piglin brute is kept away from even though the bot wears gold', () => {
  const bot = new EventEmitter();
  bot.entity = { position: new Vec3(0, 64, 0) };
  bot.game = { dimension: 'the_nether' };
  bot.inventory = { slots: { 5: { name: 'golden_helmet' } }, items: () => [] };
  bot.registry = { foodsByName: {} };
  bot.entities = {};
  const behaviors = createSurvivalBehaviors({ bot });
  const avoid = behaviors.find((b) => b.name === 'avoid');
  const defend = behaviors.find((b) => b.name === 'defend');
  const state = (name, distance) => ({ alive: true, health: 20, food: 20, position: bot.entity.position, inventory: {},
    hostiles: [{ id: 1, name, distance, position: new Vec3(distance, 64, 0) }] });
  assert.equal(avoid.want(state('piglin_brute', 8)), 1);
  assert.equal(defend.want(state('piglin_brute', 6)), 0, 'not fought from afar');
  assert.equal(defend.want(state('piglin_brute', 3)), 1, 'fought once it is on the bot');
  assert.equal(avoid.want(state('piglin_brute', 3)), 0);
  assert.equal(avoid.want(state('piglin_brute', 20)), 0);
  assert.equal(avoid.want(state('piglin', 3)), 0);
});

test('the expedition counts rods, skulls and trades and is only done back home', () => {
  const bot = { ...world({}), game: { dimension: 'the_nether' }, inventory: { slots: [], items: () => [] } };
  const goal = createNetherExpeditionGoal({ bot, blazeRods: 2, witherSkulls: 1, trades: 1 });
  const full = { inventory: { blaze_rod: 2, wither_skeleton_skull: 1 } };
  assert.equal(goal.isDone(full), false, 'no trade yet');
  goal.memory.trades = 1;
  assert.equal(goal.isDone(full), false, 'still in the nether');
  bot.game.dimension = 'overworld';
  assert.equal(goal.isDone(full), true);
  assert.ok(goal.progress(full) > goal.progress({ inventory: {} }));
  assert.throws(() => createNetherExpeditionGoal({ bot, trades: -1 }), TypeError);
});
