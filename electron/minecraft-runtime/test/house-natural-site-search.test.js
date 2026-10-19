/* global require, module, __dirname */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8'), Block = require('prismarine-block')(registry);
const { createNaturalHouseSiteSearch, inspectNaturalSiteSearchCamp, validateNaturalSiteReservation } = require('../vendor/server/minecraft/houseNaturalSiteSearch');
const { inspectNaturalHouseSite } = require('../vendor/server/minecraft/naturalHouseSites');
const clone = x => JSON.parse(JSON.stringify(x)), key = p => `${p.x},${p.y},${p.z}`;
const block = (name, p) => Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position: new Vec3(p.x, p.y, p.z) });
const nativeFilename = path.join(__dirname, 'house-observed-dry-foot-trail.test.js'), nativeSource = fs.readFileSync(nativeFilename, 'utf8'), nativeFixture = new Module(nativeFilename, module);
nativeFixture.filename = nativeFilename; nativeFixture.paths = Module._nodeModulePaths(__dirname);
nativeFixture._compile(nativeSource.slice(0, nativeSource.indexOf('\ntest(')) + '\nmodule.exports = { fixture };\n', nativeFilename);

test('original native graph Physics reaches a new loaded node before original full house predicate and actual camp reservation succeed', { timeout: 10000 }, async t => {
  const f = nativeFixture.exports.fixture(t, { terrain: 'grass_block', offset: { x: -48, y: 68, z: 117 } }), oldRead = f.bot.blockAt;
  // Modeled residency expands at the actually walked region. Original movement
  // and Physics run unchanged; no offline geometry is supplied to the actor.
  let loadedAfterWalking = false;
  f.bot.blockAt = raw => { if (f.bot.entity.position.x >= f.anchor.x + 10) loadedAfterWalking = true; return !loadedAfterWalking ? oldRead(raw) : block(raw.y <= f.anchor.y - 1 ? 'grass_block' : 'air', raw.floored()); };
  let cp = null; const saves = [], predicateOrigins = [];
  const guard = () => {};
  const deps = { ownerIdentity: { taskId: 'MODELED-residency-original-native', generation: 1 }, getBot: () => f.bot, assertActive: guard, isOwnerCurrent: () => true, isOwnerContext: () => true,
    getCP: () => cp && { ...cp, graph: f.state() }, saveCP: value => { cp = clone(value); saves.push(clone(value)); }, getGraphCP: () => f.state(), readRemainingMs: () => 60000,
    initializeGraph: async o => { o.assertActive(); await f.graph.travelToObservedNode({ nodeId: o.nodeId, exactPosition: o.exactPosition }); o.assertActive(); },
    next: async o => { o.assertActive(); const result = await f.graph.next(); o.assertActive(); return result; },
    travelObserved: async o => { o.assertActive(); const result = await f.graph.travelToObservedNode(o); o.assertActive(); return result; },
    inspectHouseSite: options => { predicateOrigins.push(key(f.bot.entity.position.floored())); return inspectNaturalHouseSite(options); } };
  const api = createNaturalHouseSiteSearch(deps, { timeoutMs: 60000 });
  const result = await api.search({ profile: 'cottage' }).catch(e => { t.diagnostic(JSON.stringify({ reason: e.reason, pose: f.bot.entity.position, onGround: f.bot.entity.onGround, graphCurrent: f.state().current })); throw e; });
  assert.equal(result.confirmed, true); assert.ok([f.origin, f.id].includes(key(result.actual))); assert.equal(result.reservation.campNodeId, key(result.actual));
  assert.equal(f.state().order.length, 2); assert.equal(f.state().visits, 2); assert.ok(f.poses.length > 10);
  assert.ok(predicateOrigins.includes(f.origin)); assert.ok(predicateOrigins.includes(f.id));
  assert.ok(saves.filter(s => s.reservation).every(s => s.graph.current === s.reservation.campNodeId));
  assert.equal(result.camp.storageSites.length, 8); assert.equal(result.authority, 'loaded_geometry_and_actual_camp_only');
  assert.equal(validateNaturalSiteReservation({ reservation: result.reservation, profile: 'cottage', ownerIdentity: deps.ownerIdentity, bot: f.bot,
    blockAt: p => f.bot.blockAt(new Vec3(p.x, p.y, p.z)), assertActive: guard }).valid, true);
  assert.ok(f.state().nodes[f.id].dryParentTrail); assert.equal(f.state().pendingDryTrail, null);
});

