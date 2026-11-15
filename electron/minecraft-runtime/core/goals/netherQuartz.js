'use strict';
// Goal: bring N nether quartz back to the overworld.
//
// Build (or reuse) a portal, go through, mine quartz ore near the arrival
// portal, return through the same portal. Every run() decides from where the
// bot is and what it holds: after a death in the nether it respawns in the
// overworld, walks back to the portal it remembers and goes through again.

const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const nether = require('../nether');
const { createBlacklist } = require('../blacklist');
const { createPortalTrip } = require('../netherTrip');
const { findStructure } = require('../netherStructures');
const { sleep } = require('../confirm');
const { KNOWLEDGE } = require('../knowledge');
const { Vec3 } = require('vec3');
const { RaycastIterator } = require('prismarine-world').iterators;
const { abortError } = require('../confirm');
const { inspectStep } = require('../mining');
const { perceive } = require('../perception');
const { chooseExcavationTarget, excavationDirections, oreSafetyFailure, shoreSafetyFailure } = require('../quartzExcavationTarget');

const isQuartz = (n) => n === 'quartz';
const isQuartzOre = (n) => n === 'nether_quartz_ore';
const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
// Blazes and wither skeletons spawn in and around a fortress, and a portal
// can open right beside one. Quartz is everywhere else: mine away from it.
const FORTRESS_BERTH = 40;
// Hurt in the Nether with nothing to eat: home to heal before going on.
const RETREAT_HEALTH = 8;
// Back in the overworld, fed: wait to heal this far before going through again.
const READY_HEALTH = 16;
// A full hunger bar after respawn is not a carried reserve. Keep enough
// safe food for the outward trip and return before the last piece is gone.
const QUARTZ_MIN_FOOD = 4;
const RETREAT_FOOD = 1;
// Straight legs add seven blocks/cell; a ninety-degree turn can replace two
// rail blocks and costs nine. Include two start/end columns at that worst
// cost. Gather the actual stone reserve; the scenario kit is unchanged.
const LEDGE_BLOCKS = (48 + 2) * 9;
const isStone = (n) => /^(stone|cobblestone|deepslate|cobbled_deepslate)$/.test(n);
const isCobble = (n) => n === 'cobblestone' || n === 'cobbled_deepslate';
const keyOf = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const HAZARD = /^(lava|water|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|powder_snow|nether_portal)$/;
const fullCube = (b) => b?.boundingBox === 'block' && b.shapes?.length === 1
  && b.shapes[0].every((n, i) => n === [0, 0, 0, 1, 1, 1][i]) && b.shapes[0].length === 6;

function quartzFootFailure(bot, p) {
  const blocks = [-1, 0, 1].map((y) => bot.blockAt(p.offset(0, y, 0)));
  if (blocks.some((b) => !b)) return 'unknown';
  if (!fullCube(blocks[0]) || blocks.some((b) => HAZARD.test(b.name))
    || blocks.slice(1).some((b) => b.boundingBox !== 'empty')) return 'unsafe_stance';
  // lavaRisk must not silently treat an unloaded neighbouring cell as dry.
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let y = -2; y <= 1; y++) if (!bot.blockAt(p.offset(x, y, z))) return 'unknown_margin';
  }
  return nether.lavaRisk(bot, p) > 0 ? 'lava_margin' : null;
}

function quartzVisible(bot, feet, ore, actual = false) {
  if (!bot.world?.raycast) return false;
  const eyeHeight = actual ? bot.entity.eyeHeight ?? 1.62 : 1.62;
  if (!Number.isFinite(eyeHeight) || eyeHeight <= 0 || eyeHeight > 2.5) return false;
  const eye = actual ? feet.offset(0, eyeHeight, 0) : feet.offset(.5, eyeHeight, .5);
  for (const [x, y, z] of [[0, .5, .5], [1, .5, .5], [.5, 0, .5], [.5, 1, .5], [.5, .5, 0], [.5, .5, 1]]) {
    const point = ore.position.offset(x, y, z), delta = point.minus(eye), distance = delta.norm();
    if (distance <= 0 || distance > 4.5) continue;
    const direction = delta.scaled(1 / distance), cells = new RaycastIterator(eye, direction, distance);
    let loaded = true;
    for (let cell = eye; cell; cell = cells.next()) if (!bot.blockAt(new Vec3(cell.x, cell.y, cell.z))) { loaded = false; break; }
    if (!loaded) continue;
    const hit = bot.world.raycast(eye, direction, distance + .001);
    if (hit?.position?.equals(ore.position)) return true;
  }
  return false;
}

function walkProfile(m) {
  const drop = m?.maxDropDown <= 1 || (m?.maxDropDown <= 2 && m.companionPhysicalDropLimit === 1
    && m.infiniteLiquidDropdownDistance === false && typeof m.companionPhysicalDropGuard === 'function'
    && m.getNeighbors === m.companionPhysicalDropGuard);
  return Boolean(m?.companionWalkOnly && m.canDig === false && m.allowParkour === false
    && m.allow1by1towers === false && m.scafoldingBlocks?.length === 0 && drop);
}

/** Native raw Move coordinates are integer FEET cells. Do not apply the native
 * postProcessPath centre/top conversion twice or count scaffolding inventory as
 * a placement. This isolated generator leaves the active follower alone.
 * It filters a candidate, not an executed route: the later goto replans. */
