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
  const t = { escapeHealth: 6, escapeRange: 6, defendRange: 5, rangedRange: 14, rangedHealth: 14, eatFood: 14,
    eatQuietRange: 4, provisionFood: 12, provisionHealth: 10, recoverHealth: 10, oxygen: 8, dropsTtlMs: 270000,
    ...thresholds };
  const huntBlacklist = createBlacklist({ ttlMs: 60000 });
  const exploreMemory = {};
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
      // Risky food (rotten flesh, raw chicken) only when starving or nearly dead.
      return hungry && hasSafeFood(state, state.food <= 6 || state.health <= 8) ? 1 : 0;
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
      if (state.hostiles.some((h) => h.distance <= 8)) return 0;
      // Chasing animals at low health gets the bot killed at night; by day with
      // nothing hostile around it is the only way back to regenerating.
      if (state.health < t.provisionHealth && state.food > 6
        && (state.isDay === false || state.hostiles.some((h) => h.distance <= 16))) return 0;
      return 0.5;
    },
    async run(ctx) {
      const result = await skills.huntOne(bot, ctx, { mobs: FOOD_ANIMALS, dropMatch: foodCheck, radius: 32, blacklist: huntBlacklist });
      // Nothing to hunt in sight: berries, else look further afield instead of waiting to starve.
      if (result.reason === 'no_mob_in_range') {
        const berries = await skills.pickBerries(bot, ctx, { blacklist: huntBlacklist });
        if (berries.ok || berries.reason !== 'no_berries') return berries;
        return skills.explore(bot, ctx, exploreMemory);
      }
      return result;
    },
  };

  // Low health with a full stomach: stand still a few seconds and let it regenerate.
  const recover = {
    name: 'recover',
    band: BAND.MAINTENANCE,
    want: (state) => (state.health < t.recoverHealth && state.food >= 18
      && !state.hostiles.some((h) => h.distance <= 8) ? 0.3 : 0),
    async run(ctx) {
      actions.haltBody(bot);
      await sleep(3000, ctx.signal);
      return { ok: true };
    },
  };

  // Items dropped on death stay for five minutes: go back for them once it is safe.
  let lastDeath = null;
  bot.on?.('death', () => { lastDeath = { position: bot.entity.position.clone(), at: Date.now(), tries: 0 }; });
  const recoverDrops = {
    name: 'recover_drops',
    band: BAND.MAINTENANCE,
    want(state) {
      if (!lastDeath || Date.now() - lastDeath.at > t.dropsTtlMs || lastDeath.tries >= 3) return 0;
      if (state.health < 10 || state.hostiles.some((h) => h.distance <= 8)) return 0;
      return state.position.distanceTo(lastDeath.position) < 160 ? 0.8 : 0;
    },
    async run(ctx) {
      const target = lastDeath;
      target.tries += 1;
      ctx.record('recover_drops', { position: target.position.floored(), try: target.tries });
      const moved = await actions.goNear(bot, ctx, target.position, 2, { timeoutMs: 60000 });
      if (!moved.ok) return moved;
      const result = await actions.collectDrops(bot, ctx, target.position, () => true, { radius: 8, timeoutMs: 15000 });
      if (result.ok || target.tries >= 3) lastDeath = null;
      return result;
    },
  };

  return [escape, breathe, defend, eat, provision, recover, recoverDrops];
}

module.exports = { createSurvivalBehaviors };
