'use strict';
// The hopper-fed furnace's blueprint and site choice. Building and running it
// is covered by the smelter-flat scenario on a vanilla server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createAutoSmelter } = require('../core/blueprints/autoSmelter');
const { FACINGS } = require('../core/blueprints/cobbleGenerator');
const { chooseSmelterSite } = require('../core/goals/autoSmelter');

const key = (p) => `${p.x},${p.y},${p.z}`;

test('every part is placed against a block that already stands, hoppers point the right way', () => {
  for (const facing of Object.keys(FACINGS)) {
    const d = createAutoSmelter({ x: 3, y: 63, z: -7 }, facing);
    const dug = new Set(d.dig.map(key));
    const placed = new Set();
    for (const part of d.parts) {
      const support = key(part.against);
      // Either an earlier part, or ground that is not dug out.
      assert.ok(placed.has(support) || (!dug.has(support) && part.against.y < d.anchor.y),
        `${facing}: ${part.key} has nothing to be placed against`);
      if (part.block === 'hopper') {
        const dx = part.against.x - part.position.x;
        const dz = part.against.z - part.position.z;
        const expected = part.against.y < part.position.y ? 'down' : facing;
        assert.equal(part.facing, expected, `${facing}: ${part.key}`);
        assert.ok(dx === 0 && dz === 0 ? part.facing === 'down' : FACINGS[part.facing].x === dx && FACINGS[part.facing].z === dz);
      }
      // Anything placed against a container must be placed sneaking.
      const against = d.parts.find((p) => key(p.position) === support);
      if (against) assert.ok(part.sneak, `${facing}: ${part.key} against ${against.key} without sneaking`);
      placed.add(key(part.position));
    }
    // The input chest's support (the input hopper's top face) is at most one block above ground.
    assert.ok(d.cells.inHopper.y + 1 <= d.anchor.y + 2);
  }
});

test('site choice needs diggable ground, solid floors and open air above', () => {
  const world = new Map();
  const block = (x, y, z) => {
    const name = world.get(`${x},${y},${z}`) ?? (y < 0 ? 'dirt' : y === 0 ? 'grass_block' : 'air');
    return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block' };
  };
  const device = chooseSmelterSite(block, { x: 0.5, y: 1, z: 0.5 });
  assert.ok(device);
  assert.equal(device.anchor.y, 0);
  for (let x = -12; x <= 12; x += 1) for (let z = -12; z <= 12; z += 1) world.set(`${x},-2,${z}`, 'water');
  assert.equal(chooseSmelterSite(block, { x: 0.5, y: 1, z: 0.5 }, { radius: 4 }), null);
});
