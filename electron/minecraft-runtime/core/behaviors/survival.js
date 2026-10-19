'use strict';
// Always-on survival behaviors. They outrank any goal; the brain preempts the
// goal while one of them wants the body and the goal re-plans afterwards.
// Kept deliberately simple; hardening them is the next milestone.

const defaultActions = require('../actions');
const defaultSkills = require('../skills');
const { BAND } = require('../brain');
const { sleep } = require('../confirm');
const { createBlacklist } = require('../blacklist');

const { RISKY_FOODS } = defaultActions;
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager']);
// Neutral mobs are left alone unless they are right next to us.
const NEUTRAL = new Set(['enderman', 'zombified_piglin', 'piglin', 'spider', 'cave_spider']);
const FOOD_ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];

function createSurvivalBehaviors({ bot, actions = defaultActions, skills = defaultSkills, isFood, thresholds = {} } = {}) {
  const t = { escapeHealth: 6, escapeRange: 6, defendRange: 5, rangedRange: 14, rangedHealth: 10, eatFood: 14,
    eatQuietRange: 8, provisionFood: 12, oxygen: 8, ...thresholds };
  const huntBlacklist = createBlacklist({ ttlMs: 60000 });
  const foodCheck = isFood || ((name) => Boolean(bot.registry.foodsByName?.[name]));
  const hasSafeFood = (state, desperate) => Object.entries(state.inventory)
    .some(([name, count]) => count > 0 && foodCheck(name) && (desperate || !RISKY_FOODS.has(name)));
  const nearest = (state) => state.hostiles[0] || null;
  // Melee anything close; go after archers only while healthy enough to close in.
  const target = (state) => state.hostiles.find((h) => h.name !== 'creeper'
    && (h.distance <= (NEUTRAL.has(h.name) ? 2.5 : t.defendRange)
      || (RANGED.has(h.name) && h.distance <= t.rangedRange && state.health > t.rangedHealth))) || null;

  const escape = {
    name: 'escape',
    band: BAND.ESCAPE,
    want(state) {
      const threat = nearest(state);
      if (!threat) return 0;
      if (threat.name === 'creeper' && threat.distance <= 4) return 1;
      return state.health <= t.escapeHealth && threat.distance <= t.escapeRange ? 1 : 0;
    },
    run: (ctx) => actions.fleeFrom(bot, ctx, nearest(ctx.perceive())?.position || bot.entity.position),
  };

  const defend = {
    name: 'defend',
    band: BAND.DEFENSE,
    want: (state) => (target(state) ? 1 : 0),
    async run(ctx) {
      const threat = target(ctx.perceive());
      if (!threat) return { ok: true };
      ctx.record('defend_target', { mob: threat.name, distance: Math.round(threat.distance) });
      return actions.attack(bot, ctx, threat.id);
    },
  };

  const eat = {
    name: 'eat',
    band: BAND.MAINTENANCE,
    want(state) {
      if (state.hostiles.some((h) => h.distance <= t.eatQuietRange)) return 0;
      const hungry = state.food <= t.eatFood || (state.health < 16 && state.food < 20);
      return hungry && hasSafeFood(state, state.food <= 6) ? 1 : 0;
    },
    run: (ctx) => actions.eat(bot, ctx),
  };

  const breathe = {
    name: 'breathe',
    band: BAND.ESCAPE,
    want: (state) => (state.inWater && Number.isFinite(state.oxygen) && state.oxygen < t.oxygen ? 1 : 0),
    async run(ctx) {
      bot.pathfinder?.setGoal(null);
      bot.setControlState('jump', true);
      try {
        for (let i = 0; i < 40 && bot.oxygenLevel < 20 && bot.entity.isInWater; i += 1) await sleep(100, ctx.signal);
      } finally {
        bot.setControlState('jump', false);
      }
      return { ok: bot.oxygenLevel >= t.oxygen, reason: 'still_underwater' };
    },
  };

  // Hungry with nothing to eat: hunt the nearest food animal.
  const provision = {
    name: 'provision',
    band: BAND.MAINTENANCE,
    want(state) {
      if (state.food > t.provisionFood || hasSafeFood(state, true)) return 0;
      if (state.hostiles.some((h) => h.distance <= t.eatQuietRange)) return 0;
      return 0.5;
    },
    run: (ctx) => skills.huntOne(bot, ctx, { mobs: FOOD_ANIMALS, dropMatch: foodCheck, radius: 40, blacklist: huntBlacklist }),
  };

  return [escape, breathe, defend, eat, provision];
}

module.exports = { createSurvivalBehaviors };
