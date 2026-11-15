'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createCompanion } = require('../core/companion');
const { sleep } = require('../core/confirm');

function fixture(t, options = {}) {
  const intervals = [], cleared = [];
  t.mock.method(global, 'setInterval', (callback) => {
    const handle = { callback, unref() {} };
    intervals.push(handle);
    return handle;
  });
  t.mock.method(global, 'clearInterval', (handle) => cleared.push(handle));
  const controls = {};
  const bot = Object.assign(new EventEmitter(), {
    version: '1.21.8', registry: require('prismarine-registry')('1.21.8'),
    health: 20, food: 20, oxygenLevel: 20, time: { timeOfDay: 1000 }, entities: {},
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true, effects: {} },
    game: { minY: -64, dimension: 'overworld' },
    inventory: { items: () => [], slots: Array(46).fill(null), emptySlotCount: () => 36 },
    pathfinder: { setMovements(value) { this.movements = value; }, setGoal() {} },
    blockAt: (position) => ({ name: 'air', type: 0, boundingBox: 'empty', position }),
    setControlState: (key, value) => { controls[key] = value; },
    clearControlStates: () => { for (const key of Object.keys(controls)) controls[key] = false; },
  });
  const events = [];
  const companion = createCompanion({ bot, onEvent: (event) => events.push(event), ...options });
  t.after(() => companion.dispose());
  return { companion, bot, events, controls, intervals, cleared };
}
const waitingGoal = (onRun = () => {}) => ({
  name: 'waiting', isDone: () => false, progress: () => 0,
  run(ctx) { onRun(ctx); return sleep(10000, ctx.signal); },
});

for (const method of ['cancelTask', 'stop', 'dispose']) test(`${method} reports a blocked continuation and can finish cleanup after it settles`, async (t) => {
  const f = fixture(t, { retirementTimeoutMs: 5 });
  let release;
  let cleanups = 0;
  let quits = 0;
  f.bot.quit = () => { quits++; };
  const held = new Promise((resolve) => { release = resolve; });
  const goal = { name: 'non_cooperative', isDone: () => false, progress: () => 0,
    run: () => { f.bot.setControlState('forward', true); return held; }, dispose: () => { cleanups++; } };
  await f.companion.setGoal(goal, { taskId: 'held-task' });
  const generation = f.companion.status().goal.generation;
  try {
    await assert.rejects(f.companion.brain.interrupt('test_interruption'), { code: 'retirement_timeout' });
    assert.equal(f.controls.forward, false, 'a timeout makes a best-effort stop of native movement');
    await assert.rejects(f.companion[method](), { code: 'retirement_timeout' });
    assert.equal(f.companion.status().blocked, true);
    assert.equal(f.companion.status().inFlight[0].taskId, 'held-task');
    assert.equal(cleanups, 0, 'goal resources remain owned by the unsettled continuation');
    assert.equal(quits, 0, 'a caller-owned bot is never implicitly disconnected');
    assert.throws(() => f.companion.setGoal(waitingGoal()), { code: method === 'dispose' ? 'disposed' : 'retirement_timeout' });
    release({ ok: false, reason: 'aborted' });
    await f.companion.brain.idleGoal(generation);
    await f.companion[method]();
    assert.equal(f.companion.status().blocked, false);
    assert.equal(cleanups, 1);
  } finally { release({ ok: false, reason: 'aborted' }); }
});

async function exerciseSafety(f) {
  f.bot.entity.isInWater = true;
  f.bot.oxygenLevel = 5;
  await f.companion.brain.tick();
  assert.equal(f.companion.status().running, 'breathe');
  assert.equal(f.controls.jump, true);
  f.bot.oxygenLevel = 20;
  await f.companion.brain.idle();
  assert.equal(f.controls.jump, false);
  f.bot.entity.isInWater = false;
}

test('cancelTask clears player task/autonomy but keeps survival available', async (t) => {
  const f = fixture(t);
  let goalSignal;
  await f.companion.setAutonomy(true);
  await f.companion.setGoal(waitingGoal((ctx) => { goalSignal = ctx.signal; }), { taskId: 'cancel-me' });
  await f.companion.cancelTask('user_cancelled');
  assert.equal(goalSignal.aborted, true);
  assert.equal(f.companion.status().goal, null);
  assert.equal(f.companion.status().autonomy.enabled, false);
  assert.equal(f.events.find((event) => event.type === 'goal_cleared').taskId, 'cancel-me');
  await exerciseSafety(f);
});

