/* global require, module, __dirname, setTimeout */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module'), crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createNaturalHouseSiteSearch } = require('../vendor/server/minecraft/houseNaturalSiteSearch');
const engineFile = path.join(__dirname, '../vendor/server/minecraftTaskAgent.js'), source = fs.readFileSync(engineFile, 'utf8');
// Like the existing XP stage probes, extract the current original engine
// declaration between its two-space function boundaries and compile with the
// built-in VM. Frozen runtimes need only their original runtime dependencies.
const declaration = name => {
  assert.match(name, /^[A-Za-z_$][A-Za-z0-9_$]*$/);
  const start = new RegExp('^  (?:async )?function ' + name + '\\(', 'm').exec(source);
  assert.ok(start, 'Actual engine declaration ' + name);
  const next = /\n {2}(?:async )?function /g; next.lastIndex = start.index + start[0].length;
  const end = next.exec(source); assert.ok(end, 'Actual engine next declaration ' + name);
  const body = source.slice(start.index, end.index).trim();
  assert.match(body, /\n {2}}$/, 'Actual engine original closing boundary ' + name);
  return body;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = x => JSON.parse(JSON.stringify(x));

// Engine functions are extracted from the current source at test execution.
// Budget/adapter callbacks below are explicit offline dependency contracts.
function probe(options = {}) {
  const token = { throwIfRequested() {}, cancelled: false, pauseRequested: false }, lease = {};
  const bot = { _client: {}, pathfinder: { movements: {} }, entity: { position: new Vec3(.5, 64, .5) }, entities: {} };
  const step = { skill: 'build_furnished_house_phase', args: { profile: 'cottage', materialSource: 'self_gathered', phase: 'inspect_inventory' } };
  const task = { taskId: 'site-engine-contract', status: 'running', executionGeneration: 5, movementLease: lease, cancellationToken: token,
    currentStepIndex: 0, plan: { steps: [step, { ...step, args: { ...step.args, phase: 'select_site' } }] } };
  const frames = new WeakMap(), startedAt = Date.now() - 100, hardTimeoutMs = 60000;
  const frame = { task, bot, client: bot._client, token, lease, generation: 5, startedAt, hardTimeoutMs, deadline: startedAt + hardTimeoutMs, stepIndex: 0, step };
  frames.set(task, frame); let context = { task, token, runGeneration: 5, movementLease: lease }, captured;
  const als = new AsyncLocalStorage(), env = {
    ensureBotReady: () => bot, currentTask: task, currentBot: bot, runtimeToken: token,
    getExecutionContext: () => als.getStore() || (options.nativeALS ? null : { ...context, extraIgnoredContextField: {} }),
    getActiveCancellationToken: () => token, getCurrentMovementLease: () => lease, naturalXPStepWatchdogFrames: frames,
    activeHouseSurfaceNavigationMove: null, activeSurvivalInterrupt: null, isMovementLeaseActive: value => value === lease,
    isHouseSurfaceDefenseCurrent: () => false, createAbortError: code => Object.assign(new Error(code), { code }), checkTaskSignal: () => token.throwIfRequested(),
    createNaturalHouseSiteSearch: deps => { captured = deps; return options.actualProvider ? createNaturalHouseSiteSearch(deps) : {}; },
    setTaskProgress: () => {}, recordTaskHeartbeat: () => {}, recordTaskDiagnostic: () => {}, exploreHouseSurfaceGraph: () => assert.fail('No graph action in this budget test'),
    executionContextStorage: als, TaskState: { PAUSED: 'paused', CANCELLED: 'cancelled' }, getHouseSurfaceDefenseFailure: () => null,
    createLoadedShallowWaterFinder: () => ({ find: () => ({ routes: [], diagnostics: {} }) }),
    createLoadedSurfaceSwimFinder: () => ({ find: () => ({ routes: [], diagnostics: {} }) }),
    createHouseObservedResourceMemory: () => assert.fail('Site graph cannot record material resources'),
    ensureMovements: () => {}, appliedMovementsBot: null, appliedMovementsInstance: null,
    Vec3, Movements: class {}, goals: { GoalBlock: class {} },
    isBotConnectionWritable: () => true, ensureMovementLeaseActive: () => {}, sleep, Date,
  };
  const sandbox = vm.createContext(env);
  const load = name => vm.runInContext(declaration(name) + '\n' + name, sandbox);
  const factory = load('createFurnishedHouseSiteSearch');
  if (options.nativeALS) als.run(context, () => factory('cottage')); else factory('cottage');
  return { bot, task, frame, frames, token, lease, context, captured, env, sandbox, load, als,
    replaceContext: value => { context = value; } };
}

