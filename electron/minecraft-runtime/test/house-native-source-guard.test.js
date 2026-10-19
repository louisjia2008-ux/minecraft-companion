/* global require, setTimeout */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withHouseNativeSourceGuard } = require('../vendor/server/minecraft/houseNativeSourceGuard');
test('pause after a native await rejects every late owned source mutation before its real protocol write', async () => {
  for (const name of ['window_click', 'block_place', 'use_item', 'use_entity', 'block_dig']) {
    const packets = []; let paused = false;
    const bot = { _client: { write(...args) { packets.push({ receiver: this, args }); } } }; const original = bot._client.write;
    await assert.rejects(withHouseNativeSourceGuard(bot, { isOwnerContext: () => true, assertActive: () => { if (paused) throw new Error('paused'); } }, async () => {
      await Promise.resolve(); paused = true; bot._client.write(name, {});
    }), /paused/);
    assert.equal(packets.length, 0); assert.equal(bot._client.write, original);
  }
});
test('foreign actor mutations and physics packets retain their exact receiver, argument identity and result', async () => {
  const packets = [], result = {}; let owner = true, paused = false;
  const bot = { _client: { write(...args) { packets.push({ receiver: this, args }); return result; } } };
  await withHouseNativeSourceGuard(bot, { isOwnerContext: () => owner, assertActive: () => { if (paused) throw new Error('paused'); } }, async () => {
    paused = true; owner = false; const payload = { windowId: 4 };
    assert.equal(bot._client.write('window_click', payload), result); assert.equal(packets[0].args[1], payload);
    owner = true; bot._client.write('position', payload); assert.equal(packets[1].receiver, bot._client);
  });
  assert.equal(packets.length, 2);
});
test('a later writer replacement is preserved when a completed source guard unwinds', async () => {
  const original = () => {}, replacement = () => {}, bot = { _client: { write: original } };
  await withHouseNativeSourceGuard(bot, { isOwnerContext: () => true, assertActive: () => {} }, async () => { bot._client.write = replacement; });
  assert.equal(bot._client.write, replacement);
});
test('native cancel remains denied by default and when its optional proof is false', async () => {
  for (const allowNativeCancel of [undefined, () => false, () => 'true']) {
    const packets = []; let paused = false;
    const bot = { _client: { write(...args) { packets.push(args); } } };
    await assert.rejects(withHouseNativeSourceGuard(bot, {
      isOwnerContext: () => true, allowNativeCancel,
      assertActive: () => { if (paused) throw new Error('paused'); },
    }, async () => { paused = true; bot._client.write('block_dig', { status: 1 }); }), /paused/);
    assert.deepEqual(packets, []);
  }
});
test('only exact proven native cancel preserves its payload, receiver and transport result after revocation', async () => {
  const packets = [], result = {}, payload = { status: 1, location: { x: 2, y: 64, z: 0 } };
  let paused = false, proofCalls = 0;
  const bot = { _client: { write(...args) { packets.push({ receiver: this, args }); return result; } } };
  const original = bot._client.write;
  await withHouseNativeSourceGuard(bot, {
    isOwnerContext: () => true,
    assertActive: () => { if (paused) throw new Error('paused'); },
    allowNativeCancel: (actualBot, name, data) => {
      proofCalls += 1; assert.equal(actualBot, bot); assert.equal(name, 'block_dig'); assert.equal(data, payload);
      return true;
    },
  }, async () => { paused = true; assert.equal(bot._client.write('block_dig', payload), result); });
  assert.equal(proofCalls, 1); assert.equal(packets.length, 1); assert.equal(packets[0].receiver, bot._client);
  assert.equal(packets[0].args[1], payload); assert.equal(bot._client.write, original);
});
test('even a permissive optional callback cannot release starts, finishes or unrelated mutations', async () => {
  for (const [name, payload] of [['block_dig', { status: 0 }], ['block_dig', { status: 2 }],
    ['block_dig', { status: '1' }], ['block_place', { status: 1 }], ['use_item', { status: 1 }],
    ['use_entity', { status: 1 }], ['window_click', { status: 1 }]]) {
    const packets = []; let paused = false, proofCalls = 0;
    const bot = { _client: { write(...args) { packets.push(args); } } };
    await assert.rejects(withHouseNativeSourceGuard(bot, {
      isOwnerContext: () => true, allowNativeCancel: () => { proofCalls += 1; return true; },
      assertActive: () => { if (paused) throw new Error('paused'); },
    }, async () => { paused = true; bot._client.write(name, payload); }), /paused/);
    assert.equal(proofCalls, 0); assert.deepEqual(packets, []);
  }
});
test('the real bridge cancel proof rejects unowned and forged cancel packets outside its synchronous native scope', async () => {
  const { isOwnedFluidNativeCancel } = require('../vendor/server/minecraft/houseFluidNativeBridge');
  const packets = []; let paused = false;
  const block = { position: { x: 2, y: 64, z: 0 } };
  const bot = { targetDigBlock: block, stopDigging() {}, _client: { write(...args) { packets.push(args); } } };
  assert.equal(isOwnedFluidNativeCancel(bot, 'block_dig', { status: 1, location: block.position }), false);
  await assert.rejects(withHouseNativeSourceGuard(bot, {
    isOwnerContext: () => true, allowNativeCancel: isOwnedFluidNativeCancel,
    assertActive: () => { if (paused) throw new Error('paused'); },
  }, async () => { paused = true; bot._client.write('block_dig', { status: 1, location: block.position }); }), /paused/);
  assert.deepEqual(packets, []);
});

