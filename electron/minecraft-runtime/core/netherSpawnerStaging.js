'use strict';

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { RaycastIterator, BlockFace } = require('prismarine-world').iterators;
const actionsDefault = require('./actions');
const { posKey } = require('./blacklist');
const { standable } = require('./caveRetreat');
const { abortError, runCancellable, sleep, waitUntil } = require('./confirm');
const { meleeGeometry, meleeSight } = require('./entityGeometry');
const nether = require('./nether');

const searchLimit = 500;
const stepLimit = 20;
const nextLimit = 12;
const stepBlock = { name: 'netherrack', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
const air = (b) => /^(air|cave_air|void_air)$/.test(b?.name || '');
const rubble = /^(netherrack|cobblestone|cobbled_deepslate|blackstone|nether_bricks)$/;
const center = (p) => p.offset(.5, 0, .5);
const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const reach = 4.2;
const fail = (reason) => ({ ok: false, reason });

function clickFloor(read, eye, base) {
  const point = base.offset(.5, 1, .5);
  const delta = point.minus(eye);
  const distance = delta.norm();
  if (distance > reach) return false;
  const ray = new RaycastIterator(eye, delta.scaled(1 / distance), distance + .001);
  for (let hit = ray.next(); hit; hit = ray.next()) {
    const p = new Vec3(hit.x, hit.y, hit.z);
    const b = read(p);
    if (!b) return false;
    if (!b.shapes?.length) continue;
    const intersection = ray.intersect(b.shapes, p);
    if (intersection) return p.equals(base) && intersection.face === BlockFace.TOP;
  }
  return false;
}

function drySteps(bot, read, from) {
  return nether.lookoutCardinalMoves(bot, from, read).filter((move) => !move.toBreak.length && standable(read, move)
    && ![0, 1].some((dy) => /portal|gateway/.test(read(move.offset(0, dy, 0)).name))
    && nether.lavaRisk({ blockAt: read }, move) === 0);
}

function search(bot, read, start, depth, limit = searchLimit) {
  const queue = [{ p: start, from: null, depth: 0 }];
  const visited = new Set([posKey(start)]);
  for (let i = 0; i < queue.length && queue.length < limit; i += 1) {
    const current = queue[i];
    if (current.depth >= depth) continue;
    for (const step of drySteps(bot, read, current.p)) {
      const key = posKey(step);
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ p: new Vec3(step.x, step.y, step.z), from: current, depth: current.depth + 1 });
      if (queue.length >= limit) break;
    }
  }
  return queue;
}

function path(node) {
  const route = [];
  for (let n = node; n; n = n.from) route.push(n.p);
  return route.reverse();
}

function stepPlan(bot, read, from, dx, dz) {
  const block = from.offset(dx, -2, dz);
  const stair = block.offset(0, 1, 0);
  const base = block.offset(0, -1, 0);
  if (!standable(read, block) || ![0, 1, 2, 3].every((y) => air(read(block.offset(0, y, 0))))) return null;
  if (nether.lavaRisk({ blockAt: read }, block) || !standable(read, from) || !air(read(from.offset(0, 2, 0)))) return null;
  const view = center(from).offset(dx * .15, 0, dz * .15);
  if (!clickFloor(read, view.offset(0, 1.62, 0), base)) return null;
  const projected = (p) => p.equals(block) ? stepBlock : read(p);
  return drySteps(bot, projected, from).some((p) => p.equals(stair)) ? { block, base, stair, view, projected } : null;
}

