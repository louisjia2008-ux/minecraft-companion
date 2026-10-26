'use strict';
// Always-on survival behaviors. They outrank any goal; the brain preempts the
// goal while one of them wants the body and the goal re-plans afterwards.
// Kept deliberately simple; hardening them is the next milestone.

const { Vec3 } = require('vec3');
const defaultActions = require('../actions');
const defaultSkills = require('../skills');
const { BAND } = require('../brain');
const { sleep, waitUntil } = require('../confirm');
const { isFireResistancePotion, hasEffect } = require('../netherStructures');
const { createBlacklist } = require('../blacklist');
const { goals } = require('mineflayer-pathfinder');

// Entity flag bit 0 is "on fire".
const burning = (bot) => (Number(bot.entity?.metadata?.[0]) & 1) === 1 || bot.entity?.isInLava === true;
const dimensionOf = (bot) => String(bot?.game?.dimension || 'overworld').replace(/^minecraft:/, '');

function nearbyGhast(bot, range) {
  const here = bot.entity?.position;
  if (!here) return null;
  return Object.values(bot.entities || {}).find((e) => e.name === 'ghast' && e.position && e.position.distanceTo(here) <= range) || null;
}

/** The top lava cell above `feet`: a bot sunk deep in a lava sea is far below it. */
function lavaSurface(bot, feet) {
  let surface = feet.y;
  while (surface < feet.y + 32 && bot.blockAt(feet.offset(0, surface - feet.y + 1, 0))?.name === 'lava') surface += 1;
  return surface;
}

/**
 * The nearest solid cell, out of the lava, that a swimmer can climb onto: its
 * top no higher than one block above the lava's surface.
 */
function lavaShore(bot, radius = 16, usable = () => true) {
  const feet = bot.entity.position.floored();
  const surface = lavaSurface(bot, feet);
  const open = (b) => b && b.boundingBox === 'empty' && !/lava|fire/.test(b.name);
  let best = null;
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let y = feet.y - 1; y <= surface; y += 1) {
        const p = new Vec3(feet.x + dx, y, feet.z + dz);
        const d = Math.hypot(dx, dz);
        if (best && d >= best.d) continue;
        const floor = bot.blockAt(p);
        if (!floor || floor.boundingBox !== 'block' || /magma/.test(floor.name)) continue;
        if (!open(bot.blockAt(p.offset(0, 1, 0))) || !open(bot.blockAt(p.offset(0, 2, 0)))) continue;
        if (!usable(p)) continue;
        best = { p, d };
      }
    }
  }
  return best?.p || null;
}

/**
 * With no shore to climb: the top lava cell nearest the bot that has a solid
 * block beside it, where a placed block makes a step out.
 */
function lavaStep(bot, radius = 40) {
  const feet = bot.entity.position.floored();
  const surface = lavaSurface(bot, feet);
  const sides = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
  let best = null;
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      const d = Math.hypot(dx, dz);
      if (best && d >= best.d) continue;
      const cell = new Vec3(feet.x + dx, surface, feet.z + dz);
      if (bot.blockAt(cell)?.name !== 'lava') continue;
      // Not a cell the bot itself is in: no block can be placed there.
      const at = bot.entity.position;
      if (Math.abs(at.x - (cell.x + 0.5)) < 0.8 && Math.abs(at.z - (cell.z + 0.5)) < 0.8) continue;
      // Room to stand on the step once it is placed.
      if (![1, 2].every((up) => { const b = bot.blockAt(cell.offset(0, up, 0)); return b?.boundingBox === 'empty' && b.name !== 'lava'; })) continue;
      const wall = sides.map((f) => cell.plus(f)).find((p) => {
        const b = bot.blockAt(p);
        return b && b.boundingBox === 'block' && !/magma/.test(b.name);
      });
      if (wall) best = { cell, wall, d };
    }
  }
  return best;
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

