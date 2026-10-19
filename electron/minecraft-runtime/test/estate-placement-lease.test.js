/* global require, process */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const Item = require('prismarine-item')(registry);
const injectInventory = require('mineflayer/lib/plugins/inventory');
const injectSimpleInventory = require('mineflayer/lib/plugins/simple_inventory');
const injectGenericPlace = require('mineflayer/lib/plugins/generic_place');
const injectPlaceBlock = require('mineflayer/lib/plugins/place_block');
const { createMinecraftTaskAgent } = require('../vendor/server/minecraftTaskAgent');
const { withEstateNativeInteractionGuard } = require('../vendor/server/minecraft/estateNativeInteractions');

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const preempted = () => Object.assign(new Error('movement_preempted'), { code: 'movement_preempted' });

// Actual engine action/recovery/finally and installed native Mineflayer place
// plugins. The delayed look and inbound world response are controlled protocol
// boundaries; this regression does not claim live-server or movement acceptance.
function fixture(t, { delayLook = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-estate-placement-lease-'));
  const paths = { MC_AGENT_LEARNING_PATH: path.join(dir, 'learning.json'),
    MC_AGENT_DIAGNOSTICS_DIR: path.join(dir, 'diagnostics'), MC_AGENT_DISCONNECT_TRACE_PATH: path.join(dir, 'disconnect.jsonl') };
  const previous = Object.fromEntries(Object.keys(paths).map(name => [name, process.env[name]]));
  Object.assign(process.env, paths);
  const client = Object.assign(new EventEmitter(), { state: 'play', socket: Object.assign(new EventEmitter(), { writable: true, destroyed: false }) });
  const target = new Vec3(1, 64, 1), cells = new Map(), writes = [], controls = [];
  const lookStarted = deferred(), finishLook = deferred(), packetSent = deferred();
  const effects = { clear: 0, stopDigging: 0, deactivate: 0, closeWindow: 0, setGoal: 0 };
  const bot = Object.assign(new EventEmitter(), { registry, version: '1.21.8', username: 'DeskPet', health: 20, food: 20,
    game: { minY: -64, height: 384, dimension: 'overworld', gameMode: 'survival' }, entities: {}, players: {}, player: { ping: 1 },
    _client: client, QUICK_BAR_START: 36, controlState: { sneak: true, forward: false },
    entity: { id: 1, position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0, height: 1.8, width: .6 },
    supportFeature: name => registry.supportFeature(name), swingArm: () => {}, findBlock: () => null, findBlocks: () => [],
  });
  bot.blockAt = p => Object.assign(Block.fromProperties(registry.blocksByName[cells.get(p.toString()) || (p.y < 64 ? 'stone' : 'air')].id, {}, 0), { position: p.clone() });
  bot.lookAt = async () => { lookStarted.resolve(); if (delayLook) await finishLook.promise; };
  bot.getControlState = name => bot.controlState[name] || false;
  bot.setControlState = (name, value) => { controls.push({ name, value }); bot.controlState[name] = value; };
  bot.clearControlStates = () => { effects.clear += 1; for (const name of Object.keys(bot.controlState)) bot.controlState[name] = false; };
  bot.stopDigging = () => { effects.stopDigging += 1; };
  bot.deactivateItem = () => { effects.deactivate += 1; };
  bot.pathfinder = { setGoal: () => { effects.setGoal += 1; }, isMoving: () => false,
    setMovements: function (movements) { this.movements = movements; } };
  client.write = function (name, packet) { writes.push({ name, packet, self: this }); if (name === 'block_place') packetSent.resolve(); };
  injectInventory(bot, { hideErrors: true }); injectSimpleInventory(bot); injectGenericPlace(bot); injectPlaceBlock(bot);
  bot.quickBarSlot = 0;
  client.emit('set_slot', { windowId: 0, stateId: 1, slot: 36, item: Item.toNotch(new Item(registry.itemsByName.oak_planks.id, 3)) });
  bot.closeWindow = () => { effects.closeWindow += 1; bot.currentWindow = null; };
  const agent = createMinecraftTaskAgent({ appPaths: { appDataDir: dir },
    readConfig: () => ({ mcExecutorMode: 'strict-executor' }), parseJsonObjectFromText: JSON.parse,
    broadcast: () => {}, broadcastMinecraftError: () => {}, allowAutonomousMaintenance: () => false });
  agent.attachBot(bot);
  const task = { taskId: 'estate-lease', status: 'running', source: 'deskpet', executionGeneration: 1,
    logs: [], currentStepIndex: 0, currentStep: 'build_estate', plan: { steps: [] } };
  const lease = agent.__testClaimMovementLease('task', task.taskId); task.movementLease = lease;
  agent.__testSetReconnectTask(task);
  const identity = () => agent.__testGetReconnectTask() === task && task.executionGeneration === 1
    && task.movementLease === lease && agent.__testGetActiveMovementLease() === lease;
  const check = () => { if (!identity()) throw preempted(); };
  function place({ guarded = true, packetGuard = true } = {}) {
    const operation = () => agent.__testPhysicalPlaceBlock(bot.blockAt(target.offset(0, -1, 0)), new Vec3(0, 1, 0),
      target, 'oak_planks', guarded ? { isOwnerCurrent: identity } : {});
    return packetGuard ? withEstateNativeInteractionGuard(bot, { assertActive: check, isOwnerContext: () => true }, operation) : operation();
  }
  function confirmWorld() {
    const before = bot.blockAt(target); cells.set(target.toString(), 'oak_planks');
    bot.emit(`blockUpdate:${target}`, before, bot.blockAt(target));
  }
  function takeover() {
    // Exact same task/bot/execution generation, only the active movement owner changes.
    task.movementLease = agent.__testClaimMovementLease('foreign-manual', task.taskId);
    bot.setControlState('sneak', false); bot.setControlState('forward', true);
    bot.currentWindow = { id: 77, type: 'foreign-window' };
    return { controls: controls.length, writes: writes.length, effects: { ...effects }, window: bot.currentWindow };
  }
  function assertUntouched(boundary) {
    assert.deepEqual(controls.slice(boundary.controls), [], 'Old owner must not restore sneak or stop foreign movement');
    assert.deepEqual(effects, boundary.effects, 'Old action must not reset runtime or close the foreign window');
    assert.equal(bot.currentWindow, boundary.window); assert.equal(bot.getControlState('sneak'), false); assert.equal(bot.getControlState('forward'), true);
  }
  t.after(() => {
    finishLook.resolve(); agent.__testSetReconnectTask(null); agent.detachBot('manual_disconnect'); agent.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previous)) { if (value == null) delete process.env[name]; else process.env[name] = value; }
  });
  return { bot, agent, task, writes, controls, effects, lookStarted, finishLook, packetSent, identity, place, confirmWorld, takeover, assertUntouched };
}

