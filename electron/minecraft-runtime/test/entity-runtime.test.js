/* global require, process, global, setTimeout */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const registry = require('prismarine-registry')('1.21.8');
const Entity = require('prismarine-entity')(registry);
const Item = require('prismarine-item')(registry);
const { createMinecraftTaskAgent } = require('../vendor/server/minecraftTaskAgent');
const { EventManager, WorldQuery } = require('../vendor/server/minecraft/eventSystem');
const { isDroppedItemEntity, isHostileMobEntity, distanceBetweenPositions } = require('../vendor/server/minecraft/entitySemantics');

function entity(name, id, position = new Vec3(2, 64, 0)) {
  const result = new Entity(id);
  const definition = registry.entitiesByName[name];
  Object.assign(result, { name, entityType: definition.id, type: definition.type, position });
  return result;
}

function droppedItem(id, position) {
  const result = entity('item', id, position);
  const metadataIndex = registry.supportFeature('metadataIxOfItem');
  result.metadata[metadataIndex] = Item.toNotch(new Item(registry.itemsByName.oak_log.id, 1));
  return result;
}

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-minecraft-entities-'));
  process.env.MC_AGENT_LEARNING_PATH = path.join(dataDir, 'learning.json');
  process.env.MC_AGENT_DIAGNOSTICS_DIR = path.join(dataDir, 'diagnostics');
  process.env.MC_AGENT_DISCONNECT_TRACE_PATH = path.join(dataDir, 'disconnect.jsonl');
  const messages = [];
  const agent = createMinecraftTaskAgent({
    appPaths: { appDataDir: dataDir },
    readConfig: () => ({ mcExecutorMode: options.mode || 'strict-executor', mcAgentAutoReconnect: false }),
    requestPlannerCompletion: async () => { throw new Error('Unexpected planner request'); },
    parseJsonObjectFromText: JSON.parse,
    broadcast: (message) => messages.push(message),
    broadcastMinecraftError: () => {},
    allowAutonomousMaintenance: () => false,
    ...(Object.hasOwn(options, 'owner') ? { getPreferredPlayerName: () => options.owner } : {}),
  });
  const resets = { stops: 0, clears: 0, goals: [] };
  const bot = new EventEmitter();
  Object.assign(bot, {
    entity: { position: new Vec3(0, 64, 0) },
    username: 'DeskPet', health: 20, food: 20,
    entities: options.entities || {}, players: {}, registry,
    inventory: { items: () => options.items || [] }, game: { dimension: 'overworld' },
    _client: { state: 'play', socket: { writable: true, destroyed: false } },
    player: { ping: 1 },
    clearControlStates: () => { resets.clears += 1; },
    findBlock: () => null, findBlocks: () => [], blockAt: () => null,
    pathfinder: {
      setGoal: (goal) => resets.goals.push(goal),
      stop: () => { resets.stops += 1; },
      setMovements: () => {},
    },
  });
  agent.attachBot(bot);
  t.after(() => {
    agent.__testSetReconnectTask(null);
    agent.detachBot('manual_disconnect');
    agent.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { agent, bot, resets, messages };
}

test('actual 1.21.8 dropped-item metadata decodes and engine selects it with a plain xyz focus', (t) => {
  const drop = droppedItem(1, new Vec3(3, 64, 0));
  const { agent, bot } = fixture(t, { entities: { 1: drop, 2: entity('arrow', 2, new Vec3(1, 64, 0)), 3: entity('oak_boat', 3) } });
  assert.equal(registry.entitiesByName.item.type, 'other');
  assert.equal(registry.supportFeature('metadataIxOfItem'), 8);
  assert.equal(drop.getDroppedItem().name, 'oak_log');
  assert.equal(drop.metadata[7], undefined);
  assert.equal(agent.__testFindNearestDroppedItemEntity({ position: { x: 0, y: 64, z: 0 }, radius: 4 }), drop);
  assert.equal(agent.__testFindNearestDroppedItemEntity({ position: { x: 0, y: 64, z: 0 }, radius: 2 }), null);
  assert.equal(new WorldQuery({ getBot: () => bot }).listNearbyItems().length, 1);
  assert.equal(new WorldQuery({ getBot: () => bot }).listNearbyItems()[0].entityId, drop.id);
});

test('itemDrop perception uses the library decoder for versioned metadata instead of fixed index 7', async (t) => {
  const bot = new EventEmitter();
  const manager = new EventManager();
  t.after(() => manager.detachSources());
  manager.bindMineflayer(bot);
  const result = new Promise((resolve) => manager.on({ type: 'perception.item_drop', handler: resolve }));
  bot.emit('itemDrop', droppedItem(4, new Vec3(2, 64, 1)));
  assert.equal((await result).payload.name, 'oak_log');
});

test('actual 1.21.8 hostile registry entities are visible to the real combat selector', (t) => {
  const zombie = entity('zombie', 1);
  const { agent } = fixture(t, { entities: { 1: zombie, 2: entity('cow', 2, new Vec3(1, 64, 0)) } });
  assert.equal(zombie.type, 'hostile');
  assert.equal(isHostileMobEntity(zombie, registry), true);
  assert.equal(isHostileMobEntity(entity('cow', 2), registry), false);
  assert.equal(isHostileMobEntity(entity('end_crystal', 3), registry), false);
  assert.equal(agent.__testFindHostileEntity(null, 12), zombie);
});

test('legacy coarse types still use entity identity and distance accepts Vec3 and plain positions', () => {
  assert.equal(isDroppedItemEntity({ name: 'Item', type: 'object' }), true);
  assert.equal(isDroppedItemEntity({ name: 'boat', type: 'object' }), false);
  assert.equal(isHostileMobEntity({ name: 'zombie', type: 'mob' }), true);
  assert.equal(isHostileMobEntity({ name: 'cow', type: 'mob' }), false);
  assert.equal(distanceBetweenPositions({ x: 1, y: 2, z: 3 }, new Vec3(4, 6, 3)), 5);
  assert.equal(distanceBetweenPositions(null, new Vec3(1, 2, 3)), Number.POSITIVE_INFINITY);
});

test('explicit owner Alice missing from the world and memory never selects nearby Bob', (t) => {
  const { agent, bot } = fixture(t, { owner: 'Alice' });
  bot.players.Bob = { username: 'Bob', entity: { username: 'Bob', position: new Vec3(1, 64, 0) } };
  assert.equal(agent.__testGetBestKnownPlayerName(), 'Alice');
  assert.equal(agent.__testFindPlayerTarget('Alice'), null);
  assert.equal(agent.__testFindPlayerTarget(), null);
});

test('blank DeskPet owner never infers Bob and follow fails with a concrete missing_owner error', async (t) => {
  const { agent, bot } = fixture(t, { owner: '' });
  bot.players.Bob = { username: 'Bob', entity: { username: 'Bob', position: new Vec3(1, 64, 0) } };
  assert.equal(agent.__testGetBestKnownPlayerName(), '');
  assert.equal(agent.__testFindPlayerTarget(), null);
  const step = { skill: 'follow_player', args: {} };
  const task = { taskId: 'missing-owner', status: 'running', logs: [], plan: { steps: [step] } };
  agent.__testSetReconnectTask(task);
  await assert.rejects(agent.__testExecuteStepWithWatchdog(task, step), /missing_owner/);
  assert.equal(agent.__testFindPlayerTarget('Bob').username, 'Bob');
});

test('legacy engine integration without the owner callback retains its visible-player inference', (t) => {
  const { agent, bot } = fixture(t);
  bot.players.Bob = { username: 'Bob', entity: { username: 'Bob', position: new Vec3(1, 64, 0) } };
  assert.equal(agent.__testGetBestKnownPlayerName(), 'Bob');
  assert.equal(agent.__testFindPlayerTarget().username, 'Bob');
});

for (const [label, items, expected] of [
  ['empty inventory', [], 'unarmed'],
  ['existing pickaxe', [{ name: 'wooden_pickaxe', count: 1 }], 'partial'],
]) {
  test(`real escort preparation handles ${label} without an undefined pickaxe constant`, async (t) => {
    const { agent } = fixture(t, { owner: 'Alice', items });
    const step = { skill: 'escort_player', args: { playerName: 'Alice' } };
    const task = { taskId: label, status: 'running', logs: [], plan: { steps: [step] } };
    agent.__testSetReconnectTask(task);
    await assert.rejects(agent.__testExecuteStepWithWatchdog(task, step, {
      beforeExecute: () => { throw new Error('preparation complete'); },
    }), /preparation complete/);
    assert.equal(task.combatReadiness, expected);
  });
}

test('continuous movement monitor survives 30s, then detects a stopped bot after its owner moves away', async (t) => {
  const { agent, bot, resets } = fixture(t, { owner: 'Alice' });
  let now = Date.now();
  let monitor;
  const cleared = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(global, 'setInterval', (callback, milliseconds) => {
    assert.equal(milliseconds, 350);
    monitor = callback;
    return { testMonitor: true };
  });
  t.mock.method(global, 'clearInterval', (handle) => cleared.push(handle));
  const step = { skill: 'follow_player', args: { playerName: 'Alice' } };
  const task = { taskId: 'moving-then-stalled', status: 'running', currentStep: 'follow_player', logs: [], plan: { steps: [step] } };
  agent.__testSetReconnectTask(task);
  const owner = { id: 51, name: 'player', username: 'Alice', position: new Vec3(8, 64, 0) };
  const goal = new goals.GoalFollow(owner, 2);
  agent.__testSetPathfinderGoal(goal, true, null);
  // One physical movement makes the old source's session permanently "stable".
  bot.entity.position = new Vec3(1, 64, 0);
  now += 350;
  monitor();
  assert.equal(task.lastHeartbeatAt, now);
  // Healthy stationary following must stay monitored past the old 30-second expiry.
  owner.position = new Vec3(3, 64, 0);
  now += 35_000;
  monitor();
  assert.equal(task.lastHeartbeatAt, now);
  assert.equal(task.stepCheckpoint.withinRange, true);
  assert.equal(cleared.length, 0);
  const healthyHeartbeat = task.lastHeartbeatAt;
  const clearCount = resets.clears;
  owner.position = new Vec3(20, 64, 0);
  now += 1_000;
  agent.__testSetPathfinderGoal(goal, true, null);
  monitor();
  assert.equal(task.lastHeartbeatAt, healthyHeartbeat, 'being stable earlier must not fabricate an in-range heartbeat now');
  now += 6_501;
  monitor();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(task.lastRecoveryReason, 'executor_stalled');
  assert.ok(task.physicalRecoveryCount > 0);
  assert.ok(resets.clears > clearCount);
  assert.equal(resets.goals.at(-1), null);
  t.mock.restoreAll();
  await new Promise((resolve) => setTimeout(resolve, 240));
});

for (const mode of ['strict-executor', 'experimental-autonomy']) {
  for (const skill of ['follow_player', 'escort_player']) {
    test(`${mode} healthy ${skill} survives 3 minutes; a later missing heartbeat still resets movement`, async (t) => {
      const { agent, resets } = fixture(t, { mode, owner: 'Alice' });
      let now = Date.now();
      const callbacks = [];
      t.mock.method(Date, 'now', () => now);
      t.mock.method(global, 'setInterval', (callback) => {
        callbacks.push(callback);
        return { unref: () => {} };
      });
      const step = { skill, args: { playerName: 'Alice' } };
      const task = {
        taskId: `${mode}-${skill}`, source: 'deskpet', intent: skill, status: 'running',
        currentStep: skill, currentStepIndex: 0, logs: [], plan: { steps: [step] },
        startedAt: now, createdAt: now, lastProgressAt: now, lastHeartbeatAt: now,
      };
      agent.__testSetReconnectTask(task);
      let release;
      const barrier = new Promise((resolve) => { release = resolve; });
      const running = agent.__testExecuteStepWithWatchdog(task, step, {
        beforePrepare: () => barrier,
        beforeExecute: () => { throw new Error('test barrier complete'); },
      });
      const completion = assert.rejects(running, (error) => error.code === 'executor_stalled');
      assert.equal(callbacks.length, 1);
      now += 181_000;
      // Remaining near the owner produces valid action heartbeat without coordinate progress.
      task.lastHeartbeatAt = now;
      task.actionState = 'acting';
      callbacks[0]();
      assert.equal(task.watchdogAbortMessage, '');
      const clearCount = resets.clears;
      now += 12_001;
      callbacks[0]();
      assert.equal(task.watchdogAbortCode, 'executor_stalled');
      assert.equal(task.lastRecoveryReason, 'executor_stalled');
      assert.equal(task.actionState, 'recovering');
      assert.ok(resets.clears > clearCount);
      assert.equal(resets.goals.at(-1), null);
      release();
      await completion;
      t.mock.restoreAll();
      await new Promise((resolve) => setTimeout(resolve, 240));
    });
  }
}

test('finite return-to-owner keeps its hard deadline even with a fresh heartbeat', async (t) => {
  const { agent } = fixture(t, { owner: 'Alice' });
  let now = Date.now();
  let tick;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(global, 'setInterval', (callback) => { tick = callback; return { unref: () => {} }; });
  const step = { skill: 'follow_player', args: { playerName: 'Alice', once: true } };
  const task = { taskId: 'finite-follow', status: 'running', logs: [], startedAt: now, lastProgressAt: now, plan: { steps: [step] } };
  agent.__testSetReconnectTask(task);
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const running = agent.__testExecuteStepWithWatchdog(task, step, {
    beforePrepare: () => barrier,
    beforeExecute: () => { throw new Error('test barrier complete'); },
  });
  const completion = assert.rejects(running, (error) => error.code === 'step_timeout');
  now += 46_000;
  task.lastHeartbeatAt = now;
  tick();
  assert.equal(task.watchdogAbortCode, 'step_timeout');
  release();
  await completion;
  t.mock.restoreAll();
  await new Promise((resolve) => setTimeout(resolve, 240));
});

test('native observed zero health is no longer an active threat; absent metadata stays unknown',()=>{
 const {getObservedEntityHealth,isThreateningMobEntity}=require('../vendor/server/minecraft/entitySemantics');
 const index=registry.entitiesByName.zombie.metadataKeys.indexOf('health'),zombie={name:'zombie',type:'hostile',metadata:[]};assert.ok(index>=0);
 assert.equal(getObservedEntityHealth(zombie,registry),null);assert.equal(isThreateningMobEntity(zombie,registry),true);
 zombie.metadata[index]=.495;assert.equal(isThreateningMobEntity(zombie,registry),true);
 zombie.metadata[index]=0;assert.equal(getObservedEntityHealth(zombie,registry),0);assert.equal(isThreateningMobEntity(zombie,registry),false);
});
