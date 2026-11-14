'use strict';

const { Vec3 } = require('vec3');
const { Movements, goals } = require('mineflayer-pathfinder');
const { standable } = require('../caveRetreat');
const { dimension } = require('../nether');
const { sleep, waitUntil } = require('../confirm');
const { readHouseBotOxygen } = require('../../vendor/server/minecraft/houseBotOxygen');
const { isHostileMobEntity, isObservedSelfAggressor } = require('../../vendor/server/minecraft/entitySemantics');

const CARDINAL = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const MAX_SWIM = 20;
const MIN_PROGRESS = 8;
const DUSK = 12542;
const AIR = /^(air|cave_air|void_air)$/;
const PORTAL = /^(nether_portal|end_portal|end_gateway)$/;
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const center = (p) => p.offset(.5, 0, .5);
const key = (p) => `${p.x},${p.y},${p.z}`;
const failure = (reason) => ({ ok: false, reason });

function createStockWaterReturn({ bot, centre, exposed, actions, safe }) {
  const read = (p) => bot.blockAt(p);
  const clear = (p) => {
    const block = read(p);
    return block && AIR.test(block.name) && !block.shapes?.length;
  };
  const source = (p) => {
    const block = read(p);
    return block?.name === 'water' && Number(block.getProperties?.().level) === 0;
  };
  const beach = (p) => {
    const sand = (block) => /^(red_)?sand$/.test(block?.name || '');
    if (!sand(read(p.offset(0, -1, 0)))) return false;
    for (let depth = 2; depth <= 6; depth += 1) {
      const bed = read(p.offset(0, -depth, 0));
      if (sand(bed)) continue;
      return bed?.shapes?.length === 1 && bed.shapes[0].every((value, i) => value === (i < 3 ? 0 : 1))
        && !/(gravel|concrete_powder|lava|magma|cactus|leaves)$/.test(bed.name)
        && [0, 1, 2].every((dy) => clear(p.offset(0, dy, 0)));
    }
    return false;
  };
  const dry = (p) => [0, 1].every((dy) => !PORTAL.test(read(p.offset(0, dy, 0))?.name || ''))
    && (standable(read, p) && !read(p.offset(0, -1, 0)).name.endsWith('_leaves') || beach(p));
  const bank = (p) => exposed(p) && dry(p) && [0, 1, 2].every((dy) => clear(p.offset(0, dy, 0)));
  const adjacent = (p) => CARDINAL.map(([x, z]) => p.offset(x, 0, z));
  const nextDry = (p) => adjacent(p).flatMap((n) => [n, n.offset(0, 1, 0), n.offset(0, -1, 0)])
    .filter((n) => dry(n) && (p.y === n.y || clear((p.y < n.y ? p : n).offset(0, 2, 0))));
  const touchesWater = (p) => adjacent(p).some((n) => source(n.offset(0, -1, 0)) && clear(n));
  const eyesAir = (p) => clear(p.offset(0, 1.62, 0).floored()) && !bot.entity.isInLava;
  const enoughAir = () => {
    const { rawAirSupply } = readHouseBotOxygen(bot);
    return rawAirSupply === null || rawAirSupply >= 285;
  };
  const atBank = (p) => bot.entity.onGround && !bot.entity.isInWater && bot.entity.position.floored().equals(p)
    && Math.abs(bot.entity.position.y - p.y) < .08 && bank(p);

  function samples(from, to, y) {
    const span = horizontal(from, to);
    const cells = new Map();
    // Sample every eighth of a block with a margin around the half-width.
    for (let step = 0, count = Math.max(1, Math.ceil(span * 8)); step <= count; step += 1) {
      const point = from.plus(to.minus(from).scale(step / count));
      const minX = Math.floor(point.x - .37), maxX = Math.floor(point.x + .37);
      const minZ = Math.floor(point.z - .37), maxZ = Math.floor(point.z + .37);
      for (let x = minX; x <= maxX; x += 1) for (let z = minZ; z <= maxZ; z += 1) {
        const p = new Vec3(x, y, z);
        cells.set(key(p), p);
      }
    }
    return [...cells.values()];
  }

  function laneClear(from, to, y, crossing = false) {
    const lane = samples(from, to, y);
    if (!lane.every((p) => [0, 1, 2].every((dy) => clear(p.offset(0, dy, 0)))
      && (source(p.offset(0, -1, 0)) || dry(p)))) return false;
    if (!crossing) return true;
    // The banks must actually bracket water along the motion line.
    const delta = to.minus(from);
    return [.33, .5, .67].every((t) => {
      const p = from.plus(delta.scaled(t)).floored();
      return source(new Vec3(p.x, y - 1, p.z));
    });
  }

  const daylightLeft = (state) => Number.isFinite(state.timeOfDay) && state.isDay === true
    && (DUSK - state.timeOfDay >= 900 || state.timeOfDay > 23460);

  function nearestOnLine(position, from, to) {
    const line = to.minus(from);
    const squared = line.x ** 2 + line.z ** 2;
    const offset = position.minus(from);
    const along = squared ? Math.max(0, Math.min(1, (offset.x * line.x + offset.z * line.z) / squared)) : 0;
    return from.plus(line.scaled(along));
  }

  function danger(from, to) {
    return Object.values(bot.entities || {}).some((entity) => {
      if (entity === bot.entity || entity.isValid === false || !entity.position
        || (!isHostileMobEntity(entity, bot.registry) && !isObservedSelfAggressor(entity))) return false;
      return entity.position.distanceTo(nearestOnLine(entity.position, from, to)) <= 16;
    });
  }

  function paths(start, depth) {
    const here = { point: start, trail: [start] };
    const queue = [here];
    const seen = new Set([key(start)]);
    for (const node of queue) {
      if (node.trail.length > depth) continue;
      for (const p of nextDry(node.point)) {
        if (seen.has(key(p))) continue;
        seen.add(key(p));
        queue.push({ point: p, trail: [...node.trail, p] });
      }
    }
    return queue;
  }

  let route = null;
  let retryAt = 0;
  async function plan(ctx) {
    const start = bot.entity.position.floored();
    const state = ctx.perceive();
    if (route || Date.now() < retryAt || dimension(bot) !== 'overworld' || !daylightLeft(state) || !safe(state)
      || !bot.entity.onGround || bot.entity.isInWater || !exposed(start) || !eyesAir(bot.entity.position) || !enoughAir()) return false;
    retryAt = Date.now() + 30000;
    const useful = horizontal(start, centre) - 2 * MIN_PROGRESS;
    const routes = [];
    for (const { point, trail } of paths(start, 14)) {
      if (point.y !== start.y || !bank(point) || !touchesWater(point)) continue;
      for (let x = -MAX_SWIM; x <= MAX_SWIM; x += 1) for (let z = -MAX_SWIM; z <= MAX_SWIM; z += 1) {
        const to = point.offset(x, 0, z);
        const span = horizontal(point, to);
        if (span < 2 || span > MAX_SWIM || horizontal(to, centre) > useful || !bank(to) || !touchesWater(to)) continue;
        routes.push({ from: point, to, trail, span, cost: trail.length + span });
      }
    }
    for (const candidate of routes.sort((a, b) => a.cost - b.cost)) {
      const { from, to, trail, span } = candidate;
      if (!laneClear(center(from), center(to), from.y, true) || danger(center(from), center(to))) continue;
      if (!paths(to, 14).some(({ point }) => horizontal(point, centre) <= horizontal(to, centre) - MIN_PROGRESS && exposed(point))) continue;
      route = { from, to, trail, span, retreat: false, entered: false };
      ctx.record('stock_water_return_plan', { from, to, span, dryApproach: trail.length - 1 });
      return true;
    }
    return false;
  }

  async function dryStep(ctx, from, to) {
    if (!bot.entity.onGround || !bot.entity.position.floored().equals(from) || !nextDry(from).some((p) => p.equals(to))) return false;
    const movement = new Movements(bot);
    const neighbors = movement.getNeighbors;
    Object.assign(movement, { canDig: false, allowSprinting: false, allowParkour: false, allowFreeMotion: false,
      allow1by1towers: false, scafoldingBlocks: [], maxDropDown: 2, infiniteLiquidDropdownDistance: false,
      getNeighbors(node) {
        return node.equals(from) ? neighbors.call(this, node).filter((p) => to.equals(p) && !p.toBreak.length && !p.toPlace.length) : [];
      },
    });
    const pathfinder = bot.pathfinder;
    const previous = pathfinder.movements;
    const abort = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, abort.signal]) : abort.signal;
    const arrived = () => bot.entity.onGround && !bot.entity.isInWater && bot.entity.position.floored().equals(to);
    const monitor = setInterval(() => {
      const state = ctx.perceive();
      if (!safe(state) || state.isDay !== true || danger(center(from), center(to))
        || !nextDry(from).some((p) => p.equals(to)) || pathfinder.movements !== movement) abort.abort();
    }, 75);
    try {
      pathfinder.setMovements(movement);
      const result = await actions.goTo(bot, { ...ctx, signal }, new goals.GoalBlock(to.x, to.y, to.z),
        { arrived, timeoutMs: 2600, retryNoProgress: false });
      return (result.ok || result.reason === 'not_arrived') && await waitUntil(arrived, { timeoutMs: 500, signal });
    } catch (error) {
      if (ctx.signal?.aborted || !abort.signal.aborted) throw error;
      return false;
    } finally {
      clearInterval(monitor);
      if (pathfinder.movements === movement) pathfinder.setMovements(previous);
    }
  }

  async function advance(ctx) {
    ctx.signal?.throwIfAborted();
    const { from, to, trail, span } = route;
    const state = ctx.perceive();
    const valid = daylightLeft(state) && safe(state) && enoughAir() && !danger(center(from), center(to));
    if (!valid && !route.entered) {
      route = null;
      return failure('stock_water_return_unsafe');
    }
    if (trail.length > 1) {
      if (await dryStep(ctx, trail[0], trail[1])) {
        trail.shift();
        return { ok: true };
      }
      route = null;
      return failure('stock_water_return_approach_changed');
    }
    if (!route.entered) {
      if (!atBank(from) || !bank(to) || !laneClear(center(from), center(to), from.y, true)) {
        route = null;
        return failure('stock_water_return_lane_changed');
      }
      route.entered = true;
      ctx.record('stock_water_return_enter', { from, to, span, air: readHouseBotOxygen(bot) });
    }
    const finish = (target, retreat) => {
      const position = bot.entity.position.clone();
      route = null;
      ctx.record(retreat ? 'stock_water_return_retreat' : 'stock_water_return_landed', { from, to, target, position });
      return retreat ? failure('stock_water_return_retreated') : { ok: true };
    };
    let best = Infinity;
    let lastProgress = Date.now();
    let target = route.retreat ? null : to;
    const budget = (Math.ceil(span) + 6) * 20;
    try {
      for (let tick = 0; tick < 2 * budget; tick += 1) {
        ctx.signal?.throwIfAborted();
        const here = bot.entity.position;
        if (target && atBank(target) && horizontal(here, center(target)) <= .27) return finish(target, route.retreat);
        const live = ctx.perceive();
        if (!route.retreat && (tick >= budget || Date.now() - lastProgress > 3500 || !safe(live) || live.isDay !== true
          || !enoughAir() || danger(here, center(to)) || !bank(to))) route.retreat = true;
        if (route.retreat) {
          const fallback = [from, to].filter((p) => bank(p) && laneClear(here, center(p), from.y))
            .sort((a, b) => horizontal(here, center(a)) - horizontal(here, center(b)));
          target = fallback.find((p) => !danger(here, center(p))) || fallback[0];
          if (!target) break;
          if (atBank(target) && horizontal(here, center(target)) <= .27) return finish(target, true);
        }
        const end = center(target);
        const distance = horizontal(here, end);
        const step = here.plus(end.minus(here).scale(Math.min(1, 1.35 / Math.max(distance, .01))));
        const verticalOK = eyesAir(here) && here.y >= from.y - 1.55;
        const centered = horizontal(here, nearestOnLine(here, center(from), center(to))) <= .75;
        const move = verticalOK && centered && laneClear(here, step, from.y);
        if (!move && !route.retreat) route.retreat = true;
        bot.setControlState('jump', bot.entity.isInWater || move && distance >= .27 && here.y < from.y - .05);
        bot.setControlState('forward', false);
        if (move && distance >= .20) {
          await bot.lookAt(new Vec3(end.x, here.y + 1.7, end.z), true);
          ctx.signal?.throwIfAborted();
          bot.setControlState('forward', true);
        }
        if (distance < best - .06) {
          best = distance;
          lastProgress = Date.now();
        }
        await sleep(50, ctx.signal);
      }
      route.retreat = true;
      ctx.record('stock_water_return_unconfirmed', { from, to, position: bot.entity.position, retreat: true });
      return failure('stock_water_return_unconfirmed');
    } catch (error) {
      route.retreat = true;
      throw error;
    } finally {
      bot.setControlState('forward', false);
      bot.setControlState('jump', false);
    }
  }

  return { plan, advance, pending: () => route !== null };
}

module.exports = { createStockWaterReturn };