// All callbacks below model confirmed actor/server movement and loaded terrain.
// They are protocol contract fixtures, never native Physics or Java evidence.
function modeled({ origin = { x: 0, y: 64, z: 0 }, terrain = 'grass_block', denyInitial = false, nextMode = 'arrive', generation = 1, prior = null } = {}) {
  let cp = prior && clone(prior), owner = true, paused = false, remaining = 60000;
  const bot = { registry, _client: {}, health: 20, food: 20, entity: { position: new Vec3(origin.x + .5, origin.y, origin.z + .5), onGround: true, isInWater: false, isInLava: false, width: .6, height: 1.8 } };
  const edits = new Map(), saves = [], calls = [], originId = key(origin), target = { ...origin, x: origin.x + 16 };
  let graph = prior?.graph || { schema: 2, kind: 'loaded_dry_waypoint_graph', anchor: origin, step: 16, radius: 384, order: [originId], nodes: { [originId]: { position: origin, parent: null } }, current: originId, resumeNode: originId, visits: 1, probes: 0 };
  const at = p => { const edit = edits.get(key(p)); return edit === null ? null : block(edit || (p.y < origin.y ? terrain : 'air'), p); };
  bot.blockAt = p => at(p.floored());
  const active = () => { if (paused) throw Object.assign(Error('paused'), { code: 'paused' }); };
  const deps = { ownerIdentity: { taskId: 'MODELED-loaded-site-search', generation }, getBot: () => bot, assertActive: active, isOwnerCurrent: () => owner, isOwnerContext: () => owner,
    getCP: () => cp && { ...cp, graph: clone(graph) }, saveCP: value => { cp = clone(value); saves.push(clone(value)); }, getGraphCP: () => graph, readRemainingMs: () => remaining,
    initializeGraph: async options => { options.assertActive(); calls.push('initialize'); graph.current = key(bot.entity.position.floored()); },
    next: async options => { options.assertActive(); calls.push('next'); graph.probes++;
      if (nextMode === 'pause') paused = true;
      if (nextMode === 'foreign') owner = false;
      if (nextMode === 'deadline') remaining = 0;
      if (nextMode === 'arrive') { bot.entity.position = new Vec3(target.x + .5, target.y, target.z + .5); graph.nodes[key(target)] = { position: target, parent: originId }; graph.order.push(key(target)); graph.current = key(target); graph.visits++; }
      if (nextMode === 'false_arrival') { graph.nodes[key(target)] = { position: target, parent: originId }; graph.order.push(key(target)); graph.current = key(target); }
      return { moved: nextMode !== 'exhausted', reason: 'loaded_reachable_frontier_exhausted' };
    }, travelObserved: async options => { options.assertActive(); calls.push('travel'); bot.entity.position = new Vec3(options.exactPosition.x + .5, options.exactPosition.y, options.exactPosition.z + .5); graph.current = options.nodeId; },
    inspectHouseSite: options => denyInitial && key(bot.entity.position.floored()) === originId ? { valid: false, reason: 'MODELED-local-forest-or-unloaded-footprint' } : inspectNaturalHouseSite(options) };
  return { bot, origin, target, deps, edits, saves, calls, getCP: () => cp, graph: () => graph, loseOwner: () => { owner = false; }, pause: () => { paused = true; }, expire: () => { remaining = 0; }, setGraph: value => { graph = value; } };
}
for (const scenario of [{ origin: { x: 731, y: -31, z: -402 }, terrain: 'dirt' }, { origin: { x: -105, y: 119, z: 283 }, terrain: 'grass_block' }]) test(`modeled original full site and actual camp use the same predicates at ${key(scenario.origin)}`, async () => {
  const f = modeled(scenario), api = createNaturalHouseSiteSearch(f.deps), result = await api.search({ profile: 'cottage' });
  assert.equal(result.confirmed, true); assert.deepEqual(result.camp.anchor, f.origin); assert.equal(f.calls.includes('next'), false);
  assert.equal(result.camp.storageSites.length, 8); assert.equal(f.graph().visits, 1); assert.equal(f.graph().order.length, 1);
});
for (const mode of ['false_arrival', 'pause', 'foreign', 'deadline', 'exhausted']) test(`modeled ${mode} callback cannot create a camp reservation or later material authority`, async () => {
  const f = modeled({ denyInitial: true, nextMode: mode }), api = createNaturalHouseSiteSearch(f.deps);
  await assert.rejects(api.search({ profile: 'cottage' }), e => ['house_site_search_graph_unconfirmed', 'paused', 'house_site_search_owner_changed', 'house_site_search_timeout', 'house_no_safe_site'].includes(e.code));
  assert.ok(f.saves.every(s => !s.reservation)); assert.equal(f.calls.filter(c => c === 'next').length, 1);
});
for (const changed of ['unloaded', 'dirt', 'magma_block']) test(`fresh material validation refuses ${changed} reserved house support`, async () => {
  const f = modeled(), result = await createNaturalHouseSiteSearch(f.deps).search({ profile: 'cottage' });
  const p = { x: result.houseAnchor.x + 1, y: result.houseAnchor.y - 1, z: result.houseAnchor.z + 1 };
  f.edits.set(key(p), changed === 'unloaded' ? null : changed);
  const proof = validateNaturalSiteReservation({ reservation: result.reservation, profile: 'cottage', ownerIdentity: f.deps.ownerIdentity, bot: f.bot, blockAt: p => f.bot.blockAt(new Vec3(p.x, p.y, p.z)) });
  assert.equal(proof.valid, false); assert.equal(f.graph().visits, 1);
});
test('same-generation re-entry keeps its original absolute TTL and finite counters', async () => {
  const f = modeled(), one = createNaturalHouseSiteSearch(f.deps), result = await one.search({ profile: 'cottage' }), before = f.getCP();
  const second = createNaturalHouseSiteSearch(f.deps), revalidated = await second.search({ profile: 'cottage' }); assert.equal(revalidated.confirmed, true);
  assert.equal(f.getCP().deadline, before.deadline); assert.equal(f.getCP().startedAt, before.startedAt); assert.equal(f.graph().visits, 1); assert.equal(f.getCP().diagnostics.advances, before.diagnostics.advances);
  assert.equal(result.reservation.ownerIdentity.taskId, f.deps.ownerIdentity.taskId);
});
test('explicit new generation resumes only from an actual registered grounded node without resetting graph counters', async () => {
  const f = modeled(), result = await createNaturalHouseSiteSearch(f.deps).search({ profile: 'cottage' });
  const prior = f.getCP(), g = modeled({ prior: { ...prior, graph: f.graph() }, generation: 2 }), api = createNaturalHouseSiteSearch(g.deps);
  // Unchecked genuine current node can be inspected again on explicit resume;
  // this fixture's initial successful reservation did not consume frontier.
  const resumed = await api.search({ profile: 'cottage' });
  assert.equal(resumed.confirmed, true); assert.equal(g.getCP().creatorGeneration, 1); assert.equal(g.getCP().budgetGeneration, 2);
  assert.equal(g.graph().visits, 1); assert.equal(g.graph().order.length, 1); assert.equal(g.graph().probes, 0); assert.equal(result.reservation.profile, resumed.reservation.profile);
});
for (const pending of ['pendingDryTrail', 'pendingWater']) test(`a saved ${pending} cannot be bypassed by another recorded camp or cleanup node`, async () => {
  const f = modeled(); f.graph()[pending] = { actual: true };
  await assert.rejects(createNaturalHouseSiteSearch(f.deps).search({ profile: 'cottage' }), e => e.code === 'house_site_search_reconciliation_required');
  assert.equal(f.calls.length, 0); assert.equal(f.saves.length, 0);
});
test('owner loss during a pure site read cannot save a positive reservation or move the actor', async () => {
  const f = modeled(), read = f.bot.blockAt; let lost = false;
  f.bot.blockAt = p => { const b = read(p); if (!lost && p.x > 1) { lost = true; f.loseOwner(); } return b; };
  await assert.rejects(createNaturalHouseSiteSearch(f.deps).search({ profile: 'cottage' }), e => e.code === 'house_site_search_owner_changed');
  assert.equal(f.calls.filter(c => c === 'next' || c === 'travel').length, 0); assert.ok(f.saves.every(s => !s.reservation));
});
test('global actual-node and pure-inspection limits remain finite without crediting an untested camp', async () => {
  const f = modeled({ denyInitial: true });
  await assert.rejects(createNaturalHouseSiteSearch(f.deps, { maxInspections: 3 }).search({ profile: 'cottage' }), e => e.code === 'house_site_search_inspection_limit');
  assert.ok(f.saves.every(s => !s.reservation)); assert.equal(f.calls.includes('next'), false);
  assert.throws(() => createNaturalHouseSiteSearch(f.deps, { maxNodes: 257 }), /cannot be enlarged/);
});
test('known short grass can be an actual registered camp anchor while the original facility AIR contract stays strict', async () => {
  const f = modeled(); f.edits.set(key(f.origin), 'short_grass');
  const graph = require('../vendor/server/minecraft/houseSurfaceGraph');
  assert.equal(graph.dryFoot(f.bot, f.origin), false); assert.equal(graph.naturalWalkingFoot(f.bot, f.origin), true);
  const result = await createNaturalHouseSiteSearch(f.deps).search({ profile: 'cottage' });
  assert.equal(result.confirmed, true); assert.equal(f.graph().current, key(f.origin)); assert.equal(result.reservation.campNodeId, key(f.origin));
  assert.equal(f.graph().visits, 1); assert.equal(f.calls.filter(c => c === 'next' || c === 'travel').length, 0);
  for (const stand of [result.camp.stations.crafting_table, result.camp.stations.furnace, ...result.camp.storageSites]) assert.equal(graph.dryFoot(f.bot, stand), true);
  const stand = result.camp.stations.crafting_table; f.edits.set(key(stand), 'short_grass');
  assert.equal(graph.dryFoot(f.bot, stand), false);
  assert.equal(validateNaturalSiteReservation({ reservation: result.reservation, profile: 'cottage', ownerIdentity: f.deps.ownerIdentity, bot: f.bot,
    blockAt: p => f.bot.blockAt(new Vec3(p.x, p.y, p.z)) }).valid, false);
});
for (const mode of ['stale_house', 'false_camp_callback']) test(`a ${mode} after registered return cannot save a selected camp`, async () => {
  const f = modeled({ denyInitial: true }), oldTravel = f.deps.travelObserved, inspect = f.deps.inspectHouseSite; let selectedHouse, travelled = false;
  f.deps.inspectHouseSite = options => { const result = inspect(options); if (result.valid) selectedHouse = options.anchor; return result; };
  f.deps.travelObserved = async options => {
    assert.ok(f.saves.every(s => !s.reservation)); travelled = true;
    if (mode === 'stale_house') { await oldTravel(options); f.edits.set(key({ x: selectedHouse.x + 1, y: selectedHouse.y - 1, z: selectedHouse.z + 1 }), null); }
    else options.assertActive();
  };
  await assert.rejects(createNaturalHouseSiteSearch(f.deps).search({ profile: 'cottage' }), e => mode === 'stale_house' ? e.code === 'house_site_search_geometry_changed' : e.code === 'house_site_search_camp_unconfirmed');
  assert.equal(travelled, true); assert.ok(f.saves.every(s => !s.reservation)); assert.equal(f.graph().order.length, 2); assert.equal(f.graph().visits, 2);
});
test('changed loaded camp support cannot reauthorize a previously selected station/storage layout', async () => {
  const f = modeled(), result = await createNaturalHouseSiteSearch(f.deps).search({ profile: 'cottage' });
  const stand = result.camp.storageSites[0]; f.edits.set(key({ ...stand, y: stand.y - 1 }), 'dirt');
  assert.equal(validateNaturalSiteReservation({ reservation: result.reservation, profile: 'cottage', ownerIdentity: f.deps.ownerIdentity, bot: f.bot,
    blockAt: p => f.bot.blockAt(new Vec3(p.x, p.y, p.z)) }).valid, false);
});
test('a foreign owner during material fresh body proof is rejected before any additional read or authority', async () => {
  const f = modeled(), result = await createNaturalHouseSiteSearch(f.deps).search({ profile: 'cottage' }); let reads = 0, live = true;
  assert.throws(() => validateNaturalSiteReservation({ reservation: result.reservation, profile: 'cottage', ownerIdentity: f.deps.ownerIdentity, bot: f.bot,
    blockAt: p => { reads++; live = false; return f.bot.blockAt(new Vec3(p.x, p.y, p.z)); }, assertActive: () => { if (!live) throw Object.assign(Error('foreign'), { code: 'foreign' }); } }), e => e.code === 'foreign');
  assert.equal(reads, 1);
});
test('the original step already expired cannot create a search checkpoint or request native motion', async () => {
  const f = modeled(); f.expire();
  await assert.rejects(createNaturalHouseSiteSearch(f.deps).search({ profile: 'cottage' }), e => e.code === 'house_site_search_timeout'); assert.equal(f.saves.length, 0); assert.equal(f.calls.length, 0);
});
test('actual graph probes already consumed at the global cap cannot produce a new site reservation', async () => {
  const f = modeled(); f.graph().probes = 8193;
  await assert.rejects(createNaturalHouseSiteSearch(f.deps).search({ profile: 'cottage' }), e => e.code === 'house_site_search_graph_unconfirmed'); assert.ok(f.saves.every(s => !s.reservation)); assert.equal(f.calls.includes('next'), false);
});
for (const leaf of ['oak_leaves', 'mangrove_leaves', 'pale_oak_leaves']) test(`the new camp role refuses ${leaf} beneath actual anchor or one remembered station while graph rule stays unchanged`, async () => {
  const f = modeled(), result = await createNaturalHouseSiteSearch(f.deps).search({ profile: 'cottage' });
  const bounds = [{ minX: 100, maxX: 110, minY: 50, maxY: 90, minZ: 100, maxZ: 110 }];
  f.edits.set(key({ ...result.camp.anchor, y: result.camp.anchor.y - 1 }), leaf);
  assert.equal(inspectNaturalSiteSearchCamp({ bot: f.bot, anchor: result.camp.anchor, camp: result.camp, constructionBounds: bounds, blockAt: p => f.bot.blockAt(new Vec3(p.x, p.y, p.z)) }).valid, false);
  assert.equal(validateNaturalSiteReservation({ reservation: result.reservation, profile: 'cottage', ownerIdentity: f.deps.ownerIdentity, bot: f.bot,
    blockAt: p => f.bot.blockAt(new Vec3(p.x, p.y, p.z)) }).valid, false);
  f.edits.delete(key({ ...result.camp.anchor, y: result.camp.anchor.y - 1 })); const stand = result.camp.stations.crafting_table;
  f.edits.set(key({ ...stand, y: stand.y - 1 }), leaf);
  assert.equal(inspectNaturalSiteSearchCamp({ bot: f.bot, anchor: result.camp.anchor, camp: result.camp, constructionBounds: bounds, blockAt: p => f.bot.blockAt(new Vec3(p.x, p.y, p.z)) }).valid, false);
});
test('registry full cube sand keeps the original dryFoot and body permission in modeled camp geometry', async () => {
  const f = modeled({ terrain: 'sand' }), result = await createNaturalHouseSiteSearch(f.deps).search({ profile: 'cottage' });
  assert.equal(result.confirmed, true); assert.equal(f.graph().visits, 1); assert.equal(result.camp.storageSites.length, 8);
});
test('a newly observed leaf canopy anchor cannot create any camp reservation or station ownership', async () => {
  const f = modeled({ nextMode: 'exhausted' }); f.edits.set(key({ ...f.origin, y: f.origin.y - 1 }), 'oak_leaves');
  await assert.rejects(createNaturalHouseSiteSearch(f.deps).search({ profile: 'cottage' }), e => e.code === 'house_no_safe_site');
  assert.ok(f.saves.every(s => !s.reservation)); assert.equal(f.graph().visits, 1); assert.equal(f.calls.filter(c => c === 'next').length, 1);
});
test('modeled natural forest trunks keep original full-site rejection while search leaves them untouched and selects valid terrain', async () => {
  const flat = modeled(), expected = await createNaturalHouseSiteSearch(flat.deps).search({ profile: 'cottage' });
  const tree = { x: expected.houseAnchor.x + 1, y: expected.houseAnchor.y + 2, z: expected.houseAnchor.z + 1 }, f = modeled(); f.edits.set(key(tree), 'oak_log');
  const first = inspectNaturalHouseSite({ anchor: expected.houseAnchor, profile: 'cottage', blockAt: p => f.bot.blockAt(new Vec3(p.x, p.y, p.z)) });
  assert.equal(first.valid, false); assert.equal(first.reason, 'foreign_site_block'); assert.equal(first.block, 'oak_log');
  const result = await createNaturalHouseSiteSearch(f.deps).search({ profile: 'cottage' });
  const inspected = inspectNaturalHouseSite({ anchor: result.houseAnchor, profile: 'cottage', blockAt: p => f.bot.blockAt(new Vec3(p.x, p.y, p.z)) });
  assert.equal(inspected.valid, true); assert.notDeepEqual(result.houseAnchor, expected.houseAnchor); assert.ok(result.diagnostics.rejections.foreign_site_block > 0);
  assert.equal(f.bot.blockAt(new Vec3(tree.x, tree.y, tree.z)).name, 'oak_log'); assert.equal(result.authority, 'loaded_geometry_and_actual_camp_only');
});
for (const replacement of [null, 'magma_block', 'lava', 'air', 'partial']) test(`the final camp support read ${replacement} cannot be mistaken for non-leaf authority`, async () => {
  const f = modeled(), result = await createNaturalHouseSiteSearch(f.deps).search({ profile: 'cottage' }), stand = result.camp.storageSites[0], floor = { ...stand, y: stand.y - 1 }; let reads = 0;
  const proof = inspectNaturalSiteSearchCamp({ bot: f.bot, anchor: result.camp.anchor, camp: result.camp,
    constructionBounds: [{ minX: 100, maxX: 110, minY: 50, maxY: 90, minZ: 100, maxZ: 110 }],
    blockAt: p => { if (key(p) === key(floor) && ++reads === 2) { if (replacement === null) return null; const b = block(replacement === 'partial' ? 'grass_block' : replacement, p); if (replacement === 'partial') b.shapes = [[0, 0, 0, 1, .5, 1]]; return b; } return f.bot.blockAt(new Vec3(p.x, p.y, p.z)); } });
  assert.equal(proof.valid, false); assert.equal(reads, 2); assert.equal(proof.camp, undefined);
});

