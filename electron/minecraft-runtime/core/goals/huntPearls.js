'use strict';
// Goal: ender pearls from endermen, hunted around home at night.
//
// Endermen walk the overworld only in the dark, so this is a night's work:
// each run() hunts the nearest enderman in sight (struck in melee it does not
// teleport away; it fights back), and with none in sight walks a little to
// look further. The night rest leaves this goal alone (companion.js). It ends
// when the bag holds `count` pearls, or at dawn after hunting through a night:
// the caller sets it again the next evening.

const defaultSkills = require('../skills');
const { createBlacklist } = require('../blacklist');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultActions = require('../actions');
const { skyOpen, standable, walkDry } = require('../caveRetreat');
const { meleeSight } = require('../entityGeometry');
const { applyWalkOnlyMovements } = require('../nether');
const { sleep, waitUntil } = require('../confirm');

const HOME_RANGE = 24;
// An enderman looked in the eyes turns on the player and teleports over.
const STARE_NEAR = 6;
const STARE_FAR = 48;
const STARE_MS = 12000;
const STARE_TURN_MS = 2200;
const STARE_AGAIN_MS = 30000;
const ENDERMAN_EYES = 2.55;
const SCOUT_RADIUS = 48;
const SCOUT_LEG = 10;
const DOOR_DIRECTIONS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

const MOBS = ['enderman'];
const isPearl = (n) => n === 'ender_pearl';

