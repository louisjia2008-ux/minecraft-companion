'use strict';
// Goal: bring N nether quartz back to the overworld.
//
// Build (or reuse) a portal, go through, mine quartz ore near the arrival
// portal, return through the same portal. Every run() decides from where the
// bot is and what it holds: after a death in the nether it respawns in the
// overworld, walks back to the portal it remembers and goes through again.

const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const nether = require('../nether');
const { createBlacklist } = require('../blacklist');
const { createPortalTrip } = require('../netherTrip');

const isQuartz = (n) => n === 'quartz';
const isQuartzOre = (n) => n === 'nether_quartz_ore';
const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

function createNetherQuartzGoal({ bot, count = 16, roam = 96, skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  const blacklist = createBlacklist({ ttlMs: 180000 });
  const memory = { explore: {} };
  const trip = createPortalTrip({ bot, memory, actions });
  const quartz = (state) => state.inventory.quartz || 0;

  async function overworldStep(ctx, state) {
    trip.leaveNetherMode();
    if (quartz(state) >= count) return { ok: true };
    return trip.toNether(ctx, state);
  }

  async function netherStep(ctx, state) {
    trip.enterNetherMode();
    trip.netherPortal();
    if (quartz(state) >= count) {
      if (!memory.netherPortal) return fail('nether_portal_lost');
      return trip.goThrough(ctx, memory.netherPortal);
    }
    if (!bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'))) return fail('no_pickaxe');
    const home = memory.netherPortal;
    const result = await skills.gatherOne(bot, ctx, {
      blocks: isQuartzOre,
      dropMatch: isQuartz,
      blacklist,
      radius: 48,
      // Stay within reach of the way home.
      exclude: (p) => home && p.distanceTo(home) > roam,
    });
    if (result.ok || result.reason !== 'no_target_in_range') return result;
    return exploreNear(ctx, home);
  }

  /** Walks ~24 blocks along one heading; turns around past `roam` from the portal. */
  async function exploreNear(ctx, home) {
    const m = memory.explore;
    const here = bot.entity.position;
    if (home && here.distanceTo(home) > roam * 0.75) {
      m.heading = Math.atan2(home.z - here.z, home.x - here.x) + Math.PI / 2;
      return actions.goNear(bot, ctx, home, 4, { timeoutMs: 60000 });
    }
    if (m.heading === undefined || m.blocked) {
      m.heading = Math.random() * Math.PI * 2;
      m.blocked = false;
    }
    const x = Math.round(here.x + Math.cos(m.heading) * 24);
    const z = Math.round(here.z + Math.sin(m.heading) * 24);
    ctx.record('explore', { x, z });
    const result = await actions.goTo(bot, ctx, new goals.GoalNearXZ(x, z, 4), { timeoutMs: 30000, arrived: () => true });
    const moved = bot.entity.position.distanceTo(here);
    if (moved < 8) m.blocked = true;
    return moved >= 8 ? { ok: true, moved: Math.round(moved) } : fail(result.ok ? 'explore_blocked' : result.reason);
  }

  return {
    name: 'nether_quartz',
    target: count,
    noProgressLimit: 20,
    maxRecoveries: 3,
    memory,
    isDone: (state) => quartz(state) >= count && !nether.inNether(bot),
    // Portal blocks (0-15), being in the nether (+5), then each quartz.
    progress(state) {
      const q = Math.min(quartz(state), count);
      const inside = nether.inNether(bot);
      return q * 30 + trip.portalProgress() + (inside ? 5 : 0);
    },
    recover() {
      blacklist.clear?.();
      memory.explore = {};
    },
    async run(ctx) {
      await trip.wearGold(ctx);
      const state = ctx.perceive();
      return nether.inNether(bot) ? netherStep(ctx, state) : overworldStep(ctx, state);
    },
    dispose: trip.leaveNetherMode,
  };
}

module.exports = { createNetherQuartzGoal };