async function quartzPathPlan(bot, goal, { ore, signal, totalMs = 2000, revision = () => 0 } = {}) {
  const began = Date.now(), originPosition = bot.entity.position.clone(), origin = originPosition.floored(), m = bot.pathfinder?.movements;
  const deadline = began + Math.min(2000, Math.max(0, totalMs)), firstRevision = revision();
  let generator, native, context, slices = 0, firstNativeStatus = null, contextStable = true;
  const finish = (result) => ({ ...result, queryMs: Date.now() - began, slices, firstNativeStatus, contextStable,
    nativePathNodes: native?.path?.length ?? null, visitedNodes: native?.visitedNodes ?? null,
    generatedNodes: native?.generatedNodes ?? null, worldChanged: revision() !== firstRevision,
    computationComplete: ['success', 'noPath'].includes(native?.status) });
  const currentFailure = () => {
    if (signal?.aborted) throw abortError(signal);
    if (bot.pathfinder.movements !== m || !walkProfile(m)) return 'quartz_profile_changed';
    if (!bot.entity.onGround || !bot.entity.position.floored().equals(origin)
      || bot.entity.position.distanceTo(originPosition) > .2) return 'quartz_origin_changed';
    return ore && bot.blockAt(ore.position)?.name !== 'nether_quartz_ore' ? 'mining_goal_changed' : null;
  };
  if (signal?.aborted) throw abortError(signal);
  if (!walkProfile(m) || !bot.entity.onGround) return finish(fail('walk_profile_or_ground'));
  if (typeof bot.pathfinder.getPathFromTo !== 'function') return finish(fail('no_native_planner'));
  try {
    generator = bot.pathfinder.getPathFromTo(m, bot.entity.position, goal,
      { timeout: Math.max(1, deadline - began), tickTimeout: 30, optimizePath: false, resetEntityIntersects: true });
    for (;;) {
      const failure = currentFailure();
      if (failure) return finish(fail(failure, { pathStatus: native?.status || null }));
      if (Date.now() >= deadline) return finish(fail('path_total_deadline', { pathStatus: native?.status || null }));
      if (slices >= 128) return finish(fail('path_slice_budget', { pathStatus: native?.status || null }));
      const yielded = generator.next(); native = yielded.value?.result; slices++;
      firstNativeStatus ||= native?.status || null;
      const nextContext = yielded.value?.astarContext || native?.context;
      if (slices === 1) context = nextContext;
      else if (!context || context !== nextContext) contextStable = false;
      if (!native || !contextStable) return finish(fail('path_context_changed', { pathStatus: native?.status || null }));
      // A partial result is an unfinished search, not unreachable geometry.
      // Resume THIS generator/context, yielding after each bounded native slice.
      await new Promise((resolve) => setImmediate(resolve));
      const changed = currentFailure();
      if (changed) return finish(fail(changed, { pathStatus: native.status }));
      if (native.status === 'partial') {
        if (!context) return finish(fail('path_context_missing', { pathStatus: native.status }));
        continue;
      }
      break;
    }
    if (Date.now() >= deadline) return finish(fail('path_total_deadline', { pathStatus: native.status }));
    if (native.status !== 'success') return finish(fail(native.status === 'noPath' && revision() !== firstRevision
      ? 'path_world_changed' : `path_${native.status}`, { pathStatus: native.status }));
    const path = native.path;
    if (!Array.isArray(path) || path.length > 128) return finish(fail('path_budget'));
    let previous = origin;
    for (const node of [origin, ...path]) {
      if (![node.x, node.y, node.z].every(Number.isInteger) || node.parkour
        || node.toBreak?.length || node.toPlace?.length) return finish(fail('path_mutation'));
      if (Math.max(Math.abs(node.x - previous.x), Math.abs(node.z - previous.z)) > 1
        || Math.abs(node.y - previous.y) > 1) return finish(fail('path_gap'));
      const failure = quartzFootFailure(bot, new Vec3(node.x, node.y, node.z));
      if (failure) return finish(fail(failure));
      previous = node;
    }
    const end = new Vec3(previous.x, previous.y, previous.z);
    if (!goal.isEnd(end) || (ore && (!quartzVisible(bot, end, ore)
      || bot.blockAt(ore.position)?.name !== 'nether_quartz_ore'))) return finish(fail('mining_goal_unconfirmed'));
    return finish({ ok: true, pathStatus: native.status, path, end, movements: m });
  } catch (error) {
    if (signal?.aborted || error?.code === 'aborted') throw abortError(signal);
    return finish(fail('path_query_error', { error: String(error.message) }));
  } finally { try { generator?.return?.(); } catch { /* never mask root cancellation while retiring a search */ } }
}

function quartzScanProfile(m) {
  return {
    scalars: JSON.stringify([m.canDig, m.allowParkour, m.allow1by1towers, m.maxDropDown, m.digCost,
      m.companionWalkOnly, m.companionNether, m.allowEntityDetection, m.canOpenDoors, m.sprintSetting ?? m.allowSprinting,
      m.scafoldingBlocks, m.companionPhysicalDropLimit, m.infiniteLiquidDropdownDistance,
      [...(m.blocksCantBreak || [])].sort((a, b) => a - b)]),
    callbacks: [m.exclusionAreasStep || [], m.exclusionAreasBreak || [], m.exclusionAreasPlace || []].map((a) => a.slice()),
    nativeNeighbors: m.getNeighbors,
    physicalDropGuard: m.companionPhysicalDropGuard,
  };
}

function sameScanProfile(a, b) {
  return a.scalars === b.scalars && a.nativeNeighbors === b.nativeNeighbors && a.physicalDropGuard === b.physicalDropGuard
    && a.callbacks.every((list, i) => list.length === b.callbacks[i].length
    && list.every((fn, j) => fn === b.callbacks[i][j]));
}

