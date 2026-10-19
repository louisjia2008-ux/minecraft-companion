/* global require, setTimeout, clearTimeout */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry), Item = require('prismarine-item')(registry);
const WorldSync = require('prismarine-world/src/worldsync');
const { createHouseNativeDigSession, isOwnedHouseNativeDigCancel } = require('../vendor/server/minecraft/houseNativeDigSession');
const { withHouseNativeSourceGuard } = require('../vendor/server/minecraft/houseNativeSourceGuard');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = p => `${p.x},${p.y},${p.z}`;
async function until(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  assert.ok(predicate(), 'installed native operation reached condition within bound');
}

// Installed inventory/physics/digging drive the native look and dig timer. The
// in-memory world models Mineflayer's own local prediction, not a server ACK.
function fixture(t, options = {}) {
  const storage = new AsyncLocalStorage(), cells = new Map(), writes = [], signals = [], configs = [], aborted = [];
  const owner = { task: { id: 'dig-A' }, generation: 0, lease: { token: 1 }, context: {} };
  const client = Object.assign(new EventEmitter(), { state: 'play' });
  let current = owner, paused = false, failCancel = false;
  const bot = Object.assign(new EventEmitter(), { registry, version: '1.21.8', username: 'NativeDigTest', _client: client,
    QUICK_BAR_START: 36, health: 20, food: 20, isAlive: true, entities: {}, players: {},
    supportFeature: name => registry.supportFeature(name), game: { dimension: 'overworld', minY: -64, height: 384, gameMode: 'survival' },
    entity: { id: 1, position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0), onGround: true,
      eyeHeight: 1.62, height: 1.8, width: .6, yaw: 0, pitch: 0, effects: {}, attributes: {}, isInWater: false,
      isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: true, elytraFlying: false } });
  const nativeWrite = function (name, data) {
    if (name === 'block_dig' && data.status === 1 && failCancel) throw Object.assign(new Error('cancel transport failed'), { code: 'SOCKET_CANCEL' });
    writes.push({ name, data, at: Date.now(), cancelProof: isOwnedHouseNativeDigCancel(bot, name, data) });
    options.onWrite?.({ bot, name, data });
  };
  client.write = nativeWrite;
  bot.blockAt = p => {
    const position = p.floored(), name = cells.get(key(position)) || (position.y < 64 ? 'stone' : 'air');
    return Object.assign(Block.fromProperties(registry.blocksByName[name].id, {}, 0), { position });
  };
  bot.world = { getBlock: p => bot.blockAt(p), raycast: WorldSync.prototype.raycast };
  bot._updateBlockState = (position, id) => {
    const before = bot.blockAt(position); cells.set(key(position), Block.fromStateId(id).name);
    const after = bot.blockAt(position); bot.emit(`blockUpdate:${position}`, before, after); bot.emit('blockUpdate', before, after);
  };
  require('mineflayer/lib/plugins/inventory')(bot, {});
  require('mineflayer/lib/plugins/simple_inventory')(bot); bot.quickBarSlot = 0;
  const slots = Array.from({ length: 46 }, () => Item.toNotch(null));
  slots[36] = Item.toNotch(new Item(registry.itemsByName.diamond_pickaxe.id, 1));
  client.emit('window_items', { windowId: 0, stateId: 1, items: slots, carriedItem: Item.toNotch(null) });
  bot.swingArm = () => client.write('arm_animation', { hand: 0 });
  require('mineflayer/lib/plugins/physics')(bot, {});
  require('mineflayer/lib/plugins/digging')(bot);
  bot.emit('login'); client.emit('position', { x: .5, y: 64, z: .5, yaw: 180, pitch: 0, flags: {} });
  const ready = bot.waitForTicks(2);
  const active = () => {
    if (paused) throw Object.assign(new Error('paused'), { code: 'paused' });
    if (current !== owner) throw Object.assign(new Error('movement_preempted'), { code: 'movement_preempted' });
  };
  const deps = { getBot: () => bot, captureOwner: () => current, assertOwner: captured => { active(); assert.equal(captured, owner); },
    isOwnerCurrent: captured => current === captured && !paused, isOwnerContext: captured => storage.getStore() === captured.context,
    abortOwner: (error, captured) => { aborted.push({ error, owner: captured }); paused = true; },
    runPhysicalAction: async (kind, primitive, op, config) => {
      assert.equal(kind, 'act'); assert.equal(primitive, 'bot.dig'); configs.push(config);
      let timer;
      try { return await Promise.race([op(signal => signals.push(signal)), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('physical deadline'), { code: 'step_timeout' })), config.timeoutMs);
      })]); } finally { clearTimeout(timer); }
    } };
  const session = createHouseNativeDigSession(deps);
  const ctx = { assertActive: active, beforeSend: active };
  const run = async action => {
    await ready;
    return storage.run(owner.context, () => withHouseNativeSourceGuard(bot, {
      assertActive: active, isOwnerContext: () => storage.getStore() === owner.context,
      allowNativeCancel: isOwnedHouseNativeDigCancel, beforeSend: options.outerBeforeSend,
    }, action));
  };
  const block = (name = 'stone', position = new Vec3(2, 64, 0)) => { cells.set(key(position), name); return bot.blockAt(position); };
  t.after(() => { paused = true; bot.clearControlStates(); bot.emit('end'); });
  return { bot, client, storage, owner, session, ctx, deps, ready, run, block, writes, signals, configs, aborted, nativeWrite,
    pause: () => { paused = true; }, replaceOwner: () => { current = { task: { id: 'dig-B' }, context: {} }; return current; },
    failCancel: value => { failCancel = value; } };
}
const packets = f => f.writes.filter(write => write.name === 'block_dig');
const started = f => packets(f).some(write => write.data.status === 0);

