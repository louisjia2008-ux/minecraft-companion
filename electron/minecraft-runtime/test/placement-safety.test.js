/* global require, process, setInterval, clearInterval */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { Physics, PlayerState } = require('prismarine-physics');
const { pathfinder, goals } = require('mineflayer-pathfinder');
const WorldSync = require('prismarine-world/src/worldsync');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { createMinecraftTaskAgent } = require('../vendor/server/minecraftTaskAgent');

function placementFixture(t, initialPosition, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-placement-physics-'));
  const env = { MC_AGENT_LEARNING_PATH: path.join(dir, 'learning.json'),
    MC_AGENT_DIAGNOSTICS_DIR: path.join(dir, 'diagnostics'), MC_AGENT_DISCONNECT_TRACE_PATH: path.join(dir, 'disconnect.jsonl') };
  const previousEnvironment = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const target = new Vec3(94, 63, 171);
  const cells = new Map();
  if (options.interactiveAnchor) cells.set(target.offset(0, -1, 0).toString(), 'crafting_table');
  const placements = [];
  const controls = [];
  let windowsClosed = 0;
  let count = 1;
  let ticks = 0;
  const bot = Object.assign(new EventEmitter(), {
    registry, version: '1.21.8', username: 'DeskPet', health: 20, food: 20,
    game: { minY: -64, height: 384, dimension: 'overworld', gameMode: 'survival' },
    entities: {}, players: {}, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    player: { ping: 1 }, _client: { state: 'play', socket: { writable: true, destroyed: false } },
    controlState: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
    entity: { position: initialPosition.clone(), velocity: new Vec3(0, 0, 0), onGround: true,
      eyeHeight: 1.62, height: 1.8, width: 0.6, yaw: 0, pitch: 0, effects: {}, attributes: {},
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false,
      isCollidedVertically: true, elytraFlying: false },
  });
  const item = () => ({ name: 'furnace', type: registry.itemsByName.furnace.id, count, metadata: 0 });
  bot.inventory = { slots: [], items: () => count ? [item()] : [],
    count: (type) => type === registry.itemsByName.furnace.id ? count : 0 };
  bot.blockAt = (point) => {
    const position = point.floored();
    const unsafe = options.noSafeStance && position.y === 62 && !position.equals(target.offset(0, -1, 0));
    const name = cells.get(position.toString()) ?? (position.y < 63 ? (unsafe ? 'magma_block' : 'grass_block') : 'air');
    return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position });
  };
  bot.world = { getBlock: (point) => bot.blockAt(point), raycast: WorldSync.prototype.raycast };
  bot.findBlock = () => null;
  bot.findBlocks = () => [];
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; };
  bot.lookAt = async () => {};
  bot.setControlState = (key, value) => { controls.push({ key, value }); bot.controlState[key] = value; };
  bot.getControlState = (key) => bot.controlState[key];
  bot.clearControlStates = () => { for (const key of Object.keys(bot.controlState)) bot.controlState[key] = false; };
  bot.closeWindow = () => { windowsClosed += 1; bot.currentWindow = null; };
  bot.stopDigging = () => {};
  bot.deactivateItem = () => {};
  bot.equip = async () => { bot.heldItem = item(); };
  const overlaps = (point) => {
    const p = bot.entity.position;
    return p.x + 0.3 > point.x && p.x - 0.3 < point.x + 1 &&
      p.z + 0.3 > point.z && p.z - 0.3 < point.z + 1 && p.y + 1.8 > point.y && p.y < point.y + 1;
  };
  // Model the relevant vanilla rejection, rather than allowing every call to
  // create a block. Installed physics and pathfinder determine the real stance.
  bot.placeBlock = async (reference, face) => {
    const position = reference.position.plus(face);
    if (overlaps(position)) throw new Error('Vanilla rejects placement intersecting the player');
    if (reference.name === 'crafting_table' && !bot.getControlState('sneak')) {
      bot.currentWindow = { type: 'minecraft:crafting' };
      throw new Error('Interactive anchor opened its window instead of placing');
    }
    assert.equal(bot.entity.onGround, true, 'Placement must wait for actual grounded physics');
    const goal = new goals.GoalPlaceBlock(position, bot.world, { range: 4.5, faces: [face.scaled(-1)] });
    assert.ok(goal.getFaceAndRef(bot.entity.position.offset(0, 1.62, 0)), 'Actual placement face must be visible and in reach');
    placements.push({ position, player: bot.entity.position.clone(), ticks });
    cells.set(position.toString(), 'furnace');
    count -= 1;
  };
  bot.physics = Physics(registry, bot.world);
  pathfinder(bot);
  const timer = setInterval(() => {
    bot.physics.simulatePlayer(new PlayerState(bot, bot.controlState), bot.world).apply(bot);
    ticks += 1;
    bot.emit('physicsTick');
  }, 10);
  const agent = createMinecraftTaskAgent({ appPaths: { appDataDir: dir },
    readConfig: () => ({ mcExecutorMode: 'strict-executor' }), parseJsonObjectFromText: JSON.parse,
    broadcast: () => {}, broadcastMinecraftError: () => {}, allowAutonomousMaintenance: () => false });
  agent.attachBot(bot);
  agent.__testSetReconnectTask({ taskId: 'placement-physics', status: 'running', source: 'deskpet',
    logs: [], currentStepIndex: 0, currentStep: 'mine_resource', plan: { steps: [] } });
  t.after(() => {
    clearInterval(timer);
    agent.__testSetReconnectTask(null);
    agent.detachBot('manual_disconnect');
    agent.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  });
  return { bot, agent, target, placements, overlaps, controls, remaining: () => count,
    windowsClosed: () => windowsClosed };
}

