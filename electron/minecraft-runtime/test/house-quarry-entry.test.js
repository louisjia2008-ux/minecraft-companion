/* global require */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { createHouseQuarryEntry } = require('../vendor/server/minecraft/houseQuarryEntry');
const key = p => `${p.x},${p.y},${p.z}`;
const clone = v => JSON.parse(JSON.stringify(v));

// Explicit offline block/actor/observed-graph contract fixture. No live arrival
// or traversal is claimed; original block shapes/classification own safety.
function fixture(options = {}) {
  const camp = { x: 0, y: 64, z: 0 }, remote = { x: 8, y: 64, z: 0 };
  const graph = { schema: 2, kind: 'loaded_dry_waypoint_graph', anchor: { ...camp }, order: [key(camp), key(remote)],
    nodes: { [key(camp)]: { position: { ...camp }, parent: null }, [key(remote)]: { position: { ...remote }, parent: key(camp) } }, visits: 2, current: key(camp), resumeNode: key(camp) };
  const cells = new Map(); let owner = true, paused = false, reads = 0;
  const bot = { game: { minY: -64, height: 384 }, entity: { position: new Vec3(.5, 64, .5), onGround: true, isInWater: false, isInLava: false } };
  const deps = { getBot: () => bot, getObservedGraph: () => graph,
    assertActive: () => { if (paused) throw Object.assign(new Error('paused'), { code: 'task_paused' }); },
    isOwnerContext: () => owner, isExcludedEntry: p => options.excluded?.(p) ?? false,
    isProtectedDig: p => options.protectedDig?.(p) ?? false,
    blockAt: p => {
      reads++; const point = p.floored();
      const name = cells.get(key(point)) ?? (point.y >= 64 ? 'air' : point.x >= 5 || options.stableCamp ? 'stone' : 'sand');
      if (name === 'UNKNOWN') return null;
      return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position: point });
    } };
  const entry = createHouseQuarryEntry(deps, { camp, resourceGraph: 'any_log' });
  return { entry, deps, camp, remote, graph, cells, bot, setOwner: v => { owner = v; }, setPaused: v => { paused = v; }, reads: () => reads };
}
const errorCode = code => e => e.code === code;

test('sand camp remains fixed; resolver selects an actual observed stable remote node without movement or graph credit', () => {
  const f = fixture(), before = clone(f.graph), pose = f.bot.entity.position.clone();
  const selected = f.entry.choose();
  assert.deepEqual(selected.camp, f.camp); assert.deepEqual(selected.position, f.remote); assert.equal(selected.status, 'selected'); assert.equal(selected.arrival, null);
  assert.deepEqual(f.graph, before); assert.ok(f.bot.entity.position.equals(pose));
  assert.equal(selected.evidence.support, 'stone'); assert.equal(selected.evidence.initialStep.needsSupport, false);
});

