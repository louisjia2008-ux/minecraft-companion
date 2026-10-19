/* global require, setTimeout, clearTimeout, setInterval, clearInterval */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { Physics, PlayerState } = require('prismarine-physics');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { CancellationToken } = require('../vendor/server/minecraft/agentControl');
const { createLoadedDryGraph, dryFoot, hasGroundedBodySupport, getSurfaceGraphProtectedPositions } = require('../vendor/server/minecraft/houseSurfaceGraph');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => JSON.parse(JSON.stringify(value));
const point = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const key = p => `${p.x},${p.y},${p.z}`;
const anchor = { x: 0, y: 2, z: 0 };
const waterRoute = () => ({ schema: 1, kind: 'loaded_source_water_wade', depth: 1, width: 4,
  surfaceY: 2, from: { x: 7, y: 2, z: 0 }, to: { x: 12, y: 2, z: 0 },
  waterStart: { x: 8, z: 0 }, direction: { x: 1, z: 0 } });

// OFFLINE actual installed pathfinder + vanilla Physics/PlayerState. Only the
// initial entity position/velocity is configured; all later changes come from
// simulatePlayer(...).apply(bot). The voxel fixture remains immutable and no
// callback teleports, assigns a goal position or fabricates a positive arrival.
function fixture(t, options = {}) {
  const token = new CancellationToken(), samples = [], attempts = [], crossings = [], checkpoints = [];
  let checkpoint = null, owner = true, discovery = true, waterBehavior = options.waterBehavior;
  const controls = Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(name => [name, false]));
  const bot = Object.assign(new EventEmitter(), { registry, version: '1.21.8', health: 20, food: 20, oxygenLevel: 20,
    username: 'WaterGraphUnit', game: { dimension: 'overworld', minY: -64, height: 384, gameMode: 'survival' },
    entities: {}, players: {}, player: { ping: 1 }, inventory: { slots: Array(46).fill(null), items: () => [] },
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, controlState: controls,
    _client: { state: 'play', socket: { writable: true, destroyed: false } },
    entity: { position: options.initialPosition?.clone()||new Vec3(0.5, 2, 0.5), velocity: new Vec3(0, 0, 0), onGround: true,
      yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8, width: 0.6, effects: {}, attributes: {},
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false,
      isCollidedVertically: true, elytraFlying: false },
  });
  bot.blockAt = raw => {
    const p = raw.floored();
    if (p.x < -12 || p.x > 15 || Math.abs(p.z) > 1 || p.y < -64 || p.y > 100) return null;
    const name = p.y < 1 ? 'stone' : p.y === 1 ? p.x >= 8 && p.x <= 11 ? 'water' : 'stone' : 'air';
    return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position: p });
  };
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; };
  bot.setControlState = (name, value) => { controls[name] = value; };
  bot.clearControlStates = () => { for (const name of Object.keys(controls)) controls[name] = false; };
  bot.stopDigging = () => {}; bot.deactivateItem = () => {};
  bot.physics = Physics(registry, { getBlock: bot.blockAt }); pathfinder(bot);
  const nativeGoto = bot.pathfinder.goto.bind(bot.pathfinder);
  bot.pathfinder.goto = goal => { attempts.push({ kind: 'direct', target: point(goal) }); return nativeGoto(goal); };
  const timer = setInterval(() => {
    bot.physics.simulatePlayer(new PlayerState(bot, controls), { getBlock: bot.blockAt }).apply(bot);
    samples.push({ position: bot.entity.position.clone(), onGround: bot.entity.onGround, water: bot.entity.isInWater });
    bot.emit('physicsTick');
  }, 5);
  const active = () => token.throwIfRequested();
  async function nativeCross(route) {
    active(); assert.deepEqual(point(bot.entity.position), route.from);
    assert.equal(hasGroundedBodySupport(bot), true);
    // Exact static 3wide source-water, loaded bottom and headroom. Side cells
    // outside this strip are UNKNOWN, so native planning cannot go around it.
    for (let i = 0; i < route.width; i++) for (let lateral = -1; lateral <= 1; lateral++) {
      const p = new Vec3(route.waterStart.x + i, route.surfaceY - 1, lateral);
      assert.equal(bot.blockAt(p).name, 'water'); assert.equal(Number(bot.blockAt(p).getProperties().level), 0);
      assert.equal(bot.blockAt(p.offset(0, -1, 0)).name, 'stone');
      for (let h = 1; h <= 4; h++) assert.equal(bot.blockAt(p.offset(0, h, 0)).name, 'air');
    }
    const previous = bot.pathfinder.movements, movement = new Movements(bot);
    movement.canDig = false; movement.scafoldingBlocks = []; movement.allowParkour = false;
    movement.allow1by1towers = false; movement.allowSprinting = false; movement.allowFreeMotion = false;
    movement.maxDropDown = 2; movement.infiniteLiquidDropdownDistance = false; movement.getMoveDiagonal = () => {};
    movement.exclusionAreasStep.push(block => block?.position?.z === 0 && block.position.x >= 7 && block.position.x <= 12 ? 0 : Infinity);
    bot.pathfinder.setMovements(movement);
    const record = { from: clone(route.from), to: clone(route.to), startSample: samples.length }; crossings.push(record);
    let deadline, originalFailure = null;
    const inspect = () => {
      if (waterBehavior === 'failWet' && bot.entity.isInWater && bot.entity.position.x >= 9) {
        originalFailure = options.originalFailure || Object.assign(new Error('Native shallow transport interrupted'), { code: 'water_timeout' });
        if (owner && bot.pathfinder.movements === movement) { bot.pathfinder.setGoal(null); bot.clearControlStates(); }
      }
    };
    bot.on('physicsTick', inspect);
    try {
      await Promise.race([nativeGoto(new goals.GoalBlock(route.to.x, route.to.y, route.to.z)), new Promise((_resolve, reject) => {
        deadline = setTimeout(() => { if (owner && bot.pathfinder.movements === movement) bot.pathfinder.setGoal(null); reject(new Error('Native crossing fixture timed out')); }, 4000);
      })]);
      for (let n = 0; n < 100 && !hasGroundedBodySupport(bot); n++) { active(); await sleep(5); }
      active(); assert.equal(dryFoot(bot, route.to), true); assert.equal(hasGroundedBodySupport(bot), true);
      assert.deepEqual(point(bot.entity.position), route.to);
      record.actual = point(bot.entity.position); record.finishSample = samples.length;
      if(waterBehavior==='pauseAfterFarBankDetour'){
        bot.pathfinder.setMovements(previous);await nativeGoto(new goals.GoalBlock(14,2,0));token.pause();active();
      }
      if (waterBehavior === 'foreignAfterLanding') {
        owner = false; const replacement = new Movements(bot); replacement.canDig = false;
        record.foreignMovements = replacement; record.foreignGoal = new goals.GoalBlock(14, 2, 0);
        bot.pathfinder.setMovements(replacement); bot.pathfinder.setGoal(record.foreignGoal);
      }
      return { confirmed: waterBehavior !== 'unconfirmed', actual: point(bot.entity.position) };
    } catch (error) { throw originalFailure || error; }
    finally {
      clearTimeout(deadline); bot.removeListener('physicsTick', inspect);
      if (owner && bot.pathfinder.movements === movement) bot.pathfinder.setMovements(previous);
    }
  }
  const deps = { getBot: () => bot, assertActive: active, isMovementOwner: () => owner,
    getCP: () => checkpoint, saveCP: value => { checkpoint = value; checkpoints.push(clone(value)); },
    discoverWaterRoutes: ({ origin }) => discovery && key(origin) === key(anchor) ? [{ route: options.route || waterRoute() }] : [],
    traverseWater: async route => {
      if (waterBehavior === 'pauseAtEntry') { token.pause(); active(); }
      return nativeCross(route);
    },
    actualnativegoto: async (goal, movements) => {
      assert.equal(movements.canDig, false); assert.equal(movements.blocksToAvoid.has(registry.blocksByName.water.id), true);
      bot.pathfinder.setMovements(movements); attempts.push({ kind: 'dry', target: point(goal), at: point(bot.entity.position) });
      assert.ok(goal.x <= 7&&bot.entity.position.x<8||goal.x>=12&&bot.entity.position.x>=12,
        'Generic dry goto must stay on its actual bank and never cross the water edge');
      const result = await nativeGoto(goal);
      if (options.foreignAfterDry && goal.x === 7) {
        owner = false; const replacement = new Movements(bot); replacement.canDig = false;
        options.foreignAfterDry.movements = replacement; options.foreignAfterDry.goal = new goals.GoalBlock(3, 2, 0);
        bot.pathfinder.setMovements(replacement); bot.pathfinder.setGoal(options.foreignAfterDry.goal);
      }
      return result;
    },
  };
  const graph = () => createLoadedDryGraph(deps, { anchor, step: 8, radius: 32, maxNodes: 16, timeoutMs: 20000, legTimeoutMs: 5000 });
  t.after(() => { clearInterval(timer); bot.pathfinder.setGoal(null); bot.clearControlStates(); });
  return { bot, deps, graph, samples, attempts, crossings, checkpoints, state: () => checkpoint,
    resume: () => token.resume(), pause: () => token.pause(), behavior: value => { waterBehavior = value; },
    disableDiscovery: () => { discovery = false; } };
}

