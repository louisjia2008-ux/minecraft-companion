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
const defaultActions = require('../actions');
const { sleep } = require('../confirm');

const HOME_RANGE = 24;

const MOBS = ['enderman'];
const isPearl = (n) => n === 'ender_pearl';

function createHuntPearlsGoal({ bot, count = 12, radius = 64, skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  const blacklist = createBlacklist({ ttlMs: 60000 });
  const memory = { explore: {}, nights: 0, hunted: 0, sawNight: false };
  const pearls = (state) => state.inventory.ender_pearl || 0;

  return {
    name: 'hunt_pearls',
    memory,
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
        const home = typeof bot.companionHomeAt === 'function' ? bot.companionHomeAt() : null;
        if (home && (state.inWater || state.position.distanceTo(new Vec3(home.x, home.y, home.z)) > HOME_RANGE)) {
          ctx.record('pearl_wait', { where: 'home' });
          const back = await actions.goNear(bot, ctx, new Vec3(home.x, home.y, home.z), 4, { timeoutMs: 120000 });
          if (!back.ok) return actions.unstick(bot, ctx);
          return back;
        }
        await sleep(5000, ctx.signal);
        return { ok: true, waited: true };
      }
      if (!memory.sawNight) { memory.sawNight = true; memory.nights += 1; }
      const hunted = await skills.huntOne(bot, ctx, { mobs: MOBS, dropMatch: isPearl, blacklist, radius });
      if (hunted.ok) { memory.hunted += 1; return hunted; }
      if (hunted.reason !== 'no_mob_in_range') return hunted;
      ctx.record('explore_for', { why: 'enderman' });
      return skills.explore(bot, ctx, memory.explore);
    },
  };
}

module.exports = { createHuntPearlsGoal };
