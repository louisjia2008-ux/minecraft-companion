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
const RANGED = new Set(['skeleton', 'stray', 'bogged']);
// Pillagers come in groups from outposts that keep spawning them: keep away.
const AVOIDED = new Set(['pillager', 'vindicator', 'evoker', 'ravager']);
// Neutral mobs are left alone unless they are right next to us.
const NEUTRAL = new Set(['enderman', 'zombified_piglin', 'piglin', 'spider', 'cave_spider']);
const SEALS = new Set(['dirt', 'cobblestone', 'cobbled_deepslate', 'coarse_dirt']);
const FOOD_ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];

function createSurvivalBehaviors({ bot, actions = defaultActions, skills = defaultSkills, isFood, thresholds = {} } = {}) {
  const t = { escapeHealth: 6, escapeRange: 6, defendRange: 5, rangedRange: 14, rangedHealth: 14, eatFood: 14,
    eatQuietRange: 4, provisionFood: 12, provisionHealth: 10, recoverHealth: 10, oxygen: 8, dropsTtlMs: 270000,
    ...thresholds };
  const huntBlacklist = createBlacklist({ ttlMs: 60000 });
  const exploreMemory = {};
  let stuckStreak = 0;
  const foodCheck = isFood || ((name) => Boolean(bot.registry.foodsByName?.[name]));
  const hasSafeFood = (state, desperate) => Object.entries(state.inventory)
    .some(([name, count]) => count > 0 && foodCheck(name) && (desperate || !RISKY_FOODS.has(name)));
  const nearest = (state) => state.hostiles[0] || null;
  // Chasing an archer bare-handed, or down into the cave it shoots from, loses.
  const armed = (state) => Object.keys(state.inventory).some((n) => n.endsWith('_sword') || n.endsWith('_axe'));
  // Melee anything close; go after archers only while healthy enough to close in.
  const target = (state) => {
    // In shelter only something that got right next to the bot is fought.
    if (state.sheltered) return state.hostiles.find((h) => h.distance <= 2) || null;
    return state.hostiles.find((h) => h.name !== 'creeper' && !(AVOIDED.has(h.name) && h.distance > 2.5)
      && (h.distance <= (NEUTRAL.has(h.name) ? 2.5 : t.defendRange)
        || (RANGED.has(h.name) && h.distance <= t.rangedRange && state.health > t.rangedHealth && armed(state)
          && Math.abs(h.position.y - state.position.y) <= 4))) || null;
  };

  const escape = {
    name: 'escape',
    band: BAND.ESCAPE,
    want(state) {
      const threat = nearest(state);
      if (!threat || state.sheltered) return 0;
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
      let last = threat.position.clone();
      const tracker = setInterval(() => { const e = bot.entities?.[threat.id]; if (e) last = e.position.clone(); }, 100);
      let result;
      try {
        result = await actions.attack(bot, ctx, threat.id);
      } finally {
        clearInterval(tracker);
      }
      // Spiders drop string (wool where there are no sheep); pick up what fell.
      if (result.ok && typeof actions.collectDrops === 'function') {
        await actions.collectDrops(bot, ctx, last, (n) => n === 'string', { radius: 6, timeoutMs: 4000 });
      }
      return result;
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
        for (let i = 0; i < 40 && bot.oxygenLevel < 20 && bot.entity.isInWater; i += 1) {
          // Swimming up into a ceiling (a flooded pit or tunnel): dig it open.
          const above = bot.blockAt(bot.entity.position.offset(0, 2, 0).floored());
          if (above && above.boundingBox === 'block' && bot.canDigBlock(above)) {
            await actions.digBlock(bot, ctx, above, { timeoutMs: 4000 });
            bot.setControlState('jump', true);
          }
          await sleep(100, ctx.signal);
        }
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
      if (state.sheltered || state.food > t.provisionFood || hasSafeFood(state, true)) return 0;
      if (state.hostiles.some((h) => h.distance <= 8)) return 0;
      // Chasing animals at low health gets the bot killed at night; by day with
      // nothing hostile around it is the only way back to regenerating.
      if (state.health < t.provisionHealth && state.food > 6
        && (state.isDay === false || state.hostiles.some((h) => h.distance <= 16))) return 0;
      return 0.5;
    },
    async run(ctx) {
      // Animals are visible out to about 100 blocks; go for the nearest one seen.
      const result = await skills.huntOne(bot, ctx, { mobs: FOOD_ANIMALS, dropMatch: foodCheck, radius: 96, blacklist: huntBlacklist });
      // Nothing to hunt in sight: berries, else look further afield instead of waiting to starve.
      // Could not reach anything: the bot itself is probably stuck (tree top, ledge).
      if (['NoPath', 'Timeout', 'path_timeout', 'no_progress', 'not_arrived', 'chase_stuck'].includes(result.reason)) {
        stuckStreak += 1;
        if (stuckStreak >= 2) { stuckStreak = 0; return actions.unstick(bot, ctx); }
        return result;
      }
      stuckStreak = 0;
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
  const onDeathDrops = () => { lastDeath = { position: bot.entity.position.clone(), at: Date.now(), tries: 0 }; };
  bot.on?.('death', onDeathDrops);
  const recoverDrops = {
    name: 'recover_drops',
    band: BAND.MAINTENANCE,
    dispose: () => bot.removeListener?.('death', onDeathDrops),
    want(state) {
      if (state.sheltered || !lastDeath || Date.now() - lastDeath.at > t.dropsTtlMs || lastDeath.tries >= 3) return 0;
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

  // An angry enderman out-damages a stone or iron sword and teleports out of
  // reach, but cannot follow into a sealed 1x1 hole: hide there until it calms
  // down or wanders off, then climb out.
  const creepyIndex = bot.registry?.entitiesByName?.enderman?.metadataKeys?.indexOf('creepy') ?? -1;
  const angryEnderman = (state, range) => state.hostiles.find((h) => h.name === 'enderman' && h.distance <= range
    && creepyIndex >= 0 && bot.entities?.[h.id]?.metadata?.[creepyIndex] === true);
  // Remember where raiders were seen; the homestead keeps its site away from there.
  const danger = (bot.companionDanger = bot.companionDanger || []);
  const avoid = {
    name: 'avoid',
    band: BAND.DEFENSE,
    want(state) {
      const raider = state.hostiles.find((h) => AVOIDED.has(h.name) && h.distance <= 24);
      if (raider && !danger.some((d) => Math.hypot(d.x - raider.position.x, d.z - raider.position.z) < 32)) {
        danger.push({ x: Math.round(raider.position.x), z: Math.round(raider.position.z) });
      }
      return raider && !state.sheltered && raider.distance > 2.5 ? 1 : 0;
    },
    async run(ctx) {
      const raider = ctx.perceive().hostiles.find((h) => AVOIDED.has(h.name));
      if (!raider) return { ok: true };
      ctx.record('avoid', { mob: raider.name, distance: Math.round(raider.distance) });
      return actions.fleeFrom(bot, ctx, raider.position, { distance: 32, timeoutMs: 15000 });
    },
  };
  let hidden = null;
  const hide = {
    name: 'hide',
    band: BAND.ESCAPE,
    want(state) {
      if (hidden) return 1;
      return !state.sheltered && angryEnderman(state, 12) ? 1 : 0;
    },
    async run(ctx) {
      if (!hidden) {
        ctx.record('hide', { from: 'enderman' });
        const dug = await skills.digIn(bot, ctx, { sealMatch: (n) => SEALS.has(n) });
        if (!dug.ok) return dug;
        hidden = { bunker: dug.bunker, since: Date.now() };
        return { ok: true };
      }
      const waited = Date.now() - hidden.since;
      if (waited < 90000 && (waited < 25000 || angryEnderman(ctx.perceive(), 24))) {
        await sleep(2000, ctx.signal);
        return { ok: true, waited: true };
      }
      const out = await skills.digOut(bot, ctx, hidden.bunker);
      hidden = null;
      return out;
    },
  };
  const onDeathHide = () => { hidden = null; };
  bot.on?.('death', onDeathHide);
  hide.dispose = () => bot.removeListener?.('death', onDeathHide);

  return [escape, breathe, hide, defend, avoid, eat, provision, recover, recoverDrops];
}

module.exports = { createSurvivalBehaviors };
