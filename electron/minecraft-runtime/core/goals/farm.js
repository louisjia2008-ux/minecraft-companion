'use strict';
// Goal: a working wheat farm and bread from it.
//
// Every run() reads the plots from the world and does the most useful single
// thing: harvest a ripe crop, sow an empty farmland, till a new plot, bake
// bread, or fetch what one of those needs (a hoe, seeds). With nothing ready
// it waits, which neither spends nor refills the goal's stall budget.

const { Vec3 } = require('vec3');
const defaultActions = require('../actions');
const defaultSkills = require('../skills');
const defaultFarming = require('../farming');
const { planNext } = require('../planner');
const { KNOWLEDGE, countKey } = require('../knowledge');
const { createBlacklist, posKey } = require('../blacklist');
const { sleep } = require('../confirm');
const { createPlannerRunner } = require('./common');
const { applyWalkOnlyMovements } = require('../nether');
const { advanceCaveRetreat, skyOpen, standable } = require('../caveRetreat');
const { goals } = require('mineflayer-pathfinder');

// Farther than this from the centre, the farm's ground may be out of view.
const FAR_FROM_FARM = 48;
const SNACK_FARM_APPROACH = 24;
const SNACK_PATH_FAILURE = new Set(['NoPath', 'Timeout', 'path_timeout', 'not_arrived', 'no_progress', 'leg_blocked']);