test('foreign lease before native start produces no placement, old control write or recovery', { timeout: 6000 }, async t => {
  const f = fixture(t), boundary = f.takeover();
  await assert.rejects(f.place(), error => error.code === 'movement_preempted');
  f.assertUntouched(boundary); assert.equal(f.writes.length, boundary.writes);
});

test('self-supply surface cleanup cannot replace a newer same-generation actor movement profile', async t => {
  const f = fixture(t); let foreign, boundary;
  await f.agent.__testWithHouseResourceBounds([], async () => {
    assert.equal(f.bot.pathfinder.movements.canDig, false);
    assert.equal(f.bot.pathfinder.movements.allowSprinting, false);
    foreign = new (require('mineflayer-pathfinder').Movements)(f.bot);
    boundary = f.takeover(); f.bot.pathfinder.setMovements(foreign);
    await Promise.resolve();
  });
  assert.equal(f.bot.pathfinder.movements, foreign);
  f.assertUntouched(boundary);
});

test('owned self-supply walking disables diagonal cuts and restores its outer native profile on completion', async t => {
  const f = fixture(t); let surface;
  await f.agent.__testWithHouseResourceBounds([], async () => {
    surface = f.bot.pathfinder.movements;
    const neighbors = [];
    surface.getMoveDiagonal(null, null, neighbors);
    assert.deepEqual(neighbors, []);
    assert.equal(surface.canDig, false); assert.equal(surface.allowSprinting, false);
  });
  assert.notEqual(f.bot.pathfinder.movements, surface);
  assert.equal(f.effects.clear, 0);
});

test('same-generation takeover during installed native look blocks late packet and old reset/finally', { timeout: 6000 }, async t => {
  const f = fixture(t, { delayLook: true });
  const action = f.place(), rejected = assert.rejects(action, error => error.code === 'movement_preempted');
  await f.lookStarted.promise; const boundary = f.takeover(); f.finishLook.resolve(); await rejected;
  f.assertUntouched(boundary); assert.equal(f.writes.length, boundary.writes); assert.equal(f.writes.some(w => w.name === 'block_place'), false);
});

test('same-generation takeover while native place awaits world response never restores old sneak or closes new window', { timeout: 6000 }, async t => {
  const f = fixture(t), action = f.place();
  // Observe rejection immediately if the runtime ownership monitor wins the race.
  const settled = action.then(() => ({ completed: true }), error => ({ error }));
  await f.packetSent.promise; const boundary = f.takeover(); f.confirmWorld();
  const outcome = await settled; if (outcome.error) assert.equal(outcome.error.code, 'movement_preempted');
  f.assertUntouched(boundary); assert.equal(f.writes.length, boundary.writes);
  assert.equal(f.writes.filter(w => w.name === 'block_place').length, 1);
});

test('owned native failure still performs normal recovery and cleanup; optional guard does not disable recovery', { timeout: 6000 }, async t => {
  const f = fixture(t, { delayLook: true }); const action = f.place();
  const rejected = assert.rejects(action, /Native look failure/);
  await f.lookStarted.promise; f.bot.currentWindow = { id: 12, type: 'accidental-window' };
  f.finishLook.reject(new Error('Native look failure')); await rejected;
  assert.ok(f.effects.clear > 0); assert.ok(f.effects.setGoal > 0); assert.ok(f.effects.closeWindow > 0);
  assert.equal(f.bot.currentWindow, null); assert.equal(f.bot.getControlState('sneak'), true);
});

for (const guarded of [false, true]) {
  test(`${guarded ? 'owned dock guard' : 'legacy caller without guard'} preserves successful installed native placement and sneak restoration`, { timeout: 6000 }, async t => {
    const f = fixture(t), action = f.place({ guarded });
    await f.packetSent.promise; f.confirmWorld(); await action;
    assert.equal(f.writes.filter(w => w.name === 'block_place').length, 1);
    assert.equal(f.bot.getControlState('sneak'), true); assert.equal(f.effects.clear, 0); assert.equal(f.effects.closeWindow, 0);
  });
}