test('a finite exploration batch with spent probes and remaining frontier continues under the same original site budgets',async()=>{
 const f=modeled({denyInitial:true}),nativeNext=f.deps.next;let batches=0;
 f.deps.inspectHouseSite=options=>f.graph().visits===1?{valid:false,reason:'MODELED-unloaded-until-actual-exploration'}:inspectNaturalHouseSite(options);
 f.deps.next=async args=>{if(batches++===0){const g=f.graph();g.probes+=8;g.frontier=[{parent:g.current,target:f.target,plannedSteps:16}];return {moved:false,reason:'finite_attempt_batch_failed'};}return nativeNext(args);};
 const result=await createNaturalHouseSiteSearch(f.deps).search({profile:'cottage'});
 assert.equal(result.confirmed,true);assert.equal(batches,2);assert.equal(f.graph().visits,2);assert.equal(result.diagnostics.advances,2);
 assert.equal(new Set(f.saves.map(s=>s.deadline)).size,1);assert.equal(f.getCP().creatorGeneration,1);
});
test('an unproductive false batch cannot loop or create a site reservation',async()=>{
 const f=modeled({denyInitial:true});let batches=0;
 f.deps.next=async()=>{batches++;const g=f.graph();g.frontier=[{parent:g.current,target:f.target,plannedSteps:16}];return {moved:false,reason:'finite_attempt_batch_failed'};};
 await assert.rejects(createNaturalHouseSiteSearch(f.deps).search({profile:'cottage'}),{code:'house_no_safe_site'});assert.equal(batches,1);assert.ok(f.saves.every(s=>!s.reservation));
});
test('deferred exploration batches consume the original finite attempt budget without adding actual nodes',async()=>{
 const f=modeled({denyInitial:true});let batches=0;
 f.deps.next=async()=>{batches++;const g=f.graph();g.probes++;g.frontier=[{parent:g.current,target:f.target,plannedSteps:16}];return {moved:false,reason:'finite_attempt_batch_failed'};};
 await assert.rejects(createNaturalHouseSiteSearch(f.deps,{maxNodes:3}).search({profile:'cottage'}),{code:'house_site_search_node_limit'});assert.equal(batches,3);assert.equal(f.graph().visits,1);assert.equal(f.graph().order.length,1);assert.ok(f.saves.every(s=>!s.reservation));
});

