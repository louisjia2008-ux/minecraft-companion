'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { nudgeAxis, installEdgeNudge } = require('../core/edgeNudge');

test('an edge rounded a hair into the block face is pushed back out', () => {
  // 32.3 - 0.3 === 31.999999999999996: the body pokes into the block at x=31.
  assert.ok(32.3 - 0.3 < 32);
  const x = nudgeAxis(32.3);
  assert.ok(x - 0.3 >= 32);
  assert.ok(x - 32.3 < 1e-5);
  // The same on the far side: -2.3 + 0.3 lands a hair past -2.
  const z = nudgeAxis(-2.3);
  assert.ok(z + 0.3 <= -2);
});

test('positions with no edge on a block face are left alone', () => {
  for (const c of [-2.5, 31.7, -2.7, 0.5, 32.30000001, 100.123]) assert.equal(nudgeAxis(c), c);
});

test('installed on physics ticks and server corrections, and removable', () => {
  const bot = new EventEmitter();
  bot.entity = { position: { x: 32.3, y: 41.42, z: -2.5 } };
  const remove = installEdgeNudge(bot);
  bot.emit('forcedMove');
  assert.ok(bot.entity.position.x - 0.3 >= 32);
  assert.equal(bot.entity.position.z, -2.5);
  remove();
  bot.entity.position.x = 32.3;
  bot.emit('physicsTick');
  assert.equal(bot.entity.position.x, 32.3);
});
