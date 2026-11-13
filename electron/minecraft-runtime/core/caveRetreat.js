'use strict';

const { goals } = require('mineflayer-pathfinder');
const { abortError, waitUntil } = require('./confirm');

const SIDES = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const FACES = [...SIDES.map(([x, z]) => [x, 0, z]), [0, 1, 0], [0, -1, 0]];
const FLUID_OR_HAZARD = /^(water|lava|bubble_column|fire|soul_fire|magma_block|cactus|powder_snow|sweet_berry_bush|campfire|soul_campfire)$/;
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/;
const NATURAL = /^(stone|deepslate|tuff|calcite|granite|diorite|andesite|dripstone_block|dirt|grass_block|coarse_dirt|rooted_dirt|podzol|clay|moss_block|snow_block|[a-z_]+_ore)$/;
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

function skyOpen(bot, feet) {
  const head = bot.blockAt(feet.offset(0, 1, 0));
  // Sky light comes from the server's dimension light data and is independent
  // of the time of day. Check the vertical column as well, since the light can
  // enter horizontally or briefly lag a dig.
  if (!open(head) || head.skyLight !== 15) return false;
  const top = (bot.game?.minY ?? -64) + (bot.game?.height ?? 384);
  for (let y = feet.y + 2; y < top; y += 1) {
    const b = bot.blockAt(feet.offset(0, y - feet.y, 0));
    if (!open(b) && !(b?.name.endsWith('_leaves') && !hazard(b))) return false;
  }
  return true;
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

// Find an existing uphill exit before cutting into the wall. Explore only
// loaded, dry ground. The returned path is traversed in short rechecked legs.
function planRetreat(bot, from, home, avoid = () => false, visited = new Set()) {
  const cache = new Map();
  const read = (p) => {
    const cell = key(p);
    if (!cache.has(cell)) cache.set(cell, bot.blockAt(p));
    return cache.get(cell);
  };
  const towardHome = (p) => home ? Math.hypot(p.x - home.x, p.z - home.z) : 0;
  const origin = { feet: from, first: null, distance: 0 };
  const seen = new Set([key(from)]);
  const queue = [origin];
  let openExit = null;
  let staircase = null;
  for (let i = 0; i < queue.length && i < 1400; i += 1) {
    const node = queue[i];
    const { feet, first, distance } = node;
    if (first && read(feet.offset(0, 1, 0))?.skyLight === 15 && skyOpen(bot, feet)) {
      openExit = node;
      break;
    }
    for (const [dx, dz] of SIDES) {
      const side = feet.offset(dx, 0, dz);
      for (const dy of [1, 0, -1]) {
        const next = side.offset(0, dy, 0);
        const id = key(next);
        if (seen.has(id) || distance >= 32 || next.y < from.y - 1 || avoid(next)
          || !standable(read, next)) continue;
        // Check headroom swept by the step, not only the destination.
        if (dy === 1 && !open(read(feet.offset(0, 2, 0)))) continue;
        if (dy === -1 && !open(read(next.offset(0, 2, 0)))) continue;
        seen.add(id);
        queue.push({ feet: next, first: first || next, distance: distance + 1 });
      }
      if (!solid(read(side)) || avoid(side.offset(0, 1, 0))) continue;
      const target = side.offset(0, 1, 0);
      const clearance = [feet.offset(0, 2, 0), side.offset(0, 2, 0), target];
      const statuses = clearance.map((point) => digSafety(bot, read, point));
      if (statuses.some((status) => !status)) continue;
      const digs = clearance.filter((_p, index) => statuses[index] === 'dig');
      if (!digs.length) continue;
      const score = (feet.y - from.y) * 25 - distance - towardHome(target) * 0.4
        - digs.reduce((sum, p) => sum + (read(p).name === 'deepslate' ? 14 : 7), 0)
        - (first && visited.has(key(first)) ? 5 : 0);
      if (!staircase || score > staircase.score) staircase = { first, target, digs, score };
    }
  }
  if (openExit) return { kind: 'walk', target: openExit.first };
  if (staircase?.first) return { kind: 'walk', target: staircase.first };
  if (staircase) return { kind: 'stairs', target: staircase.target, digs: staircase.digs };
  const best = queue.find(({ first, feet }) => first && feet.y > from.y && !visited.has(key(first)));
  return best ? { kind: 'walk', target: best.first } : null;
}

async function walkDry(bot, ctx, actions, goal, { timeoutMs = 5000, maxDrop = 1, avoid = () => false, adjacent } = {}) {
  const movements = bot.pathfinder?.movements;
  if (!movements || typeof movements.getNeighbors !== 'function') return fail('cave_retreat_no_pathfinder');
  const saved = Object.fromEntries(['canDig', 'allowParkour', 'allow1by1towers', 'scafoldingBlocks', 'maxDropDown',
    'infiniteLiquidDropdownDistance', 'getNeighbors'].map((k) => [k, movements[k]]));
  const ownedNeighbors = Object.hasOwn(movements, 'getNeighbors');
  const read = (p) => bot.blockAt(p);
  const guardedNeighbors = function (node) {
    return saved.getNeighbors.call(this, node).filter((move) => !move.toBreak?.length && !move.toPlace?.length
      && !move.parkour && move.y >= node.y - maxDrop && move.y <= node.y + 1 && !avoid(move)
      && (!adjacent || move.equals(adjacent)) && standable(read, move));
  };
  Object.assign(movements, { canDig: false, allowParkour: false, allow1by1towers: false,
    scafoldingBlocks: [], maxDropDown: Math.min(saved.maxDropDown ?? 2, maxDrop + 1),
    infiniteLiquidDropdownDistance: false, getNeighbors: guardedNeighbors });
  try {
    return await actions.goTo(bot, ctx, goal, { timeoutMs, retryNoProgress: false });
  } finally {
    if (movements.getNeighbors === guardedNeighbors) {
      Object.assign(movements, saved);
      if (!ownedNeighbors) delete movements.getNeighbors;
    }
  }
}

async function advanceCaveRetreat(bot, ctx, actions, home, { avoid, visited } = {}) {
  if (ctx.signal?.aborted) throw abortError(ctx.signal);
  const from = bot.entity.position.floored();
  const plan = planRetreat(bot, from, home, avoid, visited);
  if (!plan) return fail('cave_retreat_no_dry_route');
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
  const p = plan.target;
  const result = await walkDry(bot, ctx, actions, new goals.GoalBlock(p.x, p.y, p.z), { avoid, adjacent: p });
  if (result.ok) await waitUntil(() => bot.entity.onGround && bot.entity.position.floored().equals(p), {
    timeoutMs: 500, signal: ctx.signal,
  });
  const to = bot.entity.position.floored();
  if (!result.ok || !to.equals(p) || !bot.entity.onGround || !standable(read, to)) return fail(result.reason || 'cave_retreat_step_unconfirmed');
  return { ok: true, from, to };
}

async function returnFromCave(bot, ctx, actions, home, avoid) {
  const target = home.floored();
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

module.exports = { advanceCaveRetreat, planRetreat, returnFromCave, skyOpen, standable };
