'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runNativePhysicsClock } = require('../test-support/native-physics-clock.cjs');

for (const stepMs of [10, 20]) test(`native fixture clock preserves its ${stepMs}ms cadence and deadline`, { timeout: 1000 }, async t => {
  let ticks = 0, timer;
  const elapsed = await runNativePhysicsClock(t, async () => {
    const start = Date.now();
    timer = setInterval(() => ticks++, stepMs);
    await new Promise(resolve => setTimeout(resolve, 40));
    clearInterval(timer);
    return Date.now() - start;
  }, { maximumMs: 100, stepMs, stop: () => clearInterval(timer) });
  assert.equal(elapsed, 40);
  assert.equal(ticks, 40 / stepMs);
});

test('native fixture clock does not extend an exhausted logical budget', { timeout: 1000 }, async t => {
  let join, stops = 0;
  await assert.rejects(runNativePhysicsClock(t, () => new Promise(resolve => { join = resolve; }), {
    maximumMs: 100, stepMs: 10, stop: () => { stops++; join(); },
  }), /original logical test limit/);
  assert.equal(stops, 1);
});
