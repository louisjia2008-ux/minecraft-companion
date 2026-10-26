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

test('a bridge deck is found above the thousands of pillar bricks under it', () => {
  // A 3x3 pillar 40 high under a deck at y 104: all 360 pillar bricks are nearer than the deck.
  const cells = {};
  for (let y = 64; y < 104; y += 1) for (let x = 0; x < 3; x += 1) for (let z = 0; z < 3; z += 1) cells[`${x},${y},${z}`] = 'nether_bricks';
  for (let z = 0; z < 3; z += 1) Object.assign(cells, row('nether_bricks', -4, 11, 104, z));
  const floor = structures.fortressFloor(world(cells), new Vec3(1, 64, 1), 60, 4);
  assert.equal(floor.length, 4);
  assert.ok(floor.every((p) => p.y === 104));
});

test('a deck out of reach is towered up to from open ground beside its edge, never from lava', () => {
  // Deck x 0..4 at y 80 over a pillar at x 2; ground at y 64 west of it, lava east.
  const cells = { ...row('nether_bricks', 0, 5, 80), ...row('netherrack', -3, 3, 64), ...row('lava', 5, 3, 64) };
  for (let y = 64; y < 80; y += 1) cells[`2,${y},0`] = 'nether_bricks';
  const bot = world(cells);
  const floor = structures.fortressFloor(bot, new Vec3(2, 80, 0), 8, 16);
  const spots = structures.towerSpots(bot, floor, new Vec3(-2, 65, 0));
  assert.deepEqual(spots.map((s) => `${s.stand.x},${s.stand.y},${s.stand.z}>${s.deck.x}`), ['-1,65,0>0']);
  assert.equal(spots[0].top, 81);
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

test('deep in a lava sea the step goes on the surface, not where the bot sank to', async () => {
  const cells = {};
  for (let x = -3; x <= 3; x += 1) for (let y = 20; y <= 31; y += 1) cells[`${x},${y},0`] = 'lava';
  for (let y = 20; y <= 40; y += 1) cells[`4,${y},0`] = 'netherrack';
  const bot = world(cells);
  bot.entity.position = new Vec3(0.5, 22, 0.5);
  bot.entity.isInLava = true;
  const placed = [];
  Object.assign(bot, new EventEmitter(), { game: { dimension: 'the_nether' }, health: 20, food: 20,
    inventory: { slots: {}, items: () => [{ name: 'cobblestone', count: 8 }] },
    setControlState: () => {}, lookAt: async () => {}, equip: async () => {},
    placeBlock: async (wall, face) => { placed.push(wall.position.plus(face)); cells[`${placed[0].x},${placed[0].y},0`] = 'cobblestone'; } });
  bot.registry.foodsByName = {};
  bot.blockAt = world(cells).blockAt;
  const leaveLava = createSurvivalBehaviors({ bot, thresholds: { swimScale: 0.05 } }).find((b) => b.name === 'leave_lava');
  // Swimming: rise to the surface next to the wall.
  bot.setControlState = () => { bot.entity.position = new Vec3(3.5, 31, 0.5); };
  await leaveLava.run({ record() {}, signal: undefined });
  assert.deepEqual(placed[0], new Vec3(3, 31, 0));
});

test('on the floor of a deep lava pool the bot builds a pillar up instead of giving up', async () => {
  const cells = {};
  for (let y = 20; y <= 26; y += 1) for (let x = -1; x <= 1; x += 1) cells[`${x},${y},0`] = 'lava';
  cells['0,19,0'] = 'netherrack';
  const bot = world(cells);
  bot.blockAt = world(cells).blockAt;
  let y = 20;
  bot.entity.position = new Vec3(0.5, y, 0.5);
  Object.defineProperty(bot.entity, 'isInLava', { get: () => bot.entity.position.y <= 26 });
  bot.entity.onGround = true;
  bot.entity.yaw = 0;
  Object.assign(bot, new EventEmitter(), { game: { dimension: 'the_nether' }, health: 20, food: 20,
    inventory: { slots: {}, items: () => [{ name: 'cobblestone', count: 16 }] },
    setControlState: (control, on) => { if (control === 'jump' && on) bot.entity.position = new Vec3(0.5, y + 2, 0.5); },
    look: async () => {}, lookAt: async () => {}, equip: async () => {},
    placeBlock: async (floor) => { const top = floor.position.offset(0, 1, 0); cells[`${top.x},${top.y},${top.z}`] = 'cobblestone'; bot.blockAt = world(cells).blockAt; y = top.y + 1; bot.entity.position = new Vec3(0.5, y, 0.5); } });
  bot.registry.foodsByName = {};
  bot.registry.blocksByName.cobblestone = { id: 99, name: 'cobblestone' };
  const leaveLava = createSurvivalBehaviors({ bot }).find((b) => b.name === 'leave_lava');
  const records = [];
  const result = await leaveLava.run({ record: (type, data) => records.push([type, data]) });
  assert.equal(result.ok, true);
  assert.equal(bot.entity.isInLava, false);
  assert.ok(records.some(([, d]) => d.tower), 'built a pillar');
});

test('a lava step is never the cell the bot is swimming in', async () => {
  const cells = {};
  for (let x = -3; x <= 0; x += 1) for (let z = 0; z <= 1; z += 1) cells[`${x},31,${z}`] = 'lava';
  for (let y = 25; y <= 40; y += 1) for (let z = 0; z <= 1; z += 1) cells[`1,${y},${z}`] = 'netherrack';
  const bot = world(cells);
  bot.entity.position = new Vec3(0.5, 31, 0.5);
  bot.entity.isInLava = true;
  const placed = [];
  Object.assign(bot, new EventEmitter(), { game: { dimension: 'the_nether' }, health: 20, food: 20,
    inventory: { slots: {}, items: () => [{ name: 'netherrack', count: 8 }] },
    setControlState: () => {}, lookAt: async () => {}, equip: async () => {},
    placeBlock: async (against, face) => { placed.push(against.position.plus(face)); } });
  bot.registry.foodsByName = {};
  const leaveLava = createSurvivalBehaviors({ bot }).find((b) => b.name === 'leave_lava');
  await leaveLava.run({ record() {} });
  assert.ok(placed.length && !placed.some((p) => p.x === 0 && p.z === 0), `placed at ${placed.join(' ')}`);
});

test('in a lava pocket under a low roof the bot digs out room to climb onto a wall', async () => {
  const cells = {};
  for (let x = -1; x <= 1; x += 1) for (let z = -1; z <= 1; z += 1) for (let y = 28; y <= 33; y += 1) cells[`${x},${y},${z}`] = 'netherrack';
  cells['0,30,0'] = 'lava';
  cells['0,29,0'] = 'lava';
  const bot = world(cells);
  bot.entity.position = new Vec3(0.5, 30, 0.5);
  bot.entity.isInLava = true;
  const dug = [];
  Object.assign(bot, new EventEmitter(), { game: { dimension: 'the_nether' }, health: 20, food: 20,
    inventory: { slots: {}, items: () => [{ name: 'diamond_pickaxe' }] },
    setControlState: () => {}, lookAt: async () => {}, equip: async () => {},
    dig: async (b) => { dug.push(b.position.toString()); cells[`${b.position.x},${b.position.y},${b.position.z}`] = 'air'; bot.blockAt = world(cells).blockAt; } });
  bot.registry.foodsByName = {};
  bot.blockAt = world(cells).blockAt;
  const leaveLava = createSurvivalBehaviors({ bot }).find((b) => b.name === 'leave_lava');
  await leaveLava.run({ record() {} });
  assert.deepEqual(dug, ['(1, 31, 0)', '(1, 32, 0)']);
});

test('a brute fled from five times in a row is fought instead of fled from forever', async () => {
  const bot = new EventEmitter();
  bot.entity = { position: new Vec3(0, 64, 0) };
  bot.game = { dimension: 'the_nether' };
  bot.inventory = { slots: { 5: { name: 'golden_helmet' } }, items: () => [] };
  bot.registry = { foodsByName: {} };
  bot.entities = {};
  const state = (distance) => ({ alive: true, health: 20, food: 20, position: bot.entity.position, inventory: { diamond_sword: 1 },
    hostiles: [{ id: 3, name: 'piglin_brute', distance, position: new Vec3(distance, 64, 0) }] });
  const actions = { fleeFrom: async () => ({ ok: true }) };
  const behaviors = createSurvivalBehaviors({ bot, actions });
  const avoid = behaviors.find((b) => b.name === 'avoid');
  const defend = behaviors.find((b) => b.name === 'defend');
  for (let i = 0; i < 5; i += 1) {
    assert.equal(avoid.want(state(10)), 1);
    await avoid.run({ record() {}, perceive: () => state(10) });
  }
  assert.equal(avoid.want(state(10)), 0, 'no more running');
  assert.equal(defend.want(state(5)), 1, 'fought once it comes close');
});

test('a hoglin is fought when it comes close, not run from, while the bot is armed and healthy', () => {
  const bot = new EventEmitter();
  bot.entity = { position: new Vec3(0, 64, 0) };
  bot.game = { dimension: 'the_nether' };
  bot.inventory = { slots: { 5: { name: 'golden_helmet' } }, items: () => [] };
  bot.registry = { foodsByName: {} };
  bot.entities = {};
  const state = (distance, health = 20, inventory = { diamond_sword: 1 }) => ({ alive: true, health, food: 20, position: bot.entity.position,
    inventory, hostiles: [{ id: 3, name: 'hoglin', distance, position: new Vec3(distance, 64, 0) }] });
  const behaviors = createSurvivalBehaviors({ bot, actions: { fleeFrom: async () => ({ ok: true }) } });
  const avoid = behaviors.find((b) => b.name === 'avoid');
  const defend = behaviors.find((b) => b.name === 'defend');
  assert.equal(avoid.want(state(10)), 0);
  assert.equal(defend.want(state(5)), 1);
  assert.equal(avoid.want(state(10, 10)), 1, 'hurt: kept away from');
  assert.equal(avoid.want(state(10, 20, {})), 1, 'unarmed: kept away from');
});

test('a skull left lying after a fight is fetched before anything else', async () => {
  const items = [{ name: 'diamond_sword', count: 1 }];
  const bot = { ...world({}), game: { dimension: 'the_nether' }, inventory: { slots: [], items: () => items }, equip: async () => {} };
  bot.entities = { 7: { id: 7, name: 'item', position: new Vec3(3, 65, 0), getDroppedItem: () => ({ name: 'wither_skeleton_skull' }) } };
  const actions = {
    haltBody() {},
    goNear: async (b, ctx, p) => { assert.equal(p.x, 3); items.push({ name: 'wither_skeleton_skull', count: 1 }); delete bot.entities[7]; return { ok: true }; },
  };
  const goal = createNetherExpeditionGoal({ bot, blazeRods: 0, witherSkulls: 1, trades: 0, actions });
  const events = [];
  const result = await goal.run({ record: (type) => events.push(type), perceive: () => ({ inventory: { diamond_sword: 1 }, health: 20, hostiles: [] }),
    signal: new AbortController().signal });
  assert.equal(result.looted, 'wither_skeleton_skull');
  assert.ok(events.includes('loot'));
});

test('a blaze volley is taken on a raised shield', async () => {
  const bot = new EventEmitter();
  bot.entity = { position: new Vec3(0, 64, 0) };
  bot.game = { dimension: 'the_nether' };
  bot.registry = { foodsByName: {} };
  const ball = { id: 9, name: 'small_fireball', position: new Vec3(6, 65, 0), velocity: new Vec3(-1, 0, 0) };
  bot.entities = { 9: ball };
  bot.inventory = { slots: { 45: { name: 'shield' } }, items: () => [{ name: 'shield' }] };
  const used = [];
  Object.assign(bot, { lookAt: async () => {}, activateItem: (off) => { used.push(`up:${off}`); delete bot.entities[9]; },
    deactivateItem: () => used.push('down') });
  const block = createSurvivalBehaviors({ bot }).find((b) => b.name === 'block');
  assert.equal(block.want({}), 1);
  await block.run({ record() {}, signal: new AbortController().signal });
  assert.deepEqual(used, ['up:true', 'down']);
  ball.velocity = new Vec3(1, 0, 0);
  bot.entities = { 9: ball };
  assert.equal(block.want({}), 0, 'flying away');
  ball.velocity = new Vec3(-1, 0, 0);
  assert.equal(block.want({}), 1);
  bot.registry.effects = { 12: { id: 12, name: 'FireResistance' } };
  bot.entity.effects = { 12: { id: 12 } };
  assert.equal(block.want({}), 0, 'fire resistance takes the fireball');
});

test('respawned at home without a weapon, the expedition stops instead of going back to die', async () => {
  const bot = { ...world({}), game: { dimension: 'overworld' }, inventory: { slots: [], items: () => [] }, equip: async () => {} };
  const goal = createNetherExpeditionGoal({ bot, blazeRods: 2, witherSkulls: 0, trades: 0 });
  const result = await goal.run({ record() {}, perceive: () => ({ inventory: {} }), signal: new AbortController().signal });
  assert.equal(result.reason, 'no_weapon');
});

test('a magma cube beside the swimming bot is hit on the way to the shore', async () => {
  const cells = {};
  for (let x = -3; x <= 3; x += 1) for (let y = 20; y <= 31; y += 1) cells[`${x},${y},0`] = 'lava';
  for (let y = 20; y <= 40; y += 1) cells[`4,${y},0`] = 'netherrack';
  const bot = world(cells);
  bot.entity.position = new Vec3(0.5, 31, 0.5);
  bot.entity.isInLava = true;
  const hits = [];
  const equipped = [];
  Object.assign(bot, new EventEmitter(), { game: { dimension: 'the_nether' }, health: 20, food: 20,
    inventory: { slots: {}, items: () => [{ name: 'diamond_sword', count: 1 }, { name: 'cobblestone', count: 8 }] },
    setControlState: () => {}, lookAt: async () => {}, equip: async (item) => { equipped.push(item.name); },
    attack: (e) => { hits.push(e.id); bot.entity.isInLava = false; bot.entity.onGround = true; },
    placeBlock: async () => {} });
  bot.entities = { 3: { id: 3, name: 'magma_cube', position: new Vec3(1.5, 31, 0.5) } };
  bot.registry.foodsByName = {};
  const leaveLava = createSurvivalBehaviors({ bot }).find((b) => b.name === 'leave_lava');
  await leaveLava.run({ record() {}, signal: undefined });
  assert.deepEqual(hits, [3]);
  assert.equal(equipped[0], 'diamond_sword');
});

test('held in the same spot of a shallow lava pocket try after try, the bot builds up out of it', async () => {
  const cells = {};
  for (let x = -1; x <= 0; x += 1) for (let y = 29; y <= 30; y += 1) cells[`${x},${y},0`] = 'lava';
  cells['0,28,0'] = 'netherrack';
  cells['1,30,0'] = 'netherrack';
  const bot = world(cells);
  let y = 29;
  bot.entity.position = new Vec3(0.5, y, 0.5);
  Object.defineProperty(bot.entity, 'isInLava', { get: () => bot.entity.position.y <= 30 });
  bot.entity.onGround = true;
  bot.entity.yaw = 0;
  let towering = false;
  Object.assign(bot, new EventEmitter(), { game: { dimension: 'the_nether' }, health: 20, food: 20,
    inventory: { slots: {}, items: () => [{ name: 'cobblestone', count: 16 }] },
    setControlState: (control, on) => { if (towering && control === 'jump' && on) bot.entity.position = new Vec3(0.5, y + 2, 0.5); },
    look: async () => { towering = true; }, lookAt: async () => {}, equip: async () => {},
    placeBlock: async (floor) => { const top = floor.position.offset(0, 1, 0); cells[`${top.x},${top.y},${top.z}`] = 'cobblestone'; bot.blockAt = world(cells).blockAt; y = top.y + 1; bot.entity.position = new Vec3(0.5, y, 0.5); } });
  bot.registry.foodsByName = {};
  bot.registry.blocksByName.cobblestone = { id: 99, name: 'cobblestone' };
  const leaveLava = createSurvivalBehaviors({ bot, thresholds: { swimScale: 0.05 } }).find((b) => b.name === 'leave_lava');
  const records = [];
  const ctx = { record: (type, data) => records.push([type, data]) };
  for (let i = 0; i < 4 && bot.entity.isInLava; i += 1) await leaveLava.run(ctx);
  assert.ok(records.some(([, d]) => d.tower), 'built a pillar');
  assert.equal(bot.entity.isInLava, false);
});

test('floating beside a shore it cannot get onto, the bot digs open the space over its head', async () => {
  const cells = {};
  for (let x = -3; x <= 0; x += 1) for (let y = 20; y <= 31; y += 1) cells[`${x},${y},0`] = 'lava';
  cells['1,31,0'] = 'netherrack';
  cells['0,33,0'] = 'cobblestone'; // its own bridge overhead
  const bot = world(cells);
  bot.entity.position = new Vec3(0.5, 31.2, 0.5);
  bot.entity.isInLava = true;
  bot.entity.onGround = false;
  const dug = [];
  Object.assign(bot, new EventEmitter(), { game: { dimension: 'the_nether' }, health: 20, food: 20,
    inventory: { slots: {}, items: () => [{ name: 'diamond_pickaxe', count: 1 }] },
    setControlState: () => {}, lookAt: async () => {}, equip: async () => {},
    dig: async (b) => { dug.push(b.position.toString()); cells[`${b.position.x},${b.position.y},${b.position.z}`] = 'air'; } });
  bot.registry.foodsByName = {};
  const leaveLava = createSurvivalBehaviors({ bot, thresholds: { swimScale: 0.05 } }).find((b) => b.name === 'leave_lava');
  const records = [];
  const ctx = { record: (type, data) => records.push([type, data]) };
  for (let i = 0; i < 4 && !dug.length; i += 1) await leaveLava.run(ctx);
  assert.deepEqual(dug, ['(0, 33, 0)']);
  assert.ok(records.some(([type]) => type === 'lava_held'));
});

test('with skullTries set, that many wither skeletons killed nearby without a skull end the hunt for one', () => {
  const bot = Object.assign(new EventEmitter(), { ...world({}), game: { dimension: 'overworld' }, inventory: { slots: [], items: () => [] } });
  bot.entity.position = new Vec3(0, 64, 0);
  const goal = createNetherExpeditionGoal({ bot, blazeRods: 1, witherSkulls: 1, trades: 0, skullTries: 2 });
  const rodsOnly = { inventory: { blaze_rod: 1 } };
  assert.equal(goal.isDone(rodsOnly), false);
  bot.emit('entityDead', { name: 'wither_skeleton', position: new Vec3(3, 64, 0) });
  bot.emit('entityDead', { name: 'wither_skeleton', position: new Vec3(40, 64, 0) }); // not ours
  bot.emit('entityDead', { name: 'blaze', position: new Vec3(1, 64, 0) });
  assert.equal(goal.isDone(rodsOnly), false);
  bot.emit('entityDead', { name: 'wither_skeleton', position: new Vec3(0, 65, 2) });
  assert.equal(goal.memory.witherKills, 2);
  assert.equal(goal.isDone(rodsOnly), true);
});

test('a pillager is fought by a bot in diamond armour with a sword, and avoided otherwise', () => {
  const bot = new EventEmitter();
  bot.entity = { position: new Vec3(0, 64, 0) };
  bot.game = { dimension: 'overworld' };
  bot.registry = { foodsByName: {} };
  bot.entities = {};
  bot.inventory = { slots: {}, items: () => [] };
  const behaviors = createSurvivalBehaviors({ bot });
  const defend = behaviors.find((b) => b.name === 'defend');
  const avoid = behaviors.find((b) => b.name === 'avoid');
  const state = (inventory) => ({ alive: true, health: 20, food: 20, isDay: true, position: bot.entity.position, inventory,
    hostiles: [{ id: 1, name: 'pillager', distance: 10, position: new Vec3(10, 64, 0) }] });
  assert.equal(avoid.want(state({ diamond_sword: 1 })), 1, 'no armour: run');
  bot.inventory.slots[6] = { name: 'diamond_chestplate' };
  assert.equal(avoid.want(state({ diamond_sword: 1 })), 0);
  assert.equal(defend.want(state({ diamond_sword: 1 })), 1);
});

const { createPortalTrip } = require('../core/netherTrip');

test('a portal frame out of sight is walked back to, not given up for a new site', async () => {
  const bot = { ...world({}), game: { dimension: 'overworld' }, inventory: { slots: [], items: () => [] } };
  bot.blockAt = () => null; // the frame's chunk is not loaded
  const walks = [];
  const actions = { goNear: async (b, ctx, p) => { walks.push(p); return { ok: true }; } };
  const trip = createPortalTrip({ bot, memory: { site: { base: new Vec3(0, 64, 300), axis: 'x' } }, actions });
  await trip.toNether({ record() {} }, { inventory: { obsidian: 2, flint_and_steel: 1 } });
  assert.deepEqual(walks, [new Vec3(0, 64, 300)]);
  assert.deepEqual(trip.memory.site.base, new Vec3(0, 64, 300));
});
