'use strict';

const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { abortError, waitUntil } = require('./confirm');

const SIDES = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const FACES = [...SIDES.map(([x, z]) => [x, 0, z]), [0, 1, 0], [0, -1, 0]];
const FLUID_OR_HAZARD = /^(water|seagrass|tall_seagrass|kelp|kelp_plant|lava|bubble_column|fire|soul_fire|magma_block|cactus|powder_snow|sweet_berry_bush|campfire|soul_campfire)$/;
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/;
const NATURAL = /^(stone|deepslate|tuff|calcite|granite|diorite|andesite|dripstone_block|dirt|grass_block|coarse_dirt|rooted_dirt|podzol|clay|moss_block|snow_block|[a-z_]+_ore)$/;
const CLEARED = Object.freeze({ name: 'air', boundingBox: 'empty', shapes: [] });
const key = (p) => `${p.x},${p.y},${p.z}`;
const fail = (reason) => ({ ok: false, reason });
const hazard = (b) => !b || FLUID_OR_HAZARD.test(b.name) || b.getProperties?.()?.waterlogged === true;
const open = (b) => !hazard(b) && b.boundingBox === 'empty' && !b.shapes?.length;
const solid = (b) => !hazard(b) && b.boundingBox === 'block' && !GRAVITY.test(b.name)
  && b.shapes?.length === 1 && b.shapes[0].length === 6
  && b.shapes[0].every((v, i) => v === [0, 0, 0, 1, 1, 1][i]);

function standable(read, feet) {
  return solid(read(feet.offset(0, -1, 0))) && open(read(feet)) && open(read(feet.offset(0, 1, 0)));
}

function farmlandFooting(read, entity) {
  const at = entity.position;
  const cell = at.floored();
  const block = read(cell);
  const shape = [0, 0, 0, 1, 15 / 16, 1];
  if (!entity.onGround || block?.name !== 'farmland' || hazard(block)
    || block.shapes?.length !== 1 || block.shapes[0].length !== shape.length
    || !block.shapes[0].every((value, i) => value === shape[i]) || Math.abs(at.y - cell.y - shape[4]) > .001
    || !open(read(cell.offset(0, 1, 0))) || !open(read(cell.offset(0, 2, 0)))) return null;
  return at.clone();
}

function skyOpen(bot, feet, { allowLeafCanopy = false } = {}) {
  const head = bot.blockAt(feet.offset(0, 1, 0));
  // Sky light comes from the server's dimension light data and is independent
  // of the time of day. Check the vertical column as well, since the light can
  // enter horizontally or briefly lag a dig.
  if (!open(head)) return false;
  const fullSky = head.skyLight === 15;
  // Live section-light data can report zero beneath a real canopy. In this
  // opt-in mode the loaded column and actual dry leaves provide the proof.
  if (!fullSky && !(allowLeafCanopy && Number.isInteger(head.skyLight) && head.skyLight >= 0 && head.skyLight < 15)) return false;
  let foundLeaves = false;
  const top = (bot.game?.minY ?? -64) + (bot.game?.height ?? 384);
  for (let y = feet.y + 2; y < top; y += 1) {
    const b = bot.blockAt(feet.offset(0, y - feet.y, 0));
    if (open(b)) continue;
    if (!b?.name.endsWith('_leaves') || hazard(b)) return false;
    foundLeaves = true;
  }
  return fullSky || foundLeaves;
}

function digSafety(bot, read, point, { requireReach = false } = {}) {
  const b = read(point);
  if (open(b)) return 'open';
  if (hazard(b) || b.boundingBox !== 'block' || b.diggable !== true || !NATURAL.test(b.name)
    || bot.companionProtectBlock?.(b) || (requireReach && !bot.canDigBlock(b))) return null;
  if (FACES.some(([x, y, z]) => hazard(read(point.offset(x, y, z))))) return null;
  if (GRAVITY.test(read(point.offset(0, 1, 0)).name)) return null;
  return 'dig';
}