test('real native water edge approaches its bank, crosses, then reverses before returning to a different parent frontier', { timeout: 12000 }, async t => {
  const f = fixture(t), graph = f.graph(); const first = await graph.next();
  assert.equal(first.moved, true); assert.deepEqual(first.actual, { x: 12, y: 2, z: 0 });
  assert.deepEqual(first.via, [anchor, first.actual]); assert.equal(graph.getState().visits, 2);
  assert.equal(graph.getState().pendingWater, null); assert.equal(graph.getState().nodes['12,2,0'].transport.kind, 'source_water_depth1');
  assert.ok(f.samples.some(p => p.water), 'Actual unmodified Physics entered the real source-water voxel');
  assert.deepEqual(f.attempts.filter(a => a.kind === 'dry').map(a => a.target), [{ x: 7, y: 2, z: 0 }]);
  const second = await graph.next(); assert.equal(second.moved, true); assert.deepEqual(second.actual, { x: -8, y: 2, z: 0 });
  assert.deepEqual(f.crossings.map(c => [c.from.x, c.to.x]), [[7, 12], [12, 7]]);
  assert.deepEqual(f.attempts.filter(a => a.kind === 'dry').map(a => a.target), [{ x: 7, y: 2, z: 0 }, anchor, { x: -8, y: 2, z: 0 }]);
  assert.equal(f.bot.entity.onGround, true); assert.equal(f.bot.entity.isInWater, false); assert.equal(graph.getState().visits, 3);
});
test('a currently threatened outbound water edge yields to dry exploration and remains available after the threat clears',{timeout:12000},async t=>{
 const f=fixture(t);let threatened=true;f.deps.isWaterRouteThreatened=()=>threatened;
 const graph=f.graph(),first=await graph.next();assert.equal(first.moved,true);assert.equal(first.actual.x,-8);
 assert.equal(f.crossings.length,0);assert.equal(graph.getState().pendingWater,null);assert.equal(graph.getState().nodes['12,2,0'],undefined);
 threatened=false;const second=await graph.next();assert.deepEqual(second.actual,{x:12,y:2,z:0});
 assert.equal(f.crossings.length,1);assert.equal(f.bot.blockAt(new Vec3(9,1,0)).name,'water');
});

