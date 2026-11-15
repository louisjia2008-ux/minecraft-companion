'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const WorldSync = require('prismarine-world/src/worldsync');
const { configureMovements } = require('../core/companion');
const nether = require('../core/nether');
const quartz = require('../core/goals/netherQuartz');
const skills = require('../core/skills');
const { createBlacklist } = require('../core/blacklist');

function fixture({ radiusX = 24, radiusZ = 8 } = {}) {
  const cells = new Map(), unknown = new Set(), events = [];
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  function put(p, name) { cells.set(key(p), name); }
  function blockAt(p) {
    p = p.floored(); if (unknown.has(key(p))) return null;
    const wall = Math.abs(p.x) > radiusX || Math.abs(p.z) > radiusZ;
    const name = cells.get(key(p)) || (p.y < 0 || wall ? 'basalt' : 'air');
    const b = Block.fromProperties(registry.blocksByName[name].id, {}, 0); b.position = p; return b;
  }
  const bot = Object.assign(new EventEmitter(), { registry, blockAt, entities: {}, health: 20, food: 20,
    game: { dimension: 'the_nether', minY: -64 },
    entity: { position: new Vec3(.5, 0, .5), onGround: true, effects: {} },
    inventory: { items: () => [{ name: 'diamond_pickaxe', type: registry.itemsByName.diamond_pickaxe.id }], slots: [] },
    clearControlStates() {}, findBlocks: () => [] });
  bot.world = { getBlock: blockAt }; bot.world.raycast = WorldSync.prototype.raycast.bind(bot.world);
  require('mineflayer-pathfinder').pathfinder(bot);
  const movements = configureMovements(bot); movements.allowEntityDetection = false;
  nether.applyNetherMovements(bot); nether.applyWalkOnlyMovements(bot);
  const ctx = { signal: new AbortController().signal, record: (type, data) => events.push({ type, ...data }) };
  return { bot, movements, ctx, put, unknown, events, block: (p) => blockAt(p) };
}

test('native walk-only planner selects exposed reachable ore and rejects closer buried ore without moving', async () => {
  const f = fixture(), buried = new Vec3(2, -2, 0), exposed = new Vec3(18, 0, 0);
  f.put(buried, 'nether_quartz_ore'); f.put(exposed, 'nether_quartz_ore');
  const before = f.bot.entity.position.clone(), state = {};
  const result = await quartz.selectQuartzTarget(f.bot, f.ctx, [f.block(buried), f.block(exposed)], state);
  assert.equal(result.ok, true); assert.deepEqual(result.block.position, exposed);
  assert.deepEqual(f.bot.entity.position, before);
  assert.equal(f.movements.canDig, false); assert.deepEqual(f.movements.scafoldingBlocks, []);
  assert.equal(f.movements.maxDropDown, 2);
  assert.equal(f.movements.companionPhysicalDropLimit, 1);
  assert.equal(f.movements.getNeighbors, f.movements.companionPhysicalDropGuard);
  assert.equal(f.movements.infiniteLiquidDropdownDistance, false);
  assert.ok(f.events.some((e) => e.type === 'quartz_target_plan' && e.target === '2,-2,0' && !e.ok));
  assert.ok(f.events.some((e) => e.type === 'quartz_target_plan' && e.target === '18,0,0' && e.ok));
});

test('native reachable elevated one-block stance is not rejected by raw Move feet semantics', async () => {
  const f = fixture(); f.put(new Vec3(2, 0, 0), 'basalt'); f.put(new Vec3(3, 0, 0), 'basalt');
  const goal = new (require('mineflayer-pathfinder').goals.GoalBlock)(3, 1, 0);
  const plan = await quartz.quartzPathPlan(f.bot, goal);
  assert.equal(plan.ok, true); assert.equal(plan.path.at(-1).y, 1);
  assert.equal(f.movements.canDig, false);
});

for (const hazard of ['lava', 'water', 'fire', 'soul_fire', 'magma_block']) test(`safe mining path rejects actual ${hazard} and unknown support`, async () => {
  const f = fixture(); const goal = new (require('mineflayer-pathfinder').goals.GoalBlock)(3, 0, 0);
  f.bot.pathfinder.getPathFromTo = function* () { yield { result: { status: 'success', path: [new Vec3(1, 0, 0), new Vec3(2, 0, 0), new Vec3(3, 0, 0)] } }; };
  f.put(new Vec3(2, hazard === 'magma_block' ? -1 : 0, 0), hazard);
  assert.equal((await quartz.quartzPathPlan(f.bot, goal)).ok, false);
  f.put(new Vec3(2, 0, 0), 'air'); f.put(new Vec3(2, -1, 0), 'basalt'); f.unknown.add('2,-1,0');
  assert.equal((await quartz.quartzPathPlan(f.bot, goal)).ok, false);
});