test('exact factory accepts equivalent context fields across copied context objects and reads elapsed real time', async () => {
  const f = probe(), before = f.captured.readRemainingMs(); f.captured.assertActive();
  await sleep(20); const after = f.captured.readRemainingMs();
  assert.ok(before - after >= 10); assert.equal(f.task.materialSupply, undefined); assert.equal(f.task.siteSearch, undefined);
});

test('site factory accepts only its exact captured surface defense context without changing the original budget', () => {
  const f = probe({ nativeALS: true }), defenseLease = { token: 'defense' };
  const move = { task: f.task, lease: f.lease };
  f.env.activeHouseSurfaceNavigationMove = move;
  f.env.activeSurvivalInterrupt = { lease: defenseLease, previousLease: f.lease, surfaceMove: move };
  f.env.isMovementLeaseActive = () => false;
  f.env.isHouseSurfaceDefenseCurrent = value => value === move;
  const context = { ...f.context, movementLease: defenseLease };
  f.als.run(context, () => { f.captured.assertActive(); assert.ok(f.captured.readRemainingMs() > 0); });
  assert.equal(f.frame.deadline, f.frame.startedAt + f.frame.hardTimeoutMs);
  f.als.run({ ...context, movementLease: {} }, () => assert.throws(f.captured.assertActive, { code: 'movement_preempted' }));
  f.env.activeSurvivalInterrupt.surfaceMove = {};
  f.als.run(context, () => assert.throws(f.captured.assertActive, { code: 'movement_preempted' }));
});

test('actual EventEmitter outside task ALS permits only the still-current native observation capability', () => {
  const f = probe({ nativeALS: true }), emitter = new EventEmitter();
  let actualContext = 'unread', observed = 0;
  f.als.run(f.context, () => emitter.on('physicsTick', () => {
    actualContext = f.als.getStore() || null;
    f.captured.assertActive(); assert.ok(f.captured.readRemainingMs() > 0); observed++;
  }));
  emitter.emit('physicsTick');
  assert.equal(actualContext, null); assert.equal(observed, 1);
  assert.equal(f.task.materialSupply, undefined); assert.equal(f.task.siteSearch, undefined);
  f.als.run({ ...f.context, task: {} }, () => assert.throws(() => emitter.emit('physicsTick'), { code: 'movement_preempted' }));
  assert.equal(observed, 1);
});

for (const mutation of ['current_step', 'frame_replaced', 'client', 'paused']) {
  test(`outside-ALS native EventEmitter refuses ${mutation} without observation or CP credit`, () => {
    const f = probe({ nativeALS: true }), emitter = new EventEmitter(); let observed = 0;
    f.als.run(f.context, () => emitter.on('physicsTick', () => { f.captured.assertActive(); f.captured.readRemainingMs(); observed++; }));
    if (mutation === 'current_step') f.task.currentStepIndex++;
    if (mutation === 'frame_replaced') f.frames.set(f.task, { ...f.frame });
    if (mutation === 'client') f.bot._client = {};
    if (mutation === 'paused') f.token.pauseRequested = true;
    assert.throws(() => emitter.emit('physicsTick'), { code: 'movement_preempted' });
    assert.equal(observed, 0); assert.equal(f.task.materialSupply, undefined); assert.equal(f.task.siteSearch, undefined);
  });
}

for (const name of ['current_step', 'replaced_step', 'wrong_skill', 'wrong_profile', 'future_start', 'fractional_clock', 'deadline_sum', 'infinite_timeout', 'frame_replaced']) {
  test(`exact site factory rejects ${name} rather than borrowing an original step frame`, () => {
    const f = probe();
    if (name === 'current_step') f.task.currentStepIndex++;
    if (name === 'replaced_step') f.task.plan.steps[0] = { ...f.task.plan.steps[0] };
    if (name === 'wrong_skill') f.frame.step.skill = 'follow';
    if (name === 'wrong_profile') f.frame.step.args.profile = 'enchanting_library';
    if (name === 'future_start') { f.frame.startedAt = Date.now() + 5000; f.frame.deadline = f.frame.startedAt + f.frame.hardTimeoutMs; }
    if (name === 'fractional_clock') { f.frame.startedAt += .5; f.frame.deadline += .5; }
    if (name === 'deadline_sum') f.frame.deadline++;
    if (name === 'infinite_timeout') f.frame.hardTimeoutMs = Infinity;
    if (name === 'frame_replaced') f.frames.set(f.task, { ...f.frame });
    assert.throws(() => f.captured.readRemainingMs(), { code: 'house_site_search_step_budget_pending' });
  });
}

