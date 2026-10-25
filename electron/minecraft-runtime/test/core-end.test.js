'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const end = require('../core/end');
const { crossing } = require('../core/stronghold');

// A world of air with solid blocks at the given cells.
const world = (solids = []) => {
  const set = new Set(solids.map((p) => `${p.x},${p.y},${p.z}`));
  return { blockAt: (p) => {
    const f = p.floored();
    return set.has(`${f.x},${f.y},${f.z}`) ? { name: 'iron_bars', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
  } };
};

test('direction follows mineflayer yaw: 0 faces -z, pi/2 faces -x, positive pitch looks up', () => {
  const near = (a, b) => assert.ok(a.distanceTo(b) < 1e-9, `${a} vs ${b}`);
  near(end.direction(0, 0), new Vec3(0, 0, -1));
  near(end.direction(Math.PI / 2, 0), new Vec3(-1, 0, 0));
  assert.ok(end.direction(0, 0.5).y > 0);
});

test('aim lands an arrow on a target up a pillar, flat arc and lob both', () => {
  const origin = new Vec3(0.5, 65.5, 0.5);
  const target = new Vec3(20.5, 85, 6.5);
  for (const high of [false, true]) {
    const shot = end.aim(origin, target, end.ARROW, { high });
    assert.ok(shot, `no ${high ? 'lob' : 'flat'} shot`);
    assert.ok(end.clearFlight(world(), origin, shot, target, end.ARROW, { radius: 0.5 }));
  }
  const flat = end.aim(origin, target, end.ARROW);
  const lob = end.aim(origin, target, end.ARROW, { high: true });
  assert.ok(lob.pitch >= flat.pitch);
});

test('aim gives null out of range', () => {
  assert.equal(end.aim(new Vec3(0, 64, 0), new Vec3(400, 64, 0), end.PEARL), null);
});

test('flightInfo reports a wall in the way, and the arrival slope', () => {
  const origin = new Vec3(0.5, 65.5, 0.5);
  const target = new Vec3(0.5, 65.5, -15.5);
  const shot = end.aim(origin, target, end.PEARL);
  const open = end.flightInfo(world(), origin, shot, target, end.PEARL, { radius: 0.4 });
  assert.ok(open.hit);
  assert.ok(Math.abs(open.slope) < 0.35, `slope ${open.slope}`);
  const walled = world([new Vec3(0, 65, -8), new Vec3(0, 66, -8)]);
  assert.equal(end.flightInfo(walled, origin, shot, target, end.PEARL, { radius: 0.4 }).hit, false);
});

test('headPosition is 6.5 blocks along the yaw and one lower than the middle', () => {
  const dragon = { position: new Vec3(0, 65, 0), yaw: Math.PI / 2 };
  const head = end.headPosition(dragon);
  assert.ok(Math.abs(head.x - 6.5) < 1e-9 && Math.abs(head.z) < 1e-9 && head.y === 64.5);
  assert.equal(end.headPart({ id: 40, position: dragon.position, yaw: 0 }).id, 41);
});

test('crossing finds where two eye sightings meet, and rejects parallel or behind', () => {
  const a = { start: new Vec3(0, 0, 0), heading: new Vec3(1, 0, 0) };
  const b = { start: new Vec3(100, 0, -50), heading: new Vec3(0, 0, 1) };
  const c = crossing(a, b);
  assert.ok(c && Math.abs(c.x - 100) < 1e-9 && Math.abs(c.z) < 1e-9);
  assert.equal(crossing(a, { start: new Vec3(0, 0, 10), heading: new Vec3(1, 0, 0) }), null);
  assert.equal(crossing(a, { start: new Vec3(-100, 0, -50), heading: new Vec3(0, 0, -1) }), null);
});