function findStage(bot, start, spawner) {
  const observed = new Map();
  const read = (p) => {
    const key = posKey(p);
    if (!observed.has(key)) observed.set(key, bot.blockAt(p));
    return observed.get(key);
  };
  if (!standable(read, start)) return null;
  const targets = Object.values(bot.entities || {}).filter((e) => e.name === 'blaze' && e.isValid !== false
    && e.position?.distanceTo(spawner) <= 10);
  // A spawn deck can still be useful after a target floats behind the wall.
  // Require an authentic nearby spawner with an observed opening toward it.
  const positioning = { position: spawner.offset(.5, .2, .5), width: .75, height: 1.1 };
  const useful = (p) => {
    if (p.y > spawner.y || p.distanceTo(spawner) > 7 || read(p.offset(0, -1, 0))?.name !== 'nether_bricks') return false;
    return [...targets, positioning].some((entity) => {
      const g = meleeGeometry({ position: center(p) }, entity, bot.registry);
      return g && g.distance <= 3.8 && meleeSight(bot, g) === 'clear';
    });
  };
  const dry = search(bot, read, start, stepLimit);
  const direct = dry.find((entry) => entry.depth && useful(entry.p));
  if (direct) return { route: path(direct), destination: direct.p };
  // Prefer a dry route first. Only one supported block and at least one
  // further original foothold may connect otherwise separate levels.
  let best = null;
  let checked = 0;
  const current = new Set(dry.map(({ p }) => posKey(p)));
  for (const entry of dry) for (const [dx, dz] of sides) {
    if (best && entry.depth >= best.cost) return best;
    const step = stepPlan(bot, read, entry.p, dx, dz);
    if (!step || checked >= 24) continue;
    checked += 1;
    const onward = search(bot, step.projected, step.stair, nextLimit, 125)
      .find((next) => next.depth && next.p.y <= step.stair.y && !current.has(posKey(next.p)) && useful(next.p));
    if (!onward || (best && entry.depth + onward.depth >= best.cost)) continue;
    best = { ...step, from: entry.p, destination: onward.p, route: [...path(entry), ...path(onward)],
      cost: entry.depth + onward.depth };
  }
  return best;
}

