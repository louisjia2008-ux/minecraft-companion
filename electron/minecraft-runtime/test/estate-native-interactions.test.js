/* global require */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const injectInventory = require('mineflayer/lib/plugins/inventory');
const { withEstateNativeInteractionGuard } = require('../vendor/server/minecraft/estateNativeInteractions');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Installed native inventory plugin, actual 1.21.8 registry and real ALS
// ownership. The delayed look models its asynchronous boundary; no live-server
// or physics acceptance is claimed by this protocol regression.
function fixture({ delayedLook = false } = {}) {
  const contexts = new AsyncLocalStorage();
  const owner = { taskId: 'estate-native-interaction', generation: 1 };
  const state = { cancelled: false, paused: false, generation: 1, activeChecks: 0 };
  const writes = [], looks = [];
  const lookStarted = deferred(), finishLook = deferred();
  const client = new EventEmitter();
  const bot = new EventEmitter();
  const originalWrite = function (...args) { writes.push({ self: this, args, context: contexts.getStore() }); return 'native-write-result'; };
  Object.assign(client, { write: originalWrite });
  Object.assign(bot, { registry, version: '1.21.8', _client: client, QUICK_BAR_START: 36,
    entity: { id: 1, position: new Vec3(.5, 64, .5), yaw: 0, pitch: 0 }, game: { gameMode: 'survival' },
    supportFeature: name => registry.supportFeature(name), swingArm: () => {},
    lookAt: async (point, force) => { looks.push({ point, force }); lookStarted.resolve(); if (delayedLook) await finishLook.promise; },
  });
  injectInventory(bot, { hideErrors: true });
  const block = Block.fromProperties(registry.blocksByName.farmland.id, { moisture: 7 }, 0);
  block.position = new Vec3(1, 63, 1);
  const options = {
    isOwnerContext: () => contexts.getStore() === owner,
    assertActive: () => {
      state.activeChecks += 1;
      if (state.cancelled) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      if (state.paused) throw Object.assign(new Error('paused'), { code: 'paused' });
      if (state.generation !== owner.generation) throw Object.assign(new Error('execution superseded'), { code: 'execution_superseded' });
    },
  };
  const nativeActivate = () => bot.activateBlock(block, new Vec3(0, 1, 0), new Vec3(.2, .8, .4));
  const guarded = operation => contexts.run(owner, () => withEstateNativeInteractionGuard(bot, options, operation || nativeActivate));
  return { bot, client, contexts, owner, state, writes, looks, lookStarted, finishLook, originalWrite, options, nativeActivate, guarded };
}

test('normal installed native activation preserves exact packet, receiver and result', async () => {
  const baseline = fixture(); await baseline.nativeActivate();
  const f = fixture(); const value = await f.guarded();
  assert.equal(value, undefined, 'The native activateBlock return is unchanged');
  assert.deepEqual(f.writes.map(w => w.args), baseline.writes.map(w => w.args));
  assert.deepEqual(f.looks, baseline.looks);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].args[0], 'block_place');
  assert.equal(f.writes[0].self, f.client);
  assert.equal(f.writes[0].args[1].cursorX, .2);
  assert.equal(f.writes[0].args[1].cursorY, .8);
  assert.equal(f.writes[0].args[1].cursorZ, .4);
  assert.equal(f.state.activeChecks, 1);
  assert.equal(f.client.write, f.originalWrite);
  assert.equal(await f.guarded(() => f.client.write('use_item', { hand: 0, sequence: 9 })), 'native-write-result');
});

test('pause or supersession during installed native look prevents the late interaction packet', async () => {
  for (const condition of ['paused', 'cancelled', 'execution_superseded']) {
    const f = fixture({ delayedLook: true });
    const operation = f.guarded();
    const rejected = assert.rejects(operation, error => error.code === condition);
    await f.lookStarted.promise;
    if (condition === 'cancelled') f.state.cancelled = true;
    else if (condition === 'paused') f.state.paused = true;
    else f.state.generation += 1;
    f.finishLook.resolve(); await rejected;
    assert.equal(f.writes.length, 0);
    assert.equal(f.state.activeChecks, 1);
    assert.equal(f.client.write, f.originalWrite);
  }
});

