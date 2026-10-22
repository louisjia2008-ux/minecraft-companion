'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { penLayout, choosePenSite } = require('../core/husbandry');

test('a 6x6 pen has 19 fence posts and the gate in the middle of the north side', () => {
  const pen = penLayout({ x: 10, y: 64, z: 20 }, 6);
  assert.equal(pen.fences.length, 19);
  assert.deepEqual(pen.gate, { x: 13, y: 64, z: 20 });
  assert.ok(!pen.fences.some((f) => f.x === pen.gate.x && f.z === pen.gate.z));
  assert.ok(pen.contains({ x: 12.5, y: 64, z: 22.5 }));
  assert.ok(!pen.contains({ x: 13.5, y: 64, z: 18.5 }), 'the spot outside the gate is outside');
  assert.ok(!pen.contains({ x: 10.1, y: 64, z: 22 }), 'the fence line itself is not inside');
  assert.ok(!pen.contains({ x: 13.5, y: 64, z: 20.6 }), 'the gate cell is not inside');
});

test('the pen site is flat open ground, clear of trees', () => {
  const blockAt = (p) => {
    if (p.x >= -3 && p.x <= 3 && p.z >= -3 && p.z <= 3 && p.y >= 1 && p.y <= 5) return { name: 'oak_log', boundingBox: 'block' };
    return p.y <= 0 ? { name: 'grass_block', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
  };
  const corner = choosePenSite(blockAt, { x: 0, y: 1, z: 0 }, { size: 6, radius: 16 });
  assert.ok(corner);
  assert.equal(corner.y, 1);
  const overlaps = corner.x <= 3 && corner.x + 6 >= -3 && corner.z - 2 <= 3 && corner.z + 6 >= -3;
  assert.ok(!overlaps, `pen at ${JSON.stringify(corner)} overlaps the tree`);
});