test('saved water nodes cannot resume without their native discovery and traversal adapter', { timeout: 8000 }, async t => {
  const f = fixture(t); await f.graph().next(); const before = f.attempts.length;
  for (const name of ['discoverWaterRoutes', 'traverseWater']) {
    const saved = f.deps[name]; delete f.deps[name]; assert.throws(() => f.graph(), e => e.code === 'dry_graph_transport_invalid'); f.deps[name] = saved;
  }
  assert.equal(f.attempts.length, before); assert.equal(f.state().visits, 2);
});

test('malformed and construction-protected water descriptors never start a crossing', { timeout: 8000 }, async t => {
  const f = fixture(t, { route: { ...waterRoute(), width: 13 } });
  await assert.rejects(f.graph().next(), e => e.code === 'dry_graph_transport_invalid');
  assert.equal(f.crossings.length, 0); assert.equal(f.attempts.length, 0); assert.equal(f.state().visits, 1);
  const g = fixture(t); const graph = g.graph();
  await assert.rejects(graph.next({ excludeBounds: [{ minX: 9, maxX: 9, minY: 0, maxY: 5, minZ: 0, maxZ: 0 }] }), e => e.code === 'dry_graph_transport_invalid');
  assert.equal(g.crossings.length, 0); assert.equal(g.attempts.length, 0); assert.equal(g.state().visits, 1);
});