test('partial, timeout, excavation, scaffold and fake success endpoints never authorize navigation', async () => {
  const f = fixture(), goal = new (require('mineflayer-pathfinder').goals.GoalBlock)(3, 0, 0);
  for (const result of [
    { status: 'partial', path: [new Vec3(3, 0, 0)] },
    { status: 'timeout', path: [new Vec3(3, 0, 0)] },
    { status: 'success', path: [Object.assign(new Vec3(3, 0, 0), { toBreak: [new Vec3(3, 0, 0)] })] },
    { status: 'success', path: [Object.assign(new Vec3(3, 0, 0), { toPlace: [{}] })] },
    { status: 'success', path: [new Vec3(1, 0, 0)] },
  ]) {
    f.bot.pathfinder.getPathFromTo = function* () { yield { result }; };
    assert.equal((await quartz.quartzPathPlan(f.bot, goal)).ok, false);
  }
});

test('cancellation before and after a bounded native query cannot select or move the body', async () => {
  const f = fixture(), p = new Vec3(4, 0, 0); f.put(p, 'nether_quartz_ore');
  const controller = new AbortController(); f.ctx.signal = controller.signal; controller.abort();
  await assert.rejects(quartz.selectQuartzTarget(f.bot, f.ctx, [f.block(p)], {}), { code: 'aborted' });
  const second = new AbortController(); f.ctx.signal = second.signal;
  const getter = f.bot.pathfinder.getPathFromTo;
  f.bot.pathfinder.getPathFromTo = function* (...args) { const value = getter.apply(this, args).next().value; second.abort(); yield value; };
  await assert.rejects(quartz.selectQuartzTarget(f.bot, f.ctx, [f.block(p)], {}), { code: 'aborted' });
  assert.deepEqual(f.bot.entity.position, new Vec3(.5, 0, .5));
});

test('a completed round retains attempted candidates across world revisions but resets for a new start cell', async () => {
  const f = fixture(), p = new Vec3(2, -2, 0); f.put(p, 'nether_quartz_ore');
  let calls = 0; const getter = f.bot.pathfinder.getPathFromTo;
  f.bot.pathfinder.getPathFromTo = function* (...args) { calls++; yield* getter.apply(this, args); };
  const state = {};
  await quartz.selectQuartzTarget(f.bot, f.ctx, [f.block(p)], state); const first = calls;
  await quartz.selectQuartzTarget(f.bot, f.ctx, [f.block(p)], state); assert.equal(calls, first);
  state.quartzWorldRevision = 1;
  assert.equal((await quartz.selectQuartzTarget(f.bot, f.ctx, [f.block(p)], state)).reason, 'quartz_search_inconclusive');
  assert.equal(calls, first);
  const changedWorld = calls; f.bot.entity.position.x += 1;
  await quartz.selectQuartzTarget(f.bot, f.ctx, [f.block(p)], state); assert.ok(calls > changedWorld);
});

test('gather target-selector rejection is cancellable and optional generic selection stays unchanged', async () => {
  const f = fixture(), p = new Vec3(3, 0, 0); f.put(p, 'nether_quartz_ore'); f.bot.findBlocks = () => [p];
  const options = { blocks: (n) => n === 'nether_quartz_ore', dropMatch: (n) => n === 'quartz', blacklist: createBlacklist(),
    selectTarget: async () => ({ ok: false, reason: 'quartz_no_reachable_target' }), navigationTrace: true };
  const result = await skills.gatherOne(f.bot, f.ctx, options);
  assert.equal(result.reason, 'quartz_no_reachable_target');
  assert.equal(f.events.some((e) => e.type === 'target_selected'), false);
  // Original generic selection still reaches its original no-tool guard.
  f.bot.inventory.items = () => [];
  const generic = await skills.gatherOne(f.bot, f.ctx, { ...options, selectTarget: undefined });
  assert.equal(generic.reason, 'no_tool');
  assert.equal(f.events.at(-1).type, 'target_selected');
});