test('ordinary dig awaits installed completion with actual native signals and the 12 second default', { timeout: 5000 }, async t => {
  const f = fixture(t); await f.run(() => f.session.dig(f.block(), f.ctx));
  assert.deepEqual(packets(f).map(write => write.data.status), [0, 2]);
  assert.equal(f.bot.targetDigBlock, null);
  assert.deepEqual(f.signals.filter(signal => signal !== 'native_dig_swing'), ['native_dig_started', 'native_dig_finish_packet']);
  assert.equal(f.configs[0].timeoutMs, 12000); assert.equal(f.configs[0].requireStartupSignal, false);
});

test('a newly protected route floor at the outer finish sink rejects the original cause and settles native digging', { timeout: 5000 }, async t => {
  const cause = new Error('pending river bed was discovered');
  const error = Object.assign(new Error('protected route floor'), { code: 'house_resource_protected', cause });
  let protectedNow = false;
  const f = fixture(t, { outerBeforeSend: (_bot, name, data) => { if (name === 'block_dig' && data.status === 2 && protectedNow) throw error; } });
  const pending = f.run(() => f.session.dig(f.block(), f.ctx)); pending.catch(() => {});
  await until(() => started(f)); protectedNow = true;
  await assert.rejects(pending, actual => actual === error && actual.cause === cause);
  assert.deepEqual(packets(f).map(write => write.data.status), [0, 1]);
  assert.equal(packets(f)[1].cancelProof, true); assert.equal(f.bot.targetDigBlock, null);
  await sleep(100); assert.equal(packets(f).some(write => write.data.status === 2), false);
});

test('pause cancels only the installed owned dig and cannot send a later finish', { timeout: 5000 }, async t => {
  const f = fixture(t), pending = f.run(() => f.session.dig(f.block('obsidian'), f.ctx)); pending.catch(() => {});
  await until(() => started(f)); f.pause();
  await assert.rejects(pending, error => error.code === 'paused');
  assert.deepEqual(packets(f).map(write => write.data.status), [0, 1]); assert.equal(f.bot.targetDigBlock, null);
  await sleep(120); assert.equal(packets(f).some(write => write.data.status === 2), false);
});

test('a physical deadline cancels native timers and preserves the timeout reason', { timeout: 5000 }, async t => {
  const f = fixture(t); await assert.rejects(f.run(() => f.session.dig(f.block('obsidian'), { ...f.ctx, forceLook: 'ignore', timeoutMs: 120 })), error => error.code === 'step_timeout');
  assert.deepEqual(packets(f).map(write => write.data.status), [0, 1]); assert.equal(f.bot.targetDigBlock, null);
});

