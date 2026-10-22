'use strict';
// The carpet duplicator's blueprint and site choice. Building and pressing it
// is covered by the carpetdupe-flat scenario on a vanilla server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createCarpetDuper } = require('../core/blueprints/carpetDuper');
const { FACINGS } = require('../core/blueprints/cobbleGenerator');
const { chooseCarpetDuperSite } = require('../core/goals/carpetDuper');

const key = (p) => `${p.x},${p.y},${p.z}`;
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

test('piston pushes the slime, the fan hangs off it and holds the carpet', () => {
  for (const facing of Object.keys(FACINGS)) {
    const d = createCarpetDuper({ x: 3, y: 63, z: -2 }, facing);
    const u = FACINGS[facing];
    assert.deepEqual(sub(d.cells.slimeLow, d.cells.piston), { x: u.x, y: 0, z: u.z });
    assert.deepEqual(sub(d.cells.slimeHigh, d.cells.slimeLow), { x: 0, y: 1, z: 0 });
    // The fan points away from the slime it hangs on, the carpet sits on it beside the top slime.
    const fan = d.parts.find((p) => p.key === 'fan');
    const out = FACINGS[fan.facing];
    assert.deepEqual(sub(d.cells.fan, d.cells.slimeLow), { x: out.x, y: 0, z: out.z });
    assert.deepEqual(sub(d.cells.carpet, d.cells.fan), { x: 0, y: 1, z: 0 });
    // Every part is placed against a neighbour, after that neighbour exists.
    const placed = new Set(d.floor.map(key));
    for (const part of d.parts) {
      const step = sub(part.against, part.position);
      assert.equal(Math.abs(step.x) + Math.abs(step.y) + Math.abs(step.z), 1, `${facing} ${part.key}`);
      assert.ok(placed.has(key(part.against)), `${facing} ${part.key}`);
      placed.add(key(part.position));
    }
    // Nothing but the piston, fan and carpet touches the slime: it would drag the ground along.
    const free = new Set([...d.clear, ...d.hollow].map(key));
    for (const slime of [d.cells.slimeLow, d.cells.slimeHigh]) {
      for (const n of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const p = { x: slime.x + n[0], y: slime.y + n[1], z: slime.z + n[2] };
        const k = key(p);
        if (k === key(d.cells.slimeLow) || k === key(d.cells.slimeHigh) || k === key(d.cells.piston)) continue;
        assert.ok(free.has(k), `${facing}: ${k} beside the slime`);
      }
    }
    // The bot can press the button from where it stands.
    assert.ok(Math.hypot(...Object.values(sub(d.cells.button, d.cells.stand))) < 3);
  }
});

test('site choice needs flat ground and room around the device', () => {
  const walls = new Set();
  const block = (x, y, z) => {
    const name = walls.has(`${x},${z}`) && y <= 66 ? 'stone' : y <= 63 ? 'grass_block' : 'air';
    return { name, position: new Vec3(x, y, z), boundingBox: name === 'air' ? 'empty' : 'block' };
  };
  const device = chooseCarpetDuperSite(block, { x: 0.5, y: 64, z: 0.5 });
  assert.ok(device);
  assert.equal(device.anchor.y, 63);
  // Bedrock under every slime cell: nothing it can dig.
  const bedrock = (x, y, z) => (y === 63 ? { ...block(x, y, z), name: 'bedrock' } : block(x, y, z));
  assert.equal(chooseCarpetDuperSite((x, y, z) => (y === 63 && (x !== 0 || z !== 0) ? bedrock(x, y, z) : block(x, y, z)), { x: 0.5, y: 64, z: 0.5 }, { radius: 0 }), null);
  for (let x = -4; x <= 4; x += 1) for (let z = -4; z <= 4; z += 1) if ((x + z) % 2 === 0) walls.add(`${x},${z}`);
  assert.equal(chooseCarpetDuperSite(block, { x: 0.5, y: 64, z: 0.5 }, { radius: 3 }), null);
});