// The final synchronous mutation check runs after native awaits, against the
// current route protection. It must not be replaced by permission at dispatch.
for (const status of [0, 2]) test(`newly protected route rejects native dig status${status} at the final send boundary`, async () => {
  const packets = [], checked = [], location = { x: 4, y: 63, z: -2 };
  let protectedNow = false;
  const bot = { _client: { write(...args) { packets.push(args); } } }, original = bot._client.write;
  await assert.rejects(withHouseNativeSourceGuard(bot, {
    isOwnerContext: () => true, assertActive: () => {},
    beforeSend: (actualBot, name, payload) => {
      checked.push({ actualBot, name, payload });
      if (name === 'block_dig' && [0, 2].includes(payload.status) && protectedNow) {
        throw Object.assign(new Error('route floor became protected'), { code: 'house_resource_protected' });
      }
    },
  }, async () => {
    assert.equal(protectedNow, false);
    await Promise.resolve(); protectedNow = true;
    bot._client.write('block_dig', { status, location });
  }), error => error.code === 'house_resource_protected');
  assert.equal(checked.length, 1); assert.equal(checked[0].actualBot, bot);
  assert.equal(checked[0].payload.location, location); assert.deepEqual(packets, []);
  assert.equal(bot._client.write, original);
});

test('foreign mutations and keepalive bypass the final owned mutation check without altering transport identity', async () => {
  const packets = [], result = {}, payload = { status: 2, location: { x: 4, y: 63, z: -2 } };
  let owner = false, checks = 0;
  const bot = { _client: { write(...args) { packets.push({ receiver: this, args }); return result; } } };
  await withHouseNativeSourceGuard(bot, {
    isOwnerContext: () => owner, assertActive: () => {},
    beforeSend: () => { checks += 1; throw new Error('owned route is protected'); },
  }, async () => {
    assert.equal(bot._client.write('block_dig', payload), result);
    owner = true; assert.equal(bot._client.write('keep_alive', payload), result);
  });
  assert.equal(checks, 0); assert.equal(packets.length, 2);
  assert.ok(packets.every(packet => packet.receiver === bot._client && packet.args[1] === payload));
});