test('an owner revoked synchronously by start cannot mistake the previous noop for the native stop function', { timeout: 5000 }, async t => {
  let pause;
  const f = fixture(t, { onWrite: ({ name, data }) => { if (name === 'block_dig' && data.status === 0) pause(); } }); pause = f.pause;
  await assert.rejects(f.run(() => f.session.dig(f.block('obsidian'), f.ctx)), error => error.code === 'paused');
  assert.deepEqual(packets(f).map(write => write.data.status), [0, 1]); assert.equal(packets(f)[1].cancelProof, true);
  assert.equal(f.bot.targetDigBlock, null);
});

test('late native pre-start look cannot stop a new owner or overwrite its look method', { timeout: 5000 }, async t => {
  const f = fixture(t); await f.ready;
  const look = f.bot.lookAt; let lookStarted = false;
  f.bot.lookAt = async (...args) => { lookStarted = true; await look.apply(f.bot, args); await sleep(220); };
  const pending = f.run(() => f.session.dig(f.block('obsidian'), f.ctx)); pending.catch(() => {});
  await until(() => lookStarted);
  const next = f.replaceOwner(), foreignLook = (...args) => look.apply(f.bot, args); f.bot.lookAt = foreignLook;
  await f.storage.run(next.context, () => f.bot.dig(f.block('stone', new Vec3(1, 64, 1)), false));
  await assert.rejects(pending, error => error.code === 'movement_preempted');
  assert.equal(packets(f).filter(write => write.data.status === 0 && write.data.location.equals(new Vec3(2, 64, 0))).length, 0);
  assert.equal(packets(f).some(write => write.data.status === 1), false); assert.equal(f.bot.lookAt, foreignLook);
});

test('foreign writer replacement survives cleanup and inactive source frames never revive', { timeout: 5000 }, async t => {
  const f = fixture(t), pending = f.run(() => f.session.dig(f.block('obsidian'), f.ctx)); pending.catch(() => {});
  await until(() => started(f));
  const previous = f.client.write, foreign = function (...args) { return previous.apply(this, args); };
  f.client.write = foreign; f.pause();
  await assert.rejects(pending, error => error.code === 'paused');
  assert.equal(f.client.write, foreign); assert.equal(f.bot.targetDigBlock, null);
});

test('cancel transport failure remains bounded UNKNOWN with retained guards and the original cause', { timeout: 8000 }, async t => {
  const f = fixture(t), pending = f.run(() => f.session.dig(f.block('obsidian'), f.ctx)); pending.catch(() => {});
  await until(() => started(f)); f.failCancel(true); f.pause();
  await assert.rejects(pending, error => error.code === 'house_native_dig_cleanup_pending' && error.nativeSettlement === 'UNKNOWN'
    && error.cause.code === 'paused' && error.cleanupError.code === 'SOCKET_CANCEL');
  assert.equal(f.aborted.length, 1); assert.equal(f.aborted[0].owner, f.owner);
  assert.notEqual(f.client.write, f.nativeWrite); assert.equal(packets(f).some(write => write.data.status === 2), false);
  const retainedGuard = f.client.write;
  // Diagnostic cleanup uses the actual installed stop again from an independent
  // context after transport recovery; the old session cannot claim settlement.
  f.failCancel(false); f.storage.run({}, () => f.bot.stopDigging());
  // The source guard's inactive frame may remain in the chain after non-LIFO
  // settlement. Only this session's live wrapper must be removed.
  await until(() => f.client.write !== retainedGuard);
});

test('a delayed pre-start native promise retains guards after UNKNOWN and denies any late start', { timeout: 8000 }, async t => {
  const f = fixture(t); await f.ready; const look = f.bot.lookAt;
  let release, lookStarted = false;
  f.bot.lookAt = async (...args) => { await look.apply(f.bot, args); lookStarted = true; await new Promise(resolve => { release = resolve; }); };
  const pending = f.run(() => f.session.dig(f.block('obsidian'), f.ctx)); pending.catch(() => {});
  await until(() => lookStarted); f.pause();
  await assert.rejects(pending, error => error.code === 'house_native_dig_cleanup_pending' && error.cause.code === 'paused');
  assert.notEqual(f.client.write, f.nativeWrite); assert.equal(packets(f).length, 0);
  const retainedGuard = f.client.write;
  release(); await until(() => f.client.write !== retainedGuard);
  assert.equal(packets(f).length, 0);
});