test('an actual crossing with no adapter confirmation cannot be credited as a graph node', { timeout: 8000 }, async t => {
  const f = fixture(t, { waterBehavior: 'unconfirmed' }), graph = f.graph();
  await assert.rejects(graph.next(), e => e.code === 'dry_graph_transport_unconfirmed');
  assert.deepEqual(point(f.bot.entity.position), { x: 12, y: 2, z: 0 }); assert.equal(hasGroundedBodySupport(f.bot), true);
  assert.equal(graph.getState().visits, 1); assert.deepEqual(graph.getState().order, ['0,2,0']);
  assert.equal(graph.getState().current, '0,2,0'); assert.ok(graph.getState().pendingWater);
});

test('foreign owner after actual landing prevents node credit and preserves its replacement profile and goal', { timeout: 8000 }, async t => {
  const f = fixture(t, { waterBehavior: 'foreignAfterLanding' }), graph = f.graph();
  await assert.rejects(graph.next(), e => e.code === 'dry_graph_movement_preempted');
  const crossing = f.crossings[0]; assert.equal(f.bot.pathfinder.movements, crossing.foreignMovements); assert.equal(f.bot.pathfinder.goal, crossing.foreignGoal);
  assert.equal(graph.getState().visits, 1); assert.equal(graph.getState().nodes['12,2,0'], undefined);
});

test('original native transport failure is preserved and an actual wet interrupted checkpoint cannot use dry resume', { timeout: 8000 }, async t => {
  const original = Object.assign(new Error('Recorded native water timeout'), { code: 'water_timeout' });
  const f = fixture(t, { waterBehavior: 'failWet', originalFailure: original }), graph = f.graph();
  await assert.rejects(graph.next(), e => e === original);
  assert.ok(f.samples.some(s => s.water)); assert.equal(f.bot.entity.isInWater, true); assert.equal(graph.getState().visits, 1);
  const attempts = f.attempts.length; await assert.rejects(f.graph().next(), e => e.code === 'dry_graph_transport_resume_unsafe');
  assert.equal(f.attempts.length, attempts); assert.equal(f.state().visits, 1);
});