async function selectQuartzTarget(bot, ctx, candidates, memory, deadline = Date.now() + 12000) {
  if (ctx.signal?.aborted) throw abortError(ctx.signal);
  const origin = bot.entity.position.clone(), m = bot.pathfinder.movements;
  candidates = [...new Map(candidates.map((ore) => [keyOf(ore.position), ore])).values()];
  const candidateSet = candidates.map((ore) => `${keyOf(ore.position)}:${ore.name}`).sort().join('|');
  const profile = quartzScanProfile(m);
  let round = memory.quartzRound;
  if (!round || round.profileOwner !== m || round.candidateSet !== candidateSet || !sameScanProfile(round.profile, profile)
    || keyOf(round.origin) !== keyOf(origin) || round.origin.distanceTo(origin) > .2) {
    round = { id: (memory.quartzRoundSequence || 0) + 1, profileOwner: m, profile, candidateSet,
      origin: origin.clone(), checked: new Map(), complete: false };
    memory.quartzRoundSequence = round.id; memory.quartzRound = round; memory.quartzScanCursor = 0;
  }
  const cache = memory.quartzRejected ||= new Map();
  const scope = `${keyOf(origin)}:${memory.quartzWorldRevision || 0}`;
  const start = Date.now(); let queried = 0;
  // A flowing block elsewhere may invalidate the cache between every batch.
  // Keep the cursor separately so a reachable later candidate still gets tried.
  const offset = (memory.quartzScanCursor || 0) % candidates.length;
  for (let scan = 0; scan < candidates.length; scan++) {
    const index = (offset + scan) % candidates.length, ore = candidates[index];
    const targetKey = keyOf(ore.position), key = `${scope}:${targetKey}`;
    // Completion is a finite round of actual attempts, not a simultaneous
    // set of unexpired negative-cache entries. World/TTL changes never make
    // already attempted candidates unattempted within this same round.
    if (round.checked.has(targetKey)) continue;
    if (queried >= 6 || Date.now() >= deadline) { memory.quartzScanCursor = index; break; }
    const goal = new goals.GoalLookAtBlock(ore.position, bot.world, { reach: 4 });
    const plan = await quartzPathPlan(bot, goal, { ore, signal: ctx.signal, totalMs: Math.min(2000, deadline - Date.now()),
      revision: () => memory.quartzWorldRevision || 0 }); queried++;
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    if (bot.pathfinder.movements !== m || !walkProfile(m) || !bot.entity.onGround || !bot.entity.position.floored().equals(origin.floored())
      || bot.entity.position.distanceTo(origin) > .2) return fail('quartz_origin_changed');
    const fresh = plan.ok ? quartzPathFresh(bot, plan, goal, ore) : plan;
    ctx.record('quartz_target_plan', { stage: 'candidate', phase: 'preflight', executed: false,
      target: keyOf(ore.position), from: { ...origin }, actual: { ...bot.entity.position },
      pathStatus: plan.pathStatus || null, queryMs: plan.queryMs, validatedPathNodes: plan.path?.length ?? null,
      nativePathNodes: plan.nativePathNodes, visitedNodes: plan.visitedNodes, generatedNodes: plan.generatedNodes,
      slices: plan.slices, firstNativeStatus: plan.firstNativeStatus, contextStable: plan.contextStable,
      computationComplete: plan.computationComplete, worldChanged: plan.worldChanged,
      roundId: round.id,
      ok: fresh.ok, reason: fresh.reason || null, stance: plan.end && keyOf(plan.end) });
    memory.quartzScanCursor = (index + 1) % candidates.length;
    if (fresh.ok) { memory.quartzScanCursor = 0; memory.quartzRound = null; return { ok: true, block: ore }; }
    const inconclusive = ['partial', 'timeout'].includes(plan.pathStatus) || /unknown|deadline|budget|context|query_error|changed/.test(fresh.reason || '');
    if (plan.slices > 0) round.checked.set(targetKey, { reason: fresh.reason, inconclusive, revision: memory.quartzWorldRevision || 0 });
    cache.set(key, { until: Date.now() + 30000, reason: fresh.reason, inconclusive });
    if (cache.size > 256) cache.delete(cache.keys().next().value);
  }
  const pending = round.checked.size < candidates.length;
  round.complete = !pending;
  const unresolved = [...round.checked.values()].filter((entry) => entry.inconclusive
    || entry.revision !== (memory.quartzWorldRevision || 0)).length;
  const reason = pending ? 'quartz_scan_pending' : unresolved ? 'quartz_search_inconclusive' : 'quartz_no_reachable_target';
  ctx.record('quartz_target_scan', { from: { ...origin }, actual: { ...bot.entity.position }, candidates: candidates.length,
    queried, pending, unresolved, roundId: round.id, roundComplete: round.complete, checked: round.checked.size,
    completionMeaning: round.complete ? 'no_candidate_proven_reachable_this_round' : null, elapsedMs: Date.now() - start, reason });
  return fail(reason, { progress: false, roundComplete: round.complete, roundId: round.id });
}

function quartzPathFresh(bot, plan, goal, ore) {
  if (!bot.entity.onGround) return fail('quartz_not_grounded');
  if (bot.pathfinder.movements !== plan.movements || !walkProfile(plan.movements)) return fail('quartz_profile_changed');
  for (const node of [bot.entity.position.floored(), ...plan.path]) {
    const reason = quartzFootFailure(bot, new Vec3(node.x, node.y, node.z));
    if (reason) return fail(reason);
  }
  return goal.isEnd(plan.end) && (!ore || (bot.blockAt(ore.position)?.name === 'nether_quartz_ore'
    && quartzVisible(bot, plan.end, ore))) ? { ok: true } : fail('mining_goal_changed');
}

function quartzFoodMatch(bot, name) {
  if (defaultActions.RISKY_FOODS.has(name)) return false;
  const foods = bot.registry?.foodsByName;
  return foods ? Boolean(foods[name]) : KNOWLEDGE.food.match(name);
}

function quartzFoodCount(bot) {
  return bot.inventory.items().reduce((n, item) => n + (quartzFoodMatch(bot, item.name) && item.count > 0 ? item.count : 0), 0);
}

function quartzProtection(bot) {
  const armor = [5, 6, 7, 8].map((slot) => bot.inventory.slots?.[slot]?.name).filter(Boolean);
  const goldArmor = armor.some((name) => /^golden_/.test(name));
  return { goldArmor, armorPieces: armor.length, protectionMissing: goldArmor ? [] : ['gold_armor'] };
}