// The centre cell can hang over air or water while the grounded hitbox
// overlaps an adjacent dry ledge. Step onto that support before planning up.
function caveFootingBank(bot) {
  const entity = bot.entity;
  const at = entity.position;
  const feet = at.floored();
  const read = (p) => bot.blockAt(p);
  const floor = read(feet.offset(0, -1, 0));
  if (!entity.onGround || entity.isInWater || entity.isInLava || Math.abs(at.y - feet.y) > .02
    || !(open(floor) || floor?.name === 'water') || !open(read(feet)) || !open(read(feet.offset(0, 1, 0)))) return null;
  const radius = (entity.width || .6) / 2;
  for (const [dx, dz] of SIDES) {
    const bank = feet.offset(dx, 0, dz);
    if (!standable(read, bank)) continue;
    if (at.x + radius > bank.x && at.x - radius < bank.x + 1
      && at.z + radius > bank.z && at.z - radius < bank.z + 1) return bank;
  }
  return null;
}

function drySteps(read, feet, minY) {
  const steps = [];
  for (const [dx, dz] of SIDES) for (const dy of [1, 0, -1]) {
    const next = feet.offset(dx, dy, dz);
    if (next.y < minY || !standable(read, next)) continue;
    // Check headroom swept by the step, not only the destination.
    if (dy === 1 && !open(read(feet.offset(0, 2, 0)))) continue;
    if (dy === -1 && !open(read(next.offset(0, 2, 0)))) continue;
    steps.push(next);
  }
  return steps;
}

function retreatExposure(read, position) {
  let openSides = 0;
  let longOpen = 0;
  for (const [dx, dz] of SIDES) {
    const near = position.offset(dx, 0, dz);
    if (!open(read(near)) || !open(read(near.offset(0, 1, 0)))) continue;
    openSides += 1;
    const far = position.offset(3 * dx, 0, 3 * dz);
    const middle = position.offset(2 * dx, 0, 2 * dz);
    if ([middle, far].every((p) => open(read(p)) && open(read(p.offset(0, 1, 0))))) longOpen += 1;
  }
  const tall = [2, 3, 4].every((y) => open(read(position.offset(0, y, 0))));
  return (tall ? 1 : 0) + Math.max(0, openSides - 2) + (longOpen > 1 ? longOpen - 1 : 0);
}

function exposedAfterCut(read, from, target, digs) {
  const cleared = new Set(digs.map(key));
  const projected = (p) => cleared.has(key(p)) ? CLEARED : read(p);
  // The new stairs expose more than their destination: either headroom
  // block can open a side passage before the bot takes the upward step.
  return Math.max(retreatExposure(projected, from), retreatExposure(projected, target));
}

function stairOptions(bot, read, feet, avoid = () => false) {
  const options = [];
  for (const [dx, dz] of SIDES) {
    const side = feet.offset(dx, 0, dz);
    const target = side.offset(0, 1, 0);
    if (!solid(read(side)) || avoid(target)) continue;
    const clearance = [feet.offset(0, 2, 0), side.offset(0, 2, 0), target];
    const statuses = clearance.map((point) => digSafety(bot, read, point));
    if (statuses.some((status) => !status)) continue;
    const digs = clearance.filter((_p, index) => statuses[index] === 'dig');
    options.push({ target, digs });
  }
  return options;
}

// Inspect a few still-unmodified layers, favoring a heading that can keep
// cutting upward behind stone. It is a ranking hint, not permission to dig.
function coveredRun(bot, read, from, depth = 5) {
  let level = [from];
  const seen = new Set([key(from)]);
  let layers = 0;
  while (layers < depth && level.length) {
    const next = [];
    for (const feet of level) for (const { target } of stairOptions(bot, read, feet)) {
      const id = key(target);
      if (seen.has(id) || retreatExposure(read, target) > 0) continue;
      seen.add(id);
      next.push(target);
    }
    if (!next.length) break;
    level = next;
    layers += 1;
  }
  return layers;
}

