'use strict';
// Goal: carry at least `target` pieces of food, hunted from animals.
//
// Each run() hunts one animal; with nothing in sight it explores a little and
// lets the next run look again. Progress is the food count in the bag, so a
// death or an interruption needs no recovery.

const defaultSkills = require('../skills');
const { KNOWLEDGE, countKey } = require('../knowledge');
const { createBlacklist } = require('../blacklist');

const FOOD_MOBS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];

function createStockFoodGoal({ bot, target = 16, skills = defaultSkills, kb = KNOWLEDGE, radius = 96 } = {}) {
  if (!Number.isSafeInteger(target) || target < 1) throw new TypeError('target must be a positive integer');
  const blacklist = createBlacklist({ ttlMs: 60000 });
  const exploreMemory = {};
  const count = (state) => countKey('food', state.inventory, kb);

  return {
    name: 'stock_food',
    target,
    isDone: (state) => count(state) >= target,
    progress: (state) => count(state),
    async run(ctx) {
      const hunted = await skills.huntOne(bot, ctx, { mobs: FOOD_MOBS, dropMatch: kb.food.match, blacklist, radius });
      if (hunted.ok || hunted.reason !== 'no_mob_in_range') return hunted;
      ctx.record('explore_for', { why: 'food' });
      return skills.explore(bot, ctx, exploreMemory);
    },
  };
}

module.exports = { createStockFoodGoal, FOOD_MOBS };