function createNetherQuartzGoal({ bot, count = 16, roam = 96, skills = defaultSkills, actions = defaultActions,
  excavationFactory = (options) => require('../quartzExcavation').createExcavation(options) } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  const blacklist = createBlacklist({ ttlMs: 180000 });
  const memory = { explore: {} };
  const makeTrip = () => createPortalTrip({ bot, memory, actions, walkOnly: true, protectedBridge: true });
  let trip = makeTrip();
  const changed = () => { memory.quartzWorldRevision = (memory.quartzWorldRevision || 0) + 1; memory.quartzRejected?.clear(); };
  bot.on?.('blockUpdate', changed);
  const quartz = (state) => state.inventory.quartz || 0;
  const inOverworld = () => String(bot.game?.dimension || '').replace(/^minecraft:/, '') === 'overworld';
  let excavation, directionProposal, disposed = false, activationEpoch = 0, runSequence = 0, activeRun = null;
  const life = () => memory.quartzDeathEpoch || 0;
  const bodyLife = () => {
    const value = typeof bot.companionBodyLife === 'function' ? bot.companionBodyLife() : null;
    return value?.owner && typeof value.owner === 'object' && Number.isSafeInteger(value.epoch) && value.epoch >= 0 ? value : null;
  };
  const sameBodyLife = (a,b) => (!a && !b) || Boolean(a && b && a.owner === b.owner && a.epoch === b.epoch);
  let observedBodyLife = bodyLife();
  const workEpoch = () => `${activationEpoch}:${life()}:${activeRun?.id || 0}:${activeRun?.controller.signal.aborted ? 1 : 0}`;
  const workCurrent = (epoch = workEpoch()) => Boolean(activeRun && !disposed
    && !activeRun.controller.signal.aborted && sameBodyLife(observedBodyLife, bodyLife()) && epoch === workEpoch());
  function invalidateLifeEvidence(reason) {
    directionProposal = null; memory.quartzBridgeRecovery = null;
    memory.quartzExcavationAtShore = false; delete memory.quartzExcavationAtShoreEpoch;
    if (memory.quartzExcavationPickup) memory.quartzLostPickup = { ...memory.quartzExcavationPickup, reason };
    memory.quartzExcavationPickup = null; memory.quartzExcavationTarget = null;
  }
  const died = () => {
    // This is a local continuation marker, not the authoritative session
    // death counter. The companion's listener increments its own epoch once.
    memory.quartzDeathEpoch = life() + 1; observedBodyLife = bodyLife();
    invalidateLifeEvidence('death_before_pickup');
    activeRun?.controller.abort('quartz_death');
  };
  bot.on?.('death', died);
  function reactivate() {
    // A cached parent is allowed to run this same goal again, but only the
    // caller of a fully joined new run can create fresh listener/scope owners.
    trip = makeTrip(); excavation = undefined; directionProposal = null; activationEpoch++; disposed = false;
    bot.on?.('blockUpdate', changed); bot.on?.('death', died);
  }
  const quarryLedger = () => memory.quartzExcavation;
  function caveFingerprint(position) {
    const s = quarryLedger();
    if (!s) return null;
    const p = position.floored(), blocks = [[0,0,0],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
      .map(([x,y,z]) => bot.blockAt(p.offset(x,y,z)));
    if (blocks.some((b) => !b)) return null;
    return JSON.stringify([keyOf(bot.entity.position), s.surfaceY, (s.route || []).map(keyOf), [...(s.open || [])].sort(),
      blocks.map((b) => [b.name, b.stateId ?? b.type, b.boundingBox, b.shapes])]);
  }
  function caveExclusions() {
    const rejected = new Set(memory.quartzExcavationRejected || []);
    for (const [key, entry] of memory.quartzExcavationCaveRejected || []) {
      if (entry.fingerprint === caveFingerprint(entry.position)) rejected.add(key);
      else memory.quartzExcavationCaveRejected.delete(key);
    }
    return rejected;
  }
  function refuseCave(ctx, position, result) {
    const freshReason = oreSafetyFailure(bot, position, quarryLedger()), fingerprint = caveFingerprint(position);
    memory.quartzExcavationTarget = null;
    const stable = freshReason === 'unconfirmed_cave_at_ore' && fingerprint !== null;
    if (stable) {
      const rejected = memory.quartzExcavationCaveRejected ||= new Map(), key = keyOf(position);
      if (!rejected.has(key) && rejected.size >= 64) rejected.delete(rejected.keys().next().value);
      rejected.set(key, { position: position.clone(), fingerprint });
    }
    ctx.record('quartz_excavation_ore_refused', { target: keyOf(position), actualFront: keyOf(bot.entity.position),
      reason: result.reason, freshReason, classification: stable ? 'stable_cave' : 'uncertain',
      scope: 'actual_front_known_route_open_and_loaded_ore_margin', progress: false, budgetRefunded: false });
    return stable ? result : { ...result, ok: false, progress: false,
      reason: !fingerprint || /unknown/.test(freshReason || '') ? 'quartz_target_unknown' : 'quartz_target_changed' };
  }
  const quarryCredit = () => Math.min(64, quarryLedger()?.used?.feet || 0) + Math.min(192, quarryLedger()?.confirmedDigCredit || 0);
  async function actualExcavationAction(run, success = () => {}) {
    const epoch = workEpoch();
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false, actualExcavationCreditDelta: 0 });
    const before = quarryCredit(), result = await run(), after = quarryCredit();
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false, actualExcavationCreditDelta: 0 });
    if (result.ok) success(life());
    const delta = result.ok ? Math.max(0, after - before) : 0;
    memory.quartzExcavationMilestones = Math.min(256, (memory.quartzExcavationMilestones || 0) + delta);
    return { ...result, progress: delta > 0, actualExcavationCreditDelta: delta };
  }
  async function sameLifeAction(run) {
    const epoch = workEpoch();
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    const result = await run();
    return !workCurrent(epoch) ? fail('quartz_life_changed', { progress: false }) : result;
  }
  function invalidatePickup(ctx, pending, reason) {
    ctx.record('quartz_excavation_drop_invalidated', { reason, position: keyOf(pending.position), before: pending.before,
      oldEpoch: pending.epoch, actualEpoch: life(), pickupCredit: false, budgetRefunded: false });
    memory.quartzExcavationPickup = null; memory.quartzExcavationTarget = null;
  }
  function rememberExcavationReturn(result) {
    const budget = /budget/.test(result.reason || '') || result.reason === 'return_reserve_required';
    if (result.reason === 'needs_usable_pickaxe' || budget) {
      memory.quartzExcavationReturning = true;
      if (budget) memory.quartzExcavationExhausted = true;
    }
    return budget || result.reason === 'needs_usable_pickaxe';
  }

  function quarryEngine() {
    if (!workCurrent()) return undefined;
    if (excavation || !memory.quartzExcavationAnchor) return excavation;
    const anchor = memory.quartzExcavationAnchor;
    excavation = excavationFactory({ bot, memory, shore: anchor.shore, portal: anchor.portal, anchorMode: anchor.anchorMode,
      inspectStep, Vec3, actions, makeGoal: (p) => new goals.GoalBlock(p.x,p.y,p.z), foodCount: quartzFoodCount,
      threatened: () => {
        const observed = perceive(bot);
        return Array.isArray(observed.hostiles) ? observed.hostiles.some((h) => h.distance <= 8
          || (['ghast','blaze','skeleton','wither_skeleton'].includes(h.name) && h.distance <= 24)) : undefined;
      },
      neverBreak: nether.NEVER_BREAK, allowDiamondFallback: false });
    return excavation;
  }

  function prepareExcavation(ctx, home, nearFortress) {
    if (!workCurrent()) return false;
    if (memory.quartzExcavationAnchor) return true;
    const shore = bot.entity.position.floored(), anchorMode = home ? 'portal' : 'shore_only';
    if (shoreSafetyFailure(bot, shore, bot.entity.position, memory.ledgeSupports)) return false;
    const target = chooseExcavationTarget({ bot, portal: home || null, shore, anchorMode, excluded: nearFortress,
      ownedSupports: memory.ledgeSupports });
    ctx.record('quartz_excavation_target_query', { phase: 'cold_proposal', queryOnly: true, ok: target.ok,
      reason: target.reason || null, uncertain: target.uncertain === true, knowledgeSource: target.knowledgeSource,
      checkedCandidates: target.checkedCandidates, unknownCandidates: target.unknownCandidates,
      stableRejectedCount: target.stableRejectedCount, progress: false });
    if (!target.ok) return false;
    // Admission and the first edge happen on the NEXT body run. A completed
    // 12s planning pass never shares its lease with a 20s excavation edge.
    memory.quartzExcavationAnchor = { shore, portal: home?.clone() || null, anchorMode };
    memory.quartzExcavationTarget = target.block.position.clone();
    ctx.record('quartz_excavation_mode', { phase: 'pending_admission', actualShoreConfirmed: false,
      anchorMode, shore: keyOf(shore), portal: home ? keyOf(home) : null, bound: 96,
      noPortalReturnCredit: anchorMode === 'shore_only', target: keyOf(target.block.position),
      caps: { down: 16, flat: 48, feet: 64, digs: 192 } });
    return true;
  }

  async function alignExcavationShore(ctx) {
    const epoch = workEpoch();
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    const anchor = memory.quartzExcavationAnchor;
    if (!anchor || !bot.entity.position.floored().equals(anchor.shore)) return null;
    const offset = () => Math.max(Math.abs(bot.entity.position.x-anchor.shore.x-.5), Math.abs(bot.entity.position.z-anchor.shore.z-.5));
    if (offset() <= .2) return null;
    const failure = shoreSafetyFailure(bot, anchor.shore, bot.entity.position, memory.ledgeSupports);
    if (failure) return fail(failure, { progress: false });
    if (typeof actions.recentre !== 'function') return fail('quartz_shore_not_centered', { progress: false });
    const from = { ...bot.entity.position };
    await actions.recentre(bot, ctx, { accept: (feet, actual) => feet.equals(anchor.shore)
      && !shoreSafetyFailure(bot, anchor.shore, actual, memory.ledgeSupports) });
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    const after = shoreSafetyFailure(bot, anchor.shore, bot.entity.position, memory.ledgeSupports);
    const ok = !after && offset() <= .2;
    ctx.record('quartz_excavation_alignment', { from, actual: { ...bot.entity.position }, shore: keyOf(anchor.shore),
      ok, reason: after || (ok ? null : 'quartz_shore_not_centered'), progress: false });
    return ok ? { ok: true, progress: false, aligned: true } : fail(after || 'quartz_shore_not_centered', { progress: false });
  }

  async function returnExcavation(ctx) {
    const epoch = workEpoch();
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    memory.quartzExcavationReturning = true;
    const bridge = await returnFromConfirmedBridge(ctx);
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    if (bridge) return bridge;
    // A confirmed quarry-to-trip handoff lasts across body runs and joined
    // cancellation. The trip owns fresh bridge/portal admission from here;
    // its legitimate bridge positions are no longer quarry route cells.
    if (memory.quartzExcavationAtShore && memory.quartzExcavationAtShoreEpoch === life()) {
      return memory.netherPortal ? sameLifeAction(() => trip.toOverworld(ctx)) : fail('nether_portal_lost');
    }
    const s = quarryLedger();
    // A pending coordinate proposal has not dug or travelled any quarry
    // edge. Its ordinary trip return must not depend on an invented ledger.
    if (!s) return memory.netherPortal ? trip.toOverworld(ctx) : fail('nether_portal_lost');
    const engine = quarryEngine();
    if (!engine) return fail('quartz_excavation_route_unconfirmed');
    const alignment = await alignExcavationShore(ctx);
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    if (alignment) return alignment;
    const result = await sameLifeAction(() => engine.returnOne(ctx));
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    if (!result.ok || !result.atActualShore) return result;
    const shore = memory.quartzExcavationAnchor?.shore, actual = bot.entity.position;
    const cells = shore && [-1, 0, 1].map((y) => bot.blockAt(shore.offset(0, y, 0)));
    const dangerous = (b) => HAZARD.test(b.name) || b.name === 'bubble_column';
    const standing = cells && fullCube(cells[0]) && !dangerous(cells[0])
      && !/^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/.test(cells[0].name)
      && cells.slice(1).every((b) => b?.boundingBox === 'empty' && b.shapes?.length === 0 && !dangerous(b));
    if (!shore || !bot.entity.onGround || !actual.floored().equals(shore) || Math.abs(actual.y - shore.y) > .02
      || Math.max(Math.abs(actual.x - shore.x - .5), Math.abs(actual.z - shore.z - .5)) > .2 || !standing) {
      return fail('quartz_shore_arrival_unconfirmed', { progress: false });
    }
    // Even a final reverse edge gets its own body run. Only an already
    // observed shore arrival can hand the following run back to the trip.
    if (!memory.quartzExcavationAtShore || memory.quartzExcavationAtShoreEpoch !== life()) {
      memory.quartzExcavationAtShore = true; memory.quartzExcavationAtShoreEpoch = life();
      return { ok: true, progress: false, atActualShore: true };
    }
    if (!memory.netherPortal) return fail('nether_portal_lost', { anchorMode: memory.quartzExcavationAnchor.anchorMode });
    return trip.toOverworld(ctx);
  }

  async function returnFromConfirmedBridge(ctx) {
    const epoch = workEpoch();
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    const witness = memory.quartzBridgeRecovery, s = quarryLedger();
    const onQuarry = s?.route?.some(p => bot.entity.position.floored().equals(p));
    if (!witness && (!s || onQuarry)) return null;
    const admitted = trip.inspectConfirmedBridgeReturn?.(witness);
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    // An arbitrary off-route position keeps the original quarry refusal.
    // Once a recovery intent exists, its fresh failure cannot fall through
    // into an arbitrary quarry join or outward bridge traversal.
    if (!admitted?.ok) return witness ? fail(admitted?.reason || 'bridge_recovery_unavailable', { progress: false }) : null;
    memory.quartzBridgeRecovery = admitted.witness;
    memory.quartzExcavationReturning = true;
    ctx.record('quartz_bridge_recovery', { phase: 'fresh_admission', index: admitted.index,
      actual: { ...bot.entity.position }, actualPortalEndObserved: admitted.actualPortalEndObserved,
      nextTarget: admitted.nextTarget, nextGuardRequired: admitted.nextGuardRequired,
      nativeRetracedReported: false, quarryAtShoreGranted: false, progress: false, budgetRefunded: false });
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    const result = await trip.toOverworld(ctx);
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    if (inOverworld()) {
      memory.quartzBridgeRecovery = null; memory.quartzExcavationReturning = false;
    }
    const endpoint = !inOverworld() && trip.inspectConfirmedBridgeReturn?.(memory.quartzBridgeRecovery);
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    ctx.record('quartz_bridge_recovery', { phase: 'native_result', ok: result.ok, reason: result.reason || null,
      nativeRetracedReported: result.retraced === true, actualOverworldObserved: inOverworld(),
      actualPortalEndObserved: endpoint?.ok === true && endpoint.actualPortalEndObserved === true,
      quarryAtShoreGranted: false, progress: false, budgetRefunded: false });
    return { ...result, progress: false, bridgeRecovery: true };
  }

  async function excavationStep(ctx, state, nearFortress) {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    const epoch = workEpoch();
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    const alignment = await alignExcavationShore(ctx);
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    if (alignment) return alignment;
    const engine = quarryEngine(), s = quarryLedger();
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    if (!engine) return fail('quartz_excavation_unavailable');
    if (s && (s.routeIndex < s.route.length - 1 || !bot.entity.position.floored().equals(s.route.at(-1)))) {
      const result = await sameLifeAction(() => engine.walkKnownOne(ctx, { towards: 'front' }));
      if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
      if (!result.ok) rememberExcavationReturn(result);
      return result;
    }
    const pending = memory.quartzExcavationPickup;
    if (pending && quartz(state) > pending.before) {
      ctx.record('quartz_excavation_pickup', { position: keyOf(pending.position), before: pending.before,
        actual: quartz(state), gained: quartz(state) - pending.before, proof: 'observed_inventory_delta' });
      memory.quartzExcavationPickup = null; memory.quartzExcavationTarget = null;
      return { ok: true, gained: quartz(state) - pending.before };
    }
    if (pending && (pending.epoch !== life() || pending.attempts >= 8)) {
      invalidatePickup(ctx, pending, pending.epoch !== life() ? 'death_before_pickup' : 'pickup_attempt_budget');
      return fail('quartz_pickup_unobserved', { progress: false });
    }
    const anchor = memory.quartzExcavationAnchor;
    let target = memory.quartzExcavationTarget;
    if (!target || (!pending && bot.blockAt(target)?.name !== 'nether_quartz_ore')) {
      const chosen = chooseExcavationTarget({ bot, portal: anchor.portal, shore: anchor.shore, anchorMode: anchor.anchorMode,
        ledger: s, excluded: nearFortress, rejected: caveExclusions(), ownedSupports: memory.ledgeSupports });
      if (!chosen.ok) {
        ctx.record('quartz_excavation_target_query', { phase: 'actual_ledger_proposal', queryOnly: true, ok: false,
          reason: chosen.reason, uncertain: chosen.uncertain === true, knowledgeSource: chosen.knowledgeSource,
          checkedCandidates: chosen.checkedCandidates, unknownCandidates: chosen.unknownCandidates,
          stableRejectedCount: chosen.stableRejectedCount, progress: false });
        if (chosen.uncertain || /unknown|changed|unconfirmed/.test(chosen.reason || '')) {
          return fail(chosen.reason, { progress: false, uncertain: true });
        }
        memory.quartzExcavationReturning = true; memory.quartzExcavationExhausted = true;
        return fail(chosen.reason, { progress: false });
      }
      target = memory.quartzExcavationTarget = chosen.block.position.clone();
      ctx.record('quartz_excavation_target', { target: keyOf(target), from: keyOf(bot.entity.position),
        cost: chosen.cost, options: chosen.options, anchorMode: anchor.anchorMode, queryOnly: true,
        knowledgeSource: chosen.knowledgeSource, safetyClass: chosen.safetyClass });
    }
    // Bind refusals to the selected target. Computing this before selection
    // forgot the first failed mode on the following null-to-target run.
    const scope = `${keyOf(bot.entity.position)}:${keyOf(target)}`;
    if (memory.quartzExcavationHeadingScope !== scope) {
      memory.quartzExcavationHeadingScope = scope; memory.quartzExcavationHeadings = new Set();
    }
    const ore = bot.blockAt(target);
    if (!pending && ore?.name === 'nether_quartz_ore' && quartzVisible(bot, bot.entity.position, ore, true)) {
      const before = quartz(state);
      const result = await actualExcavationAction(() => engine.harvestAtFront(ctx, { position: target,
        validate: ({ position, stage, memory: current }) => {
          const failure = oreSafetyFailure(bot, position, current, stage);
          if (failure) return fail(failure);
          if (stage === 'before' && !quartzVisible(bot, bot.entity.position, bot.blockAt(position), true)) return fail('ore_visibility_changed');
          return { ok: true };
        } }), (epoch) => { memory.quartzExcavationPickup = { position: target.clone(), before, epoch, attempts: 0 }; });
      if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
      if (!result.ok && result.reason === 'unconfirmed_cave_at_ore') return refuseCave(ctx, target, result);
      if (!result.ok && !rememberExcavationReturn(result) && !/aborted|threat|changed|unknown|unconfirmed|lease|profile/.test(result.reason || '')) {
        (memory.quartzExcavationRejected ||= new Set()).add(keyOf(target)); memory.quartzExcavationTarget = null;
      }
      return result;
    }
    const options = excavationDirections(bot.entity.position, target, { used: s?.used,
      visited: s?.routeFeet, rejected: memory.quartzExcavationHeadings });
    if (!options.length) {
      (memory.quartzExcavationRejected ||= new Set()).add(keyOf(target)); memory.quartzExcavationTarget = null;
      if (pending) {
        invalidatePickup(ctx, pending, 'no_safe_pickup_heading');
        memory.quartzExcavationReturning = true; return fail('quartz_drop_not_safely_collectable');
      }
      return fail('quartz_excavation_no_safe_heading');
    }
    let step = options[0];
    // The bounded query gets a separate body run, not50ms plus a fresh20s
    // native edge. A direction proposal is consumed once; actual execution
    // still owns all original fresh stance/geometry/native/lease checks.
    if (typeof engine.proposeDirections === 'function') {
      const proposalScope = `${activationEpoch}:${life()}:${scope}:${options.map(s => s.attemptKey).join(',')}`;
      if (!directionProposal || directionProposal.scope !== proposalScope) {
        const query = engine.proposeDirections(ctx, { candidates: options, current: () => workCurrent(epoch) });
        if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
        const preferred = query.preferred || options[0];
        const proposed = options.find(s => s.direction === preferred.direction && s.descend === preferred.descend);
        if (!proposed) return fail('quartz_direction_proposal_invalid', { progress: false });
        directionProposal = { scope: proposalScope, direction: proposed.direction, descend: proposed.descend, fingerprint: query.fingerprint || null };
        ctx.record('quartz_excavation_continuation', { queryOnly: true, progress: false, actualFrom: keyOf(bot.entity.position), target: keyOf(target),
          selectedDirection: proposed.direction, selectedDescend: proposed.descend, selectedAttemptKey: proposed.attemptKey,
          rankingUncertain: query.rankingUncertain ?? true, orderPolicy: query.orderPolicy || 'original_first_admitted_on_uncertainty',
          stopReason: query.stopReason || query.reason || null, counts: query.counts || null, fingerprint: query.fingerprint || null });
        return { ok: true, progress: false, queryOnly: true, reason: 'quartz_direction_proposed' };
      }
      step = options.find(s => s.direction === directionProposal.direction && s.descend === directionProposal.descend);
      directionProposal = null;
      if (!step) return fail('quartz_direction_proposal_changed', { progress: false });
    }
    // Legacy injected executors retain their original direction contract;
    // the production helper always implements the query API above.
    if (pending) pending.attempts = (pending.attempts || 0) + 1;
    const result = await actualExcavationAction(() => engine.advance(ctx, { direction: step.direction, descend: step.descend }));
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    if (result.ok) { memory.quartzExcavationHeadings.clear(); memory.quartzExcavationRejected?.clear(); }
    else if (!rememberExcavationReturn(result) && !/aborted|threat|changed|unknown|not_at|unconfirmed|lease|profile/.test(result.reason || '')) {
      memory.quartzExcavationHeadings.add(step.attemptKey);
    }
    ctx.record('quartz_excavation_navigation', { stage: 'actual_edge', target: keyOf(target), direction: step.direction,
      descend: step.descend, attemptKey: step.attemptKey, plannedDistanceBefore: step.plannedDistanceBefore,
      plannedDistanceAfter: step.plannedDistanceAfter, plannedOnly: true,
      actual: { ...bot.entity.position }, ok: result.ok, reason: result.reason || null,
      used: quarryLedger()?.used || null, progressCredit: quarryCredit() });
    return result;
  }

  async function overworldStep(ctx, state) {
    const epoch = workEpoch();
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    if (!inOverworld()) return fail('wrong_dimension', { progress: false });
    trip.leaveNetherMode();
    memory.quartzBridgeRecovery = null;
    memory.quartzExcavationReturning = false; memory.quartzExcavationAtShore = false;
    delete memory.quartzExcavationAtShoreEpoch;
    if (quartz(state) >= count) return { ok: true };
    if (memory.quartzExcavationExhausted) return fail('quartz_excavation_budget_or_targets_exhausted');
    // Nothing to mine quartz with: going through would only mean coming back.
    if (!bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'))) return fail('no_pickaxe');
    const food = quartzFoodCount(bot);
    const supplies = { food, requiredFood: QUARTZ_MIN_FOOD, health: Math.round(bot.health), hunger: bot.food, ...quartzProtection(bot) };
    if (food < QUARTZ_MIN_FOOD) {
      ctx.record('needs_supplies', { ...supplies, missing: ['food'], dimension: 'overworld' });
      return fail('needs_supplies', { missing: ['food'], ...supplies });
    }
    // Health comes back on a full stomach; the Nether is no place to wait for it.
    if (bot.health < READY_HEALTH && bot.food >= 18) {
      ctx.record('rest', { health: Math.round(bot.health) });
      await sleep(5000, ctx.signal);
      if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
      return { ok: true, resting: true };
    }
    if (bot.health < READY_HEALTH) {
      ctx.record('needs_supplies', { ...supplies, missing: ['health'], dimension: 'overworld' });
      return fail('needs_supplies', { missing: ['health'], ...supplies });
    }
    // The far side is a ledge over a lava sea: bring blocks to bridge off it.
    if (memory.ledgeSeen && trip.bridgeBlocks() < LEDGE_BLOCKS) {
      ctx.record('stock_bridge', { have: trip.bridgeBlocks(), want: LEDGE_BLOCKS });
      return skills.gatherOne(bot, ctx, { blocks: isStone, dropMatch: isCobble, blacklist });
    }
    // Gold is used when available, but the flat bootstrap has no natural
    // gold source. Report the remaining protection gap without inventing a
    // successful armour recovery or requiring an unobtainable item.
    trip.setBridgeResupply(false);
    ctx.record('quartz_supplies', supplies);
    return trip.toNether(ctx, state);
  }

  async function netherStep(ctx, state) {
    const epoch = workEpoch();
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    trip.enterNetherMode();
    trip.netherPortal();
    // Returning must win even at the portal-side ledge: leaving that ledge
    // again would reverse the completed bridge return and spend new blocks.
    if (memory.quartzExcavationReturning) return returnExcavation(ctx);
    const bridge = await returnFromConfirmedBridge(ctx);
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    if (bridge) return bridge;
    // Once construction asks for materials, subsequent runs continue home.
    // They must not traverse the partial bridge outward again before restocking.
    if (memory.ledgeResupply) return memory.quartzExcavationAnchor ? returnExcavation(ctx) : trip.toOverworld(ctx);
    // Badly hurt with nothing to eat, or the pickaxe worn out: home, and back when fit.
    const hasPick = bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'));
    const food = quartzFoodCount(bot);
    const retreat = !hasPick || food <= RETREAT_FOOD || (bot.health <= RETREAT_HEALTH && !actions.pickFood?.(bot));
    if (quartz(state) >= count || retreat) {
      if (retreat) ctx.record('retreat', { health: Math.round(bot.health), pickaxe: hasPick, food, reserve: RETREAT_FOOD,
        missing: [...(!hasPick ? ['pickaxe'] : []), ...(food <= RETREAT_FOOD ? ['food'] : [])], ...quartzProtection(bot) });
      if (memory.quartzExcavationAnchor) return returnExcavation(ctx);
      if (!memory.netherPortal) return fail('nether_portal_lost');
      return trip.toOverworld(ctx);
    }
    const home = memory.netherPortal;
    const cells = home && (memory.ledgeTransit || bot.entity.position.distanceTo(home) <= 8) ? trip.ledge() : null;
    if (cells) {
      memory.ledgeSeen = true;
      const off = await trip.leaveLedge(ctx, cells);
      if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
      if (off.ok || off.reason !== 'ledge_no_blocks') return off;
      trip.setBridgeResupply(true);
      ctx.record('ledge_home', { blocks: trip.bridgeBlocks() });
      return trip.toOverworld(ctx);
    }
    if (!memory.fortress) {
      const found = findStructure(bot, 'fortress');
      if (found) {
        memory.fortress = found.position;
        ctx.record('fortress_avoided', { position: `${found.position.x},${found.position.y},${found.position.z}` });
      }
    }
    const nearFortress = (p) => memory.fortress && p.distanceTo(memory.fortress) < FORTRESS_BERTH;
    if (memory.quartzExcavationAnchor) return excavationStep(ctx, state, nearFortress);
    const planningDeadline = Date.now() + 12000;
    const result = await skills.gatherOne(bot, ctx, {
      blocks: isQuartzOre,
      dropMatch: isQuartz,
      blacklist,
      radius: 48,
      selectTarget: (candidates) => selectQuartzTarget(bot, ctx, candidates, memory, planningDeadline),
      navigationTrace: true,
      // Stay within reach of the way home.
      exclude: (p) => (home && p.distanceTo(home) > roam) || nearFortress(p),
    });
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    if (result.ok || (!result.roundComplete && result.reason !== 'no_target_in_range')) return result;
    if (prepareExcavation(ctx, home, nearFortress)) return fail('quartz_excavation_pending', { progress: false });
    const frontier = await exploreNear(ctx, home, planningDeadline);
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    // A completed round survives a spent shared deadline. Next pass sees
    // that same completion immediately and gives the frontier a fresh budget.
    if (frontier.reason !== 'quartz_frontier_pending') memory.quartzRound = null;
    return frontier;
  }

  /** Tries a bounded existing-ground frontier, turning back near the roam limit. */
  async function exploreNear(ctx, home, deadline) {
    const epoch = workEpoch();
    if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
    if (Date.now() >= deadline) return fail('quartz_frontier_pending', { progress: false });
    const m = memory.explore;
    const here = bot.entity.position.clone();
    if (home && here.distanceTo(home) > roam * 0.75) {
      m.heading = Math.atan2(home.z - here.z, home.x - here.x);
      m.blocked = false;
    }
    if (memory.fortress && here.distanceTo(memory.fortress) < FORTRESS_BERTH * 1.5) {
      // Head straight away from the fortress (a little to either side when blocked).
      m.heading = Math.atan2(here.z - memory.fortress.z, here.x - memory.fortress.x) + (m.blocked ? (Math.random() - 0.5) * Math.PI : 0);
      m.blocked = false;
    } else if (m.heading === undefined || m.blocked) {
      m.heading = Math.random() * Math.PI * 2;
      m.blocked = false;
    }
    let queried = 0;
    for (const turn of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const x = Math.round(here.x + Math.cos(m.heading + turn) * 8), z = Math.round(here.z + Math.sin(m.heading + turn) * 8);
      for (let dy = -6; dy <= 6; dy++) {
        const target = new Vec3(x, Math.floor(here.y) + dy, z);
        if ((home && target.distanceTo(home) > Math.max(roam, here.distanceTo(home))) || quartzFootFailure(bot, target)) continue;
        if (queried++ >= 4 || Date.now() >= deadline) break;
        const goal = new goals.GoalBlock(target.x, target.y, target.z);
        const plan = await quartzPathPlan(bot, goal, { signal: ctx.signal, totalMs: Math.min(2000, deadline - Date.now()),
          revision: () => memory.quartzWorldRevision || 0 });
        if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
        ctx.record('quartz_frontier_plan', { phase: 'preflight', executed: false,
          target: keyOf(target), from: { ...here }, pathStatus: plan.pathStatus || null,
          nativePathNodes: plan.nativePathNodes, visitedNodes: plan.visitedNodes, slices: plan.slices,
          firstNativeStatus: plan.firstNativeStatus, contextStable: plan.contextStable, computationComplete: plan.computationComplete,
          queryMs: plan.queryMs, ok: plan.ok, reason: plan.reason || null });
        await new Promise((resolve) => setImmediate(resolve));
        if (ctx.signal?.aborted) throw abortError(ctx.signal);
        if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
        if (!plan.ok || bot.entity.position.distanceTo(here) > .2 || !quartzPathFresh(bot, plan, goal).ok) continue;
        const result = await actions.goTo(bot, ctx, goal, { timeoutMs: 30000, retryNoProgress: false });
        if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
        const moved = bot.entity.position.distanceTo(here);
        ctx.record('gather_navigation', { stage: 'quartz_frontier', target: keyOf(target), from: { ...here }, actual: { ...bot.entity.position },
          pathSource: 'native_replan', preflightPathReused: false,
          ok: result.ok, goalFailure: result.reason || null });
        if (moved < 4) m.blocked = true;
        return moved >= 4 && result.ok ? { ok: true, moved: Math.round(moved), progress: false } : fail(result.reason || 'explore_blocked');
      }
    }
    if (Date.now() >= deadline) return fail('quartz_frontier_pending', { progress: false });
    m.blocked = true;
    return fail('quartz_no_safe_frontier', { progress: false });
  }

  return {
    name: 'nether_quartz',
    target: count,
    noProgressLimit: 20,
    maxRecoveries: 3,
    memory,
    isDone: (state) => quartz(state) >= count && inOverworld(),
    // Portal blocks (0-15), being in the nether (+5), then each quartz.
    progress(state) {
      const q = Math.min(quartz(state), count);
      const inside = nether.inNether(bot);
      return q * 1000 + (memory.quartzExcavationMilestones || 0) + trip.portalProgress() + (inside ? 5 : 0);
    },
    recover() {
      blacklist.clear?.();
      memory.explore = {};
    },
    async run(ctx) {
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      if (activeRun || memory.quartzExcavationLease) return fail('quartz_retirement_pending', { progress: false, blocked: true });
      if (disposed) reactivate();
      const currentBodyLife = bodyLife();
      if (!sameBodyLife(observedBodyLife, currentBodyLife)) {
        // A cached goal had no listener during another task's death. Revoke
        // only stale observations; actual route/spent/durability stay intact.
        memory.quartzDeathEpoch = life() + 1;
        invalidateLifeEvidence('session_life_changed_before_pickup');
        observedBodyLife = currentBodyLife;
      }
      const controller = new AbortController(), owner = { id: ++runSequence, controller };
      activeRun = owner;
      const epoch = workEpoch(), forwardAbort = () => controller.abort(ctx.signal.reason);
      ctx.signal?.addEventListener('abort', forwardAbort, { once: true });
      if (ctx.signal?.aborted) forwardAbort();
      const current = () => activeRun === owner && workCurrent(epoch);
      const scoped = { ...ctx, signal: controller.signal,
        record: (...args) => { if (current()) ctx.record?.(...args); },
        perceive: (...args) => { if (!current()) throw abortError(controller.signal); return ctx.perceive(...args); } };
      try {
        if (memory.quartzLostPickup) {
          const lost = memory.quartzLostPickup; delete memory.quartzLostPickup;
          invalidatePickup(scoped, lost, lost.reason);
        }
        await trip.wearGold(scoped);
        if (controller.signal.aborted) throw abortError(controller.signal);
        if (!workCurrent(epoch)) return fail('quartz_life_changed', { progress: false });
        const state = scoped.perceive();
        const result = await (nether.inNether(bot) ? netherStep(scoped, state) : overworldStep(scoped, state));
        return !workCurrent(epoch) ? fail('quartz_life_changed', { progress: false }) : result;
      } finally {
        ctx.signal?.removeEventListener('abort', forwardAbort);
        controller.abort('quartz_run_settled');
        if (activeRun === owner) activeRun = null;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true; activationEpoch++; directionProposal = null; memory.quartzExcavationPickup = null;
      activeRun?.controller.abort('quartz_goal_retired');
      bot.removeListener?.('death', died); bot.removeListener?.('blockUpdate', changed); trip.dispose();
    },
  };
}

module.exports = { createNetherQuartzGoal, QUARTZ_MIN_FOOD, quartzFoodMatch, quartzFoodCount, quartzProtection,
  quartzPathPlan, selectQuartzTarget };
