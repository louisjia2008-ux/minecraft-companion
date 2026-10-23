'use strict';
// Always-on survival behaviors. They outrank any goal; the brain preempts the
// goal while one of them wants the body and the goal re-plans afterwards.
// Kept deliberately simple; hardening them is the next milestone.

const { Vec3 } = require('vec3');
const defaultActions = require('../actions');
const defaultSkills = require('../skills');
const { BAND } = require('../brain');
const { sleep } = require('../confirm');
const { createBlacklist } = require('../blacklist');
const { goals } = require('mineflayer-pathfinder');

const dimensionOf = (bot) => String(bot?.game?.dimension || 'overworld').replace(/^minecraft:/, '');

function nearbyGhast(bot, range) {
  const here = bot.entity?.position;
  if (!here) return null;
  return Object.values(bot.entities || {}).find((e) => e.name === 'ghast' && e.position && e.position.distanceTo(here) <= range) || null;
}

/** True when no full block lies on the straight line between two points. */
function clearLine(bot, from, to) {
  const d = to.minus(from);
  const steps = Math.ceil(d.norm() * 3);
  for (let i = 1; i < steps; i += 1) {
    const b = bot.blockAt(from.plus(d.scaled(i / steps)));
    if (b && b.boundingBox === 'block') return false;
  }
  return true;
}

/** The ghast that can see the bot's head, or null. */
function exposedTo(bot, range) {
  const head = bot.entity.position.offset(0, 1.6, 0);
  for (const e of Object.values(bot.entities || {})) {
    if (e.name !== 'ghast' || !e.position || e.position.distanceTo(head) > range) continue;
    if (clearLine(bot, e.position.offset(0, 2, 0), head)) return e;
  }
  return null;
}

/** A nearby standable cell with a roof that the ghast cannot see into. */
function coverSpot(bot, ghast) {
  const feet = bot.entity.position.floored();
  const eye = ghast.position.offset(0, 2, 0);
  let best = null;
  for (let dx = -6; dx <= 6; dx += 1) {
    for (let dz = -6; dz <= 6; dz += 1) {
      for (let dy = -2; dy <= 2; dy += 1) {
        const p = feet.offset(dx, dy, dz);
        const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy);
        if (best && d >= best.d) continue;
        const floor = bot.blockAt(p.offset(0, -1, 0));
        if (!floor || floor.boundingBox !== 'block' || /magma|lava/.test(floor.name)) continue;
        if (bot.blockAt(p)?.boundingBox !== 'empty' || bot.blockAt(p.offset(0, 1, 0))?.boundingBox !== 'empty') continue;
        if (/lava|fire/.test(bot.blockAt(p)?.name || '')) continue;
        if (bot.blockAt(p.offset(0, 2, 0))?.boundingBox !== 'block') continue;
        if (clearLine(bot, eye, p.offset(0.5, 1.6, 0.5)) || clearLine(bot, eye, p.offset(0.5, 0.5, 0.5))) continue;
        best = { p, d };
      }
    }
  }
  return best?.p || null;
}

/** A ghast fireball within 6 blocks that is closing in. */
function incomingFireball(bot) {
  const head = bot.entity?.position?.offset(0, 1.6, 0);
  if (!head) return null;
  return Object.values(bot.entities || {}).find((e) => {
    if (e.name !== 'fireball' || !e.position) return false;
    const distance = e.position.distanceTo(head);
    if (distance > 6) return false;
    const v = e.velocity;
    return !v || v.norm() === 0 || e.position.plus(v).distanceTo(head) < distance;
  }) || null;
}

const { RISKY_FOODS } = defaultActions;
const RANGED = new Set(['skeleton', 'stray', 'bogged']);
// Pillagers come in groups from outposts that keep spawning them: keep away.
const AVOIDED = new Set(['pillager', 'vindicator', 'evoker', 'ravager']);
// Piglin brutes ignore gold armour and hit for half a heart bar with their axe: keep clear of them too.
const BRUTE_RANGE = 12;
const KEPT_DROPS = new Set(['string', 'blaze_rod', 'wither_skeleton_skull']);
// One that got this close outruns the bot: turn and fight it.
const BRUTE_FIGHT = 4;
// Neutral mobs are left alone unless they are right next to us.
const NEUTRAL = new Set(['enderman', 'zombified_piglin', 'piglin', 'spider', 'cave_spider']);
const SEALS = new Set(['dirt', 'cobblestone', 'cobbled_deepslate', 'coarse_dirt']);
const CALM_UNLESS_PROVOKED = new Set(['zombified_piglin', 'piglin']);
const wearsGold = (bot) => /^golden_/.test(bot.inventory?.slots?.[5]?.name || '');
const FOOD_ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];

