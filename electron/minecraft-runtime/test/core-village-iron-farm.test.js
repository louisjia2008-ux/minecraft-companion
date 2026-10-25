'use strict';
// Laying rails to a villager, and where the minecart iron farm goes beside a
// village. Finding the village, loading and pushing the carts is covered by the
// ironfarm-village-flat scenario.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { railPath, railCell, chooseVillageFarmSite, trackDismounts } = require('../core/goals/villageIronFarm');

const key = (x, y, z) => `${x},${y},${z}`;

// Grass at y=63 over stone, air above; `set` overrides single blocks.
function flat(set = {}) {
  return (x, y, z) => {
    const name = set[key(x, y, z)] || (y < 60 ? 'stone' : y < 63 ? 'dirt' : y === 63 ? 'grass_block' : 'air');
    const empty = name === 'air' || /rail$|short_grass|poppy/.test(name);
    return { name, position: new Vec3(x, y, z), boundingBox: empty ? 'empty' : 'block' };
  };
}

test('a straight run of rails from the line end to the villager', () => {
  const at = flat({ [key(0, 64, 0)]: 'rail' });
  const path = railPath(at, { x: 0, y: 64, z: 0 }, { x: 5, y: 64, z: 0 });
  assert.deepEqual(path.map((c) => c.x), [1, 2, 3, 4, 5]);
  assert.ok(path.every((c) => c.y === 64 && c.z === 0));
});

test('around a wall, never beside another rail, and not across a fence or crops', () => {
  const set = { [key(0, 64, 0)]: 'rail' };
  for (let z = -3; z <= 3; z += 1) set[key(3, 64, z)] = 'oak_planks';
  // Someone else's rail along z=-4: the path must keep one cell off it.
  for (let x = 1; x <= 6; x += 1) set[key(x, 64, -4)] = 'rail';
  // Farmland and a fence block the low way round.
  set[key(3, 63, -3)] = 'farmland';
  const at = flat(set);
  const path = railPath(at, { x: 0, y: 64, z: 0 }, { x: 6, y: 64, z: 0 });
  assert.ok(path);
  assert.deepEqual(path[path.length - 1], { x: 6, y: 64, z: 0 });
  for (const c of path) {
    assert.notEqual(set[key(c.x, 64, c.z)], 'oak_planks');
    assert.notEqual(c.z, -3, 'beside the other rail, or on farmland');
  }
  // Each step is one cell across.
  let prev = { x: 0, z: 0 };
  for (const c of path) {
    assert.equal(Math.abs(c.x - prev.x) + Math.abs(c.z - prev.z), 1);
    prev = c;
  }
});

test('grass and flowers are cleared, a dirt path or a hole is redone, a slab or a door is not a rail cell', () => {
  assert.deepEqual(railCell(flat({ [key(0, 64, 0)]: 'short_grass' }), { x: 0, y: 64, z: 0 }), { path: false, fill: false });
  assert.deepEqual(railCell(flat({ [key(0, 63, 0)]: 'dirt_path' }), { x: 0, y: 64, z: 0 }), { path: true, fill: false });
  assert.deepEqual(railCell(flat({ [key(0, 63, 0)]: 'air' }), { x: 0, y: 64, z: 0 }), { path: false, fill: true });
  assert.equal(railCell(flat({ [key(0, 63, 0)]: 'air', [key(0, 62, 0)]: 'air' }), { x: 0, y: 64, z: 0 }), null);
  assert.equal(railCell(flat({ [key(0, 63, 0)]: 'oak_slab' }), { x: 0, y: 64, z: 0 }), null);
  assert.equal(railCell(flat({ [key(0, 64, 0)]: 'oak_door' }), { x: 0, y: 64, z: 0 }), null);
  assert.equal(railCell(flat({ [key(0, 63, 0)]: 'water' }), { x: 0, y: 64, z: 0 }), null);
});

test('the line may run beside its own rails, never beside someone else\'s', () => {
  // Our line came along z=1 and turned up to the end at (0,0); the way on runs beside it.
  const set = { [key(0, 64, 0)]: 'rail' };
  for (let x = -5; x <= 0; x += 1) set[key(x, 64, 1)] = 'rail';
  for (let x = 1; x <= 5; x += 1) set[key(x, 64, 1)] = 'stone';
  const at = flat(set);
  const target = { x: 4, y: 64, z: 0 };
  assert.equal(railPath(at, { x: 0, y: 64, z: 0 }, { x: -3, y: 64, z: 0 }), null);
  const ours = new Set(Object.keys(set).filter((k) => set[k] === 'rail'));
  const path = railPath(at, { x: 0, y: 64, z: 0 }, { x: -3, y: 64, z: 0 }, { ours });
  assert.deepEqual(path.map((c) => c.x), [-1, -2, -3]);
  assert.ok(railPath(at, { x: 0, y: 64, z: 0 }, target, { ours }));
});

test('the line runs up to a parked cart\'s own rail and ends on it', () => {
  const set = { [key(0, 64, 0)]: 'rail', [key(4, 64, 2)]: 'rail' };
  const at = flat(set);
  const stub = { x: 4, y: 64, z: 2 };
  // Someone else's rail: never next to it, so no way onto it.
  assert.equal(railPath(at, { x: 0, y: 64, z: 0 }, stub), null);
  const ours = new Set([key(0, 64, 0), key(4, 64, 2)]);
  const path = railPath(at, { x: 0, y: 64, z: 0 }, stub, { ours, targetIsRail: true });
  assert.equal(path.length, 6);
  assert.deepEqual(path[path.length - 1], stub);
});

test('no route past the limit, or to another level', () => {
  const set = { [key(0, 64, 0)]: 'rail' };
  for (let z = -40; z <= 40; z += 1) set[key(3, 64, z)] = 'stone';
  const at = flat(set);
  assert.equal(railPath(at, { x: 0, y: 64, z: 0 }, { x: 6, y: 64, z: 0 }, { max: 20 }), null);
  assert.equal(railPath(at, { x: 0, y: 64, z: 0 }, { x: 1, y: 65, z: 0 }), null);
});

test('the farm goes 24-40 blocks out, its stairs facing the village', () => {
  const at = flat();
  // Deep rock: the farm is eight blocks down.
  const deep = (x, y, z) => at(x, y, z);
  const village = { x: 100, y: 64, z: 0 };
  const farm = chooseVillageFarmSite(deep, village);
  assert.ok(farm);
  const top = farm.cells.stairsTop;
  const corridor = Math.hypot(farm.anchor.x - village.x, farm.anchor.z - village.z);
  assert.ok(corridor >= 24 && corridor <= 46, `corridor ${corridor}`);
  assert.ok(Math.hypot(top.x - village.x, top.z - village.z) < corridor);
});

test('a villager left out of its cart\'s passenger list is no longer seated', () => {
  const { EventEmitter } = require('node:events');
  const client = new EventEmitter();
  const cart = { id: 5, passengers: [] };
  const villager = { id: 7, vehicle: cart };
  cart.passengers.push(villager);
  const bot = { _client: client, entities: { 5: cart, 7: villager } };
  trackDismounts(bot);
  trackDismounts(bot); // once per bot
  client.emit('set_passengers', { entityId: 5, passengers: [] });
  assert.equal(villager.vehicle, null);
  assert.deepEqual(cart.passengers, []);
  assert.equal(client.listenerCount('set_passengers'), 1);
});