test('formal25 only the captured live defense may hold a wounded site scope; exploration gate and owner cancellation stay strict',()=>{
 const f=modeled();let defending=false;f.deps.isOwnedDefenseActive=()=>defending;
 const api=createNaturalHouseSiteSearch(f.deps);f.bot.health=15;
 assert.throws(()=>api.assertActive(),{code:'house_site_search_survival_limit'});
 defending=true;assert.doesNotThrow(()=>api.assertActive());assert.equal(f.calls.length,0);assert.equal(f.saves.length,0);
 defending=false;assert.throws(()=>api.assertActive(),{code:'house_site_search_survival_limit'});
 f.bot.health=16;assert.doesNotThrow(()=>api.assertActive());
 defending=true;f.bot.health=0;assert.throws(()=>api.assertActive(),{code:'house_site_search_survival_limit'});
 f.bot.health=15;f.loseOwner();assert.throws(()=>api.assertActive(),{code:'house_site_search_owner_changed'});
 assert.equal(f.calls.length,0);assert.equal(f.saves.length,0);
});

test('thin natural snow permits a prospective ten-slot camp but never credits cleared or placed stations',()=>{
 const anchor={x:0,y:64,z:0},bot={};
 const at=p=>block(p.y<64?'grass_block':p.y===64?'snow':'air',new Vec3(p.x,p.y,p.z));
 const proof=inspectNaturalSiteSearchCamp({bot,anchor,constructionBounds:[{minX:100,maxX:120,minY:60,maxY:80,minZ:100,maxZ:120}],blockAt:at});
 assert.equal(proof.valid,true);assert.equal(proof.camp.storageSites.length,8);assert.equal(proof.camp.confirmedPlaced,undefined);
 assert.equal(at(anchor).name,'snow');
 const thick=p=>p.y===64?Object.assign(Block.fromProperties(registry.blocksByName.snow.id,{layers:'2'}),{position:new Vec3(p.x,p.y,p.z)}):at(p);
 assert.equal(inspectNaturalSiteSearchCamp({bot,anchor,constructionBounds:[{minX:100,maxX:120,minY:60,maxY:80,minZ:100,maxZ:120}],blockAt:thick}).valid,false);
});
test('explicit site resumes retain lifetime reads and physical graph counters across at most six finite observation windows',async()=>{
 let prior=null,previous=0;
 for(let generation=1;generation<=6;generation++){
  const f=modeled({generation,prior});await assert.rejects(createNaturalHouseSiteSearch(f.deps,{maxReads:64}).search(),{code:'house_site_search_read_limit'});
  prior={...f.getCP(),graph:f.graph()};assert.equal(prior.readWindow.reads,64);assert.ok(prior.diagnostics.reads>previous);
  assert.equal(prior.readWindowHistory.length,generation-1);assert.equal(f.graph().visits,1);assert.equal(f.graph().probes,0);previous=prior.diagnostics.reads;
 }
 const f=modeled({generation:7,prior});await assert.rejects(createNaturalHouseSiteSearch(f.deps,{maxReads:64}).search(),{code:'house_site_search_read_limit'});
 assert.equal(f.getCP().diagnostics.reads,previous);assert.equal(f.calls.length,0);
});