/** A blaze's fireball flying at the bot, or null. */
function incomingBlazeShot(bot, range = 10) {
  const head = bot.entity?.position?.offset(0, 1.2, 0);
  if (!head) return null;
  return Object.values(bot.entities || {}).find((e) => {
    if (e.name !== 'small_fireball' || !e.position) return false;
    const distance = e.position.distanceTo(head);
    if (distance > range) return false;
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
// Anything solid it carries makes a lava step: a fortress run ends with
// stacks of nether bricks and no cobblestone left after a tower.
const STEP_BLOCKS = new Set(['cobblestone', 'netherrack', 'blackstone', 'cobbled_deepslate', 'dirt', 'basalt', 'soul_soil',
  'nether_bricks', 'polished_basalt', 'smooth_basalt', 'soul_sand', 'stone', 'end_stone']);
const GOLDEN_APPLES = new Set(['golden_apple', 'enchanted_golden_apple']);
const SHOOTERS = new Set(['blaze', 'ghast']);
const KEPT_DROPS = new Set(['string', 'blaze_rod', 'wither_skeleton_skull']);
const SKULL_DROPPERS = new Set(['wither_skeleton', 'blaze']);
// Hoglins too: their charge tosses the bot, into lava as often as not.
const CHARGERS = new Set(['piglin_brute', 'hoglin']);
// One that got this close outruns the bot: turn and fight it.
const BRUTE_FIGHT = 4;
// Neutral mobs are left alone unless they are right next to us.
const NEUTRAL = new Set(['enderman', 'zombified_piglin', 'piglin', 'spider', 'cave_spider']);
const SEALS = new Set(['dirt', 'cobblestone', 'cobbled_deepslate', 'coarse_dirt']);
const CALM_UNLESS_PROVOKED = new Set(['zombified_piglin', 'piglin']);
const OTHER_ATTACKERS = new Set(['wither_skeleton', 'skeleton', 'blaze', 'ghast', 'magma_cube', 'hoglin', 'piglin_brute', 'zombie', 'husk', 'spider', 'cave_spider', 'creeper', 'stray', 'bogged']);
const PROJECTILES = new Set(['arrow', 'small_fireball', 'fireball', 'spectral_arrow']);
const wearsGold = (bot) => /^golden_/.test(bot.inventory?.slots?.[5]?.name || '');
const FOOD_ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];

function createSurvivalBehaviors({ bot, actions = defaultActions, skills = defaultSkills, isFood, spare = () => false, thresholds = {} } = {}) {
  // At night an archer is not chased far: out there more of them spawn, and
  // the way home to bed is the better defence.
  const t = { ghastRange: 48, escapeHealth: 6, healHealth: 10, escapeRange: 6, defendRange: 5, rangedRange: 14, nightRangedRange: 6, rangedHealth: 14, eatFood: 14,
    eatQuietRange: 4, provisionFood: 12, provisionHealth: 10, recoverHealth: 10, recoverFood: 18, oxygen: 8, dropsTtlMs: 270000,
    walkSpeed: 4, dropsMaxDistance: 600, swimScale: 1,
    ...thresholds };
  const huntBlacklist = createBlacklist({ ttlMs: 60000 });
  const exploreMemory = {};
  let stuckStreak = 0;
  const foodCheck = isFood || ((name) => Boolean(bot.registry.foodsByName?.[name]));
  const hasSafeFood = (state, desperate) => Object.entries(state.inventory)
    .some(([name, count]) => count > 0 && foodCheck(name) && (desperate || !RISKY_FOODS.has(name)));
  const desperateForFood = (state) => state.food <= 6 || state.health <= 8;
  // Zombified piglins (and piglins, while the bot wears gold) leave the bot
  // alone unless provoked, and hitting one turns the whole group. Only a mob
  // of a pack that has hurt the bot counts as a threat.
  const provoked = new Map(); // entity id -> until
  const creepyIndex = bot.registry?.entitiesByName?.enderman?.metadataKeys?.indexOf('creepy') ?? -1;
  const endermanAngry = (h) => (creepyIndex >= 0 && bot.entities?.[h.id]?.metadata?.[creepyIndex] === true)
    || (provoked.get(h.id) || 0) > Date.now();
  // The server flags a mob that is going for its target (mob_flags bit 4).
  // In a fortress the swing heuristic below never blames a zombified piglin
  // (a wither skeleton is always about), so a pack that turned on the bot
  // hit it to death while it was let alone as calm.
  const mobFlagsIndex = bot.registry?.entitiesByName?.zombified_piglin?.metadataKeys?.indexOf('mob_flags') ?? -1;
  const aggressive = (h) => mobFlagsIndex >= 0 && ((bot.entities?.[h.id]?.metadata?.[mobFlagsIndex] || 0) & 4) !== 0;
  const calm = (h) => {
    // Proximity does not make an enderman hostile. Attacking a calm one is
    // precisely what turns an avoidable encounter into a deadly fight.
    if (h.name === 'enderman') return !endermanAngry(h);
    if (!CALM_UNLESS_PROVOKED.has(h.name)) return false;
    if ((provoked.get(h.id) || 0) > Date.now()) return false;
    if (aggressive(h)) return false;
    return h.name === 'zombified_piglin' || wearsGold(bot);
  };
  const threats = (state) => state.hostiles.filter((h) => !calm(h));
  // entityHurt names no attacker, so a mob counts as the culprit only if it
  // swung its arm at melee range just before the hit; a skeleton arrow, a fall
  // or fire next to a calm piglin must not turn the pack hostile.
  const swings = new Map(); // entity id -> time of last arm swing
  const trackedNeutral = (e) => CALM_UNLESS_PROVOKED.has(e.name) || e.name === 'enderman';
  const onSwing = (entity) => {
    if (entity && trackedNeutral(entity)) swings.set(entity.id, Date.now());
  };
  const onHurt = (entity) => {
    if (entity !== bot.entity) return;
    const here = bot.entity.position;
    const culprit = Object.values(bot.entities || {})
      .filter((e) => trackedNeutral(e) && e.position && e.position.distanceTo(here) <= 4
        && Date.now() - (swings.get(e.id) || 0) <= 600)
      .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0];
    if (!culprit) return;
    if (culprit.name === 'enderman') {
      // Endermen do not share the piglin group's provocation state.
      provoked.set(culprit.id, Date.now() + 60000);
      return;
    }
    // Another attacker in reach (a wither skeleton's blade, a blaze's fireball,
    // an arrow) makes the swing a coincidence; hitting the pack then turns all
    // of it. Blame the pack only when nothing else could have done it.
    const other = Object.values(bot.entities || {}).some((e) => e.position && e !== bot.entity
      && ((OTHER_ATTACKERS.has(e.name) && e.position.distanceTo(here) <= 24)
        || (PROJECTILES.has(e.name) && e.position.distanceTo(here) <= 6)));
    if (other) return;
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
  // A brute by the way home keeps coming back however often the bot runs.
  // Fled from five times in three minutes, it is fought instead, while
  // the bot is armed and healthy. A hoglin is fought straight away: crimson
  // forests are full of them, and running from each one turned a walk to a
  // fortress into a hundred aborted legs.
  const flights = new Map(); // entity id -> times fled from
  const standing = (state, h) => CHARGERS.has(h.name) && armed(state) && state.health > 12
    && (h.name === 'hoglin' || (flights.get(h.id) || []).filter((at) => Date.now() - at < 180000).length >= 5);
  // A pillager patrol chased a bot in diamond armour with a sword across the
  // map for seven minutes, away from the portal it was building. So kitted,
  // pillagers are fought like skeletons; the rest of a raid is still avoided.
  const kitted = (state) => armed(state) && /^(diamond|netherite)_chestplate$/.test(bot.inventory?.slots?.[6]?.name || '');
  const avoided = (state, h) => AVOIDED.has(h.name) && !(h.name === 'pillager' && kitted(state) && state.health > t.rangedHealth);
  const target = (state) => {
    // In shelter only something that got right next to the bot is fought.
    if (state.sheltered) return threats(state).find((h) => h.distance <= 2) || null;
    return threats(state).find((h) => h.name !== 'creeper' && !((avoided(state, h) && h.distance > 2.5) || (CHARGERS.has(h.name) && h.distance > BRUTE_FIGHT && !standing(state, h)))
      && (h.distance <= (NEUTRAL.has(h.name) ? 2.5 : t.defendRange)
        || ((RANGED.has(h.name) || (h.name === 'pillager' && !avoided(state, h))) && h.distance <= (state.isDay === false ? t.nightRangedRange : t.rangedRange)
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
      if (CHARGERS.has(threat.name) && threat.distance <= BRUTE_FIGHT) return 0;
      // In the End an enderman teleports after anything that runs, and the
      // run ends in the void: fight it out there instead.
      if (threat.name === 'enderman' && dimensionOf(bot) === 'the_end') return 0;
      return state.health <= t.escapeHealth && threat.distance <= t.escapeRange ? 1 : 0;
    },
    run: (ctx) => actions.fleeFrom(bot, ctx, nearest(ctx.perceive())?.position || bot.entity.position),
  };

  const droppedNear = (at, radius) => Object.values(bot.entities || {})
    .filter((e) => e.name === 'item' && e.position && e.position.distanceTo(at) <= radius)
    .map((e) => { try { return e.getDroppedItem?.()?.name || '?'; } catch { return '?'; } });
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
      if (result.ok) {
        // What fell where it died (a skull lost to lava shows here as nothing).
        if (result.died && SKULL_DROPPERS.has(threat.name)) await sleep(600, ctx.signal);
        const drops = result.died && SKULL_DROPPERS.has(threat.name) ? droppedNear(last, 6) : undefined;
        ctx.record('defend_result', { mob: threat.name, died: result.died === true, hits: result.hits, ...(drops ? { drops, y: Math.round(last.y) } : {}) });
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
      // A goal mid-dodge (out of a taking-off dragon's path) must not stop to eat.
      if ((bot.companionNoEatUntil || 0) > Date.now() && state.health > 6) return 0;
      const hungry = state.food <= t.eatFood || (state.health < 16 && state.food < 20);
      // Risky food (rotten flesh, raw chicken) only when starving or nearly dead.
      return hungry && hasSafeFood(state, desperateForFood(state)) ? 1 : 0;
    },
    run: (ctx) => actions.eat(bot, ctx),
  };

  // Burning (lava, a blaze's fireball): drink fire resistance if there is any.
  // Rides along with any other escape: it takes under two seconds.
  const quench = {
    name: 'quench',
    band: BAND.ESCAPE,
    want: () => (burning(bot) && !hasEffect(bot, 'FireResistance') && bot.inventory?.items?.().some(isFireResistancePotion) ? 3 : 0),
    async run(ctx) {
      const potion = bot.inventory.items().find(isFireResistancePotion);
      if (!potion) return { ok: false, reason: 'no_potion' };
      ctx.record('quench', { inLava: bot.entity.isInLava === true });
      try {
        await bot.equip(potion, 'hand');
        await bot.consume();
      } catch { /* confirmed by the effect below */ }
      const ok = await waitUntil(() => hasEffect(bot, 'FireResistance'), { timeoutMs: 2000, signal: ctx.signal });
      return ok ? { ok: true } : { ok: false, reason: 'drink_unconfirmed' };
    },
  };

  // Badly hurt mid-fight (wither skeletons, brutes): a golden apple's absorption
  // and regeneration buy the time running away does not.
  const heal = {
    name: 'heal',
    band: BAND.ESCAPE,
    want: (state) => (state.health <= t.healHealth && !hasEffect(bot, 'Regeneration')
      && bot.inventory?.items?.().some((i) => GOLDEN_APPLES.has(i.name)) ? 1.2 : 0),
    async run(ctx) {
      const apple = bot.inventory.items().find((i) => i.name === 'enchanted_golden_apple')
        || bot.inventory.items().find((i) => i.name === 'golden_apple');
      if (!apple) return { ok: false, reason: 'no_golden_apple' };
      ctx.record('heal', { item: apple.name, health: Math.round(bot.health) });
      try {
        await bot.equip(apple, 'hand');
        await bot.consume();
      } catch { /* confirmed by the effect below */ }
      const ok = await waitUntil(() => hasEffect(bot, 'Regeneration'), { timeoutMs: 2000, signal: ctx.signal });
      return ok ? { ok: true } : { ok: false, reason: 'eat_unconfirmed' };
    },
  };

  // Swimming in lava (a hoglin's toss, a slip): the pathfinder cannot plan from
  // there. Swim for the nearest shore it can climb; with only cliffs around,
  // swim to one, put a block on the lava against it and climb onto that.
  // Magma cubes live in the lava seas: one beside a swimming bot knocks it
  // back off every step it climbs and hits it to death with fire resistance
  // on. Hit any in reach on the way, without stopping the swim.
  let lastSwimHit = 0;
  async function hitInPassing() {
    if (Date.now() - lastSwimHit < 500) return;
    const here = bot.entity.position;
    const cube = Object.values(bot.entities || {}).find((e) => e.name === 'magma_cube' && e.position
      && e.position.distanceTo(here) <= 3);
    if (!cube) return;
    const sword = bot.inventory.items().find((i) => i.name.endsWith('_sword'));
    if (sword && bot.heldItem?.name !== sword.name) {
      try { await bot.equip(sword, 'hand'); } catch { return; }
    }
    lastSwimHit = Date.now();
    bot.attack(cube);
  }
  async function swimTo(ctx, point, until, maxTicks = 150) {
    try {
      for (let i = 0; i < maxTicks * t.swimScale && !until(); i += 1) {
        await hitInPassing();
        await bot.lookAt(point, true);
        for (const control of ['jump', 'forward', 'sprint']) bot.setControlState(control, true);
        await sleep(100, ctx.signal);
      }
    } finally {
      for (const control of ['jump', 'forward', 'sprint']) bot.setControlState(control, false);
    }
  }
  // Jump, and once clear of the floor put a block on it: one block higher
  // each round, until the head is out of the lava.
  async function towerUp(ctx, block, out) {
    try { await bot.equip(block, 'hand'); } catch { return; }
    for (let i = 0; i < 12 && !out() && !ctx.signal?.aborted; i += 1) {
      const floor = bot.blockAt(bot.entity.position.offset(0, -0.5, 0));
      if (!floor || floor.boundingBox !== 'block') return;
      if (!bot.inventory.items().some((it) => it.name === block.name)) return;
      try {
        await bot.look(bot.entity.yaw, -Math.PI / 2, true);
        bot.setControlState('jump', true);
        await waitUntil(() => bot.entity.position.y >= floor.position.y + 2, { timeoutMs: 2500, signal: ctx.signal });
        await bot.placeBlock(floor, new Vec3(0, 1, 0));
      } catch { /* checked by the next round's floor */ } finally {
        bot.setControlState('jump', false);
      }
      await waitUntil(() => bot.entity.onGround, { timeoutMs: 1500, signal: ctx.signal }).catch(() => {});
    }
  }
  // Still in lava is not a failure to back off from: the next try comes at
  // once, before the bot sinks out of reach of the walls.
  const shoreMisses = new Map(); // "(x, y, z)" -> { count, until }
  // Tries that ended still in lava where they began: a shallow pocket under
  // a ledge can hold the bot for an hour with every shore just out of reach.
  // Drifting a block or two between tries is still being held there.
  let lavaStuck = { at: null, count: 0 };
  const heldNear = (p) => Boolean(lavaStuck.at && lavaStuck.at.distanceTo(p) <= 3);
  const lavaResult = (ctx, done) => {
    if (!done) {
      const at = bot.entity.position.floored();
      lavaStuck = heldNear(at) ? { at: lavaStuck.at, count: lavaStuck.count + 1 } : { at, count: 1 };
      ctx.record('still_in_lava', { tries: lavaStuck.count });
    }
    return { ok: true, waited: !done };
  };
  // A pocket of lava under a low roof has no shore with room to stand: dig
  // out the two blocks above a wall beside the bot, so the wall becomes one.
  async function digShore(ctx) {
    const feet = bot.entity.position.floored();
    const surface = lavaSurface(bot, feet);
    if (surface - feet.y > 1) return false;
    const sides = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
    for (const side of sides) {
      const wall = new Vec3(feet.x, surface, feet.z).plus(side);
      const b = bot.blockAt(wall);
      if (!b || b.boundingBox !== 'block' || /magma/.test(b.name)) continue;
      const above = [1, 2].map((up) => bot.blockAt(wall.offset(0, up, 0)));
      // Digging into more lava only floods the pocket.
      if (above.some((a) => a?.name === 'lava') || bot.blockAt(wall.offset(0, 3, 0))?.name === 'lava') continue;
      const solid = above.filter((a) => a && a.boundingBox === 'block' && a.diggable !== false);
      if (!solid.length) continue;
      ctx.record('leave_lava', { dig: `${wall.x},${wall.y},${wall.z}`, blocks: solid.length });
      const pick = bot.inventory.items().find((i) => i.name.endsWith('_pickaxe'));
      try {
        if (pick) await bot.equip(pick, 'hand');
        for (const a of solid) await bot.dig(a, true);
      } catch { return false; }
      await swimTo(ctx, wall.offset(0.5, 1.2, 0.5), () => !bot.entity.isInLava && bot.entity.onGround !== false, 50);
      return true;
    }
    return false;
  }
  // What is around a bot stuck in lava, for the log: solid cells only.
  function surroundings(feet) {
    const cells = [];
    for (let dy = -1; dy <= 3; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        for (let dz = -2; dz <= 2; dz += 1) {
          const b = bot.blockAt(feet.offset(dx, dy, dz));
          if (b && b.boundingBox === 'block') cells.push(`${dx},${dy},${dz}:${b.name}`);
        }
      }
    }
    return cells.join(' ');
  }
  const leaveLava = {
    name: 'leave_lava',
    band: BAND.ESCAPE,
    want: () => (bot.entity?.isInLava === true ? 2 : 0),
    async run(ctx) {
      bot.pathfinder?.setGoal(null);
      // Out means standing out of it: bobbing up at the surface for a tick is
      // not, and stopping the swim there lets the bot slide straight back.
      const out = () => !bot.entity.isInLava && bot.entity.onGround !== false;
      const shore = lavaShore(bot, 16, (p) => {
        const miss = shoreMisses.get(p.toString());
        return !miss || miss.until <= Date.now() || miss.count < 4;
      });
      // Sunk to the floor of a deep pool, or held in the same spot try after
      // try: build a pillar up through the lava.
      const block = bot.inventory.items().find((i) => STEP_BLOCKS.has(i.name));
      const feet = bot.entity.position.floored();
      const held = heldNear(feet) && lavaStuck.count >= 3;
      if (block && bot.entity.onGround && (held || (!shore && lavaSurface(bot, feet) - feet.y >= 2))) {
        ctx.record('leave_lava', { tower: `${feet.x},${feet.y},${feet.z}`, surface: lavaSurface(bot, feet), block: block.name });
        await towerUp(ctx, block, out);
        if (out()) return { ok: true };
      }
      // Floating at the surface beside a shore it never gets onto: something
      // over its head (its own bridge, a tower's foot) stops the hop out,
      // which needs the space above clear. Dig that open.
      if (held && !bot.entity.onGround) {
        if (lavaStuck.count === 3) ctx.record('lava_held', { around: surroundings(feet) });
        const roof = [1, 2].map((up) => bot.blockAt(feet.offset(0, up, 0)))
          .filter((b) => b && b.boundingBox === 'block' && b.diggable !== false && !/lava/.test(bot.blockAt(b.position.offset(0, 1, 0))?.name || ''));
        if (roof.length) {
          ctx.record('leave_lava', { roof: roof.map((b) => `${b.name}@${b.position.y - feet.y}`) });
          const pick = bot.inventory.items().find((i) => i.name.endsWith('_pickaxe'));
          try {
            if (pick) await bot.equip(pick, 'hand');
            for (const b of roof) await bot.dig(b, true);
          } catch { /* the next try looks again */ }
        }
      }
      // Overhangs over the lava sea: the wall beside it has no room on top
      // either. Make room there (every hold seen had a roof two blocks up).
      if (held && await digShore(ctx)) return lavaResult(ctx, out());
      // A shore it keeps failing to reach (a current from flowing lava, a lip):
      // build its own step instead, which also stems the flow.
      const step = lavaStep(bot);
      if (shore && !(held && step && block)) {
        ctx.record('leave_lava', { shore: `${shore.x},${shore.y},${shore.z}` });
        await swimTo(ctx, shore.offset(0.5, 1.2, 0.5), out);
        if (out()) await sleep(400, ctx.signal);
        if (!out()) {
          // A shore it keeps failing to climb (a flowing edge, a lip) is
          // given up for a while in favour of another shore or a step.
          const key = shore.toString();
          const miss = shoreMisses.get(key);
          shoreMisses.set(key, { count: (miss && miss.until > Date.now() ? miss.count : 0) + 1, until: Date.now() + 120000 });
        }
        return lavaResult(ctx, out());
      }
      ctx.record('leave_lava', { shore: null, step: step ? `${step.cell.x},${step.cell.y},${step.cell.z}` : null, block: block?.name || null });
      if (!step && await digShore(ctx)) return lavaResult(ctx, out());
      if (!step || !block) {
        await swimTo(ctx, bot.entity.position.offset(0, 3, 0), out, 20);
        if (out()) return { ok: true };
        lavaResult(ctx, false);
        return { ok: false, reason: step ? 'no_step_block' : 'no_shore' };
      }
      const centre = step.cell.offset(0.5, 0.5, 0.5);
      // Out in a lava sea the nearest wall can be far: a long swim with fire resistance.
      // Sunk deep, it also has to come up within reach of the wall's top. It
      // swims for the cell beyond the step and stops short of the step's own
      // column: with its head in that cell the server refuses the block.
      const beyond = centre.plus(step.cell.minus(step.wall).scaled(1.2));
      const inCell = () => Math.abs(bot.entity.position.x - centre.x) < 0.8 && Math.abs(bot.entity.position.z - centre.z) < 0.8;
      await swimTo(ctx, beyond, () => out() || (!inCell() && Math.hypot(bot.entity.position.x - centre.x, bot.entity.position.z - centre.z) <= 2.2
        && bot.entity.position.y >= step.cell.y - 1.5), 400);
      if (!out()) {
        try {
          await bot.equip(block, 'hand');
          const wall = bot.blockAt(step.wall);
          await bot.lookAt(step.wall.offset(0.5, 0.5, 0.5).plus(step.cell.minus(step.wall).scaled(0.5)), true);
          await bot.placeBlock(wall, step.cell.minus(step.wall));
        } catch { /* checked below */ }
        const placed = bot.blockAt(step.cell)?.boundingBox === 'block';
        ctx.record('lava_step', { placed });
        if (placed) await swimTo(ctx, step.cell.offset(0.5, 1.2, 0.5), out, 50);
      }
      if (out()) await sleep(300, ctx.signal);
      return lavaResult(ctx, out());
    },
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
      // Hunger alone is not the only reason to get food: below 18 a badly
      // injured bot cannot regenerate, even at food 16. Stop supplying at the
      // same threshold at which recovery can take over, and eat carried food
      // first using exactly the eat behavior's risky-food policy.
      const needsFood = state.food <= t.provisionFood
        || (state.health < t.recoverHealth && state.food < t.recoverFood);
      if (state.sheltered || !needsFood || hasSafeFood(state, desperateForFood(state))) return 0;
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
    // Not in the sight of something that shoots: a blaze or ghast out of
    // melee reach still hits a bot standing still to heal.
    want: (state) => (state.health < t.recoverHealth && state.food >= t.recoverFood
      && !threats(state).some((h) => h.distance <= 8 || (SHOOTERS.has(h.name) && h.distance <= 24)) ? 0.3 : 0),
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
  const angryEnderman = (state, range) => threats(state).find((h) => h.name === 'enderman' && h.distance <= range
    && endermanAngry(h));
  // Remember where raiders were seen; the homestead keeps its site away from there.
  const danger = (bot.companionDanger = bot.companionDanger || []);
  const avoid = {
    name: 'avoid',
    band: BAND.DEFENSE,
    want(state) {
      const brute = threats(state).find((h) => CHARGERS.has(h.name) && h.distance <= BRUTE_RANGE && !standing(state, h));
      if (brute) return !state.sheltered && brute.distance > BRUTE_FIGHT ? 1 : 0;
      const raider = threats(state).find((h) => avoided(state, h) && h.distance <= 24);
      if (raider && !danger.some((d) => Math.hypot(d.x - raider.position.x, d.z - raider.position.z) < 32)) {
        danger.push({ x: Math.round(raider.position.x), z: Math.round(raider.position.z) });
      }
      return raider && !state.sheltered && raider.distance > 2.5 ? 1 : 0;
    },
    async run(ctx) {
      const state = ctx.perceive();
      const raider = state.hostiles.find((h) => avoided(state, h) || (CHARGERS.has(h.name) && !standing(state, h)));
      if (!raider) return { ok: true };
      ctx.record('avoid', { mob: raider.name, distance: Math.round(raider.distance) });
      const brute = CHARGERS.has(raider.name);
      if (brute) flights.set(raider.id, [...(flights.get(raider.id) || []).slice(-9), Date.now()]);
      return actions.fleeFrom(bot, ctx, raider.position, { distance: brute ? BRUTE_RANGE + 6 : 32, timeoutMs: 15000 });
    },
  };
  let hidden = null;
  const hide = {
    name: 'hide',
    band: BAND.ESCAPE,
    want(state) {
      if (hidden) return 1;
      // The End is full of them and the fight cannot wait: there an angry one
      // is fought (defend). A bunker dug mid-fight left the bot to the dragon.
      if (dimensionOf(bot) === 'the_end') return 0;
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

  // A blaze out of reach of the sword fires volley after volley; each ball
  // hits for a heart and a half through fire resistance. A raised shield
  // takes them all: it was golden apples, then a death, without one.
  const hasShield = () => bot.inventory?.slots?.[45]?.name === 'shield' || bot.inventory?.items?.().some((i) => i.name === 'shield');
  const block = {
    name: 'block',
    band: BAND.ESCAPE,
    // Fire resistance makes a blaze's fireball harmless (it is fire damage):
    // then raising the shield only cuts a tower up to a deck short, again and again.
    want: () => (hasShield() && !hasEffect(bot, 'FireResistance') && incomingBlazeShot(bot) ? 1 : 0),
    async run(ctx) {
      const shield = bot.inventory.items().find((i) => i.name === 'shield');
      if (bot.inventory.slots?.[45]?.name !== 'shield' && shield) {
        try { await bot.equip(shield, 'off-hand'); } catch { return { ok: false, reason: 'no_shield' }; }
      }
      const first = incomingBlazeShot(bot);
      if (!first) return { ok: true };
      ctx.record('block', { distance: Math.round(first.position.distanceTo(bot.entity.position) * 10) / 10 });
      bot.pathfinder?.setGoal?.(null);
      try {
        bot.activateItem(true);
        // A volley is three shots: hold the shield until none is coming.
        for (let quiet = 0, i = 0; i < 40 && quiet < 6; i += 1) {
          const ball = incomingBlazeShot(bot, 16);
          if (ball) {
            quiet = 0;
            await bot.lookAt(ball.position, true);
          } else quiet += 1;
          await sleep(100, ctx.signal);
        }
      } finally {
        bot.deactivateItem();
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

  return [quench, leaveLava, heal, escape, breathe, deflect, block, hide, defend, cover, avoid, eat, provision, recover, recoverDrops];
}

module.exports = { createSurvivalBehaviors };