test('natural hillside furnace placement leaves the target occupied by the player before placing', { timeout: 6000 }, async (t) => {
  const state = placementFixture(t, new Vec3(94.45756878356855, 63, 171.49995017076705));
  const oldGoal = new goals.GoalNear(94, 62, 171, 2);
  assert.equal(oldGoal.isEnd(state.bot.entity.position.floored()), true, 'Old anchor goal already succeeds inside the placement target');
  await state.bot.equip();
  await assert.rejects(state.bot.placeBlock(state.bot.blockAt(state.target.offset(0, -1, 0)), new Vec3(0, 1, 0)), /intersecting/);
  await state.agent.__testExecutePlaceBlock({ args: { position: state.target, item: 'furnace' } });
  assert.equal(state.placements.length, 1);
  assert.ok(state.placements[0].ticks > 0, 'Installed physics must move the player out of the target');
  assert.equal(state.overlaps(state.target), false);
  assert.equal(state.bot.blockAt(state.target).name, 'furnace');
  assert.equal(state.remaining(), 0);
});

test('a player whose feet are in a neighbouring cell still moves when its body overlaps the target', { timeout: 6000 }, async (t) => {
  const state = placementFixture(t, new Vec3(95.1, 63, 171.5));
  assert.equal(state.bot.entity.position.floored().equals(state.target), false);
  assert.equal(state.overlaps(state.target), true, 'Floor-coordinate checks alone miss this edge overlap');
  await state.agent.__testExecutePlaceBlock({ args: { position: state.target, item: 'furnace' } });
  assert.equal(state.placements.length, 1);
  assert.equal(state.overlaps(state.target), false);
});

test('placement with no loaded safe stance fails before spending a furnace or calling placeBlock', { timeout: 6000 }, async (t) => {
  const state = placementFixture(t, new Vec3(94.5, 63, 171.5), { noSafeStance: true });
  await assert.rejects(state.agent.__testExecutePlaceBlock({ args: { position: state.target, item: 'furnace' } }),
    (error) => error.code === 'placement_no_safe_stance');
  assert.equal(state.placements.length, 0);
  assert.equal(state.remaining(), 1);
});

