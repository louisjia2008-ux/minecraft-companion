/* global require, setTimeout */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createRuntimeTickLoop } = require('../vendor/server/minecraft/runtimeTickLoop');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('host ticks are serialized, readiness guarded and drained on stop', async () => {
  let ready = false, calls = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const loop = createRuntimeTickLoop({ intervalMs: 5, isReady: () => ready, tick: async () => { calls++; await pending; } });
  await sleep(20); assert.equal(calls, 0); ready = true;
  await sleep(30); assert.equal(calls, 1);
  let drained = false; const stopping = loop.stop().then(() => { drained = true; });
  await sleep(10); assert.equal(drained, false); release(); await stopping;
  await sleep(20); assert.equal(calls, 1);
});
test('tick faults reach the host once; stopped hosts receive no late fault', async () => {
  const faults = []; let ready = true;
  const loop = createRuntimeTickLoop({ intervalMs: 5, isReady: () => ready, tick: async () => { ready = false; throw Error('tick fault'); }, onFault: e => faults.push(e.message) });
  await sleep(30); await loop.stop(); assert.deepEqual(faults, ['tick fault']);
  let reject; const pending = new Promise((_resolve, no) => { reject = no; });
  const second = createRuntimeTickLoop({ intervalMs: 5, isReady: () => true, tick: () => pending, onFault: e => faults.push(e.message) });
  await sleep(20); const stopping = second.stop(); reject(Error('after close')); await stopping;
  assert.deepEqual(faults, ['tick fault']);
});