test('a deadline during native look denies a late start even while the parent owner remains active', { timeout: 5000 }, async t => {
  const f = fixture(t); await assert.rejects(f.run(() => f.session.dig(f.block('obsidian'), { ...f.ctx, timeoutMs: 80 })), error => error.code === 'step_timeout');
  assert.equal(packets(f).length, 0); assert.equal(f.bot.targetDigBlock, null);
  await sleep(150); assert.equal(packets(f).length, 0); assert.equal(f.aborted.length, 0);
});

test('a pending pre-start session cannot be overlapped by a second module instance', { timeout: 5000 }, async t => {
  const f = fixture(t); await f.ready; const look = f.bot.lookAt;
  let release, looking = false;
  f.bot.lookAt = async (...args) => { await look.apply(f.bot, args); looking = true; await new Promise(resolve => { release = resolve; }); };
  const pending = f.run(() => f.session.dig(f.block(), f.ctx)); pending.catch(() => {}); await until(() => looking);
  const second = createHouseNativeDigSession(f.deps);
  await assert.rejects(f.run(() => second.dig(f.block('stone', new Vec3(1, 64, 1)), f.ctx)), error => error.code === 'house_native_dig_busy');
  release(); await pending; assert.deepEqual(packets(f).map(write => write.data.status), [0, 2]);
});

test('exact cancel proof cannot authorize start, finish, wrong block, or calls outside native cancel', { timeout: 5000 }, async t => {
  const proofs = [];
  const f = fixture(t, { onWrite: ({ bot, name, data }) => {
    if (name === 'block_dig' && data.status === 1) proofs.push([
      isOwnedHouseNativeDigCancel(bot, name, data),
      isOwnedHouseNativeDigCancel(bot, name, { ...data, status: 0 }),
      isOwnedHouseNativeDigCancel(bot, name, { ...data, status: 2 }),
      isOwnedHouseNativeDigCancel(bot, name, { ...data, location: data.location.offset(1, 0, 0) }),
      isOwnedHouseNativeDigCancel({ ...bot }, name, data),
    ]);
  } });
  const block = f.block('obsidian'), pending = f.run(() => f.session.dig(block, f.ctx)); pending.catch(() => {});
  await until(() => started(f)); assert.equal(isOwnedHouseNativeDigCancel(f.bot, 'block_dig', { status: 1, location: block.position }), false);
  f.pause(); await assert.rejects(pending, error => error.code === 'paused');
  assert.deepEqual(proofs, [[true, false, false, false, false]]);
  assert.equal(isOwnedHouseNativeDigCancel(f.bot, 'block_dig', { status: 1, location: block.position }), false);
});

test('ordinary parent cancellation blocked by its guard is repaired once by the exact session cancel', { timeout: 5000 }, async t => {
  const f = fixture(t), pending = f.run(() => f.session.dig(f.block('obsidian'), f.ctx)); pending.catch(() => {});
  await until(() => started(f)); f.pause();
  f.storage.run(f.owner.context, () => assert.throws(() => f.bot.stopDigging(), error => error.code === 'paused'));
  await assert.rejects(pending, error => error.code === 'paused');
  assert.deepEqual(packets(f).map(write => write.data.status), [0, 1]); assert.equal(f.bot.targetDigBlock, null);
});

test('invalid or initially denied requests send no native mutation', { timeout: 5000 }, async t => {
  const f = fixture(t); await assert.rejects(f.run(() => f.session.dig(f.block(), { ...f.ctx, timeoutMs: Infinity })), error => error.code === 'house_native_dig_invalid');
  const original = Object.assign(new Error('construction bounds'), { code: 'house_resource_protected' });
  await assert.rejects(f.run(() => f.session.dig(f.block(), { ...f.ctx, beforeSend: () => { throw original; } })), error => error === original);
  assert.equal(packets(f).length, 0);
});
