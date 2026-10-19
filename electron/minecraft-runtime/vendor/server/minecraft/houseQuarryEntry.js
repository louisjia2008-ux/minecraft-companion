/* global require, module */
'use strict';

const { Vec3 } = require('vec3');
const { CARDINALS, classifyMiningBlock, inspectMiningStep } = require('./miningNavigation');
const { inspectSurfaceBody, hasGroundedBodySupport } = require('./houseSurfaceGraph');
const clone = value => JSON.parse(JSON.stringify(value));
const integerPosition = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]));
const key = p => `${p.x},${p.y},${p.z}`;
const same = (a, b) => integerPosition(a) && integerPosition(b) && key(a) === key(b);
const fail = (code, message, facts = {}) => Object.assign(new Error(message), { code, ...facts });

// Resolver only: the host retains the fixed camp, graph transport and quarry CP.
// Selected entries do not mean arrival and never add graph nodes or visits.
function createHouseQuarryEntry(deps, { camp, resourceGraph = 'any_log', maxObservedNodes = 512 } = {}) {
  for (const name of ['getBot', 'getObservedGraph', 'blockAt', 'assertActive', 'isOwnerContext', 'isExcludedEntry', 'isProtectedDig']) {
    if (typeof deps?.[name] !== 'function') throw fail('house_quarry_entry_dependency_missing', `自然矿道入口缺少依赖：${name}`);
  }
  if (!integerPosition(camp) || typeof resourceGraph !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(resourceGraph)
    || !Number.isSafeInteger(maxObservedNodes) || maxObservedNodes < 1 || maxObservedNodes > 4096) {
    throw fail('house_quarry_entry_invalid_request', '矿道入口需要固定整数营地和有限已观察节点范围');
  }
  const fixedCamp = { ...camp };
  let capturedBot = null;
  function active() {
    deps.assertActive();
    if (deps.isOwnerContext() !== true) throw fail('house_quarry_entry_foreign_owner', '只有当前资源任务可以选择或确认矿道入口');
    const bot = deps.getBot();
    if (!bot || capturedBot && bot !== capturedBot) throw fail('house_quarry_entry_bot_changed', '矿道入口不能借用其它客户端');
    capturedBot ||= bot;
    return bot;
  }
  function observed() {
    active();
    const graph = deps.getObservedGraph(resourceGraph);
    if (graph == null) throw fail('house_quarry_entry_pending', '当前营地未确认稳定，且尚无实际地表节点可选择独立矿道入口');
    if (graph?.schema !== 2 || graph.kind !== 'loaded_dry_waypoint_graph' || !same(graph.anchor, fixedCamp)
      || !Array.isArray(graph.order) || !graph.nodes || graph.order.length < 1 || graph.order.length > maxObservedNodes
      || Object.keys(graph.nodes).length !== graph.order.length || new Set(graph.order).size !== graph.order.length) {
      throw fail('house_quarry_entry_graph_unconfirmed', '入口只允许同一营地完整已实际到达的原地表图');
    }
    const ordered = new Set(graph.order), campId = key(fixedCamp);
    for (const id of graph.order) {
      const node = graph.nodes[id];
      if (!integerPosition(node?.position) || key(node.position) !== id
        || (id === campId ? node.parent !== null : !ordered.has(node.parent))) {
        throw fail('house_quarry_entry_graph_unconfirmed', '矿道入口节点必须来自原图的实际节点树');
      }
      const seen = new Set();
      let cursor = id;
      while (cursor !== campId) {
        if (seen.has(cursor) || !graph.nodes[cursor]) throw fail('house_quarry_entry_graph_unconfirmed', '原图节点不能循环或脱离固定营地');
        seen.add(cursor); cursor = graph.nodes[cursor].parent;
      }
    }
    if (!ordered.has(campId)) throw fail('house_quarry_entry_graph_unconfirmed', '原图没有实际营地根节点');
    active();
    return graph;
  }
  function at(p) { active(); return deps.blockAt(new Vec3(p.x, p.y, p.z)); }
  function inspect(position) {
    const bot = active();
    if (deps.isExcludedEntry(position) !== false) return { confirmed: false, reason: 'entry_excluded_or_unknown' };
    const foot = classifyMiningBlock(at(position)), head = classifyMiningBlock(at({ ...position, y: position.y + 1 }));
    const floor = classifyMiningBlock(at({ ...position, y: position.y - 1 }));
    if (!foot.loaded || !head.loaded || !floor.loaded) return { confirmed: false, reason: 'entry_unloaded' };
    if (!foot.passable || !head.passable || !floor.support) return { confirmed: false, reason: 'entry_no_stable_support', support: floor.name };
    const rejected = [];
    for (const direction of CARDINALS) for (const descend of [true, false]) {
      active();
      const step = inspectMiningStep({ blockAt: at, from: position, direction, descend,
        minY: Number.isFinite(bot.game?.minY) ? bot.game.minY : -64,
        maxY: Number.isFinite(bot.game?.minY) && Number.isFinite(bot.game?.height) ? bot.game.minY + bot.game.height - 1 : 319 });
      if (!step.ok || step.needsSupport) { rejected.push(step.code || 'MINING_NO_STABLE_STEP_FLOOR'); continue; }
      // A protected walking/standing floor is allowed. A protected solid
      // clearance block must never be opened to make the initial quarry step.
      if (step.clearance.some(p => !classifyMiningBlock(at(p)).passable && deps.isProtectedDig(p) !== false)) {
        rejected.push('HOUSE_QUARRY_PROTECTED'); continue;
      }
      active();
      return { confirmed: true, support: floor.name, initialStep: { direction: { ...direction }, descend, target: { ...step.target }, floor: { ...step.floor }, clearance: clone(step.clearance), needsSupport: false } };
    }
    return { confirmed: false, reason: 'entry_no_safe_initial_step', support: floor.name, rejected };
  }
  function actualArrival(position) {
    const bot = active(), entity = bot.entity, p = entity?.position;
    if (!p || !['x', 'y', 'z'].every(k => Number.isFinite(p[k]))
      || !same({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, position)
      || Math.abs(p.y - position.y) > 0.075 || entity.onGround !== true || entity.isInWater !== false || entity.isInLava !== false) return null;
    // Helper reads use this resolver's captured ownership guard, rather than
    // the client's unguarded callback, including every adjacent body cell.
    const guardedBot = { entity, blockAt: at };
    const body = inspectSurfaceBody(guardedBot);
    if (!body.dry || !hasGroundedBodySupport(guardedBot)) return null;
    active();
    return { confirmed: true, actualPosition: { x: p.x, y: p.y, z: p.z }, onGround: true, body,
      evidence: 'actual_actor_pose_fresh_native_dry_AABB_and_shape_support' };
  }
  function selected(nodeId, position, evidence, routeKind = 'observed_graph_node') {
    return { schema: 1, kind: 'observed_house_quarry_entry', resourceGraph, camp: { ...fixedCamp }, nodeId, routeKind,
      position: { ...position }, status: 'selected', arrival: null,
      evidence: { source: routeKind === 'same_camp' ? 'fresh_native_loaded_actual_camp' : 'fresh_native_loaded_observed_node',
        support: evidence.support, initialStep: clone(evidence.initialStep) } };
  }
  function choose() {
    // Nearby trees can be harvested before surface exploration ever creates a
    // graph. A genuinely stable camp at the actual actor needs no new route.
    const campEvidence = inspect(fixedCamp);
    if (campEvidence.confirmed && actualArrival(fixedCamp)) {
      active(); return selected(null, fixedCamp, campEvidence, 'same_camp');
    }
    let graph;
    try { graph = observed(); }
    catch (error) {
      if (error.code === 'house_quarry_entry_pending') error.campInspection = {
        ...clone(campEvidence), actualArrivalConfirmed: Boolean(actualArrival(fixedCamp)) };
      throw error;
    }
    const positions = graph.order.map((nodeId, index) => ({ nodeId, position: graph.nodes[nodeId].position, index }));
    positions.sort((a, b) => Math.hypot(a.position.x - fixedCamp.x, a.position.y - fixedCamp.y, a.position.z - fixedCamp.z)
      - Math.hypot(b.position.x - fixedCamp.x, b.position.y - fixedCamp.y, b.position.z - fixedCamp.z) || a.index - b.index);
    const rejected = {};
    for (const item of positions) {
      const evidence = inspect(item.position);
      if (evidence.confirmed) { active(); return selected(item.nodeId, item.position, evidence); }
      rejected[evidence.reason] = (rejected[evidence.reason] || 0) + 1;
    }
    throw fail('house_quarry_entry_pending', '已实际观察节点中尚无稳定且可安全起步的独立矿道入口', { observedNodes: positions.length, rejected });
  }
  function revalidate(entry) {
    active();
    if (entry?.schema !== 1 || entry.kind !== 'observed_house_quarry_entry' || entry.resourceGraph !== resourceGraph
      || !same(entry.camp, fixedCamp) || !integerPosition(entry.position)
      || !['same_camp', 'observed_graph_node'].includes(entry.routeKind)
      || !['selected', 'arrived'].includes(entry.status)) {
      throw fail('house_quarry_entry_checkpoint_unconfirmed', '保存入口不得更换营地、节点或来源图');
    }
    if (entry.routeKind === 'same_camp') {
      if (entry.nodeId !== null || !same(entry.position, fixedCamp)) throw fail('house_quarry_entry_checkpoint_unconfirmed', '同营地入口不能引入新节点或更换固定营地');
    } else {
      const graph = observed();
      if (key(entry.position) !== entry.nodeId || !graph.order.includes(entry.nodeId) || !same(graph.nodes[entry.nodeId]?.position, entry.position)) {
        throw fail('house_quarry_entry_checkpoint_unconfirmed', '保存入口必须仍是同一实际已观察图节点');
      }
    }
    const evidence = inspect(entry.position);
    if (!evidence.confirmed) throw fail('house_quarry_entry_revalidation_failed', '原入口的实际地形不再安全，不能复用历史到达', { reason: evidence.reason });
    active();
    // Every restore drops historical arrival; confirm must read the real actor.
    return selected(entry.nodeId, entry.position, evidence, entry.routeKind);
  }
  function confirm(entry) {
    const fresh = revalidate(entry), arrival = actualArrival(fresh.position);
    if (!arrival) {
      throw fail('house_quarry_entry_arrival_unconfirmed', '必须在原生矿道入口同格真实落稳后才能开始采石');
    }
    active();
    return { ...fresh, status: 'arrived', arrival };
  }
  return { choose, revalidate, confirm };
}

module.exports = { createHouseQuarryEntry };
