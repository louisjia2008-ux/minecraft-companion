'use strict';
// The trip into the nether and back, shared by every nether goal: build (or
// reuse) a portal in the overworld, go through, remember both portals, and
// switch to nether-safe movement while on the other side.
//
// Everything is decided from where the bot is: after a death in the nether it
// respawns in the overworld, walks back to the portal it remembers and goes
// through again.

const defaultActions = require('./actions');
const { goals } = require('mineflayer-pathfinder');
const nether = require('./nether');

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

function createPortalTrip({ bot, memory, actions = defaultActions }) {
  Object.assign(memory, { overworldPortal: null, netherPortal: null, site: null, ...memory });
  let restoreMovements = null;

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
    // What it can build with changes as it digs and places.
    const m = bot.pathfinder?.movements;
    if (m?.companionNether) m.scafoldingBlocks = nether.netherScaffolding(bot);
  }
  function leaveNetherMode() {
    restoreMovements?.();
    restoreMovements = null;
  }

  /** Portal progress 0-15 (15 once lit or once the bot has used a portal). */
  const portalProgress = () => (nether.inNether(bot) || memory.overworldPortal ? 15 : framePlaced());

  async function wearGold(ctx) {
    const head = bot.inventory.slots[5];
    if (head && /^golden_/.test(head.name)) return;
    const helmet = bot.inventory.items().find((i) => i.name === 'golden_helmet');
    if (!helmet) return;
    try { await bot.equip(helmet, 'head'); ctx.record('equip', { item: 'golden_helmet' }); } catch { /* retried next run */ }
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

  // Out of sight (chased off by a patrol, say) the frame's chunk is not
  // loaded and reads as nothing there: the obsidian already in it would be
  // lost to a new site. Keep the site and walk back to it instead.
  const siteUnseen = () => !bot.blockAt(memory.site.base);
  function siteStillUsable() {
    return siteUnseen() || framePlaced() > 0 || nether.portalSiteOk(bot, memory.site.base, memory.site.axis);
  }

  /** One overworld step towards the nether: walk back, build, light or enter the portal. */
  async function toNether(ctx, state) {
    leaveNetherMode();
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
    if (siteUnseen() || bot.entity.position.distanceTo(memory.site.base) > 24) {
      return actions.goNear(bot, ctx, memory.site.base, 3, { timeoutMs: 90000 });
    }
    const frame = nether.portalFrame(memory.site.base, memory.site.axis);
    const missing = frame.cells.filter((c) => !c.corner && bot.blockAt(c.pos)?.name !== 'obsidian').length;
    if (missing > 0 && (state.inventory.obsidian || 0) < missing) return fail('missing_obsidian');
    if (!(state.inventory.flint_and_steel || 0)) return fail('missing_flint_and_steel');
    const step = await nether.buildPortalStep(bot, ctx, memory.site);
    if (step.lit) {
      memory.overworldPortal = nether.findPortal(bot, 8);
      ctx.record('portal_lit', {});
    }
    return step;
  }

  /** Re-reads the nether portal near the remembered spot (it may be out of sight on arrival). */
  function netherPortal(range = 128) {
    if (!memory.netherPortal || bot.blockAt(memory.netherPortal)?.name !== 'nether_portal') {
      memory.netherPortal = nether.findPortal(bot, range) || memory.netherPortal;
    }
    return memory.netherPortal;
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

  /** One nether step towards home: walk back to the arrival portal, then go through. */
  async function toOverworld(ctx) {
    const portal = netherPortal();
    if (!portal) return fail('nether_portal_lost');
    if (bot.entity.position.distanceTo(portal) > 24) {
      const start = bot.entity.position.clone();
      const result = await actions.goNear(bot, ctx, portal, 3, { timeoutMs: 120000 });
      memory.homeStalls = bot.entity.position.distanceTo(start) >= 4 ? 0 : (memory.homeStalls || 0) + 1;
      if (memory.homeStalls < 2) return result;
      // Every rod and skull in hand, an hour in a cave pocket beside the
      // fortress: the pathfinder replanned without one step. Walk the first
      // leg with the lava margins lifted, then dig a staircase up.
      ctx.record('home_stuck', { stalls: memory.homeStalls, at: `${start.x | 0},${start.y | 0},${start.z | 0}` });
      const here = bot.entity.position;
      const flat = Math.hypot(portal.x - here.x, portal.z - here.z) || 1;
      const leg = new goals.GoalNearXZ(here.x + (portal.x - here.x) * 12 / flat, here.z + (portal.z - here.z) * 12 / flat, 3);
      await nether.withLavaMarginsLifted(bot, () => actions.goTo(bot, ctx, leg, { timeoutMs: 20000, arrived: () => true }));
      if (bot.entity.position.distanceTo(start) < 4 && actions.digStairsUp) {
        await actions.digStairsUp(bot, ctx, Math.max(portal.y, start.y + 6), { maxSteps: 12 });
      }
      if (bot.entity.position.distanceTo(start) >= 4) memory.homeStalls = 0;
      return result;
    }
    // Close but stuck above or below it (a fortress floor over the portal):
    // first get over its column, then step in.
    if ((memory.homeMisses || 0) >= 2 && Math.hypot(bot.entity.position.x - portal.x, bot.entity.position.z - portal.z) > 2) {
      ctx.record('portal_column', { misses: memory.homeMisses });
      await actions.goTo(bot, ctx, new goals.GoalNearXZ(portal.x, portal.z, 1), { timeoutMs: 30000, arrived: () => true });
    }
    // A ghast's blast puts a portal out; the frame stays. Light it again
    // (the corners do not matter to a portal, only the ten obsidian).
    if (bot.blockAt(portal)?.name !== 'nether_portal') {
      const frame = frameAround(portal);
      if (frame) {
        ctx.record('portal_relight', { portal: `${portal.x},${portal.y},${portal.z}` });
        return nether.ignite(bot, ctx, nether.portalFrame(frame.base, frame.axis));
      }
    }
    const result = await goThrough(ctx, portal);
    memory.homeMisses = result.ok ? 0 : (memory.homeMisses || 0) + 1;
    return result;
  }

  return { memory, enterNetherMode, leaveNetherMode, framePlaced, portalProgress, wearGold, goThrough, toNether, toOverworld, netherPortal };
}

module.exports = { createPortalTrip };