test('one scan has at most six native queries with yields, not64 long synchronous searches', async () => {
  const f = fixture(); let calls = 0, yielded = false;
  f.bot.pathfinder.getPathFromTo = function* () { calls++; yield { result: { status: 'timeout', path: [] } }; };
  const ores = Array.from({ length: 64 }, (_, i) => { const p = new Vec3(i, -2, 0); f.put(p, 'nether_quartz_ore'); return f.block(p); });
  setImmediate(() => { yielded = true; });
  const result = await quartz.selectQuartzTarget(f.bot, f.ctx, ores, {});
  assert.equal(calls, 6); assert.equal(yielded, true); assert.equal(result.reason, 'quartz_scan_pending');
});

test('world changed during yield cannot authorize a stale reachable ore', async () => {
  const f = fixture(), p = new Vec3(4, 0, 0); f.put(p, 'nether_quartz_ore');
  setImmediate(() => f.put(p, 'basalt'));
  const result = await quartz.selectQuartzTarget(f.bot, f.ctx, [f.block(p)], {});
  assert.equal(result.ok, false);
  assert.ok(f.events.some((e) => e.reason === 'mining_goal_changed'));
});

test('quartz block-update cache owner survives recover and is removed on dispose', () => {
  const f = fixture(), before = f.bot.listenerCount('blockUpdate');
  const goal = quartz.createNetherQuartzGoal({ bot: f.bot });
  assert.equal(f.bot.listenerCount('blockUpdate'), before + 1);
  goal.memory.quartzRejected = new Map([['a', { until: Infinity }]]); goal.recover();
  assert.equal(goal.memory.quartzRejected.size, 1);
  f.bot.emit('blockUpdate'); assert.equal(goal.memory.quartzRejected.size, 0);
  goal.dispose(); assert.equal(f.bot.listenerCount('blockUpdate'), before);
});

test('failed actual navigation records stage, target and actual position without inventing arrival', async (t) => {
  const f = fixture(), p = new Vec3(4, 0, 0); f.put(p, 'nether_quartz_ore'); f.bot.findBlocks = () => [p];
  t.mock.method(require('../core/actions'), 'goToDig', async () => ({ ok: false, reason: 'not_arrived' }));
  const result = await skills.gatherOne(f.bot, f.ctx, { blocks: (n) => n === 'nether_quartz_ore', dropMatch: (n) => n === 'quartz',
    blacklist: createBlacklist(), selectTarget: async (candidates) => ({ ok: true, block: candidates[0] }), navigationTrace: true });
  assert.equal(result.reason, 'not_arrived');
  const row = f.events.find((e) => e.type === 'gather_navigation' && e.phase === 'result');
  assert.equal(row.stage, 'mining_stance'); assert.equal(row.target, '4,0,0'); assert.equal(row.goalFailure, 'not_arrived');
  assert.deepEqual(row.actual, { x: .5, y: 0, z: .5 }); assert.equal(row.ok, false);
  assert.equal(row.requiredRange, 4.5); assert.equal(row.distanceKind, 'eye_to_block_center');
  assert.equal(row.pathSource, 'native_replan'); assert.equal(row.preflightPathReused, false);
});

test('native raycast cannot skip unknown voxels when confirming the mining stance', async () => {
  const f = fixture(), p = new Vec3(4, 0, 0); f.put(p, 'nether_quartz_ore');
  f.bot.pathfinder.getPathFromTo = function* () { yield { result: { status: 'success', path: [new Vec3(1, 0, 0)] } }; };
  f.bot.world.raycast = () => ({ position: p });
  // Outside the route's body/margin, between its end stance and the ore.
  f.unknown.add('3,0,0'); f.unknown.add('3,1,0');
  const goal = new (require('mineflayer-pathfinder').goals.GoalLookAtBlock)(p, f.bot.world, { reach: 4 });
  assert.equal((await quartz.quartzPathPlan(f.bot, goal, { ore: f.block(p) })).ok, false);
});

test('profile or floor-cell changes during the yield reject stale origin credit', async () => {
  for (const change of ['profile', 'origin']) {
    const f = fixture(), p = new Vec3(4, 0, 0); f.put(p, 'nether_quartz_ore');
    f.bot.entity.position.x = .95;
    setImmediate(() => { if (change === 'profile') f.movements.canDig = true; else f.bot.entity.position.x = 1.05; });
    const result = await quartz.selectQuartzTarget(f.bot, f.ctx, [f.block(p)], {});
    assert.equal(result.reason, 'quartz_origin_changed');
  }
});