function createSurvivalBehaviors({ bot, actions = defaultActions, skills = defaultSkills, isFood, spare = () => false, thresholds = {} } = {}) {
  // At night an archer is not chased far: out there more of them spawn, and
  // the way home to bed is the better defence.
  const t = { ghastRange: 48, escapeHealth: 6, escapeRange: 6, defendRange: 5, rangedRange: 14, nightRangedRange: 6, rangedHealth: 14, eatFood: 14,
    eatQuietRange: 4, provisionFood: 12, provisionHealth: 10, recoverHealth: 10, oxygen: 8, dropsTtlMs: 270000,
    walkSpeed: 4, dropsMaxDistance: 600,
    ...thresholds };
  const huntBlacklist = createBlacklist({ ttlMs: 60000 });
  const exploreMemory = {};
  let stuckStreak = 0;
  const foodCheck = isFood || ((name) => Boolean(bot.registry.foodsByName?.[name]));
  const hasSafeFood = (state, desperate) => Object.entries(state.inventory)
    .some(([name, count]) => count > 0 && foodCheck(name) && (desperate || !RISKY_FOODS.has(name)));
  // Zombified piglins (and piglins, while the bot wears gold) leave the bot
  // alone unless provoked, and hitting one turns the whole group. Only a mob
  // of a pack that has hurt the bot counts as a threat.
  const provoked = new Map(); // entity id -> until
  const calm = (h) => {
    if (!CALM_UNLESS_PROVOKED.has(h.name)) return false;
    if ((provoked.get(h.id) || 0) > Date.now()) return false;
    return h.name === 'zombified_piglin' || wearsGold(bot);
  };
  const threats = (state) => state.hostiles.filter((h) => !calm(h));
  // entityHurt names no attacker, so a mob counts as the culprit only if it
  // swung its arm at melee range just before the hit; a skeleton arrow, a fall
  // or fire next to a calm piglin must not turn the pack hostile.
  const swings = new Map(); // entity id -> time of last arm swing
  const onSwing = (entity) => {
    if (entity && CALM_UNLESS_PROVOKED.has(entity.name)) swings.set(entity.id, Date.now());
  };
  const onHurt = (entity) => {
    if (entity !== bot.entity) return;
    const here = bot.entity.position;
    const culprit = Object.values(bot.entities || {})
      .filter((e) => CALM_UNLESS_PROVOKED.has(e.name) && e.position && e.position.distanceTo(here) <= 4
        && Date.now() - (swings.get(e.id) || 0) <= 600)
      .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0];
    if (!culprit) return;
    for (const e of Object.values(bot.entities || {})) {
      if (e.name === culprit.name && e.position && e.position.distanceTo(culprit.position) <= 24) provoked.set(e.id, Date.now() + 60000);
    }
  };
  bot.on?.('entitySwingArm', onSwing);
  bot.on?.('entityHurt', onHurt);
  const nearest = (state) => threats(state)[0] || null;
  // Chasing an archer bare-handed, or down into the cave it shoots from, loses.
  const armed = (state) => Object.keys(state.inventory).some((n) => n.endsWith('_sword') || n.endsWith('_axe'));
  // Melee anything close; go after archers only while healthy enough to close in.
  const target = (state) => {
    // In shelter only something that got right next to the bot is fought.
    if (state.sheltered) return threats(state).find((h) => h.distance <= 2) || null;
    return threats(state).find((h) => h.name !== 'creeper' && !((AVOIDED.has(h.name) && h.distance > 2.5) || (h.name === 'piglin_brute' && h.distance > BRUTE_FIGHT))
      && (h.distance <= (NEUTRAL.has(h.name) ? 2.5 : t.defendRange)
        || (RANGED.has(h.name) && h.distance <= (state.isDay === false ? t.nightRangedRange : t.rangedRange)
          && state.health > t.rangedHealth && armed(state)
          && Math.abs(h.position.y - state.position.y) <= 4))) || null;
  };

  const escape = {
    name: 'escape',
    band: BAND.ESCAPE,
    want(state) {
      const threat = nearest(state);
      if (!threat || state.sheltered) return 0;
      if (threat.name === 'creeper' && threat.distance <= 4) return 1;
      // A brute or hoglin on the bot outruns it: running only takes the hits in the back.
      if ((threat.name === 'piglin_brute' || threat.name === 'hoglin') && threat.distance <= BRUTE_FIGHT) return 0;
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
      // Spiders drop string (wool where there are no sheep); blazes and wither
      // skeletons fought off in a fortress drop what the expedition is there for.
      if (result.ok && typeof actions.collectDrops === 'function') {
        await actions.collectDrops(bot, ctx, last, (n) => KEPT_DROPS.has(n), { radius: 6, timeoutMs: 4000 });
      }
      return result;
    },
  };

  const eat = {
    name: 'eat',
    band: BAND.MAINTENANCE,
    want(state) {
      if (threats(state).some((h) => h.distance <= t.eatQuietRange)) return 0;
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
      // Nothing to hunt in the nether but hoglins; wandering off there to look for food kills.
      if (dimensionOf(bot) !== 'overworld') return 0;
      if (threats(state).some((h) => h.distance <= 8)) return 0;
      // Chasing animals at low health gets the bot killed at night; by day with
      // nothing hostile around it is the only way back to regenerating.
      if (state.health < t.provisionHealth && state.food > 6
        && (state.isDay === false || threats(state).some((h) => h.distance <= 16))) return 0;
      return 0.5;
    },
    async run(ctx) {
      // Animals are visible out to about 100 blocks; go for the nearest one seen.
      const result = await skills.huntOne(bot, ctx, { mobs: FOOD_ANIMALS, dropMatch: foodCheck, radius: 96, blacklist: huntBlacklist,
        accept: (e) => !spare(e) });
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
      && !threats(state).some((h) => h.distance <= 8) ? 0.3 : 0),
    async run(ctx) {
      actions.haltBody(bot);
      await sleep(3000, ctx.signal);
      return { ok: true };
    },
  };

  // Items dropped on death stay for five minutes: go back for them once it is safe.
  let lastDeath = null;
  const onDeathDrops = () => {
    lastDeath = { position: bot.entity.position.clone(), dimension: dimensionOf(bot), at: Date.now(), tries: 0 };
  };
  bot.on?.('death', onDeathDrops);
  const recoverDrops = {
    name: 'recover_drops',
    band: BAND.MAINTENANCE,
    dispose: () => bot.removeListener?.('death', onDeathDrops),
    want(state) {
      if (state.sheltered || !lastDeath || Date.now() - lastDeath.at > t.dropsTtlMs || lastDeath.tries >= 3) return 0;
      if (state.health < 10 || threats(state).some((h) => h.distance <= 8)) return 0;
      // Drops left in the other dimension wait until a goal takes the bot back there.
      if (lastDeath.dimension !== dimensionOf(bot)) return 0;
      // Where the bot keeps dying, the drops are bait: leave them.
      const danger = bot.companionDeathDanger;
      if (danger && danger.until > Date.now() && danger.dimension === lastDeath.dimension
        && lastDeath.position.distanceTo(new Vec3(danger.center.x, danger.center.y, danger.center.z)) <= 24) return 0;
      // Worth the trip while the bot can still get there before they despawn.
      const reachable = Math.min(t.dropsMaxDistance, ((t.dropsTtlMs - (Date.now() - lastDeath.at)) / 1000) * t.walkSpeed);
      return state.position.distanceTo(lastDeath.position) < reachable ? 0.8 : 0;
    },
    async run(ctx) {
      const target = lastDeath;
      target.tries += 1;
      ctx.record('recover_drops', { position: target.position.floored(), try: target.tries });
      const left = t.dropsTtlMs - (Date.now() - target.at);
      const moved = await actions.goNear(bot, ctx, target.position, 2, { timeoutMs: Math.max(60000, Math.min(240000, left)) });
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
  const angryEnderman = (state, range) => threats(state).find((h) => h.name === 'enderman' && h.distance <= range
    && creepyIndex >= 0 && bot.entities?.[h.id]?.metadata?.[creepyIndex] === true);
  // Remember where raiders were seen; the homestead keeps its site away from there.
  const danger = (bot.companionDanger = bot.companionDanger || []);
  const avoid = {
    name: 'avoid',
    band: BAND.DEFENSE,
    want(state) {
      const brute = threats(state).find((h) => h.name === 'piglin_brute' && h.distance <= BRUTE_RANGE);
      if (brute) return !state.sheltered && brute.distance > BRUTE_FIGHT ? 1 : 0;
      const raider = threats(state).find((h) => AVOIDED.has(h.name) && h.distance <= 24);
      if (raider && !danger.some((d) => Math.hypot(d.x - raider.position.x, d.z - raider.position.z) < 32)) {
        danger.push({ x: Math.round(raider.position.x), z: Math.round(raider.position.z) });
      }
      return raider && !state.sheltered && raider.distance > 2.5 ? 1 : 0;
    },
    async run(ctx) {
      const raider = ctx.perceive().hostiles.find((h) => AVOIDED.has(h.name) || h.name === 'piglin_brute');
      if (!raider) return { ok: true };
      ctx.record('avoid', { mob: raider.name, distance: Math.round(raider.distance) });
      const brute = raider.name === 'piglin_brute';
      return actions.fleeFrom(bot, ctx, raider.position, { distance: brute ? BRUTE_RANGE + 6 : 32, timeoutMs: 15000 });
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

  // A ghast's fireball is sent back by hitting it.
  const deflect = {
    name: 'deflect',
    band: BAND.ESCAPE,
    want: () => (incomingFireball(bot) ? 1 : 0),
    async run(ctx) {
      for (let i = 0; i < 10; i += 1) {
        const ball = incomingFireball(bot);
        if (!ball) return { ok: true };
        ctx.record('deflect', { distance: Math.round(ball.position.distanceTo(bot.entity.position) * 10) / 10 });
        await bot.lookAt(ball.position, true);
        if (ball.position.distanceTo(bot.entity.position.offset(0, 1.6, 0)) <= 3.5) bot.attack(ball);
        await sleep(100, ctx.signal);
      }
      return { ok: true };
    },
  };

  // A ghast that can see the bot keeps shooting: get under a roof, out of its sight.
  let coverUntil = 0;
  const cover = {
    name: 'take_cover',
    band: BAND.DEFENSE,
    want(state) {
      if (state.sheltered || Date.now() < coverUntil) return 0;
      return exposedTo(bot, t.ghastRange) ? 1 : 0;
    },
    async run(ctx) {
      const ghast = exposedTo(bot, t.ghastRange);
      if (!ghast) return { ok: true };
      ctx.record('take_cover', { from: 'ghast', distance: Math.round(ghast.position.distanceTo(bot.entity.position)) });
      const spot = coverSpot(bot, ghast);
      try {
        if (spot) {
          await actions.goTo(bot, ctx, new goals.GoalBlock(spot.x, spot.y, spot.z), { timeoutMs: 8000 });
        } else {
          const dug = await skills.digIn(bot, ctx, { sealMatch: (n) => SEALS.has(n) || n === 'netherrack' });
          if (dug.ok) {
            await sleep(8000, ctx.signal);
            await skills.digOut(bot, ctx, dug.bunker);
          }
        }
        // Wait out its attention while covered; give up after a few seconds either way.
        for (let i = 0; i < 16 && exposedTo(bot, t.ghastRange) === null && nearbyGhast(bot, t.ghastRange); i += 1) {
          await sleep(500, ctx.signal);
        }
      } finally {
        // Work resumes for a while even if the ghast is still around, or nothing gets done.
        coverUntil = Date.now() + 10000;
      }
      return { ok: true };
    },
  };

  const disposeNether = () => {
    bot.removeListener?.('entityHurt', onHurt);
    bot.removeListener?.('entitySwingArm', onSwing);
  };
  deflect.dispose = disposeNether;

  return [escape, breathe, deflect, hide, defend, cover, avoid, eat, provision, recover, recoverDrops];
}

module.exports = { createSurvivalBehaviors };