test('pauseTask gates goal and director work but not safety; resume replans preserved task', async (t) => {
  const f = fixture(t);
  let goalRuns = 0, directorTicks = 0;
  await f.companion.setAutonomy(true);
  await f.companion.setGoal(waitingGoal(() => goalRuns++), { taskId: 'resume-me' });
  t.mock.method(f.companion.director, 'tick', () => { directorTicks++; });
  await f.companion.pauseTask();
  assert.equal(f.companion.status().paused, true);
  assert.equal(f.companion.status().goal.taskId, 'resume-me');
  assert.equal(f.companion.status().autonomy.enabled, true);
  f.intervals[0].callback();
  assert.equal(directorTicks, 0);
  await exerciseSafety(f);
  assert.equal(goalRuns, 1);
  await f.companion.resumeTask();
  assert.equal(f.companion.status().paused, false);
  assert.equal(goalRuns, 2);
  f.intervals[0].callback();
  assert.equal(directorTicks, 1);
});

test('legacy stop remains safety-on rather than an implicit all-stop', async (t) => {
  const f = fixture(t);
  await f.companion.setGoal(waitingGoal());
  await f.companion.stop();
  assert.equal(f.companion.status().goal, null);
  assert.equal(f.companion.status().disposed, false);
  await exerciseSafety(f);
});

test('dispose/stopAll are one terminal cleanup and cannot be resurrected', async (t) => {
  const f = fixture(t);
  let interrupted = false;
  const goal = waitingGoal((ctx) => ctx.signal.addEventListener('abort', () => { interrupted = true; }));
  let cleanups = 0;
  goal.dispose = () => cleanups++;
  await f.companion.setGoal(goal);
  const disposal = f.companion.dispose();
  assert.equal(f.companion.stopAll(), disposal);
  await disposal;
  assert.equal(interrupted, true);
  assert.equal(cleanups, 1);
  assert.equal(f.cleared.includes(f.intervals[0]), true);
  assert.equal(f.companion.status().disposed, true);
  assert.equal(f.bot.listenerCount('death'), 0);
  assert.equal(f.bot.listenerCount('physicsTick'), 0);
  assert.equal(f.bot.listenerCount('forcedMove'), 0);
  assert.equal(f.bot.listenerCount('entitySwingArm'), 0);
  assert.equal(f.bot.listenerCount('entityHurt'), 0);
  assert.equal(f.bot.listenerCount('path_update'), 0);
  const count = f.events.length;
  f.bot.entity.isInWater = true;
  f.bot.oxygenLevel = 5;
  f.intervals[0].callback();
  f.bot.emit('death');
  await f.companion.brain.tick();
  assert.equal(f.events.length, count);
  assert.equal(f.companion.status().running, null);
  assert.throws(() => f.companion.gatherLogs(2), { code: 'disposed' });
  assert.throws(() => f.companion.farm(), { code: 'disposed' });
  assert.throws(() => f.companion.setGoal(waitingGoal()), { code: 'disposed' });
  assert.throws(() => f.companion.setAutonomy(true), { code: 'disposed' });
  await assert.rejects(f.companion.submitTask('gatherLogs', { count: 2 }), { code: 'disposed' });
  await assert.rejects(f.companion.resumeTask(), { code: 'disposed' });
  await assert.rejects(f.companion.pauseTask(), { code: 'disposed' });
  await assert.rejects(f.companion.cancelTask(), { code: 'disposed' });
});

test('cleanup failure still releases listeners and movement hooks during all-stop', async (t) => {
  const f = fixture(t), cleanups = [];
  const goal = waitingGoal();
  goal.dispose = () => { cleanups.push('goal'); throw new Error('cleanup_failed'); };
  f.bot.health = 0;
  await f.companion.setGoal(goal);
  const disposal = f.companion.dispose();
  await assert.rejects(disposal, AggregateError);
  assert.deepEqual(cleanups, ['goal']);
  assert.equal(f.bot.listenerCount('death'), 0);
  assert.equal(f.bot.listenerCount('path_update'), 0);
  assert.equal(f.companion.dispose(), disposal);
  // The failed disposal is intentionally observable; avoid rethrowing it in after().
  f.companion.dispose = () => Promise.resolve();
});