test('far approach failure identifies its separate navigation stage', async (t) => {
  const f = fixture(), p = new Vec3(35, 0, 0); f.put(p, 'nether_quartz_ore'); f.bot.findBlocks = () => [p];
  t.mock.method(require('../core/actions'), 'goNear', async () => ({ ok: false, reason: 'not_arrived' }));
  const result = await skills.gatherOne(f.bot, f.ctx, { blocks: (n) => n === 'nether_quartz_ore', dropMatch: () => true,
    blacklist: createBlacklist(), navigationTrace: true });
  assert.equal(result.reason, 'not_arrived');
  assert.equal(f.events.find((e) => e.type === 'gather_navigation').stage, 'far_approach');
});

test('fresh grounded witness is required after a query yields even within the same feet cell', async () => {
  const f = fixture(), p = new Vec3(4, 0, 0); f.put(p, 'nether_quartz_ore');
  setImmediate(() => { f.bot.entity.position.y += .1; f.bot.entity.onGround = false; });
  const result = await quartz.selectQuartzTarget(f.bot, f.ctx, [f.block(p)], {});
  assert.equal(result.ok, false);
});

test('world revision between batches cannot starve a seventh reachable ore behind six rejected candidates', async () => {
  const f = fixture(), state = {}, exposed = new Vec3(18, 0, 0);
  const ores = Array.from({ length: 6 }, (_, i) => { const p = new Vec3(i + 1, -2, 0); f.put(p, 'nether_quartz_ore'); return f.block(p); });
  f.put(exposed, 'nether_quartz_ore'); ores.push(f.block(exposed));
  const getter = f.bot.pathfinder.getPathFromTo;
  f.bot.pathfinder.getPathFromTo = function* (...args) {
    if (args[2].pos.y === -2) yield { result: { status: 'noPath', path: [] } };
    else yield* getter.apply(this, args);
  };
  assert.equal((await quartz.selectQuartzTarget(f.bot, f.ctx, ores, state)).reason, 'quartz_scan_pending');
  state.quartzWorldRevision = 1; state.quartzRejected.clear();
  const result = await quartz.selectQuartzTarget(f.bot, f.ctx, ores, state);
  assert.equal(result.ok, true); assert.deepEqual(result.block.position, exposed);
});

function maze() {
  const f = fixture({ radiusX: 32, radiusZ: 32 });
  for (let z = -20; z <= 20; z++) for (const y of [0, 1]) f.put(new Vec3(4, y, z), 'basalt');
  f.goal = new (require('mineflayer-pathfinder').goals.GoalBlock)(8, 0, 0);
  return f;
}

test('native maze partial computation continues the same AStar until a real safe path succeeds', async () => {
  const f = maze(), origin = f.bot.entity.position.clone();
  const result = await quartz.quartzPathPlan(f.bot, f.goal);
  assert.equal(result.ok, true, JSON.stringify({ reason: result.reason, pathStatus: result.pathStatus, queryMs: result.queryMs }));
  assert.equal(result.firstNativeStatus, 'partial'); assert.ok(result.slices > 1); assert.equal(result.contextStable, true);
  assert.equal(result.pathStatus, 'success'); assert.deepEqual(f.bot.entity.position, origin);
  assert.ok(result.path.length > 30); assert.equal(f.movements.canDig, false);
});

test('root cancellation after a native partial slice closes search without dispatching a body goal', async () => {
  const f = maze(), controller = new AbortController(); let bodyGoals = 0, closed = 0;
  const getter = f.bot.pathfinder.getPathFromTo;
  f.bot.pathfinder.getPathFromTo = function* (...args) { try { yield* getter.apply(this, args); } finally { closed++; } };
  f.bot.on('goal_updated', (goal) => { if (goal) bodyGoals++; });
  setImmediate(() => controller.abort('cancel native search'));
  await assert.rejects(quartz.quartzPathPlan(f.bot, f.goal, { signal: controller.signal }), { code: 'aborted' });
  assert.equal(bodyGoals, 0); assert.equal(closed, 1); assert.deepEqual(f.bot.entity.position, new Vec3(.5, 0, .5));
});

test('a query total deadline stays computation-unknown rather than claiming geometric noPath', async () => {
  const f = maze();
  const result = await quartz.quartzPathPlan(f.bot, f.goal, { totalMs: 1 });
  assert.equal(result.ok, false); assert.notEqual(result.pathStatus, 'noPath');
  assert.match(result.reason, /budget|deadline|timeout/);
  assert.equal(result.computationComplete, false);
});

