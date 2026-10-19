/* global require */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBankAlignedWaterSession } = require('../vendor/server/minecraft/houseBankAlignedWaterSession');

// Pure host/session composition contracts. Child sessions are deliberate
// controllable contracts, not simulated movement or live-server evidence.
const route = Object.freeze({ schema: 1, from: Object.freeze({ x: 0, y: 2, z: 0 }), to: Object.freeze({ x: 13, y: 2, z: 0 }) });
const failure = code => Object.assign(new Error(code), { code });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function contract() {
  const calls = [], bot = {}, states = {
    alignment: { active: false, holding: false }, water: { active: false, holding: false },
  };
  let active = true, owner = true, validation = () => {}, alignmentBody = async () => ({ confirmed: true }),
    waterBody = async () => ({ confirmed: true }), nativeWrites = 0;
  const child = name => ({
    async [name === 'alignment' ? 'align' : 'traverse'](value) {
      calls.push({ name: `${name}.start`, value }); states[name].active = true;
      try { return await (name === 'alignment' ? alignmentBody(value) : waterBody(value)); }
      finally { states[name].active = false; }
    },
    requestCancel(code) { calls.push({ name: `${name}.cancel`, code }); },
    isActive: () => states[name].active,
    isHolding: () => states[name].holding,
    release() {
      calls.push({ name: `${name}.release` });
      if (!owner) return { foreign: true };
      if (states[name].holding || states[name].active) throw failure(`${name}_release_blocked`);
      nativeWrites++; return { released: true };
    },
  });
  const alignment = child('alignment'), water = child('water');
  const session = createBankAlignedWaterSession({
    getBot: () => bot,
    assertActive: () => { calls.push({ name: 'assert' }); if (!active) throw failure(owner ? 'paused' : 'movement_preempted'); },
    validateRoute: (actualBot, actualRoute) => { calls.push({ name: 'validate' }); assert.equal(actualBot, bot); assert.equal(actualRoute, route); validation(); },
    createAlignment: () => alignment, createTraversal: () => water,
  });
  return { session, calls, states, alignment, water,
    onValidation: fn => { validation = fn; }, onAlignment: fn => { alignmentBody = fn; }, onWater: fn => { waterBody = fn; },
    pause: () => { active = false; }, takeover: () => { owner = false; active = false; }, writes: () => nativeWrites,
    count: name => calls.filter(c => c.name === name).length,
  };
}

test('geometry precedes alignment and water within one observable active session', async () => {
  const f = contract(), align = deferred(), swim = deferred();
  f.onAlignment(() => align.promise); f.onWater(() => swim.promise);
  const running = f.session.traverse(route);
  assert.deepEqual(f.calls.map(c => c.name), ['assert', 'validate', 'assert', 'alignment.start']);
  assert.equal(f.session.isActive(), true);
  assert.equal(f.session.isHolding(), false);
  align.resolve({ confirmed: true }); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.count('water.start'), 1);
  assert.equal(f.calls.find(c => c.name === 'alignment.start').value, route.from);
  assert.equal(f.calls.find(c => c.name === 'water.start').value, route);
  assert.equal(f.session.isActive(), true);
  swim.resolve({ confirmed: true, actualNativeProof: 'belongs to separate native tests' });
  const result = await running; assert.equal(result.confirmed, true);
  assert.equal(f.session.isActive(), false);
  assert.deepEqual(f.session.release(), { released: true });
  assert.equal(f.count('water.release'), 1); assert.equal(f.count('alignment.release'), 0);
});

test('failed geometry never invokes alignment or water', async () => {
  const f = contract(), error = failure('water_bank_changed'); f.onValidation(() => { throw error; });
  await assert.rejects(f.session.traverse(route), e => e === error);
  assert.equal(f.count('alignment.start'), 0); assert.equal(f.count('water.start'), 0);
  assert.equal(f.session.isActive(), false); assert.equal(f.writes(), 0);
});

test('business pause before entry prevents validation and both child actions', async () => {
  const f = contract(); f.pause();
  await assert.rejects(f.session.traverse(route), e => e.code === 'paused');
  assert.equal(f.count('validate'), 0); assert.equal(f.count('alignment.start'), 0); assert.equal(f.count('water.start'), 0);
});

test('cached idle cancellation prevents even dry alignment', async () => {
  const f = contract(); f.session.requestCancel('paused');
  await assert.rejects(f.session.traverse(route), e => e.code === 'paused');
  assert.equal(f.count('alignment.start'), 0); assert.equal(f.count('water.start'), 0);
  assert.equal(f.count('alignment.cancel'), 1); assert.equal(f.count('water.cancel'), 1);
});

test('cancellation during synchronous geometry observation cannot start dry alignment', async () => {
  const f = contract(); f.onValidation(() => f.session.requestCancel('cancelled'));
  await assert.rejects(f.session.traverse(route), e => e.code === 'cancelled');
  assert.equal(f.count('alignment.start'), 0); assert.equal(f.count('water.start'), 0);
});

test('business pause during geometry observation is rechecked before dry alignment', async () => {
  const f = contract(); f.onValidation(() => f.pause());
  await assert.rejects(f.session.traverse(route), e => e.code === 'paused');
  assert.equal(f.count('alignment.start'), 0); assert.equal(f.count('water.start'), 0);
});