test('submitTask is built-in data-only dispatch with task-correlated goal events', async (t) => {
  const f = fixture(t);
  f.bot.health = 0;
  await f.companion.submitTask('gatherLogs', { count: 7 }, { taskId: 'dispatch-id' });
  assert.equal(f.companion.status().goal.taskId, 'dispatch-id');
  assert.equal(f.companion.status().goal.name, 'gather_logs');
  assert.equal(f.events.find((event) => event.type === 'goal_set').taskId, 'dispatch-id');
  assert.equal(f.events.some((event) => event.type === 'goal_done'), false);
  await assert.rejects(f.companion.submitTask('setGoal', {}), { code: 'unknown_task' });
  await assert.rejects(f.companion.submitTask(['gatherLogs'], { count: 1 }), { code: 'unknown_task' });
  await assert.rejects(f.companion.submitTask('constructor', {}), { code: 'unknown_task' });
  await assert.rejects(f.companion.submitTask('gatherLogs', { count: () => 7 }), /plain JSON data/);
  await assert.rejects(f.companion.submitTask('farm', { actions: {} }), /not allowed/);
  let getterCalled = false;
  await assert.rejects(f.companion.submitTask('gatherLogs', { get count() { getterCalled = true; return 7; } }), /plain JSON data/);
  assert.equal(getterCalled, false);
  assert.equal(f.companion.status().goal.taskId, 'dispatch-id');
});

const turn = () => new Promise((resolve) => setImmediate(resolve));
const dragonListeners = (bot) => ['entityUpdate', 'entityGone', 'entityMoved'].map((name) => bot.listenerCount(name));

test('repeated real endDragon cancellation retires its listeners before the next task', async (t) => {
  const f = fixture(t);
  f.bot.health = 0;
  const baseline = dragonListeners(f.bot);
  for (let i = 0; i < 20; i++) {
    await f.companion.submitTask('endDragon', {}, { taskId: `cancel-${i}` });
    assert.deepEqual(dragonListeners(f.bot), baseline.map((n) => n + 1));
    await f.companion.cancelTask();
    assert.deepEqual(dragonListeners(f.bot), baseline);
  }
});

test('repeated real endDragon completion retires listeners without all-stop', async (t) => {
  const f = fixture(t);
  const baseline = dragonListeners(f.bot);
  for (let i = 0; i < 20; i++) {
    f.bot.health = 0;
    const goal = await f.companion.endDragon({}, { taskId: `complete-${i}` });
    assert.deepEqual(dragonListeners(f.bot), baseline.map((n) => n + 1));
    goal.memory.killed = true;
    f.bot.health = 20;
    await f.companion.brain.tick();
    await turn();
    assert.equal(f.companion.status().goal, null);
    assert.deepEqual(dragonListeners(f.bot), baseline);
  }
  assert.equal(f.events.filter((event) => event.type === 'goal_done').length, 20);
});

test('replacement waits for old body and resource restoration before installing new goal listeners', async (t) => {
  const f = fixture(t);
  const baseline = dragonListeners(f.bot);
  let release, signal, retired = false;
  const old = { name: 'old', progress: () => 0, isDone: () => false,
    run(ctx) { signal = ctx.signal; return new Promise((resolve) => { release = resolve; }); },
    dispose() { retired = true; assert.deepEqual(dragonListeners(f.bot), baseline); },
  };
  await f.companion.setGoal(old);
  f.bot.health = 0;
  const replacement = f.companion.endDragon();
  await turn();
  assert.equal(signal.aborted, true);
  assert.equal(retired, false);
  assert.deepEqual(dragonListeners(f.bot), baseline);
  release({ ok: true });
  await replacement;
  assert.equal(retired, true);
  assert.deepEqual(dragonListeners(f.bot), baseline.map((n) => n + 1));
  await f.companion.cancelTask();
  assert.deepEqual(dragonListeners(f.bot), baseline);
});

test('retired goals are not retained and disposed again during final shutdown', async (t) => {
  const f = fixture(t);
  let disposals = 0;
  for (let i = 0; i < 50; i++) {
    await f.companion.setGoal({ name: `done-${i}`, progress: () => 1, isDone: () => true,
      run: () => assert.fail('already satisfied'), dispose: () => { disposals++; } });
    await turn();
    assert.equal(disposals, i + 1);
  }
  await f.companion.dispose();
  assert.equal(disposals, 50);
});

