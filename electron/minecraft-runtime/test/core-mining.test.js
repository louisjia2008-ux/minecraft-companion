'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { stepCells, stepSafe } = require('../core/mining');

test('a staircase step clears head, body and the cell below ahead, and needs a floor under that', () => {
  const cells = stepCells(new Vec3(0, 40, 0), [1, 0], 'down');
  assert.deepEqual(cells.next, new Vec3(1, 39, 0));
  assert.deepEqual(cells.dig.map((p) => p.y), [41, 40, 39]);
  assert.deepEqual(cells.floor, new Vec3(1, 38, 0));
  const level = stepCells(new Vec3(0, 16, 0), [0, -1], 'level');
  assert.deepEqual(level.next, new Vec3(0, 16, -1));
  assert.equal(level.dig.length, 2);
});

test('a step that would open onto lava or water is not safe', () => {
  const lavaAt = new Set(['2,40,0']);
  const bot = { blockAt: (p) => ({ name: lavaAt.has(`${p.x},${p.y},${p.z}`) ? 'lava' : 'stone' }) };
  assert.equal(stepSafe(bot, stepCells(new Vec3(0, 40, 0), [1, 0], 'down')), false);
  assert.equal(stepSafe(bot, stepCells(new Vec3(0, 40, 0), [-1, 0], 'down')), true);
});
