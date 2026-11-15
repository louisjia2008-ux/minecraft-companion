'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { createCoreHost } = require('../core-host');
const { createCompanion } = require('../core/companion');
const { createBrain, BAND } = require('../core/brain');
const { sleep } = require('../core/confirm');

function fakeBot() {
  return Object.assign(new EventEmitter(), {
    version: '1.21.8', registry: require('prismarine-registry')('1.21.8'),
    health: 0, food: 20, oxygenLevel: 20, time: { timeOfDay: 1000 }, entities: {},
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true, effects: {} },
    game: { minY: -64, dimension: 'overworld' },
    _client: Object.assign(new EventEmitter(), { state: 'play', write() {}, end() {} }),
    inventory: { items: () => [], slots: Array(46).fill(null), emptySlotCount: () => 36 },
    pathfinder: { setMovements(value) { this.movements = value; }, setGoal() {} },
    blockAt: (position) => ({ name: 'air', type: 0, boundingBox: 'empty', position }),
    setControlState() {}, clearControlStates() {}, quit() {}, waitForChunksToLoad: async () => {},
  });
}

// Exercise the actual host, companion and goal factories. The bot is a fixture:
// health=0 keeps physical gameplay out of this dispatch/cancellation contract.
test('preparation tools reach real goals with correlated failures and cancellation', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-embedding-goals-'));
  const events = [];
  const bot = fakeBot();
  let companion;
  const host = createCoreHost({ dataDir, createBot: () => bot, emit: (event) => events.push(event),
    createCompanion: (options) => (companion = createCompanion({ ...options, tickMs: 60000 })) });
  t.after(async () => { try { await host.close(); } finally { fs.rmSync(dataDir, { recursive: true, force: true }); } });
  let sequence = 0;
  const tool = (name, args = {}) => host.handle({ version: 1, id: `tool-${++sequence}`, type: 'tool', name, arguments: args });
  await host.handle({ version: 1, id: 'connect', type: 'connect', config: {
    host: '127.0.0.1', port: 25565, username: 'EmbeddingGoals', auth: 'offline', version: '1.21.8',
  } });
  bot.emit('spawn');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.status().connection.state, 'ready', JSON.stringify(host.status().connection));

  bot.inventory.items = () => [{ name: 'ender_pearl', count: 2 }];
  bot.inventory.slots[6] = { name: 'iron_chestplate', count: 1 };
  bot.inventory.slots[45] = { name: 'shield', count: 1 };
  const snapshot = (await tool('getStatus')).result.observation;
  assert.deepEqual(snapshot.inventory, { ender_pearl: 2, iron_chestplate: 1, shield: 1 });
  assert.equal(snapshot.dimension, 'overworld');
  assert.equal(snapshot.health, 0);
  assert.equal(snapshot.isDay, true);
  assert.deepEqual(snapshot.position, { x: 0.5, y: 64, z: 0.5 });
  snapshot.inventory.ender_pearl = 99;
  assert.equal((await tool('getStatus')).result.observation.inventory.ender_pearl, 2);

  const noHome = await tool('outfit', { items: [{ key: 'food', count: 1 }] });
  assert.equal(noHome.ok, false);
  assert.equal(noHome.error.code, 'no_home');
  assert.equal(noHome.task.status, 'failed');
  assert.equal((await tool('getTask', { taskId: noHome.task.taskId })).result.task.status, 'failed');

  companion.director.memory.homestead = { memory: { house: {
    furniture: {
      chest: { position: new Vec3(0, 64, 1) }, crafting_table: { position: new Vec3(1, 64, 1) },
      furnace: { position: new Vec3(2, 64, 1) },
    },
    interiorCenter: new Vec3(2, 64, 2), anchor: new Vec3(0, 64, 0),
  } } };
  const tracked = ['move', 'death', 'entityDead', 'entityUpdate', 'entityGone', 'entityMoved'];
  const listeners = () => tracked.map((name) => bot.listenerCount(name));
  const baseline = listeners();
  for (const [name, args, goalName] of [
    ['outfit', { items: [{ key: 'iron_helmet', count: 1 }, { key: 'food', count: 12 }] }, 'outfit'],
    ['huntPearls', { count: 12, radius: 64 }, 'hunt_pearls'],
    ['netherExpedition', { blazeRods: 7, witherSkulls: 0, trades: 0, skullTries: 0, roam: 400 }, 'nether_expedition'],
    ['endJourney', { withCity: false, home: true }, 'end_journey'],
  ]) {
    const receipt = await tool(name, args);
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.result.dispatchOnly, true);
    const taskId = receipt.result.task.taskId;
    assert.equal(receipt.result.task.status, 'running');
    assert.equal(companion.status().goal.name, goalName);
    assert.equal(companion.status().goal.taskId, taskId);
    assert.ok(events.some((row) => row.event?.type === 'core' && row.event.taskId === taskId
      && row.event.payload.type === 'goal_set' && row.event.payload.goal === goalName));
    assert.equal((await tool('cancel', { taskId })).result.task.status, 'cancelled');
    assert.equal((await tool('getTask', { taskId })).result.task.status, 'cancelled');
    assert.equal(companion.status().goal, null);
    assert.equal(host.status().safetyActive, true);
    assert.deepEqual(listeners(), baseline, `${name} must retire its goal-owned listeners before returning cancellation`);
  }
  await host.handle({ version: 1, id: 'disconnect', type: 'disconnect' });
  assert.equal((await tool('getStatus')).result.observation, null, 'Disconnected inventory must not be presented as current');
});

