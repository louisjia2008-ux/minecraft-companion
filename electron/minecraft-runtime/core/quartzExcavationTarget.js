'use strict';
// Coordinate planning only. This never authorizes a dig or movement: the
// executor must freshly admit each actual edge and each ore harvest.
const { Vec3 } = require('vec3');

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const feet = (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
const HAZARD = /^(water|lava|bubble_column|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|powder_snow|nether_portal)$/;
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/;
const ROCK = new Set(['basalt','polished_basalt','smooth_basalt','netherrack','blackstone','polished_blackstone']);
const full = (b) => b?.boundingBox === 'block' && b.shapes?.length === 1 && b.shapes[0].length === 6
  && b.shapes[0].every((n,i) => n === [0,0,0,1,1,1][i]);

function targetCost(from, ore, used = {}) {
  const horizontal = Math.abs(from.x - ore.x) + Math.abs(from.z - ore.z);
  const down = Math.max(0, from.y - ore.y);
  // Each descent also advances one horizontal cell. When directly above a
  // deep target, additional cardinal legs are necessary; no vertical shaft.
  const edges = horizontal + 2 * Math.ceil(Math.max(0, down - horizontal) / 2);
  const flat = Math.max(0, edges - down);
  if (ore.y > from.y + 1 || down + (used.down || 0) > 16
    || flat + (used.flat || 0) > 48 || edges + (used.feet || 0) > 64) return null;
  return { edges, down, flat, score: edges + down * .1 };
}

function chooseExcavationTarget({ bot, portal, shore, anchorMode = 'portal', ledger, ownedSupports = new Set(),
  excluded = () => false, rejected = new Set() }) {
  const query = { queryOnly: true, progress: false, knowledgeSource: null, checkedCandidates: 0,
    unknownCandidates: 0, stableRejectedCount: 0, stableRejections: [] };
  const refuse = (reason, uncertain = false) => ({ ok: false, reason, uncertain, ...query });
  const shoreOnly = anchorMode === 'shore_only' && !portal;
  if (!['portal','shore_only'].includes(anchorMode) || (anchorMode === 'shore_only' && portal)
    || !shore || (!shoreOnly && (!portal || bot.blockAt(portal)?.name !== 'nether_portal')) || !bot.entity.onGround) {
    return refuse('excavation_anchor_unconfirmed', true);
  }
  let knowledge;
  const hasRouteKnowledge = ledger && (ledger.route !== undefined || ledger.open !== undefined || ledger.surfaceY !== undefined);
  if (hasRouteKnowledge) {
    if (!Array.isArray(ledger.route) || !(ledger.open instanceof Set) || !(ledger.protectedFloors instanceof Set)
      || !Number.isFinite(ledger.surfaceY)) return refuse('quartz_target_unknown', true);
    knowledge = ledger; query.knowledgeSource = 'actual_quarry_ledger';
  } else {
    // A cold query is allowed only at an independently fresh actual shore.
    // This local planning view is never installed as an executor ledger or
    // credited as a route: only the observed feet/head air and floor are known.
    if (shoreSafetyFailure(bot, shore, bot.entity.position, ownedSupports)) return refuse('quartz_target_unknown', true);
    const actualShore = feet(shore);
    knowledge = { surfaceY: actualShore.y, route: [], open: new Set([key(actualShore), key(actualShore.offset(0, 1, 0))]),
      protectedFloors: new Set([key(actualShore.offset(0, -1, 0))]) };
    query.knowledgeSource = 'fresh_actual_shore_only';
  }
  const anchor = shoreOnly ? shore : portal;
  const from = feet(bot.entity.position), protectedFloors = ledger?.protectedFloors || new Set([key(feet(shore).offset(0, -1, 0))]);
  const id = bot.registry.blocksByName.nether_quartz_ore?.id;
  const found = id === undefined ? [] : bot.findBlocks({ matching: id, maxDistance: 48, count: 64 });
  if (!Array.isArray(found)) return refuse('quartz_target_unknown', true);
  const options = [], seen = new Set();
  for (const position of found.slice(0, 64)) {
    const p = feet(position), coordinate = key(p), cost = targetCost(from, p, ledger?.used);
    if (seen.has(coordinate)) continue;
    seen.add(coordinate);
    if (!cost || rejected.has(coordinate) || protectedFloors.has(coordinate) || p.distanceTo(anchor) > 96
      || shore.y - p.y > 16 || excluded(p) || bot.companionPlacedRecently?.(p)) continue;
    const block = bot.blockAt(p);
    query.checkedCandidates++;
    if (!block || block.name !== 'nether_quartz_ore') { query.unknownCandidates++; continue; }
    if (bot.companionProtectBlock?.(block)) continue;
    // Reuse the exact action safety predicate. Capture its read-only evidence
    // to rank buried ore without a second, potentially changed neighbour scan.
    const observed = new Map();
    const reason = oreSafetyFailure({
      blockAt: (at) => { const b = bot.blockAt(at); observed.set(key(at), b); return b; },
      companionProtectBlock: bot.companionProtectBlock?.bind(bot),
      companionPlacedRecently: bot.companionPlacedRecently?.bind(bot),
    }, p, knowledge);
    if (reason) {
      if (/^unknown_|changed/.test(reason)) query.unknownCandidates++;
      else { query.stableRejectedCount++; query.stableRejections.push({ position: coordinate, reason }); }
      continue;
    }
    const buried = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
      .every(([x,y,z]) => full(observed.get(key(p.offset(x,y,z)))));
    options.push({ block: observed.get(coordinate), cost, safetyClass: buried ? 'six_solid_neighbors' : 'original_guard_pass', rank: buried ? 0 : 1 });
  }
  options.sort((a, b) => a.rank - b.rank || a.cost.score - b.cost.score || key(a.block.position).localeCompare(key(b.block.position)));
  if (options.length) return { ok: true, ...query, block: options[0].block, cost: options[0].cost,
    safetyClass: options[0].safetyClass, options: options.length, anchorMode };
  if (query.unknownCandidates) return refuse('quartz_target_unknown', true);
  return refuse(query.stableRejectedCount ? 'no_safe_excavation_target' : 'no_bounded_excavation_target');
}

function excavationDirections(from, target, { used = {}, visited = new Set(), rejected = new Set() } = {}) {
  from = feet(from); target = feet(target);
  if ((used.feet || 0) >= 64) return [];
  const distance = (p) => Math.abs(p.x - target.x) + Math.abs(p.y - target.y) + Math.abs(p.z - target.z);
  const plannedDistanceBefore = distance(from);
  // An unsafe immediate stair does not rule out a same-height approach to
  // another entrance. Each mode is only a proposal: the unchanged executor
  // must admit its actual floor, cave margins, tool and return reserves.
  return (from.y > target.y ? [true, false] : [false]).flatMap((descend) => {
    if ((used[descend ? 'down' : 'flat'] || 0) >= (descend ? 16 : 48)) return [];
    return DIRS.map(([x, z], direction) => {
      const next = from.offset(x, descend ? -1 : 0, z), plannedDistanceAfter = distance(next);
      return { direction, descend, next, attemptKey: `${direction}:${descend ? 'down' : 'flat'}`,
        score: plannedDistanceAfter, plannedDistanceBefore, plannedDistanceAfter };
    });
  }).filter((step) => !visited.has(key(step.next)) && !rejected.has(step.direction) && !rejected.has(step.attemptKey))
    .sort((a, b) => Number(b.descend) - Number(a.descend) || a.score - b.score || a.direction - b.direction);
}

function oreSafetyFailure(bot, position, ledger, stage = 'before') {
  const p = feet(position), block = bot.blockAt(p);
  if (!block) return 'unknown_ore';
  if (!ledger || ledger.protectedFloors?.has(key(p)) || bot.companionProtectBlock?.(block)
    || bot.companionPlacedRecently?.(p)) return 'protected_ore_or_route_floor';
  if (stage === 'before' ? block.name !== 'nether_quartz_ore' || !full(block)
    : block.boundingBox !== 'empty' || block.shapes?.length !== 0 || HAZARD.test(block.name)) return 'ore_or_open_changed';
  const known = (cell) => ledger.open?.has(key(cell)) || ledger.route?.some((r) => [0,1,2].some(y => key(r.offset(0,y,0)) === key(cell)));
  for (const [x,y,z] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
    const cell=p.offset(x,y,z), next=bot.blockAt(cell);
    if (!next) return 'unknown_ore_margin';
    if (HAZARD.test(next.name) || GRAVITY.test(next.name)) return 'hazard_or_gravity_ore_margin';
    if (next.boundingBox === 'empty' && cell.y < ledger.surfaceY && !known(cell)) return 'unconfirmed_cave_at_ore';
  }
  return null;
}

function shoreSafetyFailure(bot, shore, actual = bot.entity.position, ownedSupports = new Set()) {
  shore=feet(shore);
  if (!bot.entity.onGround || !feet(actual).equals(shore) || Math.abs(actual.y-shore.y)>.02) return 'shore_not_actual_grounded';
  const stand = (p) => {
    const floor=bot.blockAt(p.offset(0,-1,0));
    return full(floor) && ROCK.has(floor.name) && !ownedSupports.has(key(floor.position)) && !bot.companionPlacedRecently?.(floor.position)
      && [0,1].every(y=>{const b=bot.blockAt(p.offset(0,y,0));return b?.boundingBox==='empty'&&b.shapes?.length===0&&!HAZARD.test(b.name);});
  };
  const patch=[[-1,-1],[-1,0],[0,-1],[0,0]].some(([x,z])=>[0,1].every(dx=>[0,1].every(dz=>stand(shore.offset(x+dx,0,z+dz)))));
  if (!patch) return 'shore_natural_patch_unconfirmed';
  // The centre segment stays inside this loaded, supported body sweep. A
  // neighbouring fire is still contact even when the feet cell itself is air.
  const half=.3, centre=shore.offset(.5,0,.5);
  for(let x=Math.floor(Math.min(actual.x,centre.x)-half+1e-8);x<=Math.floor(Math.max(actual.x,centre.x)+half-1e-8);x++){
    for(let z=Math.floor(Math.min(actual.z,centre.z)-half+1e-8);z<=Math.floor(Math.max(actual.z,centre.z)+half-1e-8);z++){
      if(!stand(new Vec3(x,shore.y,z)))return 'shore_body_sweep_unsafe';
    }
  }
  return null;
}

module.exports = { chooseExcavationTarget, excavationDirections, targetCost, oreSafetyFailure, shoreSafetyFailure };
