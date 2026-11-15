'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Vec3 } = require('vec3');
const { findNetherCombatCover, hasNetherCombatCover } = require('../core/netherCombatCover');

const solid = { name: 'nether_bricks', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
const air = { name: 'air', boundingBox: 'empty', shapes: [] };
const thin = { name: 'nether_brick_fence', boundingBox: 'block', shapes: [[.375, 0, .375, .625, 1.5, .625]] };
const lava = { ...air, name: 'lava' };
const place = (x, y, z) => new Vec3(x, y, z);

function fixture() {
  const terrain = new Map();
  const put = (x, y, z, block = solid) => terrain.set(place(x, y, z).toString(), block);
  const start = place(.5, 74, .5);
  const threat = { id: 1, isValid: true, name: 'blaze', position: place(5.5, 74, .5), width: .6, height: 1.8 };
  const bot = { game: { dimension: 'the_nether' }, entity: { onGround: true, position: start },
    entities: { 1: threat }, blockAt(p) {
      const cell = p.floored();
      return terrain.has(cell.toString()) ? terrain.get(cell.toString()) : cell.y === 73 ? solid : air;
    } };
  return { bot, put, threat };
}

test('a sheltered floor around a wall yields a short observed cardinal route', () => {
  const { bot, put, threat } = fixture();
  for (const z of [-4, -3, -2]) for (const y of [74, 75, 76]) put(2, y, z);
  put(0, 76, -3);
  const plan = findNetherCombatCover({ bot, threats: [threat] });
  assert.ok(plan);
  assert.deepEqual(plan.position, place(0, 74, -3));
  assert.deepEqual(plan.waypoints, [place(0, 74, -1), place(0, 74, -2), plan.position]);
  const alternate = findNetherCombatCover({ bot, threats: [threat],
    blocked: (from, to) => from.equals(place(0, 74, 0)) && to.equals(plan.waypoints[0]) });
  assert.ok(alternate?.waypoints.length > plan.waypoints.length);
  assert.ok(!alternate.waypoints[0].equals(plan.waypoints[0]));
  assert.equal(hasNetherCombatCover({ bot, threats: [threat], position: plan.position }), true);
  bot.entity.position = plan.position.offset(.5, 0, .5);
  assert.deepEqual(findNetherCombatCover({ bot, threats: [threat] }), { position: plan.position, waypoints: [] });
});

test('roof, partial fences and unknown cells do not prove solid cover from every known shooter', () => {
  const { bot, put, threat } = fixture();
  const stand = place(0, 74, -3);
  put(0, 76, -3);
  for (const z of [-4, -3, -2]) for (const y of [74, 75, 76]) put(2, y, z, thin);
  assert.equal(hasNetherCombatCover({ bot, threats: [threat], position: stand }), false);
  for (const z of [-4, -3, -2]) for (const y of [74, 75, 76]) put(2, y, z);
  assert.equal(hasNetherCombatCover({ bot, threats: [threat], position: stand }), true);
  const other = { ...threat, id: 2, position: place(-4.5, 74, -3.5) };
  bot.entities[2] = other;
  assert.equal(hasNetherCombatCover({ bot, threats: [threat, other], position: stand }), false);
  assert.equal(hasNetherCombatCover({ bot, threats: [threat, { ...other, id: 9 }], position: stand }), false);
  for (const z of [-1, 0, 1]) for (const y of [74, 75, 76]) put(4, y, z, null);
  assert.equal(hasNetherCombatCover({ bot, threats: [threat], position: stand }), false);
});

test('a proven refuge across an unbridgeable chasm is never returned as reachable', () => {
  const { bot, put, threat } = fixture();
  const stand = place(0, 74, -3);
  for (let x = -13; x <= 13; x += 1) {
    put(x, 73, -1, lava);
    put(x, 73, 1, lava);
  }
  for (const z of [-4, -3, -2]) for (const y of [74, 75, 76]) put(2, y, z);
  put(0, 76, -3);
  assert.equal(hasNetherCombatCover({ bot, threats: [threat], position: stand }), true);
  assert.equal(findNetherCombatCover({ bot, threats: [threat] }), null);
});
