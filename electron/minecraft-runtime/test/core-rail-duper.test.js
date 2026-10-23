'use strict';
// The rail duplicator's blueprint and site choice. Building and pressing it is
// covered by the raildupe-flat scenario on a vanilla server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createRailDuper } = require('../core/blueprints/railDuper');
const { FACINGS } = require('../core/blueprints/cobbleGenerator');
const { chooseRailDuperSite } = require('../core/goals/railDuper');

const key = (p) => `${p.x},${p.y},${p.z}`;
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

test('every moving part touches the slime; nothing else does; only the base is pushed out of its cell', () => {
  for (const facing of Object.keys(FACINGS)) {
    const d = createRailDuper({ x: -3, y: 63, z: 4 }, facing);
    const u = FACINGS[facing];
    const byKey = Object.fromEntries(d.parts.map((p) => [p.key, p]));
    const slimes = d.parts.filter((p) => p.block === 'slime_block').map((p) => key(p.position));
    const slimeSet = new Set(slimes);
    const parts = new Set(d.parts.map((p) => key(p.position)));
    const moving = new Set([...slimes, ...['fan', 'rail', 'carpet'].map((k) => key(byKey[k].position))]);
    // The slime blocks hold together, and each of fan, rail and carpet touches one.
    const touchesSlime = (p) => NEIGHBOURS.some(([x, y, z]) => slimeSet.has(key({ x: p.x + x, y: p.y + y, z: p.z + z })));
    for (const k of ['fan', 'rail', 'carpet']) assert.ok(touchesSlime(byKey[k].position), `${facing} ${k}`);
    // No block outside the machine touches a slime block: it would be dragged along.
    for (const s of d.parts.filter((p) => p.block === 'slime_block')) {
      for (const [x, y, z] of NEIGHBOURS) {
        const n = key({ x: s.position.x + x, y: s.position.y + y, z: s.position.z + z });
        assert.ok(parts.has(n) || d.clear.some((c) => key(c) === n), `${facing} ${n} beside slime`);
      }
    }
    // Pushed one block along: only the base's cell is entered by another moving block (the pusher).
    const entered = [...moving].map((k) => k.split(',').map(Number)).map(([x, y, z]) => key({ x: x + u.x, y, z: z + u.z }));
    assert.deepEqual(entered.filter((k) => moving.has(k)), [key(byKey.base.position)]);
    // The fan hangs on the base, the carpet stands on the fan, and the carpet is next to the rail.
    assert.deepEqual(sub(byKey.fan.position, byKey.base.position), { ...FACINGS[byKey.fan.facing], y: 0 });
    assert.deepEqual(sub(byKey.carpet.position, byKey.fan.position), { x: 0, y: 1, z: 0 });
    assert.deepEqual(sub(byKey.rail.position, byKey.base.position), { x: 0, y: 1, z: 0 });
    const railToCarpet = sub(byKey.carpet.position, byKey.rail.position);
    assert.equal(Math.abs(railToCarpet.x) + Math.abs(railToCarpet.y) + Math.abs(railToCarpet.z), 1);
    // The piston pushes the pusher into the base.
    assert.deepEqual(sub(byKey.pusher.position, byKey.piston.position), { x: u.x, y: 0, z: u.z });
    // Every part is placed against a neighbour that is already there.
    const placed = new Set(d.floor.map(key));
    for (const part of d.parts) {
      const step = sub(part.against, part.position);
      assert.equal(Math.abs(step.x) + Math.abs(step.y) + Math.abs(step.z), 1, `${facing} ${part.key}`);
      assert.ok(placed.has(key(part.against)), `${facing} ${part.key}`);
      placed.add(key(part.position));
    }
  }
});

test('site choice needs a flat, open area', () => {
  const walls = new Set();
  const block = (x, y, z) => {
    const name = walls.has(`${x},${z}`) && y <= 66 ? 'stone' : y <= 63 ? 'grass_block' : 'air';
    return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' };
  };
  const device = chooseRailDuperSite(block, { x: 0.5, y: 64, z: 0.5 });
  assert.ok(device);
  assert.equal(device.anchor.y, 63);
  for (let x = -12; x <= 12; x += 1) for (let z = -12; z <= 12; z += 1) if ((x + z) % 3 === 0) walls.add(`${x},${z}`);
  assert.equal(chooseRailDuperSite(block, { x: 0.5, y: 64, z: 0.5 }, { radius: 4 }), null);
});