test('cancel invalidates a pending direct dispatch before its factory installs listeners', async (t) => {
  const f = fixture(t);
  const baseline = dragonListeners(f.bot);
  f.bot.health = 0;
  const pending = f.companion.endDragon();
  await f.companion.cancelTask();
  await assert.rejects(pending, { code: 'aborted' });
  assert.deepEqual(dragonListeners(f.bot), baseline);
  assert.equal(f.companion.status().goal, null);
});

test('retirement failure is observable and blocks new goal construction', async (t) => {
  const f = fixture(t);
  const baseline = dragonListeners(f.bot);
  f.bot.health = 0;
  const old = waitingGoal();
  old.dispose = () => { throw new Error('cannot release old resources'); };
  await f.companion.setGoal(old, { taskId: 'cannot-retire' });
  await assert.rejects(f.companion.cancelTask(), /cannot release old resources/);
  await assert.rejects(f.companion.endDragon(), /cannot release old resources/);
  assert.deepEqual(dragonListeners(f.bot), baseline);
  assert.equal(f.events.find((event) => event.type === 'goal_cleanup_error').taskId, 'cannot-retire');
  let directorTicks = 0;
  t.mock.method(f.companion.director, 'tick', () => { directorTicks++; });
  assert.throws(() => f.companion.setAutonomy(true), { code: 'cleanup_failed' });
  assert.equal(f.companion.status().cleanupFailed, true);
  assert.equal(f.companion.status().autonomy.enabled, false);
  const failure = f.events.find((event) => event.type === 'goal_cleanup_error');
  assert.equal(failure.code, 'cleanup_failed');
  assert.equal(failure.retryable, false);
  f.intervals[0].callback();
  assert.equal(directorTicks, 0, 'failed restoration cannot admit autonomous factories either');
  await assert.rejects(f.companion.dispose(), AggregateError);
  f.companion.dispose = () => Promise.resolve();
});

test('cancellation retires only its goal and never waits for an unrelated ongoing safety behavior', async (t) => {
  const f = fixture(t);
  let retired = false;
  const goal = waitingGoal();
  goal.dispose = () => { retired = true; };
  await f.companion.setGoal(goal);
  f.bot.entity.isInWater = true;
  f.bot.oxygenLevel = 5;
  await f.companion.brain.tick();
  assert.equal(f.companion.status().running, 'breathe');
  const safety = f.companion.brain.idle();
  const cancelled = f.companion.cancelTask();
  assert.equal(await Promise.race([cancelled.then(() => 'cancelled'), turn().then(() => 'still_waiting')]), 'cancelled');
  assert.equal(retired, true);
  assert.equal(f.companion.status().running, 'breathe');
  assert.equal(f.controls.jump, true);
  f.bot.oxygenLevel = 20;
  await safety;
  assert.equal(f.controls.jump, false);
});

for (const terminal of ['cancel', 'replace', 'failure', 'completion', 'dispose']) {
  test(`nested Nether trip restores its own movement policy on ${terminal}`, async (t) => {
    const f = fixture(t);
    f.bot.health = 0;
    f.bot.game.dimension = 'the_nether';
    f.bot.findBlocks = () => [];
    const movements = f.bot.pathfinder.movements;
    // Capture the two existing ownership layers without guessing their
    // implementation identity: disposal removes the door wrapper too.
    const { uninstallOpenDoorPassage, installOpenDoorPassage } = require('../core/openDoorPassage');
    uninstallOpenDoorPassage(f.bot, movements);
    const afterDoorRetirement = movements.getNeighbors;
    installOpenDoorPassage(f.bot, movements);
    // The lifecycle fixture does not execute paths; expose the native
    // neighbor API so it can still verify ownership of the physical guard.
    if (typeof movements.getNeighbors !== 'function') movements.getNeighbors = () => [];
    const originalNeighbors = movements.getNeighbors;
    // Restore caller policy, not hard-coded global defaults.
    movements.maxDropDown = 7;
    const extraHook = () => 17;
    movements.exclusionAreasStep.push(extraHook);
    const hooks = [...movements.exclusionAreasStep];
    const cantBreak = new Set(movements.blocksCantBreak);
    const goal = await f.companion.gatherMaterials({ chest: { x: 0, y: 64, z: 0 },
      requirements: [{ key: 'quartz', count: 2 }] });
    const ctx = { perceive: () => ({ inventory: {} }), record() {}, signal: new AbortController().signal };
    await goal.run(ctx);
    assert.equal(movements.companionNether, true);
    assert.equal(movements.maxDropDown, 2);
    assert.equal(movements.companionPhysicalDropLimit, 1);
    assert.equal(movements.getNeighbors, movements.companionPhysicalDropGuard);
    assert.equal(movements.infiniteLiquidDropdownDistance, false);
    assert.equal(movements.canDig, false);
    assert.equal(movements.allowParkour, false);
    assert.equal(movements.allow1by1towers, false);
    assert.deepEqual(movements.scafoldingBlocks, []);
    assert.equal(movements.exclusionAreasStep.length, hooks.length + 1);
    if (terminal === 'cancel') await f.companion.cancelTask();
    if (terminal === 'replace') await f.companion.gatherLogs(1);
    if (terminal === 'failure') { await f.companion.brain.failGoal('test_failure'); await turn(); }
    if (terminal === 'completion') {
      goal.memory.chest = { quartz: 2 };
      f.bot.health = 20;
      await f.companion.brain.tick();
      await turn();
    }
    if (terminal === 'dispose') await f.companion.dispose();
    assert.equal(movements.companionNether, false);
    assert.equal(movements.maxDropDown, 7);
    // Full companion disposal also retires its pre-existing door wrapper;
    // the other transitions keep that live companion wrapper available.
    assert.equal(movements.getNeighbors, terminal === 'dispose' ? afterDoorRetirement : originalNeighbors);
    assert.equal(Object.hasOwn(movements, 'companionPhysicalDropGuard'), false);
    assert.equal(Object.hasOwn(movements, 'companionPhysicalDropLimit'), false);
    assert.deepEqual(movements.exclusionAreasStep, hooks);
    assert.deepEqual(movements.blocksCantBreak, cantBreak);
    // Idempotence must not erase policy installed after retirement.
    movements.maxDropDown = 9;
    await goal.dispose();
    assert.equal(movements.maxDropDown, 9);
  });
}