test('a fresh native exhausted search reports true noPath separately from partial budgets', async () => {
  const f = fixture({ radiusX: 5, radiusZ: 3 });
  for (const y of [0, 1]) for (let z = -3; z <= 3; z++) f.put(new Vec3(2, y, z), 'basalt');
  const goal = new (require('mineflayer-pathfinder').goals.GoalBlock)(4, 0, 0);
  const result = await quartz.quartzPathPlan(f.bot, goal);
  assert.equal(result.ok, false); assert.equal(result.pathStatus, 'noPath'); assert.equal(result.computationComplete, true);
});

test('unfinished query cache remains inconclusive and cannot masquerade as geometric unreachable', async () => {
  const f = fixture(), p = new Vec3(4, 0, 0); f.put(p, 'nether_quartz_ore');
  f.bot.pathfinder.getPathFromTo = function* () { yield { result: { status: 'timeout', path: [new Vec3(1, 0, 0)], visitedNodes: 12 } }; };
  const result = await quartz.selectQuartzTarget(f.bot, f.ctx, [f.block(p)], {});
  assert.equal(result.reason, 'quartz_search_inconclusive'); assert.equal(result.ok, false); assert.equal(result.progress, false);
  const row = f.events.find((e) => e.type === 'quartz_target_plan');
  assert.equal(row.nativePathNodes, 1); assert.equal(row.validatedPathNodes, null); assert.equal(row.visitedNodes, 12);
  assert.equal(row.computationComplete, false);
});

test('an exhausted shared pass deadline dispatches no new native query or body movement', async () => {
  const f = fixture(), p = new Vec3(4, 0, 0); f.put(p, 'nether_quartz_ore'); let calls = 0;
  f.bot.pathfinder.getPathFromTo = function* () { calls++; yield {}; };
  const result = await quartz.selectQuartzTarget(f.bot, f.ctx, [f.block(p)], {}, Date.now() - 1);
  assert.equal(result.reason, 'quartz_scan_pending'); assert.equal(calls, 0);
  assert.deepEqual(f.bot.entity.position, new Vec3(.5, 0, .5));
});

test('repeated native preflight recomputes entity intersections without stacking the same entity cost', async () => {
  const f = fixture(); f.movements.allowEntityDetection = true;
  f.bot.entities[21] = { id: 21, name: 'cow', width: .9, height: 1.4, position: new Vec3(10.5, 0, 4.5) };
  const goal = new (require('mineflayer-pathfinder').goals.GoalBlock)(3, 0, 0);
  assert.equal((await quartz.quartzPathPlan(f.bot, goal)).ok, true);
  const first = { ...f.movements.entityIntersections };
  assert.equal((await quartz.quartzPathPlan(f.bot, goal)).ok, true);
  assert.deepEqual(f.movements.entityIntersections, first);
  assert.ok(Object.values(first).every((n) => n === 1));
});

test('an exhausted search over changed world data stays inconclusive instead of current noPath proof', async () => {
  const f = fixture({ radiusX: 5, radiusZ: 3 }); let revision = 0;
  for (const y of [0, 1]) for (let z = -3; z <= 3; z++) f.put(new Vec3(2, y, z), 'basalt');
  const goal = new (require('mineflayer-pathfinder').goals.GoalBlock)(4, 0, 0);
  setImmediate(() => { revision++; });
  const result = await quartz.quartzPathPlan(f.bot, goal, { revision: () => revision });
  assert.equal(result.ok, false); assert.equal(result.reason, 'path_world_changed'); assert.equal(result.worldChanged, true);
});

test('a finite scan round completes64 actual attempts despite3s backoff outlasting30s negative TTL', async (t) => {
  let clock = 1000000; t.mock.method(Date, 'now', () => clock);
  const f = fixture(), state = {}; let calls = 0;
  const ores = Array.from({ length: 64 }, (_, i) => { const p = new Vec3(i % 8 + 1, -2, Math.floor(i / 8) + 1); f.put(p, 'nether_quartz_ore'); return f.block(p); });
  f.bot.pathfinder.getPathFromTo = function* () { calls++; yield { result: { status: 'noPath', path: [] } }; };
  let result;
  for (let pass = 0; pass < 11; pass++) { result = await quartz.selectQuartzTarget(f.bot, f.ctx, ores, state); clock += 3000; }
  assert.equal(calls, 64); assert.equal(result.roundComplete, true); assert.equal(result.ok, false); assert.equal(result.progress, false);
  assert.equal(state.quartzRound.checked.size, 64);
  clock += 100000; const complete = await quartz.selectQuartzTarget(f.bot, f.ctx, ores, state);
  assert.equal(complete.roundComplete, true); assert.equal(calls, 64, 'completed round reserves the next pass for a fresh frontier, not another full scan');
});

