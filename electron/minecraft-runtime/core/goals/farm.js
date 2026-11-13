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

// Farther than this from the centre, the farm's ground may be out of view.
const FAR_FROM_FARM = 48;

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
    if (bot.entity.position.y < (bot.companionSurfaceY ?? center.y) - 3 && actions.underground(bot)) {
      if (state.health <= 6) {
        await sleep(waitMs, ctx.signal);
        return { ok: true, waited: true };
      }
      return (await actions.surface(bot, ctx)) || { ok: false, reason: 'farm_snack_still_underground' };
    }
    const here = bot.entity.position;
    const homeward = new Vec3(center.x, center.y, center.z);
    const restore = applyWalkOnlyMovements(bot);
    try {
      if (state.food < 18 && countKey('bread', state.inventory, kb) > 0
        && !(state.hostiles || []).some((h) => h.distance <= 4)) {
        const ate = await actions.eat(bot, ctx);
        if (ate.ok) ctx.record('farm', { action: 'snack_eat', item: ate.ate, foodBefore: state.food, foodAfter: ctx.perceive().food });
        return ate;
      }
      const nearest = memory.plots.slice().sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
      const byState = (want) => nearest.find((p) => farming.plotState(bot, p) === want && !blacklist.has(posKey(p)));
      const unknown = byState('unknown');
      const distance = Math.hypot(here.x - center.x, here.z - center.z);
      if (distance > FAR_FROM_FARM || unknown && distance > 20) {
        ctx.record('farm', { action: 'snack_return', plot: posKey(unknown || nearest[0]) });
        const from = here.clone();
        const returned = await actions.goNear(bot, ctx, homeward, 4, { timeoutMs: 60000, retryNoProgress: false });
        const closer = from.distanceTo(homeward) - bot.entity.position.distanceTo(homeward) > 4;
        return returned.ok || closer ? { ok: true } : returned;
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
      restore();
    }
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