test('missing graph diagnostics keep a dry grounded sand camp distinct from stable mining support', () => {
  const f = fixture(); f.deps.getObservedGraph = () => null;
  assert.throws(() => f.entry.choose(), error => error.code === 'house_quarry_entry_pending'
    && error.campInspection.reason === 'entry_no_stable_support'
    && error.campInspection.support === 'sand' && error.campInspection.actualArrivalConfirmed === true);
  assert.equal(f.bot.entity.position.y, 64);
});
test('stable camp is preferred and protected standing floor does not authorize any floor dig', () => {
  const f = fixture({ stableCamp: true, protectedDig: p => p.y === 63 });
  const selected = f.entry.choose(); assert.deepEqual(selected.position, f.camp); assert.equal(selected.evidence.initialStep.descend, false);
  assert.equal(selected.routeKind, 'same_camp'); assert.equal(selected.nodeId, null);
  assert.ok(selected.evidence.initialStep.clearance.every(p => p.y >= 64));
});
test('construction/owned entry exclusions are independent from protected quarry clearance digs', () => {
  const f = fixture({ stableCamp: true, excluded: p => p.x === 0 });
  assert.deepEqual(f.entry.choose().position, f.remote);
});
test('selection does not grant arrival; confirm reads actual actor and fresh support', () => {
  const f = fixture(), selected = f.entry.choose();
  assert.throws(() => f.entry.confirm(selected), errorCode('house_quarry_entry_arrival_unconfirmed'));
  f.bot.entity.position = new Vec3(8.5, 64, .5); // Explicit actor readback fixture.
  const confirmed = f.entry.confirm(selected); assert.equal(confirmed.status, 'arrived'); assert.equal(confirmed.arrival.confirmed, true);
  assert.equal(selected.status, 'selected'); assert.equal(selected.arrival, null);
  const restored = f.entry.revalidate(confirmed); assert.equal(restored.status, 'selected'); assert.equal(restored.arrival, null);
});
test('unknown/fullcube gravity/leaves/fluid support never becomes a quarry entry', () => {
  for (const name of ['UNKNOWN', 'sand', 'gravel', 'oak_leaves', 'water', 'oak_slab']) {
    const f = fixture(); f.cells.set('8,63,0', name);
    assert.throws(() => f.entry.choose(), errorCode('house_quarry_entry_pending'));
  }
});
test('fresh changed support invalidates saved selected or arrived entry', () => {
  const f = fixture(), selected = f.entry.choose(); f.cells.set('8,63,0', 'sand');
  assert.throws(() => f.entry.revalidate(selected), errorCode('house_quarry_entry_revalidation_failed'));
});
test('arrival rejects airborne, fractional-height, wet and wrong-cell actors', () => {
  for (const setup of [f => { f.bot.entity.onGround = false; }, f => { f.bot.entity.position.y = 64.1; }, f => { f.bot.entity.isInWater = true; }, f => { f.bot.entity.isInLava = true; }, f => { f.bot.entity.position.x = 9.5; }]) {
    const f = fixture(), selected = f.entry.choose(); f.bot.entity.position = new Vec3(8.5, 64, .5); setup(f);
    assert.throws(() => f.entry.confirm(selected), errorCode('house_quarry_entry_arrival_unconfirmed'));
  }
});
test('foreign and pause reject before block query or selected/arrival changes', () => {
  const f = fixture(), selected = f.entry.choose(), before = clone(selected), reads = f.reads();
  f.setOwner(false); assert.throws(() => f.entry.confirm(selected), errorCode('house_quarry_entry_foreign_owner')); assert.equal(f.reads(), reads);
  f.setOwner(true); f.setPaused(true); assert.throws(() => f.entry.choose(), errorCode('task_paused')); assert.equal(f.reads(), reads); assert.deepEqual(selected, before);
});
test('different client cannot reuse an entry resolver', () => {
  const f = fixture(), selected = f.entry.choose(); f.deps.getBot = () => ({ ...f.bot });
  assert.throws(() => f.entry.revalidate(selected), errorCode('house_quarry_entry_bot_changed'));
});
test('candidate only/frontier/extra unobserved nodes are rejected rather than gaining graph credit', () => {
  const f = fixture(); f.graph.nodes['9,64,0'] = { position: { x: 9, y: 64, z: 0 }, parent: key(f.camp) };
  assert.throws(() => f.entry.choose(), errorCode('house_quarry_entry_graph_unconfirmed'));
});
test('stable actual camp without a surface graph supports local bootstrap, without invented graph credit', () => {
  const f = fixture({ stableCamp: true }); f.deps.getObservedGraph = () => null;
  const before = clone(f.graph), selected = f.entry.choose();
  assert.equal(selected.routeKind, 'same_camp'); assert.equal(selected.nodeId, null); assert.equal(selected.status, 'selected'); assert.equal(selected.arrival, null);
  assert.equal(selected.evidence.source, 'fresh_native_loaded_actual_camp');
  assert.deepEqual(f.entry.confirm(selected).camp, f.camp); assert.deepEqual(f.graph, before);
  f.bot.entity.position = new Vec3(8.5, 64, .5);
  assert.throws(() => f.entry.confirm(selected), errorCode('house_quarry_entry_arrival_unconfirmed'));
});
test('unstable sand camp with no actual observed graph refuses quarry entry', () => {
  const f = fixture(); f.deps.getObservedGraph = () => null;
  assert.throws(() => f.entry.choose(), errorCode('house_quarry_entry_pending'));
});
test('stable but unoccupied camp cannot create a no-route entry from missing graph', () => {
  const f = fixture({ stableCamp: true }); f.deps.getObservedGraph = () => null; f.bot.entity.position = new Vec3(8.5, 64, .5);
  assert.throws(() => f.entry.choose(), errorCode('house_quarry_entry_pending'));
});
test('arrival rejects actual AABB touching adjacent lava or UNKNOWN while center and native flags appear dry', () => {
  for (const name of ['lava', 'UNKNOWN']) {
    const f = fixture(), selected = f.entry.choose(); f.bot.entity.position = new Vec3(8.8, 64, .5);
    f.cells.set('9,64,0', name);
    assert.throws(() => f.entry.confirm(selected), errorCode('house_quarry_entry_arrival_unconfirmed'));
  }
});
test('missing/UNKNOWN water or lava metadata cannot confirm a dry arrival or same-camp bootstrap', () => {
  for (const field of ['isInWater', 'isInLava']) for (const value of [undefined, null, 'false']) {
    const f = fixture(), selected = f.entry.choose(); f.bot.entity.position = new Vec3(8.5, 64, .5); f.bot.entity[field] = value;
    assert.throws(() => f.entry.confirm(selected), errorCode('house_quarry_entry_arrival_unconfirmed'));
    const camp = fixture({ stableCamp: true }); camp.deps.getObservedGraph = () => null; camp.bot.entity[field] = value;
    assert.throws(() => camp.entry.choose(), errorCode('house_quarry_entry_pending'));
  }
});
test('cycle, changed camp, malformed ordering and disconnected tree cannot authorize an entry', () => {
  for (const setup of [f => { f.graph.nodes[key(f.remote)].parent = key(f.remote); }, f => { f.graph.anchor.x++; }, f => { f.graph.order.push(key(f.remote)); }, f => { f.graph.nodes[key(f.remote)].parent = null; }]) {
    const f = fixture(); setup(f); assert.throws(() => f.entry.choose(), errorCode('house_quarry_entry_graph_unconfirmed'));
  }
});
test('saved entry namespace/camp/node/source/status cannot be replaced during revalidation', () => {
  for (const setup of [v => { v.resourceGraph = 'other'; }, v => { v.camp.x++; }, v => { v.nodeId = '9,64,0'; }, v => { v.position.x++; }, v => { v.status = 'complete'; }]) {
    const f = fixture(), selected = f.entry.choose(); setup(selected);
    assert.throws(() => f.entry.revalidate(selected), errorCode('house_quarry_entry_checkpoint_unconfirmed'));
  }
});
test('all cardinal initial steps reject unknown/hazard/unstable floors and protected solid clearance', () => {
  for (const variant of ['unknown', 'hazard', 'protected']) {
    const f = fixture({ protectedDig: () => variant === 'protected' });
    for (const p of [{ x: 9, z: 0 }, { x: 7, z: 0 }, { x: 8, z: 1 }, { x: 8, z: -1 }]) {
      if (variant === 'unknown') f.cells.set(`${p.x},64,${p.z}`, 'UNKNOWN');
      if (variant === 'hazard') f.cells.set(`${p.x},64,${p.z}`, 'lava');
      if (variant === 'protected') { f.cells.set(`${p.x},64,${p.z}`, 'stone'); f.cells.set(`${p.x},63,${p.z}`, 'stone'); }
    }
    assert.throws(() => f.entry.choose(), errorCode('house_quarry_entry_pending'));
  }
});
test('no-op position query cannot refresh arrival after actual actor leaves the entry', () => {
  const f = fixture(), selected = f.entry.choose(); f.bot.entity.position = new Vec3(8.5, 64, .5);
  const arrived = f.entry.confirm(selected); f.bot.entity.position = new Vec3(.5, 64, .5);
  const restored = f.entry.revalidate(arrived); assert.equal(restored.arrival, null);
  assert.throws(() => f.entry.confirm(restored), errorCode('house_quarry_entry_arrival_unconfirmed'));
});
