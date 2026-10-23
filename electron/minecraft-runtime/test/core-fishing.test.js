'use strict';
// The fishing pond's blueprint and site choice. Digging, filling and fishing
// from it are covered by the fishing-flat scenario on a vanilla server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createFishPond } = require('../core/blueprints/fishPond');
const { FACINGS } = require('../core/blueprints/cobbleGenerator');
const { choosePondSite } = require('../core/goals/fishing');

const key = (p) => `${p.x},${p.y},${p.z}`;
const near = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) === 1;

test('two poured sources fill the whole pond, the rim holds it, the bot stands on its edge', () => {
  for (const facing of Object.keys(FACINGS)) {
    const p = createFishPond({ x: 2, y: 63, z: -5 }, facing);
    const pond = new Set(p.pond.map(key));
    // Every other pond cell touches both poured sources, so it becomes a source.
    for (const c of p.pond.filter((c) => !p.water.some((w) => key(w) === key(c)))) {
      assert.ok(p.water.every((w) => near(w, c)), `${facing} ${key(c)}`);
    }
    // Each sideways neighbour of the pond is pond or rim.
    const rim = new Set(p.rim.map(key));
    for (const c of p.pond) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = key({ x: c.x + dx, y: c.y, z: c.z + dz });
        assert.ok(pond.has(n) || rim.has(n), `${facing} ${n}`);
      }
    }
    // The bot stands on the rim right beside the pond and aims inside it.
    const s = p.cells.stand;
    assert.ok(rim.has(key({ ...s, y: s.y - 1 })));
    assert.ok(p.pond.some((c) => near({ ...s, y: s.y - 1 }, c)));
    assert.ok(p.pond.some((c) => Math.floor(p.target.x) === c.x && Math.floor(p.target.z) === c.z));
  }
});

test('site choice needs solid flat ground', () => {
  const holes = new Set();
  const block = (x, y, z) => {
    const name = holes.has(`${x},${z}`) && y === 62 ? 'air' : y <= 63 ? 'grass_block' : 'air';
    return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' };
  };
  const pond = choosePondSite(block, { x: 0.5, y: 64, z: 0.5 });
  assert.ok(pond);
  assert.equal(pond.anchor.y, 63);
  // A cave right under the topsoil everywhere: no pond floor holds.
  for (let x = -12; x <= 12; x += 1) for (let z = -12; z <= 12; z += 1) holes.add(`${x},${z}`);
  assert.equal(choosePondSite(block, { x: 0.5, y: 64, z: 0.5 }, { radius: 3 }), null);
});
