'use strict';
// Nights once the house is finished. The homestead goal handles its own
// nights while it builds; after that every other goal (a mining trip, a
// machine) would just carry on in the dark. This behavior outranks goals at
// night: walk home and sleep in the bed (which skips the night), or wait in
// the house if monsters are too close to sleep; caught far from home, dig in
// where the bot stands. Underground work (a branch mine) is left alone.

const { Vec3 } = require('vec3');
const defaultActions = require('../actions');
const defaultSkills = require('../skills');
const { BAND } = require('../brain');
const { sleep } = require('../confirm');

const SEALS = new Set(['dirt', 'cobblestone', 'cobbled_deepslate', 'coarse_dirt']);
const dimensionOf = (bot) => String(bot?.game?.dimension || 'overworld').replace(/^minecraft:/, '');

// Within this the bed is used straight away (useBed walks to it).
const NEAR_BED = 16;

/** `home()` returns { bed, centre } once the house is finished (bed null if it is gone), otherwise null. */
function createNightRest({ bot, home, actions = defaultActions, skills = defaultSkills, now = Date.now,
  farDistance = 64, retryBedMs = 20000 } = {}) {
  if (!bot || typeof home !== 'function') throw new TypeError('bot and home are required');
  let bunker = null;
  let bedRefusedUntil = 0;

  const where = () => {
    try { return home(); } catch { return null; }
  };

  const behavior = {
    name: 'night_rest',
    band: BAND.MAINTENANCE,
    want(state) {
      if (bunker) return 0.8;
      if (state.isDay !== false || state.sheltered || dimensionOf(bot) !== 'overworld') return 0;
      if (!where()) return 0;
      if (typeof actions.underground === 'function' && actions.underground(bot)) return 0;
      return 0.8;
    },
    async run(ctx) {
      const state = ctx.perceive();
      if (bunker) {
        if (state.isDay === false) {
          await sleep(3000, ctx.signal);
          return { ok: true, waited: true };
        }
        ctx.record('night_rest', { action: 'dig_out' });
        const out = await skills.digOut(bot, ctx, bunker);
        bunker = null;
        bot.companionSheltered = false;
        return out;
      }
      const spot = where();
      if (!spot) return { ok: true };
      // No bed left (broken, not yet replaced): the house itself is the shelter.
      const anchor = spot.bed || spot.centre;
      const bed = new Vec3(anchor.x + 0.5, anchor.y, anchor.z + 0.5);
      const distance = bot.entity.position.distanceTo(bed);
      if (distance > farDistance) {
        ctx.record('night_rest', { action: 'dig_in', distance: Math.round(distance) });
        const dug = await skills.digIn(bot, ctx, { sealMatch: (n) => SEALS.has(n) });
        if (!dug.ok) return dug;
        bunker = dug.bunker;
        bot.companionSheltered = true;
        return { ok: true };
      }
      if (spot.bed && now() >= bedRefusedUntil) {
        // Close by, the bed is walked to by using it: a walk to "near the bed"
        // could end outside the wall beside it, and the next night_rest found
        // it still too far and walked again, all night long.
        if (distance > NEAR_BED) {
          ctx.record('night_rest', { action: 'go_home', distance: Math.round(distance) });
          return actions.goNear(bot, ctx, bed, 2, { timeoutMs: 90000 });
        }
        ctx.record('night_rest', { action: 'sleep' });
        const slept = await skills.useBed(bot, ctx, { position: spot.bed });
        if (slept.ok) return slept;
        // Monsters nearby: wait indoors for a while, then try the bed again.
        bedRefusedUntil = now() + retryBedMs;
      }
      const centre = new Vec3(spot.centre.x + 0.5, spot.centre.y, spot.centre.z + 0.5);
      if (bot.entity.position.distanceTo(centre) > 2) {
        ctx.record('night_rest', { action: 'shelter' });
        return actions.goNear(bot, ctx, centre, 1, { timeoutMs: 40000 });
      }
      await sleep(3000, ctx.signal);
      return { ok: true, waited: true };
    },
  };
  const onDeath = () => { bunker = null; };
  bot.on?.('death', onDeath);
  behavior.dispose = () => bot.removeListener?.('death', onDeath);
  return behavior;
}

module.exports = { createNightRest };
