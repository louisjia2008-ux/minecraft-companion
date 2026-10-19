/* global require */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { createLoadedDryGraph, getSurfaceGraphProtectedPositions } = require('../vendor/server/minecraft/houseSurfaceGraph');
const copy = v => JSON.parse(JSON.stringify(v));
const point = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const key = p => `${p.x},${p.y},${p.z}`;
const anchor = { x: 0, y: 2, z: 0 };
const route = () => ({ schema: 1, kind: 'loaded_surface_swim', depth: 'surface_only', width: 4,
  surfaceY: 2, waterStart: { x: 8, z: 0 }, direction: { x: 1, z: 0 },
  from: { x: 7, y: 2, z: 0 }, to: { x: 12, y: 2, z: 0 } });

// CONTRACT ONLY. These dependencies model adapter arrivals and owner changes;
// they do not run native physics or a server. Real Block shapes validate dry
// graph endpoints. The unknown river bottom is deliberately never invented.
function fixture(options = {}) {
  let cp = null, owner = true, active = true;
  const attempts = [], crossings = [], saves = [];
  const originalProfile = {};
  const bot = Object.assign(new EventEmitter(), { registry, health: 20, food: 20,
    entity: { position: new Vec3(0.5, 2, 0.5), velocity: new Vec3(0, 0, 0), onGround: true,
      width: 0.6, height: 1.8, isInWater: false, isInLava: false },
    inventory: { items: () => [] }, entities: {},
    pathfinder: { movements: originalProfile, goal: null,
      setMovements(value) { this.movements = value; }, setGoal(value) { this.goal = value; } },
    clearControlStates() {},
  });
  bot.blockAt = raw => {
    const p = raw.floored();
    if (p.x < -12 || p.x > 15 || Math.abs(p.z) > 1) return null;
    const river = p.x >= 8 && p.x <= 11;
    if (river && p.y < 1) return null;
    const name = p.y >= 2 ? 'air' : river ? 'water' : 'stone';
    return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position: p });
  };
  const arrive = p => { bot.entity.position = new Vec3(p.x + 0.5, p.y, p.z + 0.5); bot.entity.onGround = true; };
  const deps = { getBot: () => bot,
    assertActive: () => { if (!active) throw Object.assign(new Error('Contract owner paused'), { code: 'paused' }); },
    isMovementOwner: () => owner, getCP: () => cp, saveCP: value => { cp = copy(value); saves.push(cp); },
    waterTransportKinds: ['source_water_depth1', 'source_water_surface'],
    discoverWaterRoutes: ({ origin }) => key(origin) === key(anchor) ? [{ route: options.route || route() }] : [],
    pathprobe: (_movements, goal) => ({ status: goal.x <= 7 && bot.entity.position.x < 8 && Math.abs(goal.z) <= 1 ? 'success' : 'noPath', path: [] }),
    actualnativegoto: async (goal, movements) => {
      assert.ok(goal.x <= 7, 'Generic dry callback cannot replace the typed surface crossing');
      assert.equal(movements.canDig, false); attempts.push(point(goal)); arrive(goal);
    },
    traverseWater: async value => {
      assert.equal(value.kind, 'loaded_surface_swim'); assert.equal(value.depth, 'surface_only');
      assert.deepEqual(point(bot.entity.position), value.from); crossings.push(copy(value));
      if (options.pauseEntry) { active = false; deps.assertActive(); }
      if (options.error) throw options.error;
      if (!options.noArrival) arrive(value.to);
      if (options.foreign) { owner = false; bot.pathfinder.movements = options.foreign.profile; bot.pathfinder.goal = options.foreign.goal; }
      return { confirmed: options.unconfirmed !== true };
    },
  };
  const graph = () => createLoadedDryGraph(deps, { anchor, step: 8, radius: 32, maxNodes: 16, timeoutMs: 10000,deferInconclusiveExplorationReplay:options.resumeRecovered===true });
  return { bot, deps, graph, attempts, crossings, saves, originalProfile, state: () => cp,
    replaceCP: value => { cp = copy(value); }, resume: () => { active = true; options.pauseEntry = false; } };
}

test('surface family is preserved through forward crossing and reverse before another parent frontier', async () => {
  const f = fixture(), g = f.graph();
  const first = await g.next(); assert.equal(first.moved, true); assert.deepEqual(first.actual, route().to);
  assert.equal(g.getState().nodes['12,2,0'].transport.kind, 'source_water_surface');
  assert.equal(g.getState().pendingWater, null); assert.equal(g.getState().visits, 2);
  const second = await g.next(); assert.deepEqual(second.actual, { x: -8, y: 2, z: 0 });
  assert.deepEqual(f.crossings.map(v => [v.kind, v.depth, v.from.x, v.to.x]), [
    ['loaded_surface_swim', 'surface_only', 7, 12], ['loaded_surface_swim', 'surface_only', 12, 7],
  ]);
  assert.deepEqual(f.attempts, [route().from, anchor, { x: -8, y: 2, z: 0 }]);
  assert.equal(f.bot.pathfinder.movements, f.originalProfile);
});

test('observed surface checkpoint return uses its exact adapter and actual bank before camp', async () => {
  const f = fixture(), first = f.graph(); await first.next();
  const restored = f.graph(), result = await restored.returnToAnchor();
  assert.equal(result.confirmed, true); assert.deepEqual(result.actual, anchor);
  assert.deepEqual(f.crossings.at(-1).from, route().to); assert.deepEqual(f.crossings.at(-1).to, route().from);
  assert.equal(restored.getState().visits, 2); assert.equal(restored.getState().current, key(anchor));
});