test('pause at the actual entry bank replays the dry parent and retains the original unfinished water edge', { timeout: 12000 }, async t => {
  const f = fixture(t, { waterBehavior: 'pauseAtEntry' });
  await assert.rejects(f.graph().next(), e => e.code === 'paused');
  assert.deepEqual(point(f.bot.entity.position), { x: 7, y: 2, z: 0 }); assert.equal(f.state().current, '0,2,0');
  assert.equal(f.state().pendingWater.originNode, '0,2,0'); assert.equal(f.state().visits, 1);
  f.resume(); f.behavior(null);
  const resumed = f.graph(); const result = await resumed.next();
  assert.deepEqual(result.actual, { x: 12, y: 2, z: 0 }); assert.equal(result.visits, 2); assert.equal(resumed.getState().pendingWater, null);
  assert.deepEqual(f.attempts.filter(a => a.kind === 'dry').map(a => a.target), [{ x: 7, y: 2, z: 0 }, anchor, { x: 7, y: 2, z: 0 }]);
});
test('a pending forward transport saved in node position form resumes without inventing arrival', { timeout: 12000 }, async t => {
  const f=fixture(t,{waterBehavior:'pauseAtEntry'});
  await assert.rejects(f.graph().next(),e=>e.code==='paused');
  const edge=f.state().pendingWater.edge;edge.position=clone(edge.target);delete edge.target;
  assert.equal(f.state().nodes['12,2,0'],undefined);assert.equal(f.state().visits,1);
  f.resume();f.behavior(null);const graph=f.graph(),result=await graph.next();
  assert.deepEqual(result.actual,{x:12,y:2,z:0});assert.equal(graph.getState().pendingWater,null);
  assert.equal(hasGroundedBodySupport(f.bot),true);assert.equal(graph.getState().visits,2);
});
test('forward transport interrupted beyond its far bank physically rejoins that bank before typed rewind',{timeout:15000},async t=>{
 const f=fixture(t,{waterBehavior:'pauseAfterFarBankDetour'});
 await assert.rejects(f.graph().next(),e=>e.code==='paused');
 assert.deepEqual(point(f.bot.entity.position),{x:14,y:2,z:0});assert.equal(f.state().visits,1);
 f.resume();f.behavior(null);const graph=f.graph(),result=await graph.next();
 assert.deepEqual(result.actual,{x:12,y:2,z:0});assert.equal(graph.getState().pendingWater,null);
 assert.ok(f.attempts.some(a=>a.kind==='dry'&&a.target.x===12));
 assert.deepEqual(f.crossings.map(c=>[c.from.x,c.to.x]),[[7,12],[12,7],[7,12]]);
});

test('owner replacement as the native dry approach settles cannot start water transport or restore the old profile', { timeout: 8000 }, async t => {
  const foreign = {}, f = fixture(t, { foreignAfterDry: foreign }), graph = f.graph();
  await assert.rejects(graph.next(), e => e.code === 'dry_graph_movement_preempted');
  assert.equal(f.crossings.length, 0); assert.equal(graph.getState().visits, 1);
  assert.equal(f.bot.pathfinder.movements, foreign.movements); assert.equal(f.bot.pathfinder.goal, foreign.goal);
});

test('a real pause partway through the dry approach resumes from its actual uncredited position', { timeout: 12000 }, async t => {
  const f = fixture(t);
  const pause = () => {
    if (f.bot.entity.position.x >= 2) { f.bot.removeListener('physicsTick', pause); f.pause(); }
  };
  f.bot.on('physicsTick', pause);
  await assert.rejects(f.graph().next(), e => e.code === 'paused');
  const actual = point(f.bot.entity.position); assert.ok(actual.x > 0 && actual.x < 7); assert.equal(actual.y, 2);
  assert.equal(hasGroundedBodySupport(f.bot), true); assert.equal(f.state().current, '0,2,0'); assert.equal(f.state().visits, 1);
  f.resume(); const resumed = f.graph(), result = await resumed.next();
  assert.deepEqual(result.actual, { x: 12, y: 2, z: 0 }); assert.equal(resumed.getState().visits, 2);
  assert.deepEqual(f.attempts.filter(a => a.kind === 'dry').map(a => a.target), [{ x: 7, y: 2, z: 0 }, anchor, { x: 7, y: 2, z: 0 }]);
});