// Find an existing uphill exit before cutting into the wall. Explore only
// loaded, dry ground. The returned path is traversed in short rechecked legs.
function planRetreat(bot, from, home, avoid = () => false, visited = new Set(), risk = () => 0, surfaceFloor = -Infinity) {
  const cache = new Map();
  const read = (p) => {
    const cell = key(p);
    if (!cache.has(cell)) cache.set(cell, bot.blockAt(p));
    return cache.get(cell);
  };
  const towardHome = (p) => home ? Math.hypot(p.x - home.x, p.z - home.z) : 0;
  const origin = { feet: from, first: null, distance: 0, risk: 0 };
  const seen = new Set([key(from)]);
  const queue = [origin];
  let openExit = null;
  let staircase = null;
  const exposure = (p) => retreatExposure(read, p) * 60;
  const cutExposure = (feet, target, digs) => exposedAfterCut(read, feet, target, digs) * 60;
  const covered = new Map();
  const stairScore = ({ target, digs }) => {
    const id = key(target);
    if (!covered.has(id)) covered.set(id, coveredRun(bot, read, target));
    return covered.get(id) * 8 - cutExposure(from, target, digs)
      - risk(target) - towardHome(target) * 0.4 - digs.length * 7;
  };
  for (let i = 0; i < queue.length && i < 1400; i += 1) {
    const node = queue[i];
    const { feet, first, distance } = node;
    if (first && feet.y >= surfaceFloor && read(feet.offset(0, 1, 0))?.skyLight === 15 && skyOpen(bot, feet)) {
      if (!openExit || distance + node.risk < openExit.distance + openExit.risk) openExit = node;
      if (!node.risk) break;
    }
    if (distance < 14) for (const next of drySteps(read, feet, from.y - 1)) {
      const id = key(next);
      if (seen.has(id) || avoid(next)) continue;
      seen.add(id);
      queue.push({ feet: next, first: first || next, distance: distance + 1,
        risk: node.risk + risk(next) + exposure(next) });
    }
    for (const { target, digs } of stairOptions(bot, read, feet, avoid)) {
      if (!digs.length) continue;
      const score = (feet.y - from.y) * 25 - distance - towardHome(target) * 0.4
        - digs.reduce((sum, p) => sum + (read(p).name === 'deepslate' ? 14 : 7), 0)
        - node.risk - risk(target) - cutExposure(feet, target, digs)
        - (first && visited.has(key(first)) ? 5 : 0);
      if (!staircase || score > staircase.score) staircase = { first, target, digs, score };
    }
  }
  if (openExit) return { kind: 'walk', target: openExit.first };
  if (staircase?.first) return { kind: 'walk', target: staircase.first };
  if (staircase) {
    const better = stairOptions(bot, read, from, avoid).filter(({ digs }) => digs.length)
      .sort((a, b) => stairScore(b) - stairScore(a))[0];
    return { kind: 'stairs', target: better.target, digs: better.digs };
  }
  const best = queue.find(({ first, feet }) => first && feet.y > from.y && !visited.has(key(first)));
  return best ? { kind: 'walk', target: best.first } : null;
}

async function walkDry(bot, ctx, actions, goal, { timeoutMs = 5000, maxDrop = 1, avoid = () => false, adjacent, arrived,
  supports = standable } = {}) {
  const movements = bot.pathfinder?.movements;
  if (!movements || typeof movements.getNeighbors !== 'function') return fail('cave_retreat_no_pathfinder');
  const saved = Object.fromEntries(['canDig', 'allowParkour', 'allow1by1towers', 'scafoldingBlocks', 'maxDropDown',
    'infiniteLiquidDropdownDistance', 'getNeighbors'].map((k) => [k, movements[k]]));
  const ownedNeighbors = Object.hasOwn(movements, 'getNeighbors');
  const read = (p) => bot.blockAt(p);
  const guardedNeighbors = function (node) {
    return saved.getNeighbors.call(this, node).filter((move) => !move.toBreak?.length && !move.toPlace?.length
      && !move.parkour && move.y >= node.y - maxDrop && move.y <= node.y + 1 && !avoid(move)
      && (!adjacent || move.equals(adjacent)) && supports(read, move));
  };
  Object.assign(movements, { canDig: false, allowParkour: false, allow1by1towers: false,
    scafoldingBlocks: [], maxDropDown: Math.min(saved.maxDropDown ?? 2, maxDrop + 1),
    infiniteLiquidDropdownDistance: false, getNeighbors: guardedNeighbors });
  try {
    return await actions.goTo(bot, ctx, goal, { timeoutMs, retryNoProgress: false, ...(arrived ? { arrived } : {}) });
  } finally {
    if (movements.getNeighbors === guardedNeighbors) {
      Object.assign(movements, saved);
      if (!ownedNeighbors) delete movements.getNeighbors;
    }
  }
}