function createNetherSpawnerStaging({ bot, actions = actionsDefault }) {
  const read = (p) => bot.blockAt(p);
  let active = null;
  const clear = () => { active = null; };

  async function descendToSupport(ctx, from, to, block) {
    const target = center(to);
    const origin = center(from);
    const heading = new Vec3(to.x - from.x, 0, to.z - from.z);
    const liveTerrain = () => drySteps(bot, read, from).some((p) => p.equals(to)) && rubble.test(read(block)?.name || '');
    const body = () => {
      const here = bot.entity.position;
      const delta = here.minus(origin);
      const along = delta.dot(heading);
      const lateral = Math.abs(delta.x * heading.z - delta.z * heading.x);
      return { here, along, lateral };
    };
    const safe = ({ here, along, lateral }) => liveTerrain() && !bot.entity.isInWater && !bot.entity.isInLava
      && here.y >= to.y - .02 && here.y <= from.y + .08 && along >= -.2 && along <= 1.15 && lateral <= .15;
    if (!bot.entity.onGround || !safe(body())) return false;
    actions.haltBody(bot);
    try {
      await bot.lookAt(target.offset(0, from.y - to.y + (bot.entity.eyeHeight || 1.62), 0), true);
      // Stay on the axis of the two adjoining footholds. With controls
      // released between pulses, coast only far enough to land on this step.
      for (let i = 0; i < 24; i += 1) {
        const current = body();
        if (ctx.signal?.aborted) throw abortError(ctx.signal);
        if (!safe(current)) return false;
        if (bot.entity.onGround && current.here.floored().equals(to)
          && Math.hypot(current.here.x - target.x, current.here.z - target.z) <= .21) return true;
        const velocity = bot.entity.velocity;
        const advance = velocity ? velocity.dot(heading) : 0;
        bot.setControlState('forward', current.along < .83 && current.along + Math.max(0, advance) * 3 < .94);
        await sleep(50, ctx.signal);
        bot.setControlState('forward', false);
      }
      return false;
    } finally {
      actions.haltBody(bot);
    }
  }

  async function place(ctx, plan) {
    const { from, block, base, stair, view } = plan;
    const dir = stair.minus(from);
    const stillSafe = () => bot.entity.onGround && bot.entity.position.floored().equals(from)
      && Math.abs(bot.entity.position.x - center(from).x) < .2 && Math.abs(bot.entity.position.z - center(from).z) < .2
      && stepPlan(bot, read, from, dir.x, dir.z);
    const item = bot.inventory.items().find((entry) => rubble.test(entry.name));
    if (!item || !stillSafe()) return false;
    const eyeHeight = bot.entity.eyeHeight || 1.62;
    const eye = () => bot.entity.position.offset(0, eyeHeight, 0);
    actions.haltBody(bot);
    try {
      // The lip can obscure the lower floor from the cell centre. Move only
      // within the verified support, under sneak, until the top face is seen.
      bot.setControlState('sneak', true);
      for (let i = 0; i < 8 && !clickFloor(read, eye(), base); i += 1) {
        await bot.lookAt(view.offset(0, eyeHeight, 0), true);
        if (ctx.signal?.aborted) throw abortError(ctx.signal);
        if (!stillSafe() || bot.entity.position.distanceTo(view) < .03) return false;
        bot.setControlState('forward', true);
        await sleep(50, ctx.signal);
        bot.setControlState('forward', false);
      }
      if (!stillSafe() || !clickFloor(read, eye(), base)) return false;
      await bot.equip(item, 'hand');
      await bot.lookAt(base.offset(.5, 1, .5), true);
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      if (!stillSafe() || !clickFloor(read, eye(), base)) return false;
      try {
        await runCancellable(() => bot.placeBlock(read(base), new Vec3(0, 1, 0)), { timeoutMs: 2500, signal: ctx.signal });
      } catch (error) {
        if (error.code === 'aborted') throw error;
      }
      if (!await waitUntil(() => read(block)?.name === item.name && standable(read, stair),
        { timeoutMs: 600, signal: ctx.signal })) return false;
      ctx.record?.('spawner_staging_support', { block, floor: base, from, material: item.name });
      return true;
    } finally {
      actions.haltBody(bot);
    }
  }

  async function run(ctx, { spawner }) {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    if (!nether.inNether(bot) || !bot.entity?.onGround || typeof bot.blockAt !== 'function' || !spawner
      || read(spawner)?.name !== 'spawner') return null;
    const here = bot.entity.position.floored();
    if (!active || !active.spawner.equals(spawner) || !active.route[0].equals(here)) {
      active = findStage(bot, here, spawner);
      if (!active) return null;
      active.spawner = spawner;
      ctx.record?.('spawner_staging_plan', {
        from: here, spawner, destination: active.destination, legs: active.route.length - 1, support: active.block || null,
      });
    }
    if (active.block && active.from.equals(here) && air(read(active.block))) {
      if (await place(ctx, active)) return { ok: true, staging: true };
      clear();
      return fail('spawner_staging_support_unconfirmed');
    }
    const next = active.route[1];
    if (!next || !drySteps(bot, read, here).some((p) => p.equals(next))) {
      clear();
      return fail('spawner_staging_route_changed');
    }
    const arrived = () => bot.entity.onGround && bot.entity.position.floored().equals(next);
    // A preceding native goal can finish at the near side of its tile with
    // horizontal momentum. Settle and centre before turning across a ledge.
    actions.haltBody(bot);
    const centred = () => Math.hypot(bot.entity.position.x - (here.x + .5), bot.entity.position.z - (here.z + .5)) <= .15;
    const settled = () => bot.entity.onGround && bot.entity.position.floored().equals(here)
      && Math.hypot(bot.entity.velocity?.x || 0, bot.entity.velocity?.z || 0) <= .025;
    if (!await waitUntil(settled, { timeoutMs: 400, signal: ctx.signal })) return fail('spawner_staging_unsettled');
    if (!centred()) await actions.recentre(bot, ctx, { accept: (p) => p.equals(here) && standable(read, here) });
    if (!await waitUntil(settled, { timeoutMs: 400, signal: ctx.signal }) || !centred()) return fail('spawner_staging_uncentred');
    const onNewSupport = active.block && active.from.equals(here) && active.stair.equals(next);
    const moved = onNewSupport
      ? await descendToSupport(ctx, here, next, active.block) ? { ok: true } : fail('spawner_staging_new_step_unconfirmed')
      : await nether.withFortressCombatTerrain(bot, ctx, (combat) =>
        actions.goTo(bot, combat, new goals.GoalBlock(next.x, next.y, next.z),
          { arrived, timeoutMs: 2800, retryNoProgress: false }));
    if (moved.repositioned) return moved;
    if (!(moved.ok || moved.reason === 'not_arrived') || !await waitUntil(arrived, { timeoutMs: 600, signal: ctx.signal })) {
      clear();
      return fail(moved.reason || 'spawner_staging_step_unconfirmed');
    }
    active.route.shift();
    if (active.route.length > 1) return { ok: true, staging: true };
    ctx.record?.('spawner_staging_arrived', { position: bot.entity.position, spawner });
    clear();
    return { ok: true, staged: true };
  }

  return { run, pending: () => Boolean(active), clear };
}

module.exports = { createNetherSpawnerStaging };