test('pause after reverse water landing retraces its bank and re-crosses through transport instead of a dry goto across water', { timeout: 15000 }, async t => {
  const f = fixture(t), graph = f.graph(); await graph.next();
  const pause = () => {
    if (f.crossings.length === 2 && f.bot.pathfinder.goal?.x === 0 && f.bot.entity.position.x < 5) {
      f.bot.removeListener('physicsTick', pause); f.pause();
    }
  };
  f.bot.on('physicsTick', pause);
  await assert.rejects(graph.next(), e => e.code === 'paused');
  assert.equal(f.state().pendingWater.reverse, true); assert.equal(f.state().pendingWater.originNode, '12,2,0');
  assert.equal(f.state().current, '12,2,0'); assert.equal(f.state().visits, 2);
  assert.ok(f.bot.entity.position.x > 0 && f.bot.entity.position.x < 5); assert.equal(hasGroundedBodySupport(f.bot), true);
  f.resume(); const resumed = f.graph(), result = await resumed.next();
  assert.deepEqual(result.actual, { x: -8, y: 2, z: 0 }); assert.equal(resumed.getState().visits, 3);
  assert.deepEqual(f.crossings.map(c => [c.from.x, c.to.x]), [[7, 12], [12, 7], [7, 12], [12, 7]]);
  assert.equal(f.attempts.filter(a => a.kind === 'dry').some(a => a.target.x === 12), false);
  assert.equal(resumed.getState().pendingWater, null);
});

test('explicit fixed-camp return replays the saved native transport and protects observed dry supports and river beds', { timeout: 10000 }, async t => {
  const f = fixture(t), graph = f.graph(); await graph.next();
  const child = graph.getState().nodes['12,2,0'];
  assert.ok(child.supportPositions.some(p => key(p) === '3,1,0'), 'Native dry approach support was observed between graph nodes');
  const protectedPositions = getSurfaceGraphProtectedPositions(graph.getState()), keys = new Set(protectedPositions.map(key));
  for (const position of ['0,1,0', '3,1,0', '7,1,0', '7,-2,0', '12,1,0', '8,0,0', '11,0,1']) assert.ok(keys.has(position), position);
  assert.equal(keys.size, protectedPositions.length);
  const result = await graph.returnToAnchor();
  assert.equal(result.confirmed, true); assert.deepEqual(result.actual, anchor); assert.deepEqual(point(f.bot.entity.position), anchor);
  assert.equal(hasGroundedBodySupport(f.bot), true); assert.equal(graph.getState().current, '0,2,0');
  assert.equal(graph.getState().visits, 2); assert.equal(graph.getState().pendingWater, null);
  assert.deepEqual(f.crossings.map(c => [c.from.x, c.to.x]), [[7, 12], [12, 7]]);
  assert.deepEqual(f.attempts.filter(a => a.kind === 'dry').map(a => a.target), [{ x: 7, y: 2, z: 0 }, anchor]);
  assert.equal(f.bot.blockAt(new Vec3(9, 1, 0)).name, 'water');
});

test('saved native support facts require bounded integer positions before any checkpoint replay', { timeout: 8000 }, async t => {
  const f = fixture(t); await f.graph().next(); const child = f.state().nodes['12,2,0'], original = child.supportPositions;
  for (const positions of [[{ x: 1.5, y: 1, z: 0 }], [{ x: 1, y: 1, z: NaN }], Array(2049).fill({ x: 1, y: 1, z: 0 })]) {
    child.supportPositions = positions;
    assert.throws(() => f.graph(), error => error.code === 'dry_graph_checkpoint_changed');
  }
  child.supportPositions = original; assert.ok(f.graph());
});

test('an actual paused entry reserves pending river banks and beds without crediting an unvisited child', { timeout: 8000 }, async t => {
  const f = fixture(t, { waterBehavior: 'pauseAtEntry' }), graph = f.graph();
  await assert.rejects(graph.next(), error => error.code === 'paused');
  assert.deepEqual(point(f.bot.entity.position), { x: 7, y: 2, z: 0 });
  assert.equal(hasGroundedBodySupport(f.bot), true); assert.equal(f.crossings.length, 0);
  assert.equal(f.samples.some(sample => sample.water), false, 'Original physics has not entered or crossed water');
  const state = graph.getState(), before = clone(state);
  assert.equal(state.visits, 1); assert.equal(state.current, '0,2,0'); assert.deepEqual(state.order, ['0,2,0']);
  assert.equal(state.nodes['12,2,0'], undefined); assert.equal(state.pendingWater.originNode, '0,2,0');
  const protectedPositions = getSurfaceGraphProtectedPositions(state), keys = new Set(protectedPositions.map(key));
  for (const position of ['0,1,0', '7,1,0', '7,-2,0', '12,1,0', '12,-2,0', '8,0,-1', '9,0,0', '11,-3,1']) {
    assert.ok(keys.has(position), `Captured pending support ${position} must survive recursive raw acquisition`);
  }
  assert.equal(keys.size, protectedPositions.length); assert.deepEqual(state, before, 'Protection query is read-only');
  assert.deepEqual(graph.getState(), before, 'Protecting the pending route never creates a node or visit');
});

