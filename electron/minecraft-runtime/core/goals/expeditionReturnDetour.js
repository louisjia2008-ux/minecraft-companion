'use strict';

const { Vec3 } = require('vec3');
const { goals, Movements } = require('mineflayer-pathfinder');
const { standable } = require('../caveRetreat');
const { abortError, sleep, waitUntil } = require('../confirm');

const MAX_DROP = 3;
const MAX_STEPS = 72;
const MAX_OFFSET = 24;
const MAX_HOME_DETOUR = 16;
const HOME_PROGRESS = 8;
const UNSAFE = /^(water|lava|bubble_column|nether_portal|end_portal|end_gateway|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|powder_snow|sweet_berry_bush)$/;
const point = ({ x, y, z }) => new Vec3(x, y, z);
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const failure = (reason) => ({ ok: false, reason });

function createExpeditionReturnDetour({ bot, centre, floor, exposed, actions, safe }) {
  const read = (p) => bot.blockAt(p);
  const clear = (p) => {
    const b = read(p);
    return b && b.boundingBox === 'empty' && !b.shapes?.length && !UNSAFE.test(b.name)
      && b.getProperties?.()?.waterlogged !== true;
  };
  const foothold = (p) => p.y >= floor && standable(read, p)
    && !read(p.offset(0, -1, 0)).name.endsWith('_leaves') && clear(p) && clear(p.offset(0, 1, 0));
  const safeEdge = (from, to) => {
    const dy = to.y - from.y;
    if (Math.abs(to.x - from.x) + Math.abs(to.z - from.z) !== 1 || dy > 1 || dy < -MAX_DROP
      || !foothold(from) || !foothold(to)) return false;
    if (dy > 0) return clear(from.offset(0, 2, 0));
    for (let y = 2; y <= -dy + 1; y += 1) if (!clear(to.offset(0, y, 0))) return false;
    return true;
  };
  let trail = null;
  let retryAt = 0;

  function profile(legal) {
    const movement = new Movements(bot);
    const neighbors = movement.getNeighbors;
    Object.assign(movement, {
      allowFreeMotion: false, allowParkour: false, allowSprinting: false, allow1by1towers: false,
      canDig: false, scafoldingBlocks: [], maxDropDown: MAX_DROP + 1, infiniteLiquidDropdownDistance: false,
      getMoveDiagonal() {},
      getNeighbors(node) {
        return neighbors.call(this, node).filter((move) => !move.toBreak.length && !move.toPlace.length
          && !move.parkour && legal(node, move) && safeEdge(node, move));
      },
    });
    return movement;
  }

  async function plan(ctx) {
    const pathfinder = bot.pathfinder;
    if (typeof pathfinder?.getPathFromTo !== 'function' || typeof pathfinder.setMovements !== 'function'
      || !bot.registry?.blocksArray || Date.now() < retryAt || !safe(ctx.perceive(), true)) return false;
    const start = bot.entity.position.floored();
    if (!bot.entity.onGround || !foothold(start) || !exposed(start)) return false;
    retryAt = Date.now() + 30000;
    const homeRadius = horizontal(start, centre);
    const goal = {
      heuristic: (p) => Math.max(0, horizontal(p, centre) - homeRadius + HOME_PROGRESS),
      isEnd: (p) => horizontal(p, centre) <= homeRadius - HOME_PROGRESS && exposed(p),
    };
    const inBounds = (_from, to) => to.y <= start.y && horizontal(to, start) <= MAX_OFFSET
      && horizontal(to, centre) <= homeRadius + MAX_HOME_DETOUR;
    const planner = pathfinder.getPathFromTo(profile(inBounds), bot.entity.position, goal,
      { optimizePath: false, timeout: 800, tickTimeout: 12, searchRadius: MAX_STEPS + 12 });

    for (const { result } of planner) {
      if (!safe(ctx.perceive(), true) || !bot.entity.onGround || !bot.entity.position.floored().equals(start)) return false;
      if (result.status === 'partial') {
        await sleep(0, ctx.signal);
        continue;
      }
      if (result.status !== 'success' || !result.path.length || result.path.length > MAX_STEPS) return false;
      trail = [start, ...result.path.map(point)];
      ctx.record('expedition_food_return_detour', { from: start, to: trail.at(-1), steps: result.path.length });
      return true;
    }
    return false;
  }

  async function advance(ctx) {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    if (!bot.entity.onGround || !safe(ctx.perceive())) {
      await sleep(150, ctx.signal);
      return { ok: true, waited: true, reason: 'expedition_food_detour_unsafe' };
    }
    const [from, to] = trail;
    if (!bot.entity.position.floored().equals(from) || !safeEdge(from, to)) {
      trail = null;
      return failure('expedition_food_detour_changed');
    }
    const pathfinder = bot.pathfinder;
    const previous = pathfinder.movements;
    const movement = profile((a, b) => a.equals(from) && b.equals(to));
    const arrived = () => bot.entity.onGround && bot.entity.position.floored().equals(to) && foothold(to);
    const abort = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, abort.signal]) : abort.signal;
    const monitor = setInterval(() => {
      const p = bot.entity.position;
      const inLane = (Math.floor(p.x) === from.x && Math.floor(p.z) === from.z)
        || (Math.floor(p.x) === to.x && Math.floor(p.z) === to.z);
      if (!inLane || p.y < Math.min(from.y, to.y) - .05 || !safe(ctx.perceive()) || !safeEdge(from, to)
        || pathfinder.movements !== movement) abort.abort('expedition_food_detour_unsafe');
    }, 50);
    try {
      pathfinder.setMovements(movement);
      const result = await actions.goTo(bot, { ...ctx, signal }, new goals.GoalBlock(to.x, to.y, to.z),
        { arrived, timeoutMs: 2400, retryNoProgress: false });
      if ((result.ok || result.reason === 'not_arrived') && await waitUntil(arrived, { timeoutMs: 650, signal })) {
        trail.shift();
        if (trail.length === 1) trail = null;
        ctx.record('expedition_food_return_detour_step', { from, to, covered: !exposed(to) });
        return { ok: true };
      }
      trail = null;
      return failure(result.reason || 'expedition_food_detour_unconfirmed');
    } catch (error) {
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      if (!abort.signal.aborted) throw error;
      // If a threat interrupted a step, preserve the route only from a
      // server-confirmed endpoint.
      if (arrived()) {
        trail.shift();
        if (trail.length === 1) trail = null;
      } else if (!bot.entity.position.floored().equals(from)) trail = null;
      return { ok: true, waited: true, reason: 'expedition_food_detour_unsafe' };
    } finally {
      clearInterval(monitor);
      if (pathfinder.movements === movement) pathfinder.setMovements(previous);
    }
  }

  return { plan, advance, pending: () => trail !== null };
}

module.exports = { createExpeditionReturnDetour };