test('alignment failure is propagated unchanged and cannot start water or reuse the session', async () => {
  const f = contract(), error = failure('dry_bank_support_changed'); f.onAlignment(async () => { throw error; });
  await assert.rejects(f.session.traverse(route), e => e === error);
  assert.equal(f.count('water.start'), 0); assert.equal(f.session.isActive(), false);
  await assert.rejects(f.session.traverse(route), e => e.code === 'water_session_busy');
  assert.deepEqual(f.session.release(), { released: true }); assert.equal(f.count('alignment.release'), 1); assert.equal(f.count('water.release'), 0);
});

test('cancel while dry alignment awaits blocks water even if child settles successfully', async () => {
  const f = contract(), gate = deferred(); f.onAlignment(() => gate.promise);
  const running = f.session.traverse(route); assert.equal(f.session.isActive(), true);
  f.session.requestCancel('cancelled'); gate.resolve({ confirmed: true });
  await assert.rejects(running, e => e.code === 'cancelled');
  assert.equal(f.count('water.start'), 0); assert.equal(f.session.isActive(), false);
  assert.equal(f.count('alignment.cancel'), 1); assert.equal(f.count('water.cancel'), 1);
});

test('queued cancellation at alignment resolution cannot slip into the water stage', async () => {
  const f = contract();
  f.onAlignment(async () => { await Promise.resolve(); f.session.requestCancel('paused'); return { confirmed: true }; });
  await assert.rejects(f.session.traverse(route), e => e.code === 'paused');
  assert.equal(f.count('water.start'), 0);
});

test('a business pause after alignment settles still prevents water entry', async () => {
  const f = contract(); f.onAlignment(async () => { f.pause(); return { confirmed: true }; });
  await assert.rejects(f.session.traverse(route), e => e.code === 'paused');
  assert.equal(f.count('water.start'), 0);
});

test('first cancellation cause survives later cancellation in the dry gap', async () => {
  const f = contract(), gate = deferred(); f.onAlignment(() => gate.promise);
  const running = f.session.traverse(route); f.session.requestCancel('paused'); f.session.requestCancel('cancelled'); gate.resolve();
  await assert.rejects(running, e => e.code === 'paused');
  assert.equal(f.count('water.start'), 0);
});

test('water cancellation goes to both children and preserves the actual child failure', async () => {
  const f = contract(), reached = deferred(), gate = deferred(), error = failure('water_cancelled');
  f.onWater(async () => { reached.resolve(); return gate.promise; });
  const running = f.session.traverse(route); await reached.promise;
  assert.equal(f.session.isActive(), true); f.session.requestCancel('water_cancelled'); gate.reject(error);
  await assert.rejects(running, e => e === error);
  assert.equal(f.count('alignment.cancel'), 1); assert.equal(f.count('water.cancel'), 1);
  assert.deepEqual(f.session.release(), { released: true }); assert.equal(f.count('water.release'), 1); assert.equal(f.count('alignment.release'), 0);
});

for (const name of ['alignment', 'water']) test(`${name} HOLD remains visible after rejection and cannot be released`, async () => {
  const f = contract(), error = failure(`${name}_cleanup_pending`);
  const body = async () => { f.states[name].holding = true; throw error; };
  if (name === 'alignment') f.onAlignment(body); else f.onWater(body);
  await assert.rejects(f.session.traverse(route), e => e === error);
  assert.equal(f.session.isActive(), false); assert.equal(f.session.isHolding(), true);
  assert.throws(() => f.session.release(), e => e.code === `${name}_release_blocked`);
  assert.equal(f.count(`${name}.release`), 1); assert.equal(f.count(`${name === 'alignment' ? 'water' : 'alignment'}.release`), 0);
  assert.equal(f.writes(), 0); assert.equal(f.session.isHolding(), true);
});

test('foreign ownership during alignment prevents starting water; release delegates only fact cleanup', async () => {
  const f = contract(), gate = deferred(); f.onAlignment(() => gate.promise);
  const running = f.session.traverse(route); f.takeover(); gate.resolve({ confirmed: true });
  await assert.rejects(running, e => e.code === 'movement_preempted');
  assert.equal(f.count('water.start'), 0); assert.deepEqual(f.session.release(), { foreign: true });
  assert.equal(f.count('alignment.release'), 1); assert.equal(f.count('water.release'), 0); assert.equal(f.writes(), 0);
});

test('foreign ownership after water failure never releases unused alignment or writes to the new owner', async () => {
  const f = contract(), error = failure('water_movement_preempted');
  f.onWater(async () => { f.takeover(); throw error; });
  await assert.rejects(f.session.traverse(route), e => e === error);
  assert.deepEqual(f.session.release(), { foreign: true });
  assert.equal(f.count('water.release'), 1); assert.equal(f.count('alignment.release'), 0); assert.equal(f.writes(), 0);
});

test('concurrent or repeated traversal cannot start another child session', async () => {
  const f = contract(), gate = deferred(); f.onAlignment(() => gate.promise);
  const running = f.session.traverse(route);
  await assert.rejects(f.session.traverse(route), e => e.code === 'water_session_busy');
  gate.resolve({ confirmed: true }); await running;
  await assert.rejects(f.session.traverse(route), e => e.code === 'water_session_busy');
  assert.equal(f.count('alignment.start'), 1); assert.equal(f.count('water.start'), 1);
});