test('installed native activateItem retains its exact 1.21.8 rotation and sequence packet and is blocked for a paused owner', async () => {
  const baseline = fixture(); baseline.bot.activateItem();
  const f = fixture(); await f.guarded(() => f.bot.activateItem());
  assert.deepEqual(f.writes.map(w => w.args), baseline.writes.map(w => w.args));
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].args[0], 'use_item');
  assert.equal(f.writes[0].self, f.client);
  assert.ok(f.writes[0].args[1].rotation);
  f.state.paused = true;
  await assert.rejects(f.guarded(() => f.bot.activateItem()), error => error.code === 'paused');
  assert.equal(f.writes.length, 1);
  assert.equal(f.client.write, f.originalWrite);
});

test('foreign actor native activation remains untouched while the cancelled owner guard is installed', async () => {
  const f = fixture({ delayedLook: true });
  const ownerOperation = f.guarded();
  const rejected = assert.rejects(ownerOperation, error => error.code === 'cancelled');
  await f.lookStarted.promise;
  f.state.cancelled = true;
  const foreign = { taskId: 'other-actor' };
  const foreignOperation = f.contexts.run(foreign, f.nativeActivate);
  f.finishLook.resolve();
  await foreignOperation; await rejected;
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].args[0], 'block_place');
  assert.equal(f.writes[0].context, foreign);
  assert.equal(f.client.write, f.originalWrite);
});

test('only owned block_place and use_item are guarded; protocol and physics packets retain payload identity', async () => {
  const f = fixture(); f.state.cancelled = true;
  const packets = ['keep_alive', 'position', 'position_look', 'look', 'teleport_confirm', 'block_dig'];
  await f.guarded(() => {
    for (const name of packets) { const payload = { token: name }; assert.equal(f.client.write(name, payload), 'native-write-result');
      assert.equal(f.writes.at(-1).args[1], payload); }
    assert.throws(() => f.client.write('block_place', {}), error => error.code === 'cancelled');
    assert.throws(() => f.client.write('use_item', {}), error => error.code === 'cancelled');
  });
  assert.deepEqual(f.writes.map(w => w.args[0]), packets);
  assert.equal(f.state.activeChecks, 2);
  assert.equal(f.client.write, f.originalWrite);
});

test('native synchronous and asynchronous exceptions restore the original writer', async () => {
  for (const operation of [() => { throw new Error('native sync'); }, async () => { throw new Error('native async'); }]) {
    const f = fixture();
    await assert.rejects(f.guarded(operation), /native (sync|async)/);
    assert.equal(f.client.write, f.originalWrite);
  }
});

test('nested and overlapping non-LIFO guards unwind without reviving a completed guard', async () => {
  const f = fixture();
  await f.guarded(async () => {
    const outer = f.client.write;
    await f.guarded(() => f.client.write('use_item', { sequence: 1 }));
    assert.equal(f.client.write, outer);
  });
  assert.equal(f.client.write, f.originalWrite);
  const a = deferred(), b = deferred();
  const first = f.guarded(() => a.promise), firstWriter = f.client.write;
  const second = f.guarded(() => b.promise), secondWriter = f.client.write;
  a.resolve(); await first;
  assert.equal(f.client.write, secondWriter, 'The active inner actor must keep its writer');
  b.resolve(); await second;
  assert.equal(f.client.write, f.originalWrite, 'An inactive previous guard must not be restored');
  assert.notEqual(f.client.write, firstWriter);
});

test('a later actor writer replacement is never overwritten and completed guard becomes inert', async () => {
  const f = fixture(); let replaced;
  await f.guarded(() => {
    const guarded = f.client.write;
    replaced = function (...args) { return guarded.apply(this, args); };
    f.client.write = replaced;
  });
  assert.equal(f.client.write, replaced);
  f.state.cancelled = true;
  f.contexts.run(f.owner, () => f.client.write('use_item', { sequence: 2 }));
  assert.equal(f.writes.length, 1, 'A completed guard retained by another actor must be inert');
  assert.equal(f.state.activeChecks, 0);
});

test('ownership must return exactly true, and invalid guard arguments do not replace client writers', async () => {
  const f = fixture(); f.state.cancelled = true;
  await withEstateNativeInteractionGuard(f.bot, { ...f.options, isOwnerContext: () => ({ owner: true }) }, () => f.client.write('use_item', {}));
  assert.equal(f.writes.length, 1); assert.equal(f.state.activeChecks, 0);
  await assert.rejects(withEstateNativeInteractionGuard(f.bot, {}, () => {}), TypeError);
  assert.equal(f.client.write, f.originalWrite);
});