test('cached device project cascades through its real gather and Nether trip, then can resume', async (t) => {
  const { createDeviceProjectGoal } = require('../core/goals/deviceProject');
  const f = fixture(t);
  f.bot.health = 0;
  f.bot.game.dimension = 'the_nether';
  f.bot.findBlocks = () => [];
  const movements = f.bot.pathfinder.movements;
  const beforeHooks = [...movements.exclusionAreasStep];
  const foreignDeath = () => {};
  f.bot.on('death', foreignDeath);
  const deaths = f.bot.listeners('death');
  const project = createDeviceProjectGoal({ bot: f.bot, name: 'quartz_device',
    device: { name: 'device', memory: {}, needs: () => [{ key: 'quartz', count: 2 }],
      isDone: () => false, progress: () => 0 },
    home: { chest: { x: 0, y: 64, z: 0 }, centre: { x: 0, y: 64, z: 0 } } });
  const ctx = { perceive: () => ({ inventory: {} }), record() {}, signal: new AbortController().signal };
  await f.companion.setGoal(project);
  await project.run(ctx);
  const gather = project.memory.gather;
  const trip = gather.memory.trip;
  trip.memory.overworldPortal = { x: 2, y: 64, z: 3 };
  assert.equal(movements.companionNether, true);
  await f.companion.cancelTask();
  assert.equal(movements.companionNether, false);
  assert.equal(movements.maxDropDown, 4);
  assert.deepEqual(movements.exclusionAreasStep, beforeHooks);
  assert.deepEqual(f.bot.listeners('death'), deaths);
  assert.equal(project.memory.gather, gather);
  assert.equal(gather.memory.trip, trip);
  await f.companion.setGoal(project);
  await project.run(ctx);
  assert.equal(movements.companionNether, true);
  assert.deepEqual(trip.memory.overworldPortal, { x: 2, y: 64, z: 3 });
  await f.companion.cancelTask();
  assert.equal(movements.companionNether, false);
  assert.deepEqual(movements.exclusionAreasStep, beforeHooks);
});

test('companion installs observed cube dimensions and removes its geometry listeners on final dispose', async (t) => {
  const f = fixture(t);
  const definition = f.bot.registry.entitiesByName.magma_cube;
  const sizeIndex = definition.metadataKeys.indexOf('size');
  const target = { id: 91, name: 'magma_cube', width: .52, height: .52, position: new Vec3(4, 64, 0), metadata: [] };
  target.metadata[sizeIndex] = 4;
  f.bot.entities[91] = target;
  f.bot.emit('entitySpawn', target);
  assert.equal(target.width, definition.width * 4);
  assert.equal(target.height, definition.height * 4);
  const position = target.position;
  assert.equal(f.bot.listenerCount('entityUpdate'), 1);
  assert.equal(f.bot.listenerCount('entityAttributes'), 1);
  await f.companion.dispose();
  assert.deepEqual(dragonListeners(f.bot), [0, 0, 0]);
  assert.equal(f.bot.listenerCount('entityUpdate'), 0);
  assert.equal(f.bot.listenerCount('entityAttributes'), 0);
  target.metadata[sizeIndex] = 2;
  f.bot.emit('entityUpdate', target);
  assert.equal(target.width, definition.width * 4, 'disposed geometry owner cannot keep mutating native entities');
  assert.equal(target.position, position);
});