for(const mode of ['owned','pause','foreign'])test(`world121 outbound bank approach defense relocation: ${mode}`,{timeout:8000},async t=>{
 const f=fixture(t);let calls=0;
 f.deps.actualnativegoto=async(goal,movements,budget)=>{
  f.bot.pathfinder.setMovements(movements);
  await f.bot.pathfinder.goto(new goals.GoalBlock(3,2,0));
  const actual=point(f.bot.entity.position);
  if(mode==='pause')f.pause();
  if(mode==='foreign')f.deps.isMovementOwner=()=>false;
  calls++;
  throw Object.assign(Error('modeled owned defense result after actual native motion'),{code:'house_site_defense_relocated',siteDefenseRelocation:{
   kind:'actual_owned_site_defense_relocation',actual,from:{x:.5,y:2,z:.5},originalGoal:{x:goal.x,y:goal.y,z:goal.z},
   originalDeadline:budget.deadline,observedAt:Date.now(),arrivalConfirmed:true,oldTargetReached:false}});
 };
 const graph=createLoadedDryGraph(f.deps,{anchor,step:8,radius:32,maxNodes:16,timeoutMs:20000,legTimeoutMs:5000,deferInconclusiveExplorationReplay:true});
 if(mode!=='owned'){await assert.rejects(graph.next());assert.equal(graph.getState().visits,1);}
 else {const result=await graph.next();assert.equal(result.moved,true);assert.equal(graph.getState().pendingWater,null);assert.equal(graph.getState().visits,2);assert.equal(graph.getState().nodes[graph.getState().current].survivalRelocation.oldEdgeTraversalCredit,false);assert.equal(f.crossings.length,0);assert.equal(f.samples.some(s=>s.water),false);}
 assert.equal(calls,1);
});

for(const mode of ['confirmed','unconfirmed','pause'])test(`world121 saved completed reverse crossing dry parent reconnect: ${mode}`,{timeout:8000},async t=>{
 const f=fixture(t,{initialPosition:new Vec3(-10.5,2,.5)});
 const child={position:{x:12,y:2,z:0},parent:'0,2,0',expanded:true,transport:{kind:'source_water_depth1',route:waterRoute()}};
 let cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:32,step:8,nodes:{'0,2,0':{position:anchor,parent:null,expanded:true},'12,2,0':child},
  order:['0,2,0','12,2,0'],frontier:[],blockedEdges:[],current:'12,2,0',resumeNode:'12,2,0',visits:2,probes:0,
  pendingWater:{edge:child,reverse:true,originNode:'12,2,0',bankArrival:{position:{x:7,y:2,z:0},nativeTraversalConfirmed:mode!=='unconfirmed',confirmedAt:Date.now()}}};
 f.deps.getCP=()=>cp;f.deps.saveCP=value=>{cp=value;};
 const graph=createLoadedDryGraph(f.deps,{anchor,step:8,radius:32,maxNodes:16,timeoutMs:20000,legTimeoutMs:5000,deferInconclusiveExplorationReplay:true});
 if(mode==='pause')f.pause();
 if(mode==='confirmed'){const result=await graph.returnToAnchor({returnToCurrentOnly:true});assert.equal(result.confirmed,true);assert.equal(cp.current,'0,2,0');assert.equal(cp.pendingWater,null);assert.equal(cp.visits,2);assert.equal(f.crossings.length,0);assert.ok(f.samples.length>10);}
 else {await assert.rejects(graph.returnToAnchor({returnToCurrentOnly:true}));assert.equal(cp.current,'12,2,0');assert.ok(cp.pendingWater);}
});