test('surface saved nodes refuse default shallow-only host and missing traversal before movement', async () => {
  const f = fixture(); await f.graph().next(); const count = f.attempts.length;
  delete f.deps.waterTransportKinds;
  assert.throws(() => f.graph(), e => e.code === 'dry_graph_transport_invalid');
  f.deps.waterTransportKinds = ['source_water_surface']; delete f.deps.traverseWater;
  assert.throws(() => f.graph(), e => e.code === 'dry_graph_transport_invalid');
  assert.equal(f.attempts.length, count); assert.equal(f.crossings.length, 1);
});

for (const mutation of [
  node => { node.transport.kind = 'source_water_depth1'; },
  node => { node.transport.kind = 'future_water_transport'; },
  node => { node.transport.route.kind = 'future_surface_route'; },
  node => { node.transport.route.depth = 1; },
]) test(`mismatched or unknown saved family fails closed (${mutation.toString()})`, async () => {
  const f = fixture(); await f.graph().next(); const cp = f.state(); mutation(cp.nodes['12,2,0']); f.replaceCP(cp);
  assert.throws(() => f.graph(), e => e.code === 'dry_graph_transport_invalid');
  assert.equal(f.crossings.length, 1); assert.equal(f.attempts.length, 1);
});

test('confirmed promise without actual arrival and actual arrival without confirmation never credit a surface node', async () => {
  for (const options of [{ noArrival: true }, { unconfirmed: true }]) {
    const f = fixture(options), g = f.graph();
    await assert.rejects(g.next(), e => e.code === 'dry_graph_transport_unconfirmed');
    assert.equal(g.getState().visits, 1); assert.deepEqual(g.getState().order, [key(anchor)]);
    assert.ok(g.getState().pendingWater); assert.equal(g.getState().nodes['12,2,0'], undefined);
  }
});

test('paused surface entry protects water tops and stable banks but no unobserved bottom; resume uses surface again', async () => {
  const f = fixture({ pauseEntry: true }), g = f.graph();
  await assert.rejects(g.next(), e => e.code === 'paused'); const cp = g.getState();
  assert.equal(cp.visits, 1); assert.deepEqual(cp.order, [key(anchor)]); assert.deepEqual(point(f.bot.entity.position), route().from);
  const positions = new Set(getSurfaceGraphProtectedPositions(cp).map(key));
  for (let x = 8; x <= 11; x++) for (let z = -1; z <= 1; z++) {
    assert.equal(positions.has(`${x},1,${z}`), true);
    for (let y = 0; y >= -3; y--) assert.equal(positions.has(`${x},${y},${z}`), false, 'Unknown bottom is not an observed route support');
  }
  for (const x of [7, 12]) for (let y = 1; y >= -2; y--) assert.equal(positions.has(`${x},${y},0`), true);
  f.resume(); const result = await f.graph().next(); assert.equal(result.moved, true);
  assert.equal(f.state().pendingWater, null); assert.equal(f.crossings.at(-1).kind, 'loaded_surface_swim');
});

test('foreign actor after modeled landing preserves its profile/goal and cannot credit a surface node', async () => {
  const foreign = { profile: { foreign: true }, goal: { foreign: true } }, f = fixture({ foreign }), g = f.graph();
  await assert.rejects(g.next(), e => e.code === 'dry_graph_movement_preempted');
  assert.equal(f.bot.pathfinder.movements, foreign.profile); assert.equal(f.bot.pathfinder.goal, foreign.goal);
  assert.equal(g.getState().visits, 1); assert.equal(g.getState().nodes['12,2,0'], undefined);
});

test('native surface error identity is preserved and protected topwater rejects before an adapter call', async () => {
  const error = Object.assign(new Error('Actual adapter refusal'), { code: 'house_surface_swim_timeout' });
  const f = fixture({ error }); await assert.rejects(f.graph().next(), e => e === error);
  assert.equal(f.state().visits, 1);
  const blocked = fixture(); await assert.rejects(blocked.graph().next({ excludeBounds: [
    { minX: 9, maxX: 9, minY: 1, maxY: 1, minZ: -1, maxZ: 1 },
  ] }), e => e.code === 'dry_graph_transport_invalid');
  assert.deepEqual(blocked.attempts, []); assert.deepEqual(blocked.crossings, []);
});

for(const mode of ['confirmed','holding','foreign','unconfirmed'])test(`failed surface crossing dry-bank recovery handoff ${mode}`,async()=>{
 const error=Object.assign(Error('native no actual progress'),{code:'house_surface_surface_swim_no_progress',recoveredToDryBank:mode!=='unconfirmed',holding:mode==='holding',houseWaterForeignActor:mode==='foreign'});
 const f=fixture({error,resumeRecovered:true}),g=f.graph();
 if(mode!=='confirmed'){await assert.rejects(g.next(),e=>e===error);assert.ok(g.getState().pendingWater);return;}
 const r=await g.next();assert.equal(r.moved,true);assert.deepEqual(r.actual,{x:-8,y:2,z:0});
 assert.equal(g.getState().pendingWater,null);assert.equal(g.getState().nodes['12,2,0'],undefined);
 assert.equal(f.crossings.length,1);assert.equal(g.getState().visits,2);
 assert.ok(g.getState().blockedEdges.some(e=>e.reason==='surface_crossing_recovered_to_original_bank'&&e.oldTargetReached===false));
});
