'use strict';
// Site geometry and genuinely arrived camp only. No material or building action.
const { createHash } = require('node:crypto');
const { Vec3 } = require('vec3');
const { createFurnishedHouseBlueprint } = require('./furnishedHouseBlueprints');
const { inspectNaturalHouseSite } = require('./naturalHouseSites');
const { dryFoot, naturalWalkingFoot, hasGroundedBodySupport } = require('./houseSurfaceGraph');
const integer = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]));
const point = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const key = p => `${p.x},${p.y},${p.z}`;
const same = (a, b) => integer(a) && integer(b) && key(a) === key(b);
const copy = x => JSON.parse(JSON.stringify(x));
const fail = (code, message, facts = {}) => Object.assign(new Error(message), { code, ...facts });
const inBounds = (p, bounds) => bounds.some(b => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && p.z >= b.minZ && p.z <= b.maxZ);
const boundsFor = blueprint => {
  if (blueprint.workBounds) return { ...blueprint.workBounds, minY: blueprint.workBounds.minY - 5, maxY: blueprint.workBounds.maxY + 2 };
  const cells = [...blueprint.blocks, ...blueprint.scaffold].map(s => s.position);
  return { ...blueprint.bounds, minY: blueprint.anchor.y - 5, maxY: blueprint.bounds.maxY + 2,
    minX: Math.min(blueprint.bounds.minX, ...cells.map(p => p.x)) - 1, maxX: Math.max(blueprint.bounds.maxX, ...cells.map(p => p.x)) + 1,
    minZ: Math.min(blueprint.bounds.minZ, ...cells.map(p => p.z)) - 1, maxZ: Math.max(blueprint.bounds.maxZ, ...cells.map(p => p.z)) + 1 };
};
function recorder(blockAt, assertActive) {
  const facts = new Map();
  const read = p => {
    assertActive(); const b = blockAt(p); assertActive();
    facts.set(key(p), { position: { ...p }, name: b?.name ?? null, stateId: b?.stateId ?? null,
      shapes: b?.shapes ?? null, waterlogged: b?.getProperties?.().waterlogged ?? null });
    assertActive(); return b;
  };
  return { read, digest: () => createHash('sha256').update(JSON.stringify([...facts].sort(([a], [b]) => a.localeCompare(b)))).digest('hex') };
}
// This matches the original camp's ten distinct station/storage geometry rule.
// It is a read-only candidate check, never an owned station or material receipt.
function inspectNaturalSiteSearchCamp({ bot, anchor, constructionBounds, excludeBounds = [], blockAt, assertActive = () => {}, camp = null }) {
  if (!integer(anchor) || !Array.isArray(constructionBounds) || !constructionBounds.length || typeof blockAt !== 'function') return { valid: false, reason: 'invalid_camp_contract' };
  const observed = recorder(blockAt, assertActive), loaded = Object.create(bot);
  loaded.blockAt = p => observed.read(point(p));
  const denied = p => inBounds(p, [...constructionBounds, ...excludeBounds]);
  const safe = (p, walking = false) => {
    const foot = walking ? naturalWalkingFoot : (loaded,p)=>naturalWalkingFoot(loaded,p)
      &&[p,{...p,y:p.y+1}].every(q=>{const b=loaded.blockAt(new Vec3(q.x,q.y,q.z));
        return ['air','cave_air','void_air'].includes(b?.name)||require('./houseSelfSupplyRuntime').isCampReplaceablePlant(b);});
    if (!integer(p) || denied(p) || !foot(loaded, p)) return false;
    const floorPosition = { ...p, y: p.y - 1 }, floor = loaded.blockAt(new Vec3(floorPosition.x, floorPosition.y, floorPosition.z));
    if (!floor || String(floor.name).endsWith('_leaves')) return false;
    // Reuse the original dryFoot rules against this final support read too:
    // UNKNOWN, a replaced hazard, or a changed shape cannot mean "non-leaf".
    const fresh = Object.create(loaded); fresh.blockAt = q => same(point(q), floorPosition) ? floor : loaded.blockAt(q);
    return foot(fresh, p);
  };
  if (!safe(anchor, true)) return { valid: false, reason: 'camp_not_dry_or_outside_bounds' };
  const sites = camp ? [camp.stations?.crafting_table, camp.stations?.furnace, ...(camp.storageSites || [])] : [];
  if (camp) {
    if (!same(camp.anchor, anchor) || sites.length !== 10 || !sites.every(integer) || new Set(sites.map(key)).size !== 10 || !sites.every(p => safe(p))) return { valid: false, reason: 'camp_sites_changed_or_incomplete' };
  } else {
    for (let radius = 2; radius <= 8 && sites.length < 10; radius += 2) {
      for (const [dx, dz] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius], [radius, radius], [-radius, radius], [radius, -radius], [-radius, -radius]]) {
        if (sites.length >= 10) break;
        const x = anchor.x + dx, z = anchor.z + dz;
        if (sites.some(p => p.x === x && p.z === z)) continue;
        let chosen = null;
        for (let dy = 0; dy <= 12 && !chosen; dy++) for (const offset of dy ? [dy, -dy] : [0]) {
          const p = { x, y: anchor.y + offset, z }; if (safe(p)) { chosen = p; break; }
        }
        if (chosen) sites.push(chosen);
      }
    }
    if (sites.length !== 10) return { valid: false, reason: 'camp_ten_sites_unavailable' };
  }
  assertActive();
  const selected = { anchor: { ...anchor }, stations: { crafting_table: { ...sites[0] }, furnace: { ...sites[1] } }, storageSites: sites.slice(2).map(p => ({ ...p })) };
  // Only the exact ten chosen stands belong to the reservation fingerprint;
  // rejected prospective cells do not become a later support requirement.
  if (!camp) return inspectNaturalSiteSearchCamp({ bot, anchor, constructionBounds, excludeBounds, blockAt, assertActive, camp: selected });
  return { valid: true, camp: selected, digest: observed.digest() };
}
function inspectPair({ bot, houseAnchor, profile, camp, blockAt, assertActive, excludeBounds, inspectHouseSite, getBlueprint }) {
  const observed = recorder(blockAt, assertActive);
  const house = inspectHouseSite({ anchor: houseAnchor, profile, blockAt: observed.read }); assertActive();
  if (!house?.valid) return { valid: false, reason: house?.reason || 'house_site_unknown' };
  const bounds = boundsFor(getBlueprint(houseAnchor, { profile }));
  const campProof = inspectNaturalSiteSearchCamp({ bot, anchor: camp.anchor, camp, constructionBounds: [bounds], excludeBounds, blockAt, assertActive });
  if (!campProof.valid) return campProof;
  return { valid: true, houseDigest: observed.digest(), campDigest: campProof.digest, camp: campProof.camp };
}
// A later material step uses its own fresh owner/deadline capability, not an
// expired search TTL. The reservation proves neither stock nor built ownership.
function validateNaturalSiteReservation({ reservation, profile, ownerIdentity, bot, blockAt, assertActive = () => {}, excludeBounds = [], inspectHouseSite = inspectNaturalHouseSite, getBlueprint = createFurnishedHouseBlueprint }) {
  assertActive();
  if (!reservation || reservation.schema !== 1 || reservation.kind !== 'actual_loaded_house_site_and_camp' || reservation.profile !== profile
    || reservation.ownerIdentity?.taskId !== ownerIdentity?.taskId || !integer(reservation.houseAnchor) || !integer(reservation.searchStart)
    || !integer(reservation.camp?.anchor) || reservation.campNodeId !== key(reservation.camp.anchor)
    || !Number.isSafeInteger(reservation.confirmedAt) || reservation.confirmedAt < 1 || reservation.confirmedAt > Date.now()
    || !/^[a-f0-9]{64}$/.test(reservation.houseDigest || '') || !/^[a-f0-9]{64}$/.test(reservation.campDigest || '')) return { valid: false, reason: 'reservation_contract_changed' };
  const loaded = Object.create(bot); loaded.blockAt = p => { assertActive(); const b = blockAt(point(p)); assertActive(); return b; };
  if (!same(point(bot.entity?.position || {}), reservation.camp.anchor) || !hasGroundedBodySupport(loaded) || !naturalWalkingFoot(loaded, reservation.camp.anchor)) return { valid: false, reason: 'camp_actual_arrival_unconfirmed' };
  const proof = inspectPair({ bot, houseAnchor: reservation.houseAnchor, profile, camp: reservation.camp, blockAt, assertActive, excludeBounds, inspectHouseSite, getBlueprint });
  assertActive();
  if (!proof.valid) return proof;
  if (proof.houseDigest !== reservation.houseDigest || proof.campDigest !== reservation.campDigest) return { valid: false, reason: 'reserved_geometry_changed' };
  return { valid: true, anchor: { ...reservation.houseAnchor }, camp: copy(proof.camp), actual: point(bot.entity.position), authority: 'fresh_loaded_site_and_actual_camp_only' };
}
function createNaturalHouseSiteSearch(deps, limits = {}) {
  for (const name of ['getBot', 'assertActive', 'isOwnerCurrent', 'isOwnerContext', 'getCP', 'saveCP', 'getGraphCP', 'initializeGraph', 'next', 'travelObserved', 'readRemainingMs']) if (typeof deps?.[name] !== 'function') throw new TypeError(`Natural site search needs ${name}`);
  if (typeof deps.ownerIdentity?.taskId !== 'string' || !deps.ownerIdentity.taskId || !Number.isSafeInteger(deps.ownerIdentity.generation)) throw new TypeError('Captured task identity and generation required');
  const cfg = { timeoutMs: 1200000, maxNodes: 256, maxProbes: 8192, perNodeCandidates: 1024, maxInspections: 262144, maxReads: 8000000, ...limits };
  for (const [name, value] of Object.entries(cfg)) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Finite site limit ${name}`);
  if (cfg.timeoutMs > 1800000 || cfg.maxNodes > 256 || cfg.maxProbes > 8192 || cfg.perNodeCandidates > 1024 || cfg.maxInspections > 262144 || cfg.maxReads > 8000000) throw new TypeError('Original bounded site/graph limits cannot be enlarged');
  const bot = deps.getBot(), client = bot?._client, identity = copy(deps.ownerIdentity);
  const inspectHouseSite = deps.inspectHouseSite || inspectNaturalHouseSite, getBlueprint = deps.getBlueprint || createFurnishedHouseBlueprint;
  let state = null, deadline = null, running = false;
  const active = () => {
    deps.assertActive();
    if (deps.getBot() !== bot || bot._client !== client || deps.isOwnerCurrent() !== true || deps.isOwnerContext() !== true) throw fail('house_site_search_owner_changed', 'Original task/client/generation/token/lease/context changed');
    const remaining = deps.readRemainingMs();
    if (!Number.isFinite(remaining) || remaining <= 0 || deadline !== null && Date.now() >= deadline) throw fail('house_site_search_timeout', 'Original step or absolute site-search deadline expired');
    if (!Number.isFinite(bot.health) || !Number.isFinite(bot.food) || bot.health<=0
      ||(bot.health<16||bot.food<14)&&deps.isOwnedDefenseActive?.()!==true)
      throw fail('house_site_search_survival_limit', 'Real health16/food14 required for no-material exploration');
  };
  const graph = () => { active(); const value = deps.getGraphCP(); active(); return value; };
  const save = patch => {
    active(); const latest = deps.getCP(); active();
    state = { ...state, ...(latest ? { graph: latest.graph } : {}), ...copy(patch) };
    deps.saveCP(copy(state)); active();
  };
  const read = p => {
    active(); if (state.readWindow.reads >= cfg.maxReads) { throw fail('house_site_search_read_limit', 'Finite loaded site read budget reached'); }
    state.readWindow.reads++;state.diagnostics.reads++;
    const b = bot.blockAt(new Vec3(p.x, p.y, p.z)); active(); return b;
  };
  const actual = () => {
    active(); const p = point(bot.entity.position), loaded = Object.create(bot); loaded.blockAt = q => read(point(q));
    if (!naturalWalkingFoot(loaded, p) || !hasGroundedBodySupport(loaded)) throw fail('house_site_search_not_grounded', 'Actual dry foot/AABB contact must be loaded and grounded');
    active(); return p;
  };
  function currentNode() {
    const cp = graph(), p = actual();
    if (cp?.pendingDryTrail || cp?.pendingWater) throw fail('house_site_search_reconciliation_required', 'Original typed water or actual dry-prefix remains pending');
    if (cp?.schema !== 2 || cp.kind !== 'loaded_dry_waypoint_graph' || !same(cp.anchor, state.start) || !Array.isArray(cp.order)
      || cp.order.length > cfg.maxNodes || !Number.isSafeInteger(cp.probes) || cp.probes > cfg.maxProbes || cp.current !== key(p)
      || !cp.order.includes(cp.current) || !same(cp.nodes?.[cp.current]?.position, p)) throw fail('house_site_search_graph_unconfirmed', 'Only an actually registered current graph node can inspect or credit a camp');
    return { cp, p, id: cp.current };
  }
  function candidates(origin) {
    const offsets = [[2, 2], [-10, 2], [2, -14], [-10, -14], [0, 0]], seen = new Set(), result = [];
    for (let ring = 4; ring <= 24; ring += 4) for (let x = -ring; x <= ring; x += 4) for (let z = -ring; z <= ring; z += 4) if (Math.max(Math.abs(x), Math.abs(z)) === ring) offsets.push([x, z]);
    for (const [dx, dz] of offsets) for (const dy of [0, 1, -1, 2, -2]) {
      const p = { x: origin.x + dx, y: origin.y + dy, z: origin.z + dz };
      if (!seen.has(key(p))) { seen.add(key(p)); result.push(p); }
      if (result.length >= cfg.perNodeCandidates) return result;
    }
    return result;
  }
  async function search({ profile = 'cottage', excludeBounds = [] } = {}) {
    if (running) throw fail('house_site_search_busy', 'One original site-search capability at a time'); running = true;
    try {
      active(); const old = deps.getCP(); active(); const start = old?.start || point(bot.entity.position);
      if (!integer(start) || old && (old.schema !== 1 || old.kind !== 'loaded_natural_house_site_search' || old.profile !== profile || old.ownerIdentity?.taskId !== identity.taskId
        || !Number.isSafeInteger(old.creatorGeneration) || !Array.isArray(old.checkedNodes) || old.checkedNodes.length > cfg.maxNodes
        || !old.diagnostics || !Number.isSafeInteger(old.diagnostics.reads) || old.diagnostics.reads < 0 || old.diagnostics.reads > cfg.maxReads*6
        || !Number.isSafeInteger(old.diagnostics.inspected) || old.diagnostics.inspected < 0 || old.diagnostics.inspected > cfg.maxInspections
        || !Number.isSafeInteger(old.diagnostics.advances) || old.diagnostics.advances < 0 || old.diagnostics.advances > cfg.maxNodes
        || !Number.isSafeInteger(old.budgetGeneration) || new Set(old.checkedNodes).size !== old.checkedNodes.length)) throw fail('house_site_search_checkpoint_changed', 'Original task/profile/start or finite observation ledger changed');
      state = old ? copy(old) : { schema: 1, kind: 'loaded_natural_house_site_search', ownerIdentity: identity, creatorGeneration: identity.generation, profile, start,
        startedAt: Date.now(), budgetGeneration: identity.generation, graph: null, checkedNodes: [], diagnostics: { reads: 0, inspected: 0, advances: 0, rejections: {} }, reservation: null };
      // An explicit resumed generation gets only its real new watchdog budget;
      // physical observations/probes and lifetime read counts never reset.
      // Each explicit generation has at most one read window, six per task.
      // Same-generation re-entry keeps its TTL and spent read allowance.
      const freshRun = !old || old.budgetGeneration !== identity.generation;
      deadline = freshRun ? Date.now() + Math.min(cfg.timeoutMs, deps.readRemainingMs()) : old.deadline;
      if (!Number.isSafeInteger(deadline)) throw fail('house_site_search_checkpoint_changed', 'Original absolute search deadline missing');
      const priorWindow=old?.readWindow||{generation:old?.budgetGeneration??identity.generation,reads:old?.diagnostics?.reads||0};
      const history=old?.readWindowHistory||[];
      if(!Array.isArray(history)||history.length>5||!Number.isSafeInteger(priorWindow.generation)||!Number.isSafeInteger(priorWindow.reads)
        ||priorWindow.reads<0||priorWindow.reads>cfg.maxReads||history.some(w=>!Number.isSafeInteger(w.generation)||!Number.isSafeInteger(w.reads)||w.reads<0||w.reads>cfg.maxReads)
        ||history.reduce((n,w)=>n+w.reads,0)+priorWindow.reads!==state.diagnostics.reads)
        throw fail('house_site_search_checkpoint_changed','Finite read window ledger changed');
      if(priorWindow.generation!==identity.generation){
        if(history.length>=5)throw fail('house_site_search_read_limit','Six finite observation windows exhausted');
        state.readWindowHistory=[...history,priorWindow];state.readWindow={generation:identity.generation,reads:0};
      }else {state.readWindowHistory=history;state.readWindow=priorWindow;}
      actual(); const cp = graph(), here = point(bot.entity.position);
      if (cp?.pendingDryTrail || cp?.pendingWater) throw fail('house_site_search_reconciliation_required', 'Do not bypass an original pending physical prefix');
      if (cp && (!cp.order?.includes(key(here)) || !same(cp.nodes?.[key(here)]?.position, here))) throw fail('house_site_search_graph_unconfirmed', 'Explicit resume must already stand at a genuinely observed node');
      if (!cp && !same(here, start)) throw fail('house_site_search_graph_unconfirmed', 'First native search root must be the actual captured start');
      save({ deadline, budgetGeneration: identity.generation, ownerIdentity: identity, reservation: null });
      await deps.initializeGraph({ anchor: start, excludeBounds, assertActive: active, ...(cp ? { nodeId: key(here), exactPosition: here } : {}) }); active(); currentNode();
      while (true) {
        const { cp: observed, p, id } = currentNode();
        if (!state.checkedNodes.includes(id)) {
          const registered = [id, ...observed.order.filter(n => n !== id)];
          for (const houseAnchor of candidates(p)) {
            active(); if (++state.diagnostics.inspected > cfg.maxInspections) { state.diagnostics.inspected = cfg.maxInspections; throw fail('house_site_search_inspection_limit', 'Finite original site candidate budget reached'); }
            const recorded = recorder(read, active), house = inspectHouseSite({ anchor: houseAnchor, profile, blockAt: recorded.read }); active();
            if (!house?.valid) { const reason = house?.reason || 'house_site_unknown'; state.diagnostics.rejections[reason] = (state.diagnostics.rejections[reason] || 0) + 1; continue; }
            const constructionBounds = [boundsFor(getBlueprint(houseAnchor, { profile }))];
            for (const campNodeId of registered) {
              const campAnchor = observed.nodes[campNodeId]?.position; if (!integer(campAnchor)) throw fail('house_site_search_graph_unconfirmed', 'Registered camp geometry is not canonical');
              const campProof = inspectNaturalSiteSearchCamp({ bot, anchor: campAnchor, constructionBounds, excludeBounds, blockAt: read, assertActive: active });
              if (!campProof.valid) continue;
              const reservation = { schema: 1, kind: 'actual_loaded_house_site_and_camp', ownerIdentity: identity, profile, houseAnchor: { ...houseAnchor }, camp: campProof.camp,
                campNodeId, terrainPreparation: house.terrainPreparation ? copy(house.terrainPreparation) : null, searchStart: { ...start }, houseDigest: recorded.digest(), campDigest: campProof.digest, confirmedAt: null };
              if (campNodeId !== id) {
                await deps.travelObserved({ anchor: start, nodeId: campNodeId, exactPosition: campAnchor, excludeBounds, assertActive: active }); active();
              }
              const arrived = currentNode();
              if (arrived.id !== campNodeId) throw fail('house_site_search_camp_unconfirmed', 'Resolved callback did not reach the selected registered camp');
              reservation.confirmedAt = Date.now();
              const proof = validateNaturalSiteReservation({ reservation, profile, ownerIdentity: identity, bot, blockAt: read, assertActive: active, excludeBounds, inspectHouseSite, getBlueprint });
              if (!proof.valid) {
                deps.report?.('候选建地到达后复核失败，保留真实原因', { reason: proof.reason, houseAnchor: reservation.houseAnchor,
                  campAnchor: reservation.camp.anchor, actual: arrived.p, houseDigest: reservation.houseDigest, campDigest: reservation.campDigest });
                throw fail('house_site_search_geometry_changed', `Selected site/camp changed before real arrival confirmation: ${proof.reason}`, { reason: proof.reason });
              }
              reservation.confirmedAt = Date.now(); active(); save({ reservation });
              return { confirmed: true, anchor: reservation.houseAnchor, houseAnchor: reservation.houseAnchor, camp: copy(reservation.camp), actual: arrived.p, reservation: copy(reservation), diagnostics: copy(state.diagnostics), authority: 'loaded_geometry_and_actual_camp_only' };
            }
            state.diagnostics.rejections.camp_ten_sites_unavailable = (state.diagnostics.rejections.camp_ten_sites_unavailable || 0) + 1;
          }
          save({ checkedNodes: [...state.checkedNodes, id], diagnostics: state.diagnostics });
        }
        if (observed.order.length >= cfg.maxNodes || state.diagnostics.advances >= cfg.maxNodes) throw fail('house_site_search_node_limit', 'Finite actual site-search nodes reached');
        const before = bot.entity.position.clone(), probesBefore = observed.probes; active();
        let moved;
        try { moved = await deps.next({ anchor: start, excludeBounds, assertActive: active }); }
        catch(error){
          active();
          const recovered=typeof deps.recoverTimedOutLeg==='function'
            ?await deps.recoverTimedOutLeg(error,{deadline,maxNodes:cfg.maxNodes,maxProbes:cfg.maxProbes}):null;
          active();
          if(recovered?.confirmed===true){
            currentNode();state.diagnostics.advances++;save({diagnostics:state.diagnostics});
            deps.report?.('超时旧段保持未完成，从实际落稳站位继续选址',{actual:recovered.actual,oldGoalAccepted:false,oldEdgeTraversalCredit:false});
            continue;
          }
          throw error;
        }
        active();state.diagnostics.advances++; const arrived = currentNode();
        if (moved?.moved !== true) {
          save({ diagnostics: state.diagnostics });
          // Eight failed/deferred graph attempts are a batch boundary, not a
          // proof that all loaded terrain is exhausted. Continue only when the
          // original graph spent real probes and retains unstarted frontier.
          // Every callback still consumes the existing finite attempt counter,
          // absolute deadline, read/inspection ledger and native probe budget.
          if(moved?.reason==='finite_attempt_batch_failed' && arrived.cp.probes>probesBefore
            &&Array.isArray(arrived.cp.frontier)&&arrived.cp.frontier.length>0){
            deps.report?.('单向返程已暂缓，继续从真实站位探索剩余选址路线',{
              actual:arrived.p,nodes:arrived.cp.order.length,probes:arrived.cp.probes,
              actualNewNodeCredit:false,originalDeadline:deadline});
            continue;
          }
          throw fail('house_no_safe_site', 'Finite loaded reachable site search has not found a full house/camp pair', { reason: moved?.reason || 'native_frontier_unknown', diagnostics: copy(state.diagnostics), actual: arrived.p });
        }
        if (arrived.id === id || bot.entity.position.distanceTo(before) < .1) throw fail('house_site_search_arrival_unconfirmed', 'A successful callback is not a new actual graph arrival');
        save({ diagnostics: state.diagnostics }); deps.report?.('沿真实已加载站位寻找完整建地与施工营地', { actual: arrived.p, nodes: arrived.cp.order.length, inspected: state.diagnostics.inspected });
      }
    } catch (error) {
      // Persist spent pure budgets only while this captured owner is active.
      // A paused or foreign owner cannot write a late checkpoint or camp fact.
      if (state && ['house_site_search_read_limit', 'house_site_search_inspection_limit', 'house_site_search_node_limit'].includes(error.code)) {
        try { active(); save({ diagnostics: state.diagnostics }); } catch { /* Closed owner keeps its last truthful ledger. */ }
      }
      throw error;
    } finally { running = false; }
  }
  return { search, assertActive: active, getState: () => state && copy(state) };
}
module.exports = { createNaturalHouseSiteSearch, inspectNaturalSiteSearchCamp, validateNaturalSiteReservation };