for (const field of ['client', 'generation', 'token', 'lease', 'context_task', 'context_token']) {
  test(`exact site owner refuses foreign ${field} before CP or graph action`, () => {
    const f = probe();
    if (field === 'client') f.bot._client = {};
    if (field === 'generation') f.task.executionGeneration++;
    if (field === 'token') f.task.cancellationToken = {};
    if (field === 'lease') f.task.movementLease = {};
    if (field === 'context_task') f.replaceContext({ ...f.context, task: {} });
    if (field === 'context_token') f.replaceContext({ ...f.context, token: {} });
    assert.throws(() => f.captured.assertActive(), { code: 'movement_preempted' }); assert.equal(f.task.materialSupply, undefined);
  });
}

test('an expired real step returns zero and the provider rejects it without refreshing CP time', async () => {
  const f = probe({ actualProvider: true }); f.frame.startedAt = Date.now() - 1000; f.frame.hardTimeoutMs = 1; f.frame.deadline = f.frame.startedAt + 1;
  assert.equal(f.captured.readRemainingMs(), 0);
  const p = f.load('createFurnishedHouseSiteSearch')('cottage');
  await assert.rejects(p.provider.search({ profile: 'cottage' }), { code: 'house_site_search_timeout' });
  assert.equal(f.task.siteSearch, undefined); assert.equal(f.task.materialSupply, undefined);
});

test('exact host graph adapter keeps site checkpoint separate while retaining legacy material graphs', async () => {
  const f = probe(), actual = f.load('exploreHouseSurfaceGraph');
  f.task.siteSearch = { kind: 'loaded_natural_house_site_search', profile: 'cottage', ownerIdentity: { taskId: f.task.taskId }, graph: null };
  f.task.materialSupply = { quarry: { original: true }, naturalXPHost: { original: true }, surfaceGraphs: { coal: { previous: true } } };
  const before = JSON.stringify(f.task.materialSupply), fresh = { schema: 2, kind: 'loaded_dry_waypoint_graph', actual: true };
  f.env.createHouseSurfaceGraph = deps => ({ returnToAnchor: async () => { deps.assertActive(); deps.saveCP(fresh); return { returned: true }; } });
  const checkpoint = { get: () => f.task.siteSearch.graph, save: value => { f.task.siteSearch = { ...f.task.siteSearch, graph: value }; } };
  await actual(f.task, 'house_site_cottage', { x: 0, y: 64, z: 0 }, () => {}, { returnToAnchor: true, graphCheckpoint: checkpoint, assertGraphActive: () => {} });
  assert.equal(JSON.stringify(f.task.materialSupply), before); assert.deepEqual(f.task.siteSearch.graph, fresh);
  await actual(f.task, 'coal', { x: 0, y: 64, z: 0 }, () => {}, { returnToAnchor: true });
  assert.deepEqual(f.task.materialSupply.quarry, { original: true }); assert.deepEqual(f.task.materialSupply.naturalXPHost, { original: true });
  assert.deepEqual(f.task.materialSupply.surfaceGraphs.coal, fresh); assert.equal(f.task.materialSupply.activeSurfaceGraph, 'coal');
});

test('a site-only checkpoint cannot be attached to a resource graph or omit its capability guard', async () => {
  const f = probe(), actual = f.load('exploreHouseSurfaceGraph');
  const checkpoint = { get: () => null, save: () => assert.fail('no CP credit') };
  await assert.rejects(actual(f.task, 'any_log', {}, () => {}, { graphCheckpoint: checkpoint, assertGraphActive: () => {} }), { code: 'house_site_search_graph_adapter_invalid' });
  await assert.rejects(actual(f.task, 'house_site_cottage', {}, () => {}, { graphCheckpoint: checkpoint }), { code: 'house_site_search_graph_adapter_invalid' });
});

