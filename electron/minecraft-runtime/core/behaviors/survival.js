'use strict';
// Always-on survival behaviors. They outrank any goal; the brain preempts the
// goal while one of them wants the body and the goal re-plans afterwards.
// Kept deliberately simple; hardening them is the next milestone.

const defaultActions = require('../actions');
const { BAND } = require('../brain');

const { RISKY_FOODS } = defaultActions;

function createSurvivalBehaviors({ bot, actions = defaultActions, isFood, thresholds = {} } = {}) {
  const t = { escapeHealth: 6, escapeRange: 6, defendRange: 5, eatFood: 14, eatQuietRange: 8, ...thresholds };
  const foodCheck = isFood || ((name) => Boolean(bot.registry.foodsByName?.[name]));
  const hasSafeFood = (state, desperate) => Object.entries(state.inventory)
    .some(([name, count]) => count > 0 && foodCheck(name) && (desperate || !RISKY_FOODS.has(name)));
  const nearest = (state) => state.hostiles[0] || null;

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
    want(state) {
      const threat = nearest(state);
      return threat && threat.name !== 'creeper' && threat.distance <= t.defendRange ? 1 : 0;
    },
    async run(ctx) {
      const threat = nearest(ctx.perceive());
      if (!threat) return { ok: true };
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

  return [escape, defend, eat];
}

module.exports = { createSurvivalBehaviors };