const CAVE_BRIDGE_BLOCKS = /^(cobblestone|cobbled_deepslate|dirt)$/;
const CAVE_BRIDGE_LIMIT = 6;

function caveBridgePlan(bot, from, home, avoid) {
  const read = (p) => bot.blockAt(p);
  if (!standable(read, from)) return null;
  const available = bot.inventory.items().reduce((count, item) => count + (CAVE_BRIDGE_BLOCKS.test(item.name) ? item.count : 0), 0);
  const footprint = [{ feet: from, first: null, distance: 0 }];
  const seen = new Set([key(from)]);
  let plan = null;
  for (const node of footprint) {
    for (const [dx, dz] of SIDES) {
      const direction = new Vec3(dx, 0, dz);
      if (node.distance < 2) {
        const adjacent = node.feet.plus(direction);
        if (!seen.has(key(adjacent)) && !avoid(adjacent) && standable(read, adjacent)) {
          seen.add(key(adjacent));
          footprint.push({ feet: adjacent, first: node.first || adjacent, distance: node.distance + 1 });
        }
      }
      for (let gap = 0; gap <= Math.min(CAVE_BRIDGE_LIMIT, available); gap += 1) {
        const feet = node.feet.plus(direction.scaled(gap + 1));
        const floor = read(feet.offset(0, -1, 0));
        if (!open(read(feet)) || !open(read(feet.offset(0, 1, 0))) || hazard(floor) || avoid(feet)
          || FACES.some(([x, y, z]) => hazard(read(feet.offset(x, y, z))))) break;
        if (open(floor)) continue;
        if (gap && standable(read, feet) && planRetreat(bot, feet, home, avoid)) {
          const next = { bank: feet, first: node.first, distance: node.distance, gap };
          if (!plan || next.gap < plan.gap || next.gap === plan.gap && next.distance < plan.distance) plan = next;
        }
        break;
      }
    }
  }
  return plan;
}

async function bridgeCaveGap(bot, ctx, actions, from, home, avoid = () => false) {
  const read = (p) => bot.blockAt(p);
  const quiet = () => {
    const state = ctx.perceive();
    return state.health >= 12 && state.food >= 12 && !state.inWater && !(state.hostiles || []).some((h) => h.distance <= 16);
  };
  if (!bot.entity.onGround || bot.entity.isInLava || !quiet()) return fail('cave_retreat_no_dry_route');
  const plan = caveBridgePlan(bot, from, home, avoid);
  if (!plan) return fail('cave_retreat_no_dry_route');
  if (plan.first) return stepDry(bot, ctx, actions, plan.first, avoid);
  const direction = new Vec3(Math.sign(plan.bank.x - from.x), 0, Math.sign(plan.bank.z - from.z));
  const prefix = [from];
  const retreat = async (failure) => {
    while (quiet() && prefix.length > 1 && prefix.at(-1).equals(bot.entity.position.floored())) {
      prefix.pop();
      const walked = await stepDry(bot, ctx, actions, prefix.at(-1), avoid);
      if (!walked.ok) break;
    }
    return failure;
  };
  for (let i = 1; i <= plan.gap + 1; i += 1) {
    const previous = prefix.at(-1);
    const next = previous.plus(direction);
    const validateNext = ({ feet, ahead, phase }) => {
      const at = bot.entity.position.floored();
      const mayStand = phase === 'before_clear' ? !hazard(read(next.offset(0, -1, 0))) : standable(read, next);
      return quiet() && bot.entity.onGround && !bot.entity.isInLava && (at.equals(previous) || at.equals(next))
        && feet.equals(previous) && ahead.equals(next) && !avoid(next) && standable(read, at)
        && mayStand && open(read(next)) && open(read(next.offset(0, 1, 0))) && standable(read, plan.bank)
        && !FACES.some(([x, y, z]) => hazard(read(next.offset(x, y, z))))
        ? { ok: true } : fail('cave_bridge_changed');
    };
    const step = await require('./end').bridgeStep(bot, ctx, plan.bank.offset(.5, 0, .5),
      { blocks: CAVE_BRIDGE_BLOCKS, avoidLiquids: true, keepWalls: true, validateNext });
    const reached = bot.entity.onGround && next.equals(bot.entity.position.floored()) && standable(read, next);
    if (reached) prefix.push(next);
    if (!step.ok || !reached) return retreat(step.ok ? fail('cave_bridge_unconfirmed') : step);
  }
  ctx.record('cave_retreat_bridge', { from, to: plan.bank, gap: plan.gap });
  return { ok: true, from, to: plan.bank };
}