test('provider expiration during an awaited dry native continuation reaches the original move source guard', async () => {
  const f = probe(), actualGraph = f.load('exploreHouseSurfaceGraph'), actualGoto = f.load('houseSurfacePathfinderGoto'); let expired = false, lateNativeCredit = 0;
  f.env.houseSurfacePathfinderGoto = actualGoto;
  f.env.createHouseSurfaceGraph = deps => ({ returnToAnchor: async () => { await deps.actualnativegoto({}, {}); return { returned: true }; } });
  f.env.pathfinderGoto = async () => {
    await sleep(10); expired = true;
    // This is an explicitly modeled pending native continuation, with no actor
    // or controls writes. The exact engine move guard must reject before credit.
    f.env.activeHouseSurfaceNavigationMove.assertActive(); lateNativeCredit++;
  };
  const capability = () => { if (expired) throw Object.assign(new Error('absolute provider deadline elapsed'), { code: 'house_site_search_timeout' }); };
  const checkpoint = { get: () => null, save: () => {} };
  await assert.rejects(actualGraph(f.task, 'house_site_cottage', { x: 0, y: 64, z: 0 }, () => {},
    { returnToAnchor: true, graphCheckpoint: checkpoint, assertGraphActive: capability }), { code: 'house_site_search_timeout' });
  assert.equal(lateNativeCredit, 0);
});

for (const foreignClient of [false, true]) {
  test(`awaited native ownership callback refuses expired site scope${foreignClient ? ' and preserves a later foreign-owner error' : ' with its typed cause'}`, async () => {
    const f = probe(), actualGraph = f.load('exploreHouseSurfaceGraph'), actualGoto = f.load('houseSurfacePathfinderGoto');
    let expired = false, nativeCredit = 0;
    f.env.houseSurfacePathfinderGoto = actualGoto;
    f.env.createHouseSurfaceGraph = deps => ({ returnToAnchor: async () => { await deps.actualnativegoto({}, {}); return { returned: true }; } });
    f.env.pathfinderGoto = async (_goal, _timeout, _label, _lease, options) => {
      await sleep(10); expired = true;
      if (options.isOwnerCurrent()) nativeCredit++;
      assert.equal(nativeCredit, 0);
      if (foreignClient) f.bot._client = {};
      throw Object.assign(new Error('native owner predicate refused continuation'), { code: 'movement_preempted' });
    };
    const capability = () => { if (expired) throw Object.assign(new Error('absolute provider deadline elapsed'), { code: 'house_site_search_timeout' }); };
    await assert.rejects(actualGraph(f.task, 'house_site_cottage', { x: 0, y: 64, z: 0 }, () => {},
      { returnToAnchor: true, graphCheckpoint: { get: () => null, save: () => {} }, assertGraphActive: capability }),
    { code: foreignClient ? 'movement_preempted' : 'house_site_search_timeout' });
    assert.equal(nativeCredit, 0);
  });
}

test('legacy dry native movement without site capability keeps its original owner continuation', async () => {
  const f = probe(), actualGoto = f.load('houseSurfacePathfinderGoto'); let nativeCredit = 0;
  f.env.pathfinderGoto = async (_goal, _timeout, _label, _lease, options) => {
    await sleep(10); assert.equal(options.isOwnerCurrent(), true);
    f.env.activeHouseSurfaceNavigationMove.assertActive(); nativeCredit++; return 'original native result';
  };
  assert.equal(await actualGoto({}), 'original native result'); assert.equal(nativeCredit, 1);
  assert.equal(f.env.activeHouseSurfaceNavigationMove, null);
});

