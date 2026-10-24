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
const { sleep } = require('../confirm');

const isQuartz = (n) => n === 'quartz';
const isQuartzOre = (n) => n === 'nether_quartz_ore';
const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
// Hurt in the Nether with nothing to eat: home to heal before going on.
const RETREAT_HEALTH = 8;
// Back in the overworld, fed: wait to heal this far before going through again.
const READY_HEALTH = 16;

function createNetherQuartzGoal({ bot, count = 16, roam = 96, skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  const blacklist = createBlacklist({ ttlMs: 180000 });
  const memory = { overworldPortal: null, netherPortal: null, site: null, explore: {} };
  let restoreMovements = null;
  const quartz = (state) => state.inventory.quartz || 0;

  function framePlaced() {
    if (!memory.site) return 0;
    const frame = nether.portalFrame(memory.site.base, memory.site.axis);
    if (frame.interior.some((p) => bot.blockAt(p)?.name === 'nether_portal')) return 15;
    return frame.cells.filter((c) => {
      const b = bot.blockAt(c.pos);
      return c.corner ? b?.boundingBox === 'block' : b?.name === 'obsidian';
    }).length;
  }

  function enterNetherMode() {
    if (!restoreMovements) restoreMovements = nether.applyNetherMovements(bot);
  }
  function leaveNetherMode() {
    restoreMovements?.();
    restoreMovements = null;
  }

  async function wearGold(ctx) {
    const head = bot.inventory.slots[5];
    if (head && /^golden_/.test(head.name)) return;
    const helmet = bot.inventory.items().find((i) => i.name === 'golden_helmet');
    if (!helmet) return;
    try { await bot.equip(helmet, 'head'); ctx.record('equip', { item: 'golden_helmet' }); } catch (_) { /* retried next run */ }
  }

  async function goThrough(ctx, portal) {
    ctx.record('portal_enter', { from: nether.dimension(bot), portal: `${portal.x},${portal.y},${portal.z}` });
    const result = await nether.travel(bot, ctx, portal);
    if (!result.ok) return result;
    // Back in the overworld the goal may be done at once: restore movement now.
    if (!nether.inNether(bot)) leaveNetherMode();
    const here = nether.findPortal(bot, 6);
    if (nether.inNether(bot)) memory.netherPortal = here || bot.entity.position.floored();
    else memory.overworldPortal = here || memory.overworldPortal;
    ctx.record('portal_arrived', { dimension: nether.dimension(bot), portal: here ? `${here.x},${here.y},${here.z}` : null });
    await nether.leavePortal(bot, ctx);
    return { ok: true, dimension: nether.dimension(bot) };
  }

  async function overworldStep(ctx, state) {
    leaveNetherMode();
    if (quartz(state) >= count) return { ok: true };
    // Health comes back on a full stomach; the Nether is no place to wait for it.
    if (bot.health < READY_HEALTH && bot.food >= 18) {
      ctx.record('rest', { health: Math.round(bot.health) });
      await sleep(5000, ctx.signal);
      return { ok: true, resting: true };
    }
    const remembered = memory.overworldPortal && bot.blockAt(memory.overworldPortal)?.name === 'nether_portal'
      ? memory.overworldPortal : null;
    // Far from a remembered portal (respawned at world spawn): walk back first.
    if (memory.overworldPortal && !remembered && bot.entity.position.distanceTo(memory.overworldPortal) > 48) {
      return actions.goNear(bot, ctx, memory.overworldPortal, 3, { timeoutMs: 90000 });
    }
    const portal = remembered || nether.findPortal(bot, 48);
    if (portal) {
      memory.overworldPortal = portal;
      return goThrough(ctx, portal);
    }
    if (!memory.site || !siteStillUsable()) {
      memory.site = nether.findPortalSite(bot, 16);
      if (!memory.site) return fail('no_portal_site');
      ctx.record('portal_site', { base: `${memory.site.base.x},${memory.site.base.y},${memory.site.base.z}`, axis: memory.site.axis });
    }
    for (const need of ['obsidian', 'flint_and_steel']) {
      const frame = nether.portalFrame(memory.site.base, memory.site.axis);
      const missing = need === 'obsidian'
        ? frame.cells.filter((c) => !c.corner && bot.blockAt(c.pos)?.name !== 'obsidian').length
        : 1;
      if (missing > 0 && (state.inventory[need] || 0) < (need === 'obsidian' ? missing : 1)) return fail(`missing_${need}`);
    }
    const step = await nether.buildPortalStep(bot, ctx, memory.site);
    if (step.lit) {
      memory.overworldPortal = nether.findPortal(bot, 8);
      ctx.record('portal_lit', {});
    }
    return step;
  }

  function siteStillUsable() {
    const placed = framePlaced();
    return placed > 0 || nether.portalSiteOk(bot, memory.site.base, memory.site.axis);
  }

  async function netherStep(ctx, state) {
    enterNetherMode();
    if (!memory.netherPortal || bot.blockAt(memory.netherPortal)?.name !== 'nether_portal') {
      memory.netherPortal = nether.findPortal(bot, 128) || memory.netherPortal;
    }
    const retreat = bot.health <= RETREAT_HEALTH && !actions.pickFood?.(bot);
    if (quartz(state) >= count || retreat) {
      if (retreat) ctx.record('retreat', { health: Math.round(bot.health) });
      if (!memory.netherPortal) return fail('nether_portal_lost');
      // A ghast's blast puts a portal out; the frame stays. Light it again
      // (the corners do not matter to a portal, only the ten obsidian).
      if (bot.blockAt(memory.netherPortal)?.name !== 'nether_portal') {
        const frame = frameAround(memory.netherPortal);
        if (frame) {
          ctx.record('portal_relight', { portal: `${memory.netherPortal.x},${memory.netherPortal.y},${memory.netherPortal.z}` });
          return nether.ignite(bot, ctx, nether.portalFrame(frame.base, frame.axis));
        }
      }
      return goThrough(ctx, memory.netherPortal);
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

  /** The obsidian frame whose bottom interior holds `cell`, or null. */
  function frameAround(cell) {
    for (const axis of ['x', 'z']) {
      for (const u of [1, 2]) {
        const base = axis === 'x' ? cell.offset(-u, -1, 0) : cell.offset(0, -1, -u);
        const frame = nether.portalFrame(base, axis);
        if (frame.cells.every((c) => c.corner || bot.blockAt(c.pos)?.name === 'obsidian')) return { base, axis };
      }
    }
    return null;
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
      const portal = inside || memory.overworldPortal ? 15 : framePlaced();
      return q * 30 + portal + (inside ? 5 : 0);
    },
    recover() {
      blacklist.clear?.();
      memory.explore = {};
    },
    async run(ctx) {
      await wearGold(ctx);
      const state = ctx.perceive();
      return nether.inNether(bot) ? netherStep(ctx, state) : overworldStep(ctx, state);
    },
    dispose: leaveNetherMode,
  };
}

module.exports = { createNetherQuartzGoal };