function createFarmGoal({ bot, center, plots: plotCount = 16, bread = 3, home = null, snackPlots = null,
  skills = defaultSkills, farming = defaultFarming, actions = defaultActions, kb = KNOWLEDGE,
  exclude = () => false, waitMs = 3000 } = {}) {
  const blacklist = createBlacklist({ ttlMs: 60000 });
  const point = (p) => p && [p.x, p.y, p.z].every(Number.isInteger);
  const snack = snackPlots !== null;
  if (snack && (!Array.isArray(snackPlots) || !snackPlots.length || !snackPlots.every(point) || !point(center) || !point(home?.table))) {
    throw new TypeError('farm snack requires the existing plots, centre and crafting table');
  }
  const memory = { center: center || null, barren: false, plots: snack ? snackPlots.map((p) => new Vec3(p.x, p.y, p.z)) : null,
    table: home?.table || null, steps: 0, harvested: 0, shortfall: {} };
  const retreatVisited = new Set();
  const returnVisited = new Set();
  const returnBlacklist = createBlacklist({ ttlMs: 30000 });
  let needAscent = false;
  const blockAt = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));
  // Never put the crafting table on a plot.
  const onPlot = (p) => (memory.plots || []).some((q) => q.x === p.x && q.z === p.z);
  const { step, inventoryFor, tableHere } = createPlannerRunner({ bot, skills, kb, memory, blacklist,
    avoid: (p) => onPlot(p) || exclude(p) });

  function plots() {
    if (!memory.center) memory.center = bot.entity.position.floored();
    const lost = (memory.plots || []).filter((p) => farming.plotState(bot, p) === 'lost' || farming.plotState(bot, p) === 'blocked');
    if (!memory.plots?.length || lost.length > memory.plots.length / 2) {
      memory.plots = farming.choosePlots(blockAt, memory.center, { count: plotCount, exclude,
        findWater: (c, r) => farming.findWater(bot, c, r) });
    }
    return memory.plots;
  }

  async function runSnack(ctx) {
    const state = ctx.perceive();
    if (state.food >= 18) return { ok: true };
    if (countKey('bread', state.inventory, kb) > 0 && !(state.hostiles || []).some((h) => h.distance <= 4)) {
      const ate = await actions.eat(bot, ctx);
      if (ate.ok) ctx.record('farm', { action: 'snack_eat', item: ate.ate, foodBefore: state.food, foodAfter: ctx.perceive().food });
      return ate;
    }
    const here = bot.entity.position;
    const homeward = new Vec3(center.x, center.y, center.z);
    const table = new Vec3(memory.table.x, memory.table.y, memory.table.z);
    const distance = Math.hypot(here.x - center.x, here.z - center.z);
    const local = distance <= SNACK_FARM_APPROACH && Math.abs(here.y - center.y) <= 5
      || Math.hypot(here.x - table.x, here.z - table.z) <= 8 && Math.abs(here.y - table.y) <= 3;
    const feet = here.floored();
    const underground = !local && (needAscent ? !skyOpen(bot, feet) : actions.underground?.(bot) === true);
    if (!underground) {
      retreatVisited.clear();
      needAscent = false;
    } else if (needAscent || here.y < (bot.companionSurfaceY ?? center.y) - 3) {
      if (state.health <= 6 || state.inWater) {
        await sleep(waitMs, ctx.signal);
        return { ok: true, waited: true };
      }
      needAscent = true;
      const from = here.floored();
      let hostiles = state.hostiles || [];
      let refresh = 0;
      const avoid = (p) => {
        if (Date.now() >= refresh) {
          refresh = Date.now() + 100;
          hostiles = ctx.perceive().hostiles || [];
        }
        return Math.abs(p.x - table.x) <= 8 && Math.abs(p.z - table.z) <= 8
          || hostiles.some((h) => h.position?.distanceTo(p) <= 6);
      };
      const result = await advanceCaveRetreat(bot, ctx, actions, homeward, { avoid, visited: retreatVisited });
      ctx.record('farm', { action: 'snack_ascent', from, ok: result.ok, reason: result.reason });
      if (result.ok && !result.dug) {
        retreatVisited.add(posKey(from));
        if (retreatVisited.size > 64) retreatVisited.delete(retreatVisited.values().next().value);
      }
      return result;
    }
    const restore = applyWalkOnlyMovements(bot);
    const movements = bot.pathfinder?.movements;
    const neighbors = movements?.getNeighbors;
    const dry = (p) => [-1, 0, 1].every((dy) => {
      const block = blockAt(p.offset(0, dy, 0));
      return block && !/water|lava|fire|magma|campfire|cactus|powder_snow|bubble_column/.test(block.name)
        && block.getProperties?.()?.waterlogged !== true;
    });
    if (typeof neighbors === 'function') movements.getNeighbors = function (node, ...args) {
      return neighbors.call(this, node, ...args).filter((move) => dry(new Vec3(move.x, move.y, move.z)));
    };
    try {
      const nearest = memory.plots.slice().sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
      const byState = (want) => nearest.find((p) => farming.plotState(bot, p) === want && !blacklist.has(posKey(p)));
      const unknown = byState('unknown');
      if (distance > FAR_FROM_FARM || unknown && distance > 20) {
        const plot = unknown || nearest[0];
        ctx.record('farm', { action: 'snack_return', plot: posKey(plot) });
        const destination = plot.offset(.5, 1, .5);
        const goal = new goals.GoalCompositeAny(nearest.map((p) => {
          const around = new goals.GoalNear(p.x, p.y + 1, p.z, 5);
          const insideRange = around.isEnd.bind(around);
          around.isEnd = (at) => insideRange(at) && standable(blockAt, new Vec3(at.x, at.y, at.z));
          return around;
        }));
        const from = here.clone();
        const returned = await actions.goTo(bot, ctx, goal, { timeoutMs: 20000, retryNoProgress: false });
        if (returned.ok && bot.entity.onGround && goal.isEnd(bot.entity.position.floored())
          || from.distanceTo(destination) - bot.entity.position.distanceTo(destination) > 4) {
          returnVisited.clear();
          return { ok: true };
        }
        const failure = returned.ok ? { ok: false, reason: 'not_arrived' } : returned;
        if (!SNACK_PATH_FAILURE.has(failure.reason)) return failure;
        if (underground) {
          needAscent = true;
          ctx.record('farm', { action: 'snack_return_cave_blocked', from: from.floored(), reason: failure.reason });
          return { ok: true, waited: true };
        }
        return alternateFarmLeg(ctx, destination, failure);
      }
      const planted = state.inventory.wheat_seeds > 0 && byState('empty');
      if (planted) {
        const result = await farming.plant(bot, ctx, planted);
        if (!result.ok) blacklist.add(posKey(planted), result.reason);
        return result;
      }
      if (state.inventory.wheat >= 3) {
        const baked = await skills.craft(bot, ctx, { item: 'bread', times: Math.min(bread, Math.floor(state.inventory.wheat / 3)), tablePosition: memory.table });
        if (baked.ok && baked.gained > 0) {
          ctx.record('farm', { action: 'snack_baked', gained: baked.gained, table: posKey(memory.table) });
        }
        return baked;
      }
      const ripe = byState('ripe');
      if (ripe) {
        ctx.record('farm', { action: 'snack_harvest', plot: posKey(ripe) });
        const result = await farming.harvest(bot, ctx, ripe);
        if (result.ok && result.gained) memory.harvested += result.gained;
        else blacklist.add(posKey(ripe), result.reason || 'wheat_not_collected');
        return result;
      }
      // This detour neither explores for seed nor waits for a new crop cycle.
      ctx.record('farm', { action: 'snack_unavailable' });
      return { ok: false, reason: 'farm_snack_no_ripe_wheat' };
    } finally {
      if (typeof neighbors === 'function') movements.getNeighbors = neighbors;
      restore();
    }
  }

  async function alternateFarmLeg(ctx, destination, failure) {
    if (typeof actions.goTo !== 'function') return failure;
    const from = bot.entity.position.floored();
    const here = from.distanceTo(destination);
    const angle = Math.atan2(destination.z - from.z, destination.x - from.x);
    for (const offset of [Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) {
      const aim = angle + offset;
      const target = from.offset(Math.round(12 * Math.cos(aim)), 0, Math.round(12 * Math.sin(aim)));
      const key = `${posKey(from)}>${posKey(target)}`;
      if (returnBlacklist.has(key)) continue;
      returnBlacklist.add(key, 'farm_snack_return_attempt');
      const goal = new goals.GoalNearXZ(target.x, target.z, 3);
      const close = goal.isEnd.bind(goal);
      goal.isEnd = (p) => close(p) && standable(blockAt, new Vec3(p.x, p.y, p.z))
        && new Vec3(p.x, p.y, p.z).distanceTo(destination) <= here + 8
        && !returnVisited.has(`${p.x},${p.z}`);
      const moved = await actions.goTo(bot, ctx, goal, { timeoutMs: 15000, retryNoProgress: false });
      const at = bot.entity.position.floored();
      if (moved.ok && bot.entity.onGround && goal.isEnd(at) && at.distanceTo(from) >= 4) {
        returnVisited.add(`${from.x},${from.z}`);
        if (returnVisited.size > 64) returnVisited.delete(returnVisited.values().next().value);
        ctx.record('farm', { action: 'snack_return_dry_leg', from, to: at });
        return moved;
      }
      return { ok: true, waited: true };
    }
    return failure;
  }

  async function runOnce(ctx) {
    const state = ctx.perceive();
    // Asked for from far off (a hunt that wandered 900 blocks away): plots
    // chosen there were none, and the goal explored for an hour and a half
    // instead of going back. Walk back to the farm first.
    const c = memory.center;
    const at = bot.entity.position;
    const enough = Math.min(4, plotCount);
    const fits = (p) => farming.choosePlots(blockAt, p, { count: plotCount, exclude: (q) => exclude(q),
      findWater: (w, r) => farming.findWater(bot, w, r) }).length >= enough;
    const moveTo = (ground) => {
      ctx.record('farm', { action: 'move', from: posKey(memory.center), to: posKey(ground) });
      memory.center = ground;
      memory.plots = null;
      memory.barren = false;
      return farming.returnTo(bot, ctx, ground);
    };
    if (c && Math.hypot(at.x - c.x, at.z - c.z) > FAR_FROM_FARM) {
      // Out looking for soil, the old centre has none to go back to: the
      // nearest soil here that holds a farm, or further on.
      if (memory.barren && farming.findGround) {
        const ground = farming.findGround(bot, at.floored(), FAR_FROM_FARM, { fits });
        return ground ? moveTo(ground) : skills.explore(bot, ctx, memory);
      }
      ctx.record('farm', { action: 'return', distance: Math.round(Math.hypot(at.x - c.x, at.z - c.z)) });
      return farming.returnTo(bot, ctx, c);
    }
    let list = plots();
    if (list.length < enough && farming.findGround) {
      // No soil around the centre (sand, stone): move the farm to the nearest soil that holds one.
      const ground = farming.findGround(bot, memory.center, FAR_FROM_FARM, { fits });
      if (ground) return moveTo(ground);
      memory.barren = true;
      return skills.explore(bot, ctx, memory);
    }
    if (!list.length) return skills.explore(bot, ctx, memory);
    // A seed search can wander out of view of the farm. Its plots then read
    // as unknown, never ripe or empty, and the goal would wait there forever.
    const unseen = list.find((p) => farming.plotState(bot, p) === 'unknown');
    if (unseen) {
      ctx.record('farm', { action: 'return', plot: posKey(unseen) });
      return farming.returnTo(bot, ctx, unseen);
    }
    const byState = (s) => list.filter((p) => farming.plotState(bot, p) === s && !blacklist.has(posKey(p)));
    const stations = { crafting_table: tableHere() };
    const inventory = inventoryFor(state);

    // Bread first whenever three wheat are in the bag: with a large farm
    // something is always ripe, and the harvest would never end.
    if (countKey('bread', state.inventory, kb) < bread && (inventory.wheat || 0) >= 3) {
      const breadStep = planNext({ requirements: [{ key: 'bread', count: countKey('bread', state.inventory, kb) + 1 }], inventory, stations, kb });
      if (breadStep && breadStep.kind !== 'farm') return step(ctx, { ...breadStep, for: 'bread' });
    }
    const ripe = byState('ripe')[0];
    if (ripe) {
      ctx.record('farm', { action: 'harvest', plot: posKey(ripe) });
      const result = await farming.harvest(bot, ctx, ripe);
      if (result.ok) memory.harvested += result.gained || 0; else blacklist.add(posKey(ripe), result.reason, 15000);
      return result;
    }
    const empty = byState('empty')[0];
    if (empty && (inventory.wheat_seeds || 0) > 0) {
      ctx.record('farm', { action: 'plant', plot: posKey(empty) });
      const result = await farming.plant(bot, ctx, empty);
      if (!result.ok) blacklist.add(posKey(empty), result.reason, 15000);
      return result;
    }
    // Tilled only with a seed to sow: bare farmland dries back to dirt, and a
    // farm short of seeds in the desert tilled the same plots 400 times.
    const untilled = byState('untilled')[0];
    if (untilled && (inventory.wheat_seeds || 0) > 0) {
      const hoeStep = planNext({ requirements: [{ key: 'hoe', count: 1 }], inventory, stations, kb });
      if (hoeStep) return step(ctx, { ...hoeStep, for: 'hoe' });
      ctx.record('farm', { action: 'till', plot: posKey(untilled) });
      const result = await farming.till(bot, ctx, untilled);
      if (!result.ok) blacklist.add(posKey(untilled), result.reason, 15000);
      return result;
    }
    // Empty farmland and no seeds: break grass until some drop.
    if ((byState('empty').length || untilled) && !(inventory.wheat_seeds > 0)) {
      ctx.record('farm', { action: 'seeds' });
      const result = await farming.gatherSeeds(bot, ctx, { blacklist, exclude: (p) => list.some((q) => q.x === p.x && q.z === p.z) });
      if (result.reason === 'no_grass') return skills.explore(bot, ctx, memory);
      return result;
    }
    // Everything sown: the crops grow on their own.
    await sleep(waitMs, ctx.signal);
    return { ok: true, waited: true };
  }

  return {
    name: 'farm',
    noProgressLimit: snack ? 3 : 30,
    memory,
    ...(snack ? { farmSnack: true, ownsRouteRecovery: () => true } : {}),
    // Done with the bread in the bag and the farm left sown behind it.
    isDone: (state) => (snack && state.food >= 18) || countKey('bread', state.inventory, kb) >= bread
      && (!(state.inventory.wheat_seeds > 0) || !(memory.plots || []).some((p) => farming.plotState(bot, p) === 'empty')),
    progress: () => memory.steps,
    async run(ctx) {
      const result = await (snack ? runSnack(ctx) : runOnce(ctx));
      if (result.ok && !result.waited) memory.steps += 1;
      return result;
    },
  };
}

module.exports = { createFarmGoal };