async function advanceCaveRetreat(bot, ctx, actions, home, { avoid, visited, risk, bridgeGap = false, surfaceFloor } = {}) {
  if (ctx.signal?.aborted) throw abortError(ctx.signal);
  const from = bot.entity.position.floored();
  const bank = caveFootingBank(bot);
  if (bank) {
    if (avoid?.(bank)) return fail('cave_retreat_bank_unsafe');
    const result = await stepDry(bot, ctx, actions, bank, avoid, 0);
    return result.ok ? { ...result, from } : result;
  }
  const plan = planRetreat(bot, from, home, avoid, visited, risk, surfaceFloor);
  if (!plan) return bridgeGap ? bridgeCaveGap(bot, ctx, actions, from, home, avoid) : fail('cave_retreat_no_dry_route');
  const read = (p) => bot.blockAt(p);
  if (plan.kind === 'stairs') {
    // One block per invocation. The next invocation uses a fresh terrain and
    // threat snapshot, so a fluid change cannot authorize the rest of a cut.
    const dig = plan.digs[0];
    if (digSafety(bot, read, dig, { requireReach: true }) !== 'dig' || avoid?.(from)) return fail('cave_retreat_cut_changed');
    const digMs = bot.digTime?.(read(dig));
    const result = await actions.digBlock(bot, ctx, read(dig), { timeoutMs: Math.min(30000, Math.max(8000, (digMs || 0) + 3000)) });
    if (!result.ok || !open(read(dig))) return fail(result.reason || 'cave_retreat_cut_unconfirmed');
    ctx.record('cave_retreat_cut', { from, block: dig, toward: plan.target });
    return { ok: true, dug: true, from, to: from };
  }
  const result = await stepDry(bot, ctx, actions, plan.target, avoid);
  return result.ok ? { ...result, from } : result;
}

async function stepDry(bot, ctx, actions, p, avoid, maxDrop) {
  const read = (point) => bot.blockAt(point);
  const result = await walkDry(bot, ctx, actions, new goals.GoalBlock(p.x, p.y, p.z), { avoid, adjacent: p, maxDrop });
  if (result.ok || result.reason === 'not_arrived') await waitUntil(() => bot.entity.onGround && bot.entity.position.floored().equals(p), {
    timeoutMs: 500, signal: ctx.signal,
  });
  const to = bot.entity.position.floored();
  if (!(result.ok || result.reason === 'not_arrived') || !to.equals(p) || !bot.entity.onGround
    || !standable(read, to) || avoid?.(to)) return fail(result.reason || 'cave_retreat_step_unconfirmed');
  return { ok: true, to };
}