function createHuntPearlsGoal({ bot, count = 12, radius = 64, skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  const blacklist = createBlacklist({ ttlMs: 60000 });
  const memory = { centre: null, sector: 0, nights: 0, hunted: 0, sawNight: false };
  const pearls = (state) => state.inventory.ender_pearl || 0;

  const creepyIndex = () => bot.registry?.entitiesByName?.enderman?.metadataKeys?.indexOf('creepy') ?? -1;
  const angry = (e) => { const i = creepyIndex(); return i >= 0 && e.metadata?.[i] === true; };
  const endermen = () => Object.values(bot.entities || {}).filter((e) => e?.name === 'enderman' && e.position);
  const read = (p) => bot.blockAt(p, false);
  const outdoors = (p) => standable(read, p) && skyOpen(bot, p);
  const restingAtHome = (p, centre) => centre && p.distanceTo(centre) <= 6;
  const flatDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const visible = (entity) => {
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
    const point = entity.position.offset(0, ENDERMAN_EYES, 0);
    return meleeSight(bot, { eye, point, distance: eye.distanceTo(point) }) === 'clear';
  };
  const wait = async (ctx, reason) => {
    await sleep(750, ctx.signal);
    return { ok: true, waited: true, reason };
  };

  // Stared at, an enderman turns on the player; but one that is angry and
  // still looked at stands frozen (within 16 blocks it waits out the stare).
  // So: look one in the eyes until it turns, then look at the ground and let
  // it come. One at a time: two at once killed a bot in iron in ten seconds.
  async function stare(ctx, targets) {
    const here = bot.entity.position;
    // One already angry and close is the fight (defend): none turned meanwhile.
    if (endermen().some((e) => angry(e) && e.position.distanceTo(here) <= STARE_NEAR)) return null;
    const near = targets.map((e) => ({ e, d: e.position.distanceTo(here) }))
      .filter(({ d }) => d > STARE_NEAR && d <= STARE_FAR);
    const turned = near.filter(({ e }) => angry(e)).sort((a, b) => a.d - b.d)[0];
    const target = turned || near.filter(({ e }) => !blacklist.has(`stare:${e.id}`)).sort((a, b) => a.d - b.d)[0];
    if (!target) return null;
    const { e } = target;
    blacklist.add(`stare:${e.id}`, 'stared', STARE_AGAIN_MS);
    ctx.record('enderman_stare', { id: e.id, distance: Math.round(target.d), angry: angry(e) });
    actions.haltBody?.(bot);
    const started = Date.now();
    const until = started + STARE_MS;
    let turnedAt = angry(e) ? started : null;
    while (Date.now() < until && bot.entities?.[e.id]) {
      if (e.position.distanceTo(bot.entity.position) <= STARE_NEAR) break;
      if (!turnedAt && angry(e)) turnedAt = Date.now();
      if (!turnedAt && (Date.now() - started >= STARE_TURN_MS || !visible(e))) break;
      if (turnedAt) await bot.look(bot.entity.yaw, -Math.PI / 2, true);
      else await bot.lookAt(e.position.offset(0, ENDERMAN_EYES, 0), true);
      await sleep(100, ctx.signal);
    }
    const came = Boolean(bot.entities?.[e.id]) && e.position.distanceTo(bot.entity.position) <= STARE_NEAR;
    ctx.record('enderman_stare_result', { id: e.id, came, angry: angry(e), turnedMs: turnedAt ? turnedAt - started : null,
      gone: !bot.entities?.[e.id], distance: Math.round(e.position.distanceTo(bot.entity.position)) });
    return { ok: true, progress: came, waited: !came };
  }

  function home() {
    const at = bot.companionHomeAt?.();
    return at ? new Vec3(at.x, at.y, at.z) : null;
  }

  async function leaveHouse(ctx, from, centre) {
    if (!restingAtHome(from, centre) || !standable(read, from)) return false;
    const door = bot.findBlock?.({ maxDistance: 6, matching: (block) => /_door$/.test(block?.name),
      useExtraInfo: (block) => block.getProperties?.()?.half === 'lower' });
    if (!door || door.position.distanceTo(centre) > 5 || !actions.withinReach?.(bot, door.position)) return false;
    const { facing, open } = door.getProperties();
    if (!DOOR_DIRECTIONS[facing]) return false;
    const [dx, dz] = DOOR_DIRECTIONS[facing];
    const exits = [1, -1].flatMap((direction) => [0, -1, 1].map((y) => door.position.offset(dx * direction, y, dz * direction)));
    const exit = exits.find((p) => outdoors(p) && p.distanceTo(centre) > from.distanceTo(centre));
    if (!exit) return false;
    if (!open) {
      try { await bot.activateBlock(door); } catch (error) { if (error?.code === 'aborted') throw error; }
      if (!await waitUntil(() => read(door.position)?.getProperties()?.open === true, { timeoutMs: 1000, signal: ctx.signal })) return false;
    }
    const restore = applyWalkOnlyMovements(bot);
    try {
      const result = await actions.goTo(bot, ctx, new goals.GoalBlock(exit.x, exit.y, exit.z),
        { timeoutMs: 5000, retryNoProgress: false });
      if (result.ok && bot.entity.position.floored().equals(exit)) {
        ctx.record('pearl_house_exit', { from, door: door.position, to: exit });
        return true;
      }
      return false;
    } finally { restore(); }
  }

  async function scout(ctx, state, focus) {
    const from = bot.entity.position.floored();
    const house = home();
    if (state.inWater || bot.entity.onGround === false) return wait(ctx, 'pearl_wait_for_dry_ground');
    if (!outdoors(from)) {
      // On a natural lip the grounded collision box can overlap the support
      // while the centre has crossed into the next, lower column.
      if (bot.entity.onGround && skyOpen(bot, from)) {
        const here = bot.entity.position;
        const bodyRadius = (bot.entity.width || 0.6) / 2;
        const support = Object.values(DOOR_DIRECTIONS).map(([x, z]) => from.offset(x, 0, z)).find((p) =>
          here.x + bodyRadius > p.x && here.x - bodyRadius < p.x + 1
          && here.z + bodyRadius > p.z && here.z - bodyRadius < p.z + 1 && outdoors(p));
        if (support) {
          const arrived = (at) => bot.entity.onGround && at.floored().equals(support) && outdoors(support);
          const result = await walkDry(bot, ctx, actions, new goals.GoalBlock(support.x, support.y, support.z),
            { adjacent: support, timeoutMs: 2000, arrived });
          if (result.ok && arrived(bot.entity.position)) {
            ctx.record('pearl_scout_regained_footing', { from, to: support });
            return { ok: true, waited: true };
          }
        }
      }
      if (await leaveHouse(ctx, from, house)) return { ok: true, waited: true };
      return wait(ctx, 'pearl_wait_for_surface');
    }
    if (!memory.centre) memory.centre = house && flatDistance(from, house) <= SCOUT_RADIUS ? house : from;
    const centre = memory.centre;
    const sector = memory.sector;
    const angle = (sector % 8) * Math.PI / 4;
    const ring = Math.floor(sector / 8) % 2 ? 36 : 18;
    const waypoint = focus?.position || centre.offset(Math.round(ring * Math.cos(angle)), 0, Math.round(ring * Math.sin(angle)));
    const distance = flatDistance(from, waypoint);
    if (distance <= 4) {
      if (!focus) memory.sector += 1;
      return wait(ctx, 'pearl_scout_sector_complete');
    }
    const scale = Math.min(1, SCOUT_LEG / distance);
    const target = from.offset(Math.round((waypoint.x - from.x) * scale), 0, Math.round((waypoint.z - from.z) * scale));
    const goal = new goals.GoalNearXZ(target.x, target.z, 2);
    const surface = new Map();
    const accept = (p) => {
      if (flatDistance(p, centre) > SCOUT_RADIUS || flatDistance(p, from) > SCOUT_LEG + 3) return false;
      const key = `${p.x},${p.y},${p.z}`;
      if (!surface.has(key)) surface.set(key, outdoors(p));
      return surface.get(key);
    };
    ctx.record('pearl_surface_scout', { from, target, centre, sector, towardEnderman: Boolean(focus) });
    const result = await walkDry(bot, ctx, actions, goal, { timeoutMs: 5000, avoid: (p) => !accept(p) });
    const at = bot.entity.position.floored();
    if (!focus && (!result.ok || flatDistance(at, waypoint) <= 4)) memory.sector += 1;
    if (flatDistance(at, from) >= 2) return { ok: true, waited: true };
    if (focus) blacklist.add(`approach:${focus.id}`, result.reason || 'pearl_approach_blocked', 15000);
    return wait(ctx, result.reason || 'pearl_scout_no_progress');
  }

  return {
    name: 'hunt_pearls',
    memory,
    ownsRouteRecovery: () => memory.sawNight,
    // Endermen appear and vanish: a quiet stretch is normal, not a stall.
    noProgressLimit: 40,
    isDone: (state) => pearls(state) >= count || (memory.sawNight && state.isDay !== false),
    progress: (state) => pearls(state) * 10 + memory.hunted,
    async run(ctx) {
      const state = ctx.perceive();
      if (state.isDay !== false) {
        // Set during the day: wait for dusk at home. Where the night's hunt
        // ended was once a flooded cave thirty blocks down, and the bot
        // waited the day out there, coming up for air every few seconds.
        const house = home();
        if (house && (state.inWater || state.position.distanceTo(house) > HOME_RANGE)) {
          ctx.record('pearl_wait', { where: 'home' });
          const back = await actions.goNear(bot, ctx, house, 4, { timeoutMs: 120000 });
          if (!back.ok) return actions.unstick(bot, ctx);
          return back;
        }
        await sleep(5000, ctx.signal);
        return { ok: true, waited: true };
      }
      if (!memory.sawNight) { memory.sawNight = true; memory.nights += 1; }
      // One in sight but far: stare at its head and let it come. Chased,
      // it teleported off: fourteen nights of chasing brought one pearl.
      // Angry, it comes to the bot, where defend fights it and keeps the pearl.
      const targets = endermen().filter((e) => e.position.distanceTo(state.position) <= Math.min(radius, STARE_FAR)
        && outdoors(e.position.floored()) && visible(e));
      const stared = await stare(ctx, targets);
      if (stared) return stared;
      const close = targets.filter((e) => e.position.distanceTo(state.position) <= STARE_NEAR);
      if (close.length) {
        const restore = applyWalkOnlyMovements(bot);
        try {
          const hunted = await skills.huntOne(bot, ctx, { mobs: MOBS, dropMatch: isPearl, blacklist,
            radius: Math.min(radius, STARE_NEAR), accept: (e) => close.includes(e) });
          if (hunted.ok) { memory.hunted += 1; return hunted; }
          if (hunted.reason !== 'no_mob_in_range') return hunted;
        } finally { restore(); }
      }
      const focus = targets.filter((e) => !angry(e) && !blacklist.has(`mob:${e.id}`) && !blacklist.has(`approach:${e.id}`)
        && flatDistance(e.position, memory.centre || state.position) <= SCOUT_RADIUS)
        .sort((a, b) => a.position.distanceTo(state.position) - b.position.distanceTo(state.position))[0];
      return scout(ctx, state, focus);
    },
  };
}

module.exports = { createHuntPearlsGoal };