test('session body life owner records every death while a cached goal listener is inactive', async t => {
  const f=fixture(t), read=f.bot.companionBodyLife;
  assert.equal(typeof read,'function'); const first=read();
  assert.equal(first.epoch,0); assert.ok(first.owner);
  f.bot.emit('death'); const next=read();
  assert.equal(next.owner,first.owner); assert.equal(next.epoch,1);
  await f.companion.dispose(); assert.equal(read(),null,'disposed authority is invalid immediately and after cleanup');
  assert.equal(Object.hasOwn(f.bot,'companionBodyLife'),false);
});

test('session body life cleanup never overwrites a newer hook owner', async t => {
  const f=fixture(t), old=f.bot.companionBodyLife, newer=()=>({owner:{},epoch:0});
  f.bot.companionBodyLife=newer;
  if(typeof old==='function')assert.equal(old(),null,'a superseded authority cannot grant same-life proof');
  await f.companion.dispose();assert.equal(f.bot.companionBodyLife,newer);
});

test('cached quartz observes a session death during disposal and revokes stale phase proofs without refund', async t => {
  const f=fixture(t), {createNetherQuartzGoal}=require('../core/goals/netherQuartz');
  const goal=createNetherQuartzGoal({bot:f.bot}); const ledger={used:{feet:1,digs:1,nativeDigAttempts:1}};
  Object.assign(goal.memory,{quartzExcavation:ledger,quartzExcavationAtShore:true,quartzExcavationAtShoreEpoch:0,
    quartzBridgeRecovery:{owner:f.bot.companionBodyLife().owner,epoch:0,routeKey:'old'},
    quartzExcavationPickup:{position:new Vec3(1,63,0),before:7,epoch:0,attempts:0}});
  goal.dispose();f.bot.emit('death');
  assert.equal(f.bot.companionBodyLife().epoch,1,'only the session onDeath increments authority once');
  try {
    const r=await goal.run({signal:new AbortController().signal,record(){},perceive:()=>({inventory:{},hostiles:[]})});
    assert.equal(r.reason,'no_pickaxe');assert.equal(goal.memory.quartzExcavationAtShore,false);
    assert.equal(goal.memory.quartzBridgeRecovery,null);assert.equal(goal.memory.quartzExcavationPickup,null);
    assert.equal(goal.memory.quartzExcavation,ledger);assert.deepEqual(ledger.used,{feet:1,digs:1,nativeDigAttempts:1});
    assert.equal(f.bot.companionBodyLife().epoch,1,'local continuation markers do not increment session death authority');
  } finally {goal.dispose();}
});

test('body life authority becomes invalid immediately while dispose still awaits an unsettled body', async t => {
  const f=fixture(t,{retirementTimeoutMs:5});let release;
  const held=new Promise(resolve=>{release=resolve;});
  await f.companion.setGoal({name:'held_life',isDone:()=>false,progress:()=>0,run:()=>held});
  const read=f.bot.companionBodyLife,disposing=f.companion.dispose();
  assert.equal(read(),null,'disposed flag revokes authority before asynchronous cleanup');
  try { await assert.rejects(disposing,{code:'retirement_timeout'}); }
  finally {release({ok:false,reason:'aborted'});await f.companion.brain.idle();await f.companion.dispose();}
});

test('body life hook restores the exact prior own descriptor only while still its owner', async t => {
  const f=fixture(t);await f.companion.dispose();
  const prior=()=>null,descriptor={value:prior,writable:true,enumerable:true,configurable:true};
  Object.defineProperty(f.bot,'companionBodyLife',descriptor);
  const next=createCompanion({bot:f.bot});const read=f.bot.companionBodyLife;
  assert.notEqual(read,prior);await next.dispose();assert.equal(read(),null);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.bot,'companionBodyLife'),descriptor);
});