// Prefer breaking line of sight and keeping altitude over maximizing distance
// to a point the mob already left. The caller keeps its separate ascent plan.
async function evadeInCave(bot, ctx, actions, threat, visible, liveThreat, { allowDescend = true, ranged = false } = {}) {
  const read = (p) => bot.blockAt(p);
  const feet = bot.entity.position.floored();
  const farm = !allowDescend && farmlandFooting(read, bot.entity);
  const from = farm ? feet.offset(0, 1, 0) : feet;
  if (!allowDescend && !farm && (!bot.entity.onGround || !standable(read, from))) return fail('cave_evasion_no_safe_step');
  const point = (p) => p.offset(.5, 0, .5);
  const start = allowDescend ? point(from) : bot.entity.position.clone();
  const distance = (p) => point(p).distanceTo(threat.position);
  const startDistance = start.distanceTo(threat.position);
  ctx.record('cave_evasion_threat', { from: feet, threat: threat.name, id: threat.id, mobAt: threat.position, distance: startDistance,
    ...(farm ? { partialFloor: 'farmland' } : {}) });
  const queue = [{ p: from, first: null, edges: 0 }];
  const seen = new Set([key(from)]);
  let best = null;
  let coveredAscent = null;
  for (let i = 0; i < queue.length && i < 180; i += 1) {
    const { p, first, edges } = queue[i];
    if (first) {
      const range = distance(p);
      const covered = !visible(threat, point(p));
      const score = ranged
        ? Number(covered) * 14 + range - edges * .5
        : Number(covered) * 14 + Math.min(range, 10) + (p.y - from.y) * 4 - edges * 1.5;
      if ((range >= startDistance + .3 || (covered && range >= 2.5)) && (!best || score > best.score)) {
        best = { first, score };
      }
    }
    if (edges >= 6) continue;
    for (const next of drySteps(read, p, allowDescend ? from.y - 1 : p.y)) {
      const id = key(next);
      const range = distance(next);
      if (seen.has(id) || range < Math.min(2.5, startDistance) || (farm && !first && next.y !== from.y)) continue;
      // The distance gain of the open stair down is temporary if the same
      // pursuer can follow. Advance into an immediately covered uphill cell
      // outside striking range, even when the straight-line gap shrinks.
      if (allowDescend && !ranged && !first && next.y > from.y && range >= 2.5 && !visible(threat, point(next))) {
        if (!coveredAscent || range > coveredAscent.range) coveredAscent = { first: next, range };
      }
      if (!first && range < startDistance - (ranged ? .05 : .35)) continue;
      seen.add(id);
      queue.push({ p: next, first: first || next, edges: edges + 1 });
    }
  }
  if (!best && !coveredAscent) return fail('cave_evasion_no_safe_step');
  const take = (target, coverRequired) => stepDry(bot, ctx, actions, target, (p) => {
    const live = liveThreat(threat.id);
    if (!live) return false;
    if (coverRequired) return point(p).distanceTo(live.position) < 2.5 || visible(live, point(p));
    const margin = ranged ? start.distanceTo(live.position) - .05 : Math.min(2.5, start.distanceTo(live.position));
    return point(p).distanceTo(live.position) < margin;
  }, allowDescend ? 1 : 0);
  let result = coveredAscent ? await take(coveredAscent.first, true) : null;
  // If the pocket stopped being safe before movement, keep the existing
  // dry escape choice. A partially executed step belongs to the next tick.
  if (best && (!result || !result.ok && bot.entity.onGround && bot.entity.position.floored().equals(feet))) {
    result = await take(best.first, false);
  }
  if (!result) return fail('cave_evasion_no_safe_step');
  const current = liveThreat(threat.id);
  if (result.ok) ctx.record('cave_evasion_step', { from: feet, to: result.to, threat: threat.name, id: threat.id,
    mobAt: current?.position ?? null, distance: current ? point(result.to).distanceTo(current.position) : null });
  return result;
}

async function returnFromCave(bot, ctx, actions, home, avoid) {
  const target = new Vec3(home.x, home.y, home.z).floored();
  const atHome = (at) => Math.abs(at.y - home.y) <= 2 && Math.hypot(at.x - home.x, at.z - home.z) <= 5
    && standable((p) => bot.blockAt(p), at.floored());
  if (atHome(bot.entity.position) && bot.entity.onGround) return { ok: true, atHome: true };
  const goal = new goals.GoalNear(target.x, target.y, target.z, 4);
  const result = await walkDry(bot, ctx, actions, goal, { avoid, timeoutMs: 16000 });
  if (result.ok) await waitUntil(() => atHome(bot.entity.position) && bot.entity.onGround, {
    timeoutMs: 500, signal: ctx.signal,
  });
  return atHome(bot.entity.position) && bot.entity.onGround
    ? { ok: true, atHome: true } : fail(result.reason || 'cave_retreat_home_unconfirmed');
}

module.exports = { advanceCaveRetreat, caveFootingBank, evadeInCave, farmlandFooting, planRetreat, returnFromCave, skyOpen, standable, walkDry };