test('an already clear visible placement stance does not add a movement trip', { timeout: 6000 }, async (t) => {
  const state = placementFixture(t, new Vec3(96.5, 63, 171.5));
  let movementCalls = 0;
  state.bot.pathfinder.goto = async () => { movementCalls += 1; throw new Error('Unnecessary movement'); };
  await state.agent.__testExecutePlaceBlock({ args: { position: state.target, item: 'furnace' } });
  assert.equal(movementCalls, 0);
  assert.equal(state.placements.length, 1);
});

test('secondary placement builds on a crafting table and restores the prior sneak control', { timeout: 6000 }, async (t) => {
  const state = placementFixture(t, new Vec3(94.5, 63, 172.5), { interactiveAnchor: true });
  const anchor = state.bot.blockAt(state.target.offset(0, -1, 0));
  await state.bot.equip();
  await assert.rejects(state.bot.placeBlock(anchor, new Vec3(0, 1, 0)), /Interactive anchor/);
  state.bot.closeWindow();
  await state.agent.__testExecutePlaceBlock({ args: { position: state.target, item: 'furnace' } });
  assert.equal(state.placements.length, 1);
  assert.equal(state.bot.blockAt(state.target.offset(0, -1, 0)).name, 'crafting_table');
  assert.equal(state.bot.getControlState('sneak'), false);
  assert.deepEqual(state.controls.slice(-2), [{ key: 'sneak', value: true }, { key: 'sneak', value: false }]);
  assert.equal(state.bot.currentWindow, null);
});

test('a placement failure restores an existing sneak and closes any accidental interaction window', { timeout: 6000 }, async (t) => {
  const state = placementFixture(t, new Vec3(96.5, 63, 171.5));
  state.bot.setControlState('sneak', true);
  state.bot.placeBlock = async () => { state.bot.currentWindow = { type: 'minecraft:crafting' }; throw new Error('Rejected use'); };
  await assert.rejects(state.agent.__testPhysicalPlaceBlock(state.bot.blockAt(state.target.offset(0, -1, 0)),
    new Vec3(0, 1, 0), state.target, 'furnace'), /Rejected use/);
  assert.equal(state.bot.getControlState('sneak'), true);
  assert.equal(state.bot.currentWindow, null);
  assert.ok(state.windowsClosed() >= 1);
  assert.equal(state.remaining(), 1);
});

for (const action of ['pause', 'cancel']) {
  test(`${action} during placement keeps controls released instead of restoring an old sneak`, { timeout: 6000 }, async (t) => {
    const state = placementFixture(t, new Vec3(96.5, 63, 171.5));
    state.bot.setControlState('sneak', true);
    state.bot.placeBlock = async () => {
      state.bot.currentWindow = { type: 'minecraft:crafting' };
      await state.agent.handleMessage({ type: `mc_command_${action}` });
      const error = new Error(`Placement ${action}`); error.code = action === 'pause' ? 'paused' : 'cancelled'; throw error;
    };
    await assert.rejects(state.agent.__testPhysicalPlaceBlock(state.bot.blockAt(state.target.offset(0, -1, 0)),
      new Vec3(0, 1, 0), state.target, 'furnace'), new RegExp(`Placement ${action}`));
    assert.equal(state.bot.getControlState('sneak'), false);
    assert.equal(state.bot.currentWindow, null);
    assert.equal(state.remaining(), 1);
  });
}

test('a superseding execution retains its own sneak control when the old placement unwinds', { timeout: 6000 }, async (t) => {
  const state = placementFixture(t, new Vec3(96.5, 63, 171.5));
  state.bot.setControlState('sneak', true);
  state.bot.placeBlock = async () => {
    state.agent.__testSetReconnectTask({ taskId: 'replacement', status: 'running', logs: [], plan: { steps: [] } });
    state.bot.setControlState('sneak', false);
  };
  await state.agent.__testPhysicalPlaceBlock(state.bot.blockAt(state.target.offset(0, -1, 0)),
    new Vec3(0, 1, 0), state.target, 'furnace');
  assert.equal(state.bot.getControlState('sneak'), false);
  assert.deepEqual(state.controls.at(-1), { key: 'sneak', value: false });
});