function nativeFixture(t) {
  let f, running, release;
  // Retain the original real task execution context while assertions run.
  // Cleanup pauses that offline task and releases the test continuation before
  // the original fixture detaches its installed native plugins.
  t.after(async () => { f?.task.cancellationToken.pause(); release?.(); await running; });
  const filename = path.join(__dirname, 'house-quarry-entry-engine.test.js'), raw = fs.readFileSync(filename, 'utf8'), end = raw.indexOf('\ntest(');
  const loaded = new Module.Module(filename, module); loaded.filename = filename; loaded.paths = Module.Module._nodeModulePaths(__dirname);
  loaded._compile(raw.slice(0, end) + '\nmodule.exports={fixture};\n', filename);
  f = loaded.exports.fixture(t, { stableCamp: true });
  f.bot.inventory.slots.fill(null); f.bot.heldItem = null; f.cells.clear();
  for (let x = -48; x <= 48; x++) for (let z = -48; z <= 48; z++) f.cells.set(`${x},63,${z}`, 'grass_block');
  delete f.task.materialSupply; delete f.task.stepCheckpoint;
  const step = { skill: 'build_furnished_house_phase', args: { schema: 2, phase: 'inspect_inventory', profile: 'cottage', materialSource: 'self_gathered' } };
  f.task.plan = { mode: 'task', intent: 'build_furnished_house', steps: [step] }; f.task.completionPlan = clone(f.task.plan);
  return { ...f, step, inspect: async () => {
    let ready; const inspected = new Promise(resolve => { ready = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    running = f.agent.__testRunTaskExecution(f.task, { executeStep: async (task, originalStep, callbacks) => {
      await f.agent.__testExecuteStepWithWatchdog(task, originalStep, callbacks); ready(); await hold;
    } });
    await Promise.race([inspected, running.then(() => assert.fail(`Original task execution stopped before inspect: ${f.task.errorCode || f.task.status}: ${f.task.progressText}`))]);
  } };
}

test('true production watchdog/factory records an actual native start node and valid camp without initializing material supply', { timeout: 20000 }, async t => {
  const f = nativeFixture(t), beforePlan = JSON.stringify(f.task.completionPlan), start = Date.now(); await f.inspect();
  assert.equal(f.task.materialSupply, undefined); assert.equal(f.task.siteSearch.kind, 'loaded_natural_house_site_search');
  assert.equal(f.task.siteSearch.graph.order.length, 1); assert.equal(f.task.siteSearch.graph.current, '0,64,0');
  assert.ok(f.task.siteSearch.deadline >= start && f.task.siteSearch.deadline <= Date.now() + 1200000);
  assert.equal(f.task.siteSearch.reservation.kind, 'actual_loaded_house_site_and_camp');
  assert.deepEqual(f.task.siteSearch.reservation.camp.anchor, { x: 0, y: 64, z: 0 });
  assert.equal(JSON.stringify(f.task.completionPlan), beforePlan); assert.equal(f.bot.inventory.items().length, 0); assert.equal(f.digs.length, 0);
  assert.equal(f.moves.length, 0); assert.equal(f.packets.some(p => p.name === 'block_place'), false);
  const init = await f.agent.__testHouseSelfSupply({}, { anchor: f.task.siteSearch.reservation.houseAnchor, profile: 'cottage' });
  assert.equal(init.confirmed, true); assert.deepEqual(f.task.materialSupply.camp.anchor, { x: 0, y: 64, z: 0 });
  assert.deepEqual(f.task.materialSupply.ownedStations, {}); assert.equal(f.task.siteSearch.graph.order.length, 1);
});

for (const mutation of ['station_changed', 'malformed_house']) {
  test(`true material initialization refuses ${mutation} reservation before camp or owned placement credit`, { timeout: 20000 }, async t => {
    const f = nativeFixture(t); await f.inspect(); const anchor = { ...f.task.siteSearch.reservation.houseAnchor };
    if (mutation === 'station_changed') { const p = f.task.siteSearch.reservation.camp.stations.furnace; f.cells.set(`${p.x},${p.y - 1},${p.z}`, 'lava'); }
    else delete f.task.siteSearch.reservation.houseAnchor;
    await assert.rejects(f.agent.__testHouseSelfSupply({}, { anchor, profile: 'cottage' }), { code: 'house_site_search_reservation_changed' });
    assert.equal(f.task.materialSupply, undefined); assert.equal(f.digs.length, 0); assert.equal(f.packets.some(p => p.name === 'block_place'), false);
  });
}

test('exact current source hashes accompany the scoped engine contracts', t => {
  t.diagnostic(JSON.stringify({ scope: 'Exact current source functions/true factory with installed native fixture and modeled voxel replies; no Java/live map proof',
    engineSHA256: hash(source), siteModuleSHA256: hash(fs.readFileSync(path.join(__dirname, '../vendor/server/minecraft/houseNaturalSiteSearch.js'))) }));
});
