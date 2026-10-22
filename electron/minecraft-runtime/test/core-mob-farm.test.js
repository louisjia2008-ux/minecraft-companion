'use strict';
// The underground mob farm's blueprint and site choice. Digging and running it
// is covered by the mobfarm-flat scenario on a vanilla server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createMobFarm, ARM, SHAFT } = require('../core/blueprints/mobFarm');
const { FACINGS } = require('../core/blueprints/cobbleGenerator');
const { chooseMobFarmSite } = require('../core/goals/mobFarm');

const key = (p) => `${p.x},${p.y},${p.z}`;

test('water runs exactly to the hole, the fall kills, the hopper feeds the chest', () => {
  for (const facing of Object.keys(FACINGS)) {
    const f = createMobFarm({ x: 4, y: 63, z: -9 }, facing);
    const { feet, bottom } = f.levels;
    // Each source is ARM cells from the hole: it flows seven blocks and stops beside it.
    for (const w of f.water) {
      assert.equal(Math.abs(w.x - f.cells.hole.x) + Math.abs(w.z - f.cells.hole.z), ARM);
      assert.equal(w.y, feet - 1);
    }
    // 20-hp mobs die from a fall of 23 blocks or more onto the hopper.
    assert.ok(feet - 1 - (bottom + 0.625) >= 23);
    assert.equal(feet - bottom, SHAFT);
    // The bot waits more than 24 blocks from every spawning cell.
    const stand = f.cells.stand;
    for (const c of f.room) assert.ok(Math.hypot(c.x - stand.x, c.y - stand.y, c.z - stand.z) > 24);
    // The hopper points at the chest it is placed against.
    const hopper = f.parts.find((p) => p.key === 'hopper');
    const u = FACINGS[hopper.facing];
    assert.deepEqual({ x: hopper.position.x + u.x, y: hopper.position.y, z: hopper.position.z + u.z }, f.cells.chest);
    assert.deepEqual(hopper.against, f.cells.chest);
    // The stairs reach the surface and end next to the room.
    assert.equal(f.stairs[0].y, f.anchor.y);
    const foot = f.stairs[f.stairs.length - 1];
    assert.equal(Math.abs(foot.x - f.cells.stairsFoot.x) + Math.abs(foot.z - f.cells.stairsFoot.z), 1);
    // Nothing that must stay solid is dug.
    const dug = new Set([...f.stairs, ...f.room, ...f.channels, ...f.shaft, ...f.bottom].map(key));
    assert.ok(f.solid.every((c) => !dug.has(key(c))), facing);
    // No room cell is three high: endermen can't spawn.
    assert.ok(f.room.every((c) => c.y <= feet + 1));
  }
});

test('site choice needs solid rock for the whole farm', () => {
  const caves = new Set();
  const block = (x, y, z) => {
    const name = caves.has(`${x},${y},${z}`) ? 'air' : y < 60 ? 'stone' : y < 63 ? 'dirt' : y === 63 ? 'grass_block' : 'air';
    return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' };
  };
  const farm = chooseMobFarmSite(block, { x: 0.5, y: 64, z: 0.5 });
  assert.ok(farm);
  assert.equal(farm.anchor.y, 63);
  // A cave layer cuts through every shaft within reach.
  for (let x = -40; x <= 40; x += 1) for (let z = -40; z <= 40; z += 1) caves.add(`${x},40,${z}`);
  assert.equal(chooseMobFarmSite(block, { x: 0.5, y: 64, z: 0.5 }, { radius: 2 }), null);
});
