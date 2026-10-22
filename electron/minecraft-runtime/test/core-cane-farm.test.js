'use strict';
// The observer sugar cane column's blueprint and site choice. Building and
// running it is covered by the canefarm-flat scenario on a vanilla server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createCaneFarm } = require('../core/blueprints/caneFarm');
const { FACINGS } = require('../core/blueprints/cobbleGenerator');
const { chooseCaneSite } = require('../core/goals/caneFarm');

const key = (p) => `${p.x},${p.y},${p.z}`;
const adjacent = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) === 1;

test('the observer watches the 3rd cane block, its dust powers the block beside the piston', () => {
  for (const facing of Object.keys(FACINGS)) {
    const f = createCaneFarm({ x: 5, y: 63, z: -2 }, facing);
    const c = f.cells;
    const part = (k) => f.parts.find((p) => p.key === k);
    const ahead = (p, dir) => ({ x: p.x + FACINGS[dir].x, y: p.y, z: p.z + FACINGS[dir].z });
    // Piston head and observer face both point at the cane column.
    assert.deepEqual(ahead(c.piston, part('piston').facing), c.cane2, facing);
    assert.deepEqual(ahead(c.observer, part('observer').facing), c.cane3, facing);
    // The observer's back is the dust, the dust sits on B, B touches the piston.
    const behind = { x: 2 * c.observer.x - c.cane3.x, y: c.observer.y, z: 2 * c.observer.z - c.cane3.z };
    assert.deepEqual(behind, c.dust);
    assert.deepEqual({ ...c.dust, y: c.dust.y - 1 }, c.block);
    assert.ok(adjacent(c.block, c.piston));
    // The cane's dirt touches the water; the cover keeps the bot out of it.
    assert.ok(adjacent(c.dirt, c.water));
    assert.deepEqual({ ...c.water, y: c.water.y + 1 }, c.cover);
    // Nothing is listed both as a cell to keep solid and one to keep clear.
    const solid = new Set(f.solid.map(key));
    assert.ok(f.clear.every((p) => !solid.has(key(p))));
    // Piston and observer are placed from cells kept clear, on solid floors.
    for (const k of ['piston', 'observer']) {
      const stand = part(k).stand;
      assert.ok(f.clear.some((p) => key(p) === key(stand)), `${facing}: ${k} stand`);
      assert.ok(f.standFloors.some((p) => key(p) === key({ ...stand, y: stand.y - 1 })));
    }
  }
});

test('filler parts accept grass that dirt turns into', () => {
  const f = createCaneFarm({ x: 0, y: 63, z: 0 }, 'east');
  for (const k of ['cover', 'block']) assert.ok(f.parts.find((p) => p.key === k).accept.includes('grass_block'));
});

test('site choice needs soil to dig, solid supports and open air', () => {
  const world = new Map();
  const block = (x, y, z) => {
    const name = world.get(`${x},${y},${z}`) ?? (y < 63 ? 'dirt' : y === 63 ? 'grass_block' : 'air');
    return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block' };
  };
  const farm = chooseCaneSite(block, { x: 0.5, y: 64, z: 0.5 });
  assert.ok(farm);
  assert.equal(farm.anchor.y, 63);
  // Sand can't hold the device up: no site when the ground is sand.
  for (let x = -14; x <= 14; x += 1) for (let z = -14; z <= 14; z += 1) world.set(`${x},63,${z}`, 'sand');
  assert.equal(chooseCaneSite(block, { x: 0.5, y: 64, z: 0.5 }, { radius: 4 }), null);
});