test('scan round scope changes on real origin, profile or candidate set, not irrelevant world revision', async () => {
  const f = fixture(), state = {}; let calls = 0;
  const p = new Vec3(2, -2, 0); f.put(p, 'nether_quartz_ore'); const ores = [f.block(p)];
  f.bot.pathfinder.getPathFromTo = function* () { calls++; yield { result: { status: 'noPath', path: [] } }; };
  const first = await quartz.selectQuartzTarget(f.bot, f.ctx, ores, state); const firstId = first.roundId;
  state.quartzWorldRevision = 1; state.quartzRejected.clear();
  const changedWorld = await quartz.selectQuartzTarget(f.bot, f.ctx, ores, state);
  assert.equal(changedWorld.roundId, firstId); assert.equal(calls, 1); assert.equal(changedWorld.reason, 'quartz_search_inconclusive');
  f.movements.digCost += 1; await quartz.selectQuartzTarget(f.bot, f.ctx, ores, state); assert.equal(calls, 2);
  const q = new Vec3(3, -2, 0); f.put(q, 'nether_quartz_ore'); ores.push(f.block(q));
  await quartz.selectQuartzTarget(f.bot, f.ctx, ores, state); assert.equal(calls, 4);
  f.bot.entity.position.x += 1; await quartz.selectQuartzTarget(f.bot, f.ctx, ores, state); assert.equal(calls, 6);
});

test('completed round survives a spent12s pass so the next pass really reaches fresh frontier planning', async (t) => {
  let clock = 1000000; t.mock.method(Date, 'now', () => clock);
  // These candidates exceed the quartz-specific sixteen-step excavation
  // bound, so this case still exercises the existing-ground frontier branch.
  const f = fixture(), positions = Array.from({ length: 6 }, (_, i) => new Vec3(i + 1, -17, 0));
  for (const p of positions) f.put(p, 'nether_quartz_ore');
  const oreId = registry.blocksByName.nether_quartz_ore.id;
  f.bot.findBlocks = ({ matching }) => [].concat(matching).includes(oreId) ? positions : [];
  f.bot.inventory.items = () => [{ name: 'diamond_pickaxe', type: registry.itemsByName.diamond_pickaxe.id, count: 1 },
    { name: 'cooked_beef', type: registry.itemsByName.cooked_beef.id, count: 24 }];
  f.ctx.perceive = () => ({ inventory: { diamond_pickaxe: 1, cooked_beef: 24 } });
  const queryKinds = [];
  f.bot.pathfinder.getPathFromTo = function* (_m, _origin, goal) {
    queryKinds.push(goal.constructor.name); clock += 2000; yield { result: { status: 'noPath', path: [] } };
  };
  const goal = quartz.createNetherQuartzGoal({ bot: f.bot }); goal.memory.explore.heading = 0;
  try {
    const first = await goal.run(f.ctx);
    assert.equal(first.reason, 'quartz_frontier_pending'); assert.equal(goal.memory.quartzRound.complete, true);
    assert.equal(queryKinds.filter((k) => k === 'GoalLookAtBlock').length, 6);
    clock += 31000; queryKinds.length = 0;
    const second = await goal.run(f.ctx);
    assert.equal(second.ok, false); assert.equal(second.progress, false);
    assert.equal(queryKinds.includes('GoalLookAtBlock'), false, 'cache expiry cannot spend the new pass rescanning before frontier');
    assert.equal(queryKinds.includes('GoalBlock'), true, 'existing safe frontier is actually queried on the next pass');
    assert.deepEqual(f.bot.entity.position, new Vec3(.5, 0, .5));
  } finally { goal.dispose(); }
});

test('late native noPath completion cannot bypass the query total deadline', async (t) => {
  let clock = 1000000; t.mock.method(Date, 'now', () => clock);
  const f = fixture();
  f.bot.pathfinder.getPathFromTo = function* () { clock += 2001; yield { result: { status: 'noPath', path: [] } }; };
  const goal = new (require('mineflayer-pathfinder').goals.GoalBlock)(3, 0, 0);
  const result = await quartz.quartzPathPlan(f.bot, goal);
  assert.equal(result.ok, false); assert.equal(result.reason, 'path_total_deadline');
});
