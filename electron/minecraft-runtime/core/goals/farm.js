'use strict';
// Goal: a working wheat farm and bread from it.
//
// Every run() reads the plots from the world and does the most useful single
// thing: harvest a ripe crop, sow an empty farmland, till a new plot, bake
// bread, or fetch what one of those needs (a hoe, seeds). With nothing ready
// it waits, which neither spends nor refills the goal's stall budget.

const { Vec3 } = require('vec3');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const defaultFarming = require('../farming');
const { planNext } = require('../planner');
const { KNOWLEDGE, countKey } = require('../knowledge');
const { createBlacklist, posKey } = require('../blacklist');
const { sleep } = require('../confirm');
const { createPlannerRunner } = require('./common');

function createFarmGoal({ bot, center, plots: plotCount = 16, bread = 3, home = null,
  skills = defaultSkills, actions = defaultActions, farming = defaultFarming, kb = KNOWLEDGE, exclude = () => false, waitMs = 3000 } = {}) {
  const blacklist = createBlacklist({ ttlMs: 60000 });
  const memory = { center: center || null, plots: null, table: home?.table || null, steps: 0, harvested: 0, shortfall: {} };
  const blockAt = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));
  // Never put the crafting table on a plot.
  const onPlot = (p) => (memory.plots || []).some((q) => q.x === p.x && q.z === p.z);
  const { step, inventoryFor, tableHere } = createPlannerRunner({ bot, skills, kb, memory, blacklist,
    avoid: (p) => onPlot(p) || exclude(p) });

  function plots() {
    if (!memory.center) memory.center = bot.entity.position.floored();
    const lost = (memory.plots || []).filter((p) => farming.plotState(bot, p) === 'lost' || farming.plotState(bot, p) === 'blocked');
    if (!memory.plots || lost.length > memory.plots.length / 2) {
      memory.plots = farming.choosePlots(blockAt, memory.center, { count: plotCount, exclude,
        findWater: (c, r) => farming.findWater(bot, c, r) });
    }
    return memory.plots;
  }

  async function runOnce(ctx) {
    const state = ctx.perceive();
    const list = plots();
    if (!list.length) return skills.explore(bot, ctx, memory);
    // Off exploring for seeds and the farm is out of sight (unloaded) or far:
    // walk back before judging the plots, or they all look like nothing to do.
    const c = memory.center;
    const away = Math.hypot(bot.entity.position.x - c.x, bot.entity.position.z - c.z);
    if (away > 32 && (list.some((p) => farming.plotState(bot, p) === 'unknown') || (state.inventory.wheat_seeds || 0) > 0)) {
      ctx.record('farm', { action: 'return', distance: Math.round(away) });
      return actions.goNear(bot, ctx, new Vec3(c.x + 0.5, c.y, c.z + 0.5), 4, { timeoutMs: 90000 });
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
    const untilled = byState('untilled')[0];
    if (untilled) {
      const hoeStep = planNext({ requirements: [{ key: 'hoe', count: 1 }], inventory, stations, kb });
      if (hoeStep) return step(ctx, { ...hoeStep, for: 'hoe' });
      ctx.record('farm', { action: 'till', plot: posKey(untilled) });
      const result = await farming.till(bot, ctx, untilled);
      if (!result.ok) blacklist.add(posKey(untilled), result.reason, 15000);
      return result;
    }
    // Empty farmland and no seeds: break grass until some drop.
    if (byState('empty').length && !(inventory.wheat_seeds > 0)) {
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
    noProgressLimit: 30,
    memory,
    // Done with the bread in the bag and the farm left sown behind it.
    isDone: (state) => countKey('bread', state.inventory, kb) >= bread
      && (!(state.inventory.wheat_seeds > 0) || !(memory.plots || []).some((p) => farming.plotState(bot, p) === 'empty')),
    progress: () => memory.steps,
    async run(ctx) {
      const result = await runOnce(ctx);
      if (result.ok && !result.waited) memory.steps += 1;
      return result;
    },
  };
}

module.exports = { createFarmGoal };