function nativeProtectionFixture(t) {
  const { EventEmitter } = require('node:events'), { AsyncLocalStorage } = require('node:async_hooks');
  const { Vec3 } = require('vec3'), registry = require('prismarine-registry')('1.21.8');
  const Block = require('prismarine-block')(registry), WorldSync = require('prismarine-world/src/worldsync');
  const { createHouseFluidNativeBridge, isOwnedFluidNativeCancel } = require('../vendor/server/minecraft/houseFluidNativeBridge');
  const storage = new AsyncLocalStorage(), owner = {}, packets = [], checks = [];
  let protectedNow = false, lookResolve = null;
  const target = new Vec3(2, 64, 0), bot = Object.assign(new EventEmitter(), {
    _client: { write(name, payload) { packets.push({ name, payload, receiver: this }); } },
    entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62, onGround: true, effects: {} },
    game: { gameMode: 'survival' }, inventory: { slots: Array(46).fill(null) },
    heldItem: { type: registry.itemsByName.diamond_pickaxe.id, enchants: [] },
    getEquipmentDestSlot: () => 5, swingArm: () => {},
    lookAt: async () => { if (lookResolve === false) await new Promise(resolve => { lookResolve = resolve; }); },
  });
  bot.blockAt = raw => {
    const p = raw.floored(), name = p.equals(target) || p.y < 64 ? 'stone' : 'air';
    return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position: p });
  };
  bot.world = { getBlock: p => bot.blockAt(p), raycast: WorldSync.prototype.raycast };
  bot._updateBlockState = (position, stateId) => bot.emit(`blockUpdate:${position}`, bot.blockAt(position),
    Object.assign(Block.fromStateId(stateId), { position }));
  require('mineflayer/lib/plugins/digging')(bot);
  const assertActive = () => {}, beforeSend = (_bot, name, payload) => {
    if (name !== 'block_dig' || ![0, 2].includes(payload.status)) return;
    checks.push(payload.status);
    if (protectedNow && payload.location.equals(target)) throw Object.assign(new Error('captured route floor became protected'), { code: 'house_resource_protected' });
  };
  const bridge = createHouseFluidNativeBridge({
    getBot: () => bot, captureOwner: () => owner, assertOwner: assertActive,
    isOwnerCurrent: () => true, isOwnerContext: () => storage.getStore() === owner,
    sourceGuardSupportsOwnedCancel: true, abortOwner: () => {},
    runPhysicalAction: (_kind, _primitive, operation) => operation(() => {}),
    withMovements: (_movements, action) => action(), restoreMovements: () => {},
    goto: () => {}, waitGround: () => {}, guardNative: (_owner, _context, action) => action(), equipNative: () => {},
  });
  const ctx = { assertActive, beforeSend: assertActive };
  const run = () => storage.run(owner, () => withHouseNativeSourceGuard(bot, {
    assertActive, beforeSend, isOwnerContext: () => storage.getStore() === owner,
    allowNativeCancel: isOwnedFluidNativeCancel,
  }, () => bridge.digBlock(bot.blockAt(target), ctx)));
  t.after(() => { lookResolve?.(); bot.stopDigging(); bot.removeAllListeners(); });
  return { bot, packets, checks, run, protect: () => { protectedNow = true; },
    delayLook: () => { lookResolve = false; }, lookIsWaiting: () => typeof lookResolve === 'function', releaseLook: () => { lookResolve?.(); } };
}
async function waitNativeProtection(predicate) {
  for (let i = 0; i < 500 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(predicate(), true, 'bounded original native event was observed');
}
test('installed native look await cannot start a dig after its floor becomes protected', { timeout: 3000 }, async t => {
  const f = nativeProtectionFixture(t); f.delayLook();
  const pending = f.run(); pending.catch(() => {});
  await waitNativeProtection(f.lookIsWaiting); f.protect(); f.releaseLook();
  await assert.rejects(pending, error => error.code === 'house_resource_protected');
  assert.deepEqual(f.packets.filter(packet => packet.name === 'block_dig'), []);
  assert.deepEqual(f.checks, [0]); assert.equal(f.bot.targetDigBlock, null);
});
test('installed native finish timer is denied by changed route protection but its exact cancel still settles', { timeout: 3000 }, async t => {
  const f = nativeProtectionFixture(t), pending = f.run(); pending.catch(() => {});
  await waitNativeProtection(() => f.packets.some(packet => packet.name === 'block_dig' && packet.payload.status === 0));
  f.protect();
  await assert.rejects(pending, error => error.code === 'house_resource_protected');
  assert.deepEqual(f.packets.filter(packet => packet.name === 'block_dig').map(packet => packet.payload.status), [0, 1]);
  assert.deepEqual(f.checks, [0, 2]); assert.equal(f.bot.targetDigBlock, null);
});