test('external cancel reports a blocked real companion until its delayed body settles', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-embedding-retirement-'));
  const bot = fakeBot();
  bot.health = 20;
  let release, companion, runs = 0;
  const body = new Promise((resolve) => { release = resolve; });
  const events = [];
  const host = createCoreHost({ dataDir, createBot: () => bot, emit: (row) => events.push(row),
    createCompanion: (options) => {
      companion = createCompanion({ ...options, tickMs: 60000, retirementTimeoutMs: 5 });
      // Supply a deliberately non-cooperative goal through the trusted test
      // fixture, retaining the real companion/brain cancellation and disposal.
      companion.submitTask = (_name, _args, metadata) => companion.setGoal({
        name: 'delayed_fixture', isDone: () => false, progress: () => 0,
        run: () => { runs += 1; return body; },
      }, metadata);
      return companion;
    } });
  t.after(async () => { release({ ok: true }); try { await host.close(); }
    finally { fs.rmSync(dataDir, { recursive: true, force: true }); } });
  let sequence = 0;
  const tool = (name, args = {}) => host.handle({ version: 1, id: `tool-${++sequence}`, type: 'tool', name, arguments: args });
  await host.handle({ version: 1, id: 'connect', type: 'connect', config: {
    host: '127.0.0.1', port: 25565, username: 'BlockedBody', auth: 'offline', version: '1.21.8',
  } });
  bot.emit('spawn');
  await new Promise((resolve) => setImmediate(resolve));
  const taskId = (await tool('gatherLogs', { count: 1 })).result.task.taskId;
  const cancelled = await tool('cancel', { taskId });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, 'retirement_timeout');
  assert.equal(cancelled.task.status, 'failed');
  const blocked = (await tool('getStatus')).result;
  assert.equal(blocked.engine.blocked, true);
  assert.equal(blocked.safetyActive, false);
  assert.ok(blocked.engine.inFlight.some((run) => run.taskId === taskId && run.abandoned && run.aborted));
  const replacement = await tool('gatherLogs', { count: 1 });
  assert.equal(replacement.ok, false);
  assert.equal(replacement.error.code, 'retirement_timeout');
  assert.equal(runs, 1, 'The old body must remain the only running goal');
  assert.equal(events.some((row) => row.event?.task?.taskId === taskId && row.event.task.status === 'cancelled'), false);
  release({ ok: true });
  await companion.brain.idle();
  assert.equal((await tool('getStatus')).result.engine.blocked, false);
  assert.equal((await tool('getTask', { taskId })).result.task.status, 'failed');
});

test('goal retirement joins its aborted run even after urgent safety preemption', async () => {
  let release;
  const original = new Promise((resolve) => { release = resolve; });
  let safetyWanted = false;
  const brain = createBrain({ perceive: () => ({ alive: true }), abandonMs: 5, behaviors: [{
    name: 'safety', band: BAND.ESCAPE, want: () => safetyWanted ? 1 : 0,
    run: (ctx) => sleep(10000, ctx.signal),
  }] });
  brain.setGoal({ name: 'delayed_io', progress: () => 0, isDone: () => false,
    run: () => original }, { taskId: 'old-task' });
  let retirement;
  try {
    await brain.tick();
    const generation = brain.status().goal.generation;
    safetyWanted = true;
    await brain.tick();
    let joined = false;
    retirement = brain.idleGoal(generation).then(() => { joined = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(joined, false, 'Cancellation must not lose an old run that can still use the bot after await');
    release({ ok: true });
    await retirement;
    assert.equal(joined, true);
  } finally {
    release({ ok: true });
    await brain.dispose();
    await retirement;
  }
});
