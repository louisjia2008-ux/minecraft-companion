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
const { Vec3 } = require('vec3');
const nether = require('./nether');
const end = require('./end');
const { abortError } = require('./confirm');
const { RaycastIterator } = require('prismarine-world').iterators;

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
// Runtime blocks expose their actual collision shapes. A fence or half slab
// cannot stand in for the full-height floor and walls admitted by this route.
const fullCube = (block) => block?.boundingBox === 'block' && (!block.shapes || (block.shapes.length === 1
  && block.shapes[0].length === 6 && block.shapes[0].every((value, i) => value === [0, 0, 0, 1, 1, 1][i])));

function createPortalTrip({ bot, memory, actions = defaultActions, walkOnly = false, protectedBridge = false }) {
  Object.assign(memory, { overworldPortal: null, netherPortal: null, site: null, ...memory });
  if (!(memory.ledgeSupports instanceof Set)) memory.ledgeSupports = new Set(memory.ledgeSupports || []);
  let restoreMovements = null;
  let restoreWalk = null;
  let bridgeInspection = null;

  // Same-bot observations survive goal cancellation, never a new connection.
  // These are candidate routes only: reverseBridge revalidates every cell.
  function bridgeCacheKey() {
    if (!memory.netherPortal || bot.blockAt(memory.netherPortal)?.name !== 'nether_portal') return null;
    let p = new Vec3(memory.netherPortal.x, memory.netherPortal.y, memory.netherPortal.z);
    for (let i = 0; i < 3 && bot.blockAt(p.offset(0, -1, 0))?.name === 'nether_portal'; i++) p = p.offset(0, -1, 0);
    for (const [dx, dz] of [[-1, 0], [0, -1]]) {
      for (let i = 0; i < 2 && bot.blockAt(p.offset(dx, 0, dz))?.name === 'nether_portal'; i++) p = p.offset(dx, 0, dz);
    }
    return `the_nether:${p.x},${p.y},${p.z}`;
  }
  const copyRoute = (route) => route.map((p) => new Vec3(p.x, p.y, p.z));
  function retainBridgeObservation() {
    const key = bridgeCacheKey();
    if (!key || (!memory.ledgeRoute?.length && !memory.ledgeSupports.size)) return;
    const cache = bot.companionNetherBridgeRoutes instanceof Map ? bot.companionNetherBridgeRoutes
      : (bot.companionNetherBridgeRoutes = new Map());
    memory.ledgeCacheKey = key;
    cache.delete(key);
    cache.set(key, { route: copyRoute(memory.ledgeRoute || []), supports: [...memory.ledgeSupports],
      standingY: memory.ledgeStandingY, target: memory.ledgeTarget && new Vec3(memory.ledgeTarget.x, memory.ledgeTarget.y, memory.ledgeTarget.z),
      resupply: Boolean(memory.ledgeResupply), landing: memory.ledgeLanding && new Vec3(
        memory.ledgeLanding.x, memory.ledgeLanding.y, memory.ledgeLanding.z) });
    while (cache.size > 4) cache.delete(cache.keys().next().value);
  }
  function restoreBridgeObservation() {
    const key = bridgeCacheKey();
    const saved = key && bot.companionNetherBridgeRoutes?.get?.(key);
    if (!saved) return;
    memory.ledgeCacheKey = key;
    if (saved.resupply) { memory.ledgeResupply = true; memory.ledgeSeen = true; }
    if (!memory.ledgeTarget && saved.target) memory.ledgeTarget = new Vec3(saved.target.x, saved.target.y, saved.target.z);
    if (!memory.ledgeRoute?.length) memory.ledgeRoute = copyRoute(saved.route);
    for (const support of saved.supports || []) memory.ledgeSupports.add(support);
    if (!Number.isSafeInteger(memory.ledgeStandingY) && Number.isSafeInteger(saved.standingY)) memory.ledgeStandingY = saved.standingY;
    if (!memory.ledgeLanding && saved.landing) memory.ledgeLanding = new Vec3(saved.landing.x, saved.landing.y, saved.landing.z);
  }

  function setBridgeResupply(on) {
    memory.ledgeResupply = Boolean(on);
    retainBridgeObservation();
    // Clearing supplies in the overworld cannot re-read a Nether chunk. It
    // updates intent only; every cached route/guard still needs fresh admission.
    const saved = memory.ledgeCacheKey && bot.companionNetherBridgeRoutes?.get?.(memory.ledgeCacheKey);
    if (saved) saved.resupply = Boolean(on);
  }

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
    if (walkOnly && !restoreWalk) restoreWalk = nether.applyWalkOnlyMovements(bot);
    // What it can build with changes as it digs and places.
    const m = bot.pathfinder?.movements;
    if (m?.companionNether && !m.companionWalkOnly) m.scafoldingBlocks = nether.netherScaffolding(bot);
  }
  function leaveNetherMode() {
    restoreWalk?.();
    restoreWalk = null;
    restoreMovements?.();
    restoreMovements = null;
  }
  // A parent material goal may rebuild supplies before invoking this child
  // after death. Do not leave its Nether walk restriction on overworld work.
  const onGame = () => { if (!nether.inNether(bot)) leaveNetherMode(); };
  if (walkOnly) bot.on?.('game', onGame);
  function dispose() {
    if (walkOnly) bot.removeListener?.('game', onGame);
    leaveNetherMode();
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
    // A frame begun by an earlier goal (the task asked again) is finished, not
    // left with six obsidian in it while a new site needs ten the bag lacks.
    if (!memory.site && bot.companionPortalSite) memory.site = bot.companionPortalSite;
    if (!memory.site || !siteStillUsable()) {
      memory.site = nether.findPortalSite(bot, 16);
      bot.companionPortalSite = memory.site;
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
    restoreBridgeObservation();
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

  /** A built bridge is a return route only while every cell is freshly safe. */
  function bridgeRouteFailure(route) {
    for (let i = 0; i < route.length; i += 1) {
      const p = route[i];
      if (!p || !['x', 'y', 'z'].every((key) => Number.isSafeInteger(p[key]))) return 'bridge_route_invalid';
      if (i > 0 && (p.y !== route[i - 1].y || Math.abs(p.x - route[i - 1].x) + Math.abs(p.z - route[i - 1].z) !== 1)) {
        return 'bridge_route_discontinuous';
      }
      const feet = new Vec3(p.x, p.y, p.z);
      const blocks = [-1, 0, 1].map((dy) => bot.blockAt(feet.offset(0, dy, 0)));
      if (blocks.some((b) => !b)) return 'bridge_route_unknown';
      if (!fullCube(blocks[0]) || /lava|fire|magma/.test(blocks[0].name)
        || blocks.slice(1).some((b) => b.boundingBox !== 'empty' || /lava|fire|water/.test(b.name))) return 'bridge_route_unsafe';
    }
    return null;
  }

  // A return to the bridge is a ground route, never an arbitrary native climb.
  // Unknown chunks and lava margins are not filled in from old observations.
  function dryFootFailure(p) {
    const blocks = [-1, 0, 1].map((dy) => bot.blockAt(p.offset(0, dy, 0)));
    if (blocks.some((b) => !b)) return 'shore_route_unknown';
    if (!standable(p) || blocks.some((b) => /lava|fire|water|magma|campfire|cactus/.test(b.name))
      || nether.lavaRisk(bot, p) > 0) return 'shore_route_unsafe';
    return null;
  }

  function dryPathTo(target) {
    const start = bot.entity.position.floored();
    const initialFailure = dryFootFailure(start) || dryFootFailure(target);
    if (initialFailure) return fail(initialFailure);
    const key = cellKey(target);
    const seen = new Map([[cellKey(start), { cell: start, parent: null }]]);
    const queue = [start];
    for (let next = 0; next < queue.length && seen.size <= 4096; next++) {
      const cell = queue[next];
      if (cellKey(cell) === key) {
        const path = [];
        for (let at = key; at !== null; at = seen.get(at).parent) path.unshift(seen.get(at).cell);
        return { ok: true, path };
      }
      const neighbours = [];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (const dy of [0, 1, -1]) {
          const p = cell.offset(dx, dy, dz);
          if (seen.has(cellKey(p)) || p.distanceTo(start) > 96 || dryFootFailure(p)) continue;
          // One block up needs headroom above the takeoff body as well.
          if (dy === 1 && !openCell(cell.offset(0, 2, 0))) continue;
          if (dy === -1 && !openCell(p.offset(0, 2, 0))) continue;
          neighbours.push(p);
          break;
        }
      }
      neighbours.sort((a, b) => a.distanceTo(target) - b.distanceTo(target));
      for (const p of neighbours) {
        seen.set(cellKey(p), { cell: p, parent: cellKey(cell) });
        queue.push(p);
      }
    }
    return fail('shore_no_path', { scanned: seen.size });
  }

  async function walkDryRoute(ctx, target) {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    if (!bot.entity.onGround) return fail('shore_not_grounded');
    const found = dryPathTo(target);
    if (!found.ok) return found;
    if (found.path.length > 256) return fail('shore_route_budget');
    ctx.record('shore_route', { from: cellKey(found.path[0]), to: cellKey(target), cells: found.path.length });
    const m = bot.pathfinder?.movements;
    if (!m || !Array.isArray(m.exclusionAreasStep)) return fail('shore_no_movements');
    const restore = nether.applyWalkOnlyMovements(bot);
    const deadline = Date.now() + 120000;
    try {
      for (let i = 1; i < found.path.length; i++) {
        if (ctx.signal?.aborted) throw abortError(ctx.signal);
        if (Date.now() >= deadline) return fail('shore_route_timeout');
        const before = found.path[i - 1];
        const after = found.path[i];
        if (!bot.entity.onGround || !before.equals(bot.entity.position.floored())) return fail('shore_position_changed');
        for (const cell of found.path.slice(i - 1)) {
          const changed = dryFootFailure(cell);
          if (changed) return fail(changed);
        }
        // Native goto may solve only this admitted neighbour edge. It cannot
        // invent a detour, tunnel, scaffold or recovery nudge around the route.
        const confined = (block) => {
          const p = block?.position;
          return p && [before, after].some((cell) => p.x === cell.x && p.z === cell.z
            && p.y >= Math.min(before.y, after.y) - 1 && p.y <= Math.max(before.y, after.y) + 2) ? 0 : 1000;
        };
        m.exclusionAreasStep.push(confined);
        let result;
        try {
          result = await actions.goTo(bot, ctx, new goals.GoalBlock(after.x, after.y, after.z), {
            timeoutMs: Math.min(8000, deadline - Date.now()), retryNoProgress: false,
            arrived: () => bot.entity.onGround && after.equals(bot.entity.position.floored()),
          });
        } finally {
          const index = m.exclusionAreasStep.indexOf(confined);
          if (index >= 0) m.exclusionAreasStep.splice(index, 1);
        }
        if (ctx.signal?.aborted) throw abortError(ctx.signal);
        if (!nether.inNether(bot)) { leaveNetherMode(); return { ok: true, dimension: nether.dimension(bot) }; }
        if (!result.ok || !bot.entity.onGround || !after.equals(bot.entity.position.floored())) {
          return fail(result.ok ? 'shore_step_unconfirmed' : result.reason);
        }
        const changed = dryFootFailure(after);
        if (changed) return fail(changed);
        ctx.record('shore_step', { at: cellKey(after) });
      }
      return { ok: true };
    } finally {
      actions.haltBody?.(bot);
      restore();
    }
  }

  async function forwardBridge(ctx) {
    const route = memory.ledgeRoute;
    if (!Array.isArray(route) || route.length < 2) return null;
    const index = route.findIndex((p) => new Vec3(p.x, p.y, p.z).equals(bot.entity.position.floored()));
    if (index < 0) return null;
    const failure = bridgeRouteFailure(route);
    if (failure) return fail(failure, { landed: false });
    ctx.record('bridge_outbound', { at: cellKey(route[index]), cells: route.length - index });
    for (let i = index + 1; i < route.length; i++) {
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      const changed = bridgeRouteFailure(route);
      if (changed) return fail(changed, { landed: false });
      if (!bot.entity.onGround) return fail('bridge_not_grounded', { landed: false });
      const target = route[i];
      const result = await end.bridgeStep(bot, ctx, new Vec3(target.x + 0.5, target.y, target.z + 0.5),
        bridgeOptions(ctx, true));
      if (!result.ok) return result.reason === 'no_bridge_blocks' ? fail('ledge_no_blocks', { landed: false }) : result;
      if (!bot.entity.onGround || !new Vec3(target.x, target.y, target.z).equals(bot.entity.position.floored())) {
        return fail('bridge_step_unconfirmed', { landed: false });
      }
    }
    const landed = landedHere();
    memory.ledgeTransit = !landed;
    ctx.record('bridge_outbound_end', { at: cellKey(bot.entity.position.floored()), landed });
    return landed ? { ok: true, landed: true, reused: true } : null;
  }

  async function reverseBridge(ctx, route) {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    const same = (p, q) => p.x === q.x && p.y === q.y && p.z === q.z;
    let index = route.findIndex((p) => same(p, bot.entity.position.floored()));
    if (index === 0 && memory.netherPortal && bot.entity.position.distanceTo(memory.netherPortal) <= 8) {
      const originFailure = bridgeRouteFailure([route[0]]);
      if (originFailure) return fail(originFailure);
      return bot.entity.onGround ? null : fail('bridge_not_grounded');
    }
    const failure = bridgeRouteFailure(route);
    if (failure) return fail(failure);
    if (index === 0) return fail('bridge_origin_changed');
    if (index < 0) {
      const landing = route[route.length - 1];
      ctx.record('bridge_return_anchor', { at: cellKey(bot.entity.position.floored()), to: cellKey(landing), cells: route.length });
      const arrived = walkOnly ? await walkDryRoute(ctx, new Vec3(landing.x, landing.y, landing.z))
        : await actions.goNear(bot, ctx, new Vec3(landing.x, landing.y, landing.z), 0, { timeoutMs: 120000 });
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      if (!arrived.ok) return arrived;
      if (!same(landing, bot.entity.position.floored()) || !bot.entity.onGround) {
        return fail(arrived.ok ? 'bridge_anchor_not_reached' : arrived.reason);
      }
      index = route.length - 1;
    }
    for (; index > 0; index -= 1) {
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      const changed = bridgeRouteFailure(route);
      if (changed) return fail(changed);
      if (!bot.entity.onGround) return fail('bridge_not_grounded');
      const target = route[index - 1];
      const step = await end.bridgeStep(bot, ctx, new Vec3(target.x + 0.5, target.y, target.z + 0.5),
        bridgeOptions(ctx, true));
      if (!step.ok) return step;
      if (!same(target, bot.entity.position.floored()) || !bot.entity.onGround) return fail('bridge_return_not_confirmed');
    }
    ctx.record('bridge_returned', { at: cellKey(bot.entity.position.floored()), cells: route.length });
    return { ok: true, retraced: true };
  }

  /** One nether step towards home: regain the actual bridge, then cross it safely. */
  async function toOverworld(ctx) {
    netherPortal();
    const route = memory.ledgeRoute;
    if (!Array.isArray(route) || route.length < 2) {
      if (walkOnly && memory.netherPortal && bot.entity.position.distanceTo(memory.netherPortal) > 8) {
        const approach = await walkDryRoute(ctx, memory.netherPortal);
        if (!approach.ok || !nether.inNether(bot)) return approach;
      }
      return toOverworldDirect(ctx);
    }
    const m = bot.pathfinder?.movements;
    const saved = m && { parkour: m.allowParkour, drop: m.maxDropDown };
    if (m) { m.allowParkour = false; m.maxDropDown = Math.min(m.maxDropDown ?? 3, 1); }
    try {
      const result = await reverseBridge(ctx, route);
      return result || await toOverworldDirect(ctx);
    } finally {
      if (ctx.signal?.aborted) actions.haltBody?.(bot);
      if (m) {
        if (nether.inNether(bot) || !walkOnly) m.allowParkour = saved.parkour;
        // Crossing already restored the overworld drop profile; do not put
        // the old Nether value back over leaveNetherMode's restoration.
        if (nether.inNether(bot)) m.maxDropDown = saved.drop;
      }
    }
  }

  /** Normal return for a trip with no built bridge, or already back at its portal end. */
  async function toOverworldDirect(ctx) {
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
    if ((memory.homeMisses || 0) >= 1 && await paveLavaFront(ctx, portal)) return { ok: true, paved: true };
    const result = await goThrough(ctx, portal);
    memory.homeMisses = result.ok ? 0 : (memory.homeMisses || 0) + 1;
    return result;
  }

  /**
   * Lava run in over the cells in front of the portal (a hole dug beside it
   * let a hidden pocket out): the pathfinder will not step there. Cover each
   * such cell with a block. One run with every trade done stood six minutes
   * two blocks from its portal, both faces of it lava. True if any went down.
   */
  async function paveLavaFront(ctx, portal) {
    const isPortal = (p) => bot.blockAt(p)?.name === 'nether_portal';
    let bottom = portal.clone();
    while (isPortal(bottom.offset(0, -1, 0))) bottom = bottom.offset(0, -1, 0);
    const alongX = isPortal(bottom.offset(1, 0, 0)) || isPortal(bottom.offset(-1, 0, 0));
    const along = alongX ? [1, 0] : [0, 1];
    const faces = alongX ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
    const cells = [];
    for (let u = -2; u <= 2; u += 1) {
      for (const [fx, fz] of faces) {
        for (let d = 1; d <= 2; d += 1) {
          const p = bottom.offset(along[0] * u + fx * d, 0, along[1] * u + fz * d);
          if (/^lava$/.test(bot.blockAt(p)?.name || '') && bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block') cells.push(p);
        }
      }
    }
    if (!cells.length) return false;
    const here = bot.entity.position;
    cells.sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
    let paved = 0;
    for (const cell of cells) {
      const item = bot.inventory.items().find((i) => BRIDGE_BLOCKS.test(i.name) || nether.SCAFFOLD.includes(i.name));
      if (!item) break;
      if (!actions.withinReach(bot, cell.offset(0.5, 0.5, 0.5))) continue;
      try {
        await bot.equip(item, 'hand');
        await bot.placeBlock(bot.blockAt(cell.offset(0, -1, 0)), new Vec3(0, 1, 0));
      } catch (error) {
        if (error?.code === 'aborted') throw error;
      }
      if (bot.blockAt(cell)?.boundingBox === 'block') paved += 1;
    }
    ctx.record('portal_paved', { lava: cells.length, paved });
    return paved > 0;
  }

  // ---- the forced portal ledge ------------------------------------------

  // With no room for a portal near the linked spot, the server forces one at
  // y 70 on a 3x2 obsidian ledge, which can hang forty blocks over a lava sea.
  // The pathfinder (three-block drops at most, lava priced out) finds no way
  // off; a seed-101 run walked off it nine times. Bridge to the nearest land.
  // Protected quartz causeways use blast-resistant naturally gathered stone.
  const BRIDGE_BLOCKS = protectedBridge ? /^(cobblestone|cobbled_deepslate)$/
    : /^(cobblestone|cobbled_deepslate|dirt|netherrack)$/;
  const bridgeBlocks = () => bot.inventory.items().filter((i) => BRIDGE_BLOCKS.test(i.name)).reduce((n, i) => n + i.count, 0);
  const cellKey = (p) => `${p.x},${p.y},${p.z}`;
  const openCell = (p) => { const b = bot.blockAt(p); return Boolean(b) && b.boundingBox === 'empty' && !/lava|fire/.test(b.name); };
  const standable = (p) => fullCube(bot.blockAt(p.offset(0, -1, 0))) && openCell(p) && openCell(p.offset(0, 1, 0));

  // The ledge and a bridge laid from it: nothing the Nether makes itself.
  const LAID = /^(obsidian|cobblestone|cobbled_deepslate|dirt)$/;
  const naturalFoot = (p) => {
    const support = p.offset(0, -1, 0);
    const floor = bot.blockAt(support);
    if (bot.companionPlacedRecently?.(support)) memory.ledgeSupports.add(cellKey(support));
    return standable(p) && !memory.ledgeSupports.has(cellKey(support))
      && !LAID.test(floor.name) && !/bedrock|magma/.test(floor.name);
  };
  // A narrow basalt spur or a lower shelf is not a landing. Require a
  // connected two-by-two surface at the bridge's actual standing height.
  function landingAt(p) {
    if (!naturalFoot(p)) return false;
    return [-1, 1].some((dx) => [-1, 1].some((dz) => [p.offset(dx, 0, 0), p.offset(0, 0, dz), p.offset(dx, 0, dz)].every(naturalFoot)));
  }
  function landedHere() {
    if (!bot.entity.onGround) return false;
    const p = bot.entity.position;
    const feet = p.floored();
    if (Number.isSafeInteger(memory.ledgeStandingY) && feet.y !== memory.ledgeStandingY) return false;
    return Math.hypot(p.x - feet.x - 0.5, p.z - feet.z - 0.5) < 0.35 && landingAt(feet);
  }

  // Empty collision boxes can still be fire or fluid. Permit an old solid
  // rail to be cleared, then require fresh actual clearance before moving.
  function validateBridgeBody(ctx, { ahead, phase }) {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    for (const cell of [ahead, ahead.offset(0, 1, 0)]) {
      const block = bot.blockAt(cell);
      if (!block) return fail('bridge_guard_unknown');
      if (/fire|lava|water|magma|campfire|cactus|powder_snow|sweet_berry_bush/.test(block.name)) return fail('bridge_guard_unsafe');
      if (phase !== 'before_clear' && block.boundingBox !== 'empty') return fail('bridge_guard_blocked');
    }
    if (phase !== 'before_clear') {
      const floor = bot.blockAt(ahead.offset(0, -1, 0));
      if (!floor) return fail('bridge_guard_unknown');
      if (!fullCube(floor) || /fire|lava|water|magma|campfire|cactus/.test(floor.name)) return fail('bridge_guard_unsafe');
    }
    return { ok: true };
  }

  const AIR = /^(air|cave_air|void_air)$/;
  const GUARDED_HAZARD = /fire|lava|water|magma|campfire|cactus|powder_snow|sweet_berry_bush/;
  const blockData = (block) => block ? { name: block.name, position: block.position && cellKey(block.position),
    boundingBox: block.boundingBox, shapes: block.shapes } : null;
  const faceId = (face) => face.y < 0 ? 0 : face.y > 0 ? 1 : face.z < 0 ? 2 : face.z > 0 ? 3 : face.x < 0 ? 4 : 5;

  // Either endpoint can centre the full footprint. In particular the original
  // portal exit's completed east-facing footprint also admits its reverse edge.
  function guardPlan({ feet, ahead, dir }) {
    const plans = []; let rejected = null;
    const at = memory.ledgeRoute?.findIndex((p) => p.x === feet.x && p.y === feet.y && p.z === feet.z) ?? -1;
    const next = memory.ledgeRoute?.findIndex((p) => p.x === ahead.x && p.y === ahead.y && p.z === ahead.z) ?? -1;
    // Only retracing an acknowledged edge reuses the old outward endpoint's
    // footprint. Every novel/forward step still builds the next-centred3x3.
    const centres = next >= 0 && at === next + 1 ? [feet] : [ahead];
    for (const centre of centres) {
      const floor = []; const walls = []; const openings = []; let invalid = null; let required = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) floor.push(centre.offset(dx, -1, dz));
      const side = new Vec3(-dir.z, 0, dir.x);
      for (let along = -1; along <= 1; along++) for (const sign of [-1, 1]) {
        const base = centre.plus(dir.scaled(along)).plus(side.scaled(sign));
        const column = [base, base.offset(0, 1, 0)];
        // Never waive an active portal merely because it is an open collision
        // box, a remembered route cell, or beside a natural floor.
        if (column.some((p) => /portal/.test(bot.blockAt(p)?.name || ''))) invalid = fail('bridge_guard_portal', { cell: cellKey(base) });
        if (landingAt(base) || memory.ledgeRoute?.some((p) => p.x === base.x && p.y === base.y && p.z === base.z)) {
          openings.push(...column);
          for (const p of column) { const b = bot.blockAt(p);
            if (!b) invalid ||= fail('bridge_guard_unknown', { cell: cellKey(p) });
            else if (!AIR.test(b.name)) invalid ||= fail('bridge_guard_obstructed', { cell: cellKey(p) });
          }
          continue;
        }
        walls.push(...column);
      }
      for (const cell of [...floor, ...walls]) {
        const block = bot.blockAt(cell);
        if (!block) { invalid ||= fail('bridge_guard_unknown', { cell: cellKey(cell) }); continue; }
        if (/portal/.test(block.name)) invalid ||= fail('bridge_guard_portal', { cell: cellKey(cell) });
        else if (GUARDED_HAZARD.test(block.name)) invalid ||= fail('bridge_guard_unsafe', { cell: cellKey(cell) });
        else if (block.boundingBox === 'block') { if (!fullCube(block)) invalid ||= fail('bridge_guard_partial', { cell: cellKey(cell) }); }
        else if (!AIR.test(block.name)) invalid ||= fail('bridge_guard_obstructed', { cell: cellKey(cell) });
        else required++;
      }
      if (invalid) { rejected ||= invalid; continue; }
      floor.sort((a, b) => a.distanceTo(feet) - b.distanceTo(feet));
      // Complete the lower wall layer first. Within each layer, do not seal
      // a near column before a farther face that it can hide.
      walls.sort((a, b) => a.y - b.y || b.distanceTo(feet) - a.distanceTo(feet));
      plans.push({ ok: true, floor, walls, openings, centre, required });
    }
    plans.sort((a, b) => a.required - b.required);
    return plans[0] || rejected || fail('bridge_guard_no_layout');
  }

  function bridgeOptions(ctx, keepWalls = false) {
    return { avoidLiquids: true, keepWalls, blocks: BRIDGE_BLOCKS,
      ...(protectedBridge ? { prepareNext: (edge) => prepareBridgeGuard(ctx, edge), validateNext: (edge) => validateBridgeBody(ctx, edge) } : {}) };
  }

  /** Read-only admission from a freshly observed old bridge, not a quarry
   * route join. Coordinates/cached ACKs are candidates; actual loaded shapes,
   * current body/profile and the original guard plan must all agree now. */
  function inspectConfirmedBridgeReturn(witness = null) {
    if (bridgeInspection) return fail('bridge_inspection_reentrant', { queryOnly: true, progress: false });
    const scope = { actualMemory: memory, supports: memory.ledgeSupports, queryMemory: null };
    bridgeInspection = scope;
    try {
      const result = inspectBridgeReturn(witness, scope);
      return scope.actualMemory.ledgeSupports !== scope.supports
        ? fail('bridge_observation_changed', { queryOnly: true, progress: false }) : result;
    } finally {
      // Original guard helpers can remember recently placed support. Bind
      // only this synchronous query to a private view, never the real Set.
      // External callbacks still own actualMemory; their replacements survive.
      if (memory === scope.queryMemory) memory = scope.actualMemory;
      if (bridgeInspection === scope) bridgeInspection = null;
    }
  }

  function inspectBridgeReturn(witness, scope) {
    const no = (reason) => fail(reason, { queryOnly: true, progress: false });
    const life = typeof bot.companionBodyLife === 'function' ? bot.companionBodyLife() : null;
    if (!life?.owner || typeof life.owner !== 'object' || !Number.isSafeInteger(life.epoch) || life.epoch < 0) {
      return no('bridge_life_owner_unknown');
    }
    if (!nether.inNether(bot)) return no('bridge_wrong_dimension');
    const m = bot.pathfinder?.movements;
    const guardedDrop = m?.maxDropDown <= 1 || (m?.maxDropDown <= 2 && m.companionPhysicalDropLimit === 1
      && m.infiniteLiquidDropdownDistance === false && typeof m.companionPhysicalDropGuard === 'function'
      && m.getNeighbors === m.companionPhysicalDropGuard);
    if (!walkOnly || !protectedBridge || !m?.companionNether || !m.companionWalkOnly || m.canDig !== false
      || m.allowParkour !== false || m.allow1by1towers !== false || m.scafoldingBlocks?.length !== 0 || !guardedDrop) {
      return no('bridge_current_profile_unknown');
    }
    const actual = bot.entity?.position?.clone(), route = memory.ledgeRoute;
    if (!actual || !bot.entity.onGround || Math.abs(actual.y - Math.floor(actual.y)) > .02) return no('bridge_not_grounded');
    if (!Array.isArray(route) || route.length < 2 || route.length > 256) return no('bridge_route_invalid');
    const index = route.findIndex(p => p && ['x','y','z'].every(k => Number.isSafeInteger(p[k])) && actual.floored().equals(p));
    if (index < 0) return no('not_confirmed_bridge_cell');
    const portalKey = bridgeCacheKey();
    if (!portalKey) return no('original_portal_unavailable');
    const routeKey = JSON.stringify([portalKey, route.map(p => p && [p.x,p.y,p.z])]);
    if (witness && (witness.owner !== life.owner || witness.epoch !== life.epoch || witness.routeKey !== routeKey)) {
      return no('old_bridge_recovery_witness');
    }
    const endpoint = index === 0, feet = new Vec3(route[index].x, route[index].y, route[index].z);
    if (endpoint && !witness) return no('bridge_endpoint_requires_initial_witness');
    if (!endpoint && !scope.supports.has(cellKey(feet.offset(0,-1,0)))) return no('bridge_floor_not_durable_owned');
    if (scope.actualMemory.ledgeSupports !== scope.supports) return no('bridge_observation_changed');
    scope.queryMemory = { ...scope.actualMemory, ledgeSupports: new Set(scope.supports) };
    memory = scope.queryMemory;
    const routeFailure = bridgeRouteFailure(endpoint ? [route[0]] : route);
    if (routeFailure) return no(routeFailure);
    const strictFull = b => b?.boundingBox === 'block' && b.shapes?.length === 1 && b.shapes[0].length === 6
      && b.shapes[0].every((value,i) => value === [0,0,0,1,1,1][i]);
    for (const p of endpoint ? [route[0]] : route) {
      const floor = bot.blockAt(new Vec3(p.x,p.y-1,p.z));
      if (!strictFull(floor)) return no('bridge_route_support_shape_unknown');
      if ([0,1].some(y => bot.blockAt(new Vec3(p.x,p.y+y,p.z))?.shapes?.length !== 0)) return no('bridge_route_body_shape_unknown');
    }
    const width = bot.entity.width ?? .6, height = bot.entity.height ?? 1.8;
    if (![width,height].every(Number.isFinite) || width <= 0 || width > 1 || height <= 0 || height > 2) return no('bridge_body_shape_unknown');
    for (let x=Math.floor(actual.x-width/2+1e-8);x<=Math.floor(actual.x+width/2-1e-8);x++) {
      for (let z=Math.floor(actual.z-width/2+1e-8);z<=Math.floor(actual.z+width/2-1e-8);z++) {
        const cell = new Vec3(x,feet.y,z), floor = bot.blockAt(cell.offset(0,-1,0));
        if (!strictFull(floor)) return no(floor ? 'bridge_support_shape_unknown' : 'bridge_support_unknown');
        const dry = dryFootFailure(cell); if (dry) return no(dry);
        for (let y=feet.y;y<=Math.floor(actual.y+height-1e-8);y++) {
          const body = bot.blockAt(new Vec3(x,y,z));
          if (!body || body.boundingBox !== 'empty' || body.shapes?.length !== 0 || GUARDED_HAZARD.test(body.name)) {
            return no(!body ? 'bridge_body_unknown' : 'bridge_body_unsafe');
          }
        }
      }
    }
    let guard = null;
    if (!endpoint) {
      const ahead = new Vec3(route[index-1].x,route[index-1].y,route[index-1].z), dir = ahead.minus(feet);
      guard = guardPlan({ feet, ahead, dir });
      if (!guard.ok) return no(guard.reason);
      if (guard.required !== 0 || [...guard.floor,...guard.walls].some(p => !strictFull(bot.blockAt(p)))) {
        return no('bridge_guard_incomplete_or_shape_unknown');
      }
      for (const phase of ['before_clear','after_guard']) {
        const body = validateBridgeBody({}, { ahead, phase }); if (!body.ok) return no(body.reason);
      }
    } else if (actual.distanceTo(memory.netherPortal) > 8) return no('bridge_endpoint_not_near_portal');
    const freshLife = typeof bot.companionBodyLife === 'function' ? bot.companionBodyLife() : null;
    if (!freshLife || freshLife.owner !== life.owner || freshLife.epoch !== life.epoch
      || bot.pathfinder?.movements !== m || !bot.entity.onGround || !bot.entity.position.equals(actual)) return no('bridge_observation_changed');
    // The caller must re-check its own run/life token before any state write.
    // A new current-life witness comes from this complete fresh inspection,
    // never from assigning a new epoch to a historical cache acknowledgement.
    return { ok: true, queryOnly: true, progress: false, index, life,
      witness: witness || { owner: life.owner, epoch: life.epoch, routeKey, entryCell: cellKey(feet) },
      actualPortalEndObserved: endpoint, nextTarget: cellKey(endpoint ? memory.netherPortal : route[index-1]),
      nextGuardRequired: guard?.required ?? null };
  }

  function portalExitTarget(ctx, feet, shore) {
    const direction = (target) => Math.abs(target.x - feet.x) >= Math.abs(target.z - feet.z)
      ? new Vec3(Math.sign(target.x - feet.x) || 1, 0, 0) : new Vec3(0, 0, Math.sign(target.z - feet.z) || 1);
    const dir = direction(shore); const planned = guardPlan({ feet, ahead: feet.plus(dir), dir });
    if (planned.ok || planned.reason !== 'bridge_guard_portal') return { ok: true, target: shore.offset(0.5, 0, 0.5) };
    ctx.record('bridge_guard_plan_rejected', { at: cellKey(feet), shore: cellKey(shore), reason: planned.reason, cell: planned.cell });
    if (!memory.netherPortal || feet.distanceTo(memory.netherPortal) > 8) return planned;
    const choices = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const vector = new Vec3(dx, 0, dz); const next = feet.plus(vector);
      if ([next, next.offset(0, 1, 0)].some((p) => { const b = bot.blockAt(p); return !b || !AIR.test(b.name); })) continue;
      const candidate = guardPlan({ feet, ahead: next, dir: vector });
      if (candidate.ok) choices.push({ next, candidate });
    }
    choices.sort((a, b) => a.next.distanceTo(shore) - b.next.distanceTo(shore));
    if (!choices.length) return fail('bridge_portal_exit_unavailable');
    ctx.record('bridge_portal_exit', { from: cellKey(feet), to: cellKey(choices[0].next), shore: cellKey(shore),
      centre: cellKey(choices[0].candidate.centre) });
    return { ok: true, target: choices[0].next.offset(0.5, 0, 0.5) };
  }

  function placementSight(reference, face, point) {
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
    const delta = point.minus(eye); const distance = delta.norm();
    if (distance <= 0 || distance > 4.5 || !bot.world?.raycast) return 'unknown';
    const ray = delta.scaled(1 / distance); const cells = new RaycastIterator(eye, ray, distance + 0.001);
    for (let p = eye; p; p = cells.next()) if (!bot.blockAt(new Vec3(p.x, p.y, p.z))) return 'unknown';
    const hit = bot.world.raycast(eye, ray, distance + 0.001);
    if (hit && typeof hit.then === 'function') return 'unknown';
    return hit && hit.position.equals(reference.position) && hit.face === faceId(face) ? 'client_visible' : 'client_occluded';
  }

  function placementFaces(cell) {
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
    const visible = []; const fallback = [];
    for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const reference = bot.blockAt(cell.offset(dx, dy, dz));
      if (!fullCube(reference) || GUARDED_HAZARD.test(reference.name)) continue;
      const face = new Vec3(-dx, -dy, -dz); const centre = reference.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
      const los = placementSight(reference, face, centre);
      if (los !== 'unknown') fallback.push({ reference, face, point: centre, los });
      for (const a of [0.5, 0.05, 0.95]) for (const b of [0.5, 0.05, 0.95]) {
        const local = face.x ? new Vec3(face.x > 0 ? 1 : 0, a, b)
          : face.y ? new Vec3(a, face.y > 0 ? 1 : 0, b) : new Vec3(a, b, face.z > 0 ? 1 : 0);
        const point = reference.position.plus(local);
        if (placementSight(reference, face, point) === 'client_visible') visible.push({ reference, face, point, local, los: 'client_visible' });
      }
    }
    visible.sort((a, b) => a.point.distanceTo(eye) - b.point.distanceTo(eye));
    return { visible, fallback };
  }

  /** Floor acknowledgements precede clearing the old rail; complete walls then admit movement. */
  async function prepareBridgeGuard(ctx, { feet, ahead, dir }) {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    await actions.recentre?.(bot, ctx);
    const standing = bot.entity.position.clone();
    const supported = () => bot.entity.onGround && bot.entity.position.floored().equals(feet)
      && bot.entity.position.distanceTo(standing) < 0.2 && standable(feet);
    const assertPosition = () => {
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      return supported() ? { ok: true } : fail('bridge_guard_position_changed');
    };
    if (!assertPosition().ok) return fail('bridge_guard_position_changed');
    const plan = guardPlan({ feet, ahead, dir });
    if (!plan.ok) { ctx.record('bridge_guard_plan_rejected', { at: cellKey(feet), next: cellKey(ahead), reason: plan.reason, cell: plan.cell }); return plan; }
    if (bridgeBlocks() < plan.required) {
      ctx.record('bridge_guard_need_blocks', { have: bridgeBlocks(), required: plan.required });
      return fail('no_bridge_blocks');
    }
    let placed = 0;
    const put = async (cell, kind) => {
      const status = assertPosition(); if (!status.ok) return status;
      const before = bot.blockAt(cell);
      if (!before) return fail('bridge_guard_unknown');
      if (/portal/.test(before.name)) return fail('bridge_guard_portal');
      if (GUARDED_HAZARD.test(before.name)) return fail('bridge_guard_unsafe');
      if (before.boundingBox === 'block') return fullCube(before) ? { ok: true } : fail('bridge_guard_partial');
      if (!AIR.test(before.name)) return fail('bridge_guard_obstructed');
      const body = bot.entity.position;
      if (cell.x < body.x + 0.3 && cell.x + 1 > body.x - 0.3 && cell.z < body.z + 0.3 && cell.z + 1 > body.z - 0.3
        && cell.y < body.y + 1.8 && cell.y + 1 > body.y) return fail('bridge_guard_body');
      const faces = placementFaces(cell);
      // Vanilla may acknowledge an ordinary face whose centre ray is occluded.
      // Prefer visible faces; bounded normal-face fallbacks remain labelled
      // and require the same actual block acknowledgement. No custom packet.
      const groups = new Map();
      for (const face of [...faces.visible, ...faces.fallback]) {
        const group = `${cellKey(face.reference.position)}:${cellKey(face.face)}`;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(face);
      }
      // Try another actual supporting face before spending the small retry
      // budget on several cursor points of the same rejected reference.
      const candidates = [...groups.values()].map((values) => values[0]);
      for (const values of groups.values()) candidates.push(...values.slice(1));
      const attempts = []; const used = new Set();
      for (const candidate of candidates) {
        const token = `${cellKey(candidate.reference.position)}:${cellKey(candidate.face)}:${cellKey(candidate.point)}`;
        if (used.has(token)) continue; used.add(token); if (attempts.length >= 3) break;
        const item = bot.inventory.items().find((i) => BRIDGE_BLOCKS.test(i.name) && i.count > 0);
        if (!item) return fail('no_bridge_blocks');
        const itemBefore = bridgeBlocks(); let error = null; const began = Date.now();
        const evidence = { cell: cellKey(cell), kind, before: blockData(before), reference: blockData(candidate.reference),
          face: cellKey(candidate.face), cursor: cellKey(candidate.point.minus(candidate.reference.position)), los: candidate.los,
          at: cellKey(bot.entity.position), item: item.name, itemBefore };
        ctx.record('bridge_guard_place_intent', evidence);
        try {
          await bot.equip(item, 'hand'); if (!assertPosition().ok) throw new Error('bridge_guard_position_changed');
          await bot.lookAt(candidate.point, true); if (!assertPosition().ok) throw new Error('bridge_guard_position_changed');
          const current = bot.blockAt(cell); const reference = bot.blockAt(candidate.reference.position);
          if (!current || !reference) throw new Error('bridge_guard_unknown');
          if (/portal/.test(current.name)) throw new Error('bridge_guard_portal');
          if (GUARDED_HAZARD.test(current.name) || !AIR.test(current.name)) throw new Error('bridge_guard_changed');
          if (!fullCube(reference) || GUARDED_HAZARD.test(reference.name)) throw new Error('bridge_guard_reference_changed');
          evidence.losAtDispatch = placementSight(reference, candidate.face, candidate.point);
          if (evidence.losAtDispatch === 'unknown') throw new Error('bridge_guard_visibility_unknown');
          if (typeof bot._placeBlockWithOptions !== 'function') throw new Error('bridge_guard_no_place_api');
          memory.ledgeSupports.add(cellKey(cell)); retainBridgeObservation();
          await bot._placeBlockWithOptions(bot.blockAt(candidate.reference.position), candidate.face,
            { delta: candidate.point.minus(candidate.reference.position), forceLook: 'ignore', swingArm: 'right' });
        } catch (caught) { error = String(caught?.stack || caught); }
        const actual = bot.blockAt(cell); const ok = fullCube(actual) && BRIDGE_BLOCKS.test(actual.name);
        const result = { ...evidence, ok, itemAfter: bridgeBlocks(), itemDelta: bridgeBlocks() - itemBefore,
          error, actual: blockData(actual), atAfter: cellKey(bot.entity.position), elapsedMs: Date.now() - began };
        ctx.record('bridge_guard_place_result', result); attempts.push(result);
        const still = assertPosition(); if (!still.ok) return still;
        if (ok) { placed++; return { ok: true }; }
        // The previous reference, obstruction and inventory are re-read for
        // every new cell. A failed response is never a placement credit.
      }
      if (!attempts.length) ctx.record('bridge_guard_place_result', { cell: cellKey(cell), kind, before: blockData(before), reference: null,
        face: null, itemBefore: bridgeBlocks(), itemAfter: bridgeBlocks(), itemDelta: 0, error: 'no_loaded_visible_face', actual: blockData(bot.blockAt(cell)), ok: false });
      return fail('bridge_guard_place_failed');
    };
    const checkCells = (cells) => cells.every((p) => { const b = bot.blockAt(p); return fullCube(b) && !GUARDED_HAZARD.test(b.name); });
    const withSneak = async (run) => {
      const old = bot.getControlState?.('sneak') || false; const flag = bot.companionSneaking;
      bot.companionSneaking = true; bot.setControlState?.('sneak', true);
      try { return await run(); }
      finally { bot.setControlState?.('sneak', ctx.signal?.aborted ? false : old); bot.companionSneaking = flag; }
    };
    return withSneak(async () => {
      for (const cell of plan.floor) { const result = await put(cell, 'floor'); if (!result.ok) return result; }
      if (!assertPosition().ok || !checkCells(plan.floor)) return fail('bridge_guard_changed');
      ctx.record('bridge_guard_floor_prepared', { at: cellKey(feet), next: cellKey(ahead), centre: cellKey(plan.centre), placed,
        floor: plan.floor.map((p) => ({ position: cellKey(p), block: bot.blockAt(p)?.name })) });
      return { ok: true, assertPosition, afterClear: () => withSneak(async () => {
        if (!assertPosition().ok || !checkCells(plan.floor)) return fail('bridge_guard_changed');
        for (const cell of plan.walls) { const result = await put(cell, 'wall'); if (!result.ok) return result; }
        if (!assertPosition().ok || !checkCells([...plan.floor, ...plan.walls]) || plan.openings.some((p) => !AIR.test(bot.blockAt(p)?.name || 'unknown'))) return fail('bridge_guard_changed');
        const clear = validateBridgeBody(ctx, { feet, ahead, dir, phase: 'after_guard' });
        if (!clear.ok) return clear;
        ctx.record('bridge_guard_prepared', { at: cellKey(feet), next: cellKey(ahead), centre: cellKey(plan.centre), width: 3, wallHeight: 2, placed,
          floor: plan.floor.map((p) => ({ position: cellKey(p), block: bot.blockAt(p)?.name })),
          walls: plan.walls.map((p) => ({ position: cellKey(p), block: bot.blockAt(p)?.name })),
          clearance: [...plan.openings, feet, feet.offset(0, 1, 0), ahead, ahead.offset(0, 1, 0)].map((p) => ({ position: cellKey(p), block: bot.blockAt(p)?.name })) });
        return { ok: true };
      }) };
    });
  }
  /**
   * The cells walkable from the feet (steps of one up or down), or null once
   * more than `limit` of them stand on the Nether's own ground (open ground).
   */
  function walkable(limit = 40) {
    const start = bot.entity.position.floored();
    if (!standable(start)) return null;
    const seen = new Map([[cellKey(start), start]]);
    const queue = [start];
    let natural = 0;
    while (queue.length) {
      const c = queue.shift();
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (const dy of [0, 1, -1]) {
          const n = c.offset(dx, dy, dz);
          if (seen.has(cellKey(n)) || !standable(n)) continue;
          seen.set(cellKey(n), n);
          if (!LAID.test(bot.blockAt(n.offset(0, -1, 0))?.name || '')) natural += 1;
          if (natural > limit || seen.size > 400) return null;
          queue.push(n);
          break;
        }
      }
    }
    return [...seen.values()];
  }

  /** On a few cells with a long drop off every side: the walkable cells, else null. */
  function ledge() {
    if (!nether.inNether(bot)) return null;
    if (!bot.entity.onGround) return memory.ledgeTransit ? [] : null;
    if (landedHere()) { memory.ledgeTransit = false; return null; }
    const cells = walkable();
    if (!cells) return memory.ledgeTransit ? [bot.entity.position.floored()] : null;
    const keys = new Set(cells.map(cellKey));
    let drops = 0;
    for (const c of cells) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = c.offset(dx, 0, dz);
        if (keys.has(cellKey(n)) || !openCell(n)) continue;
        let depth = 0;
        while (depth < 6 && openCell(n.offset(0, -1 - depth, 0))) depth += 1;
        if (depth >= 6) drops += 1;
      }
    }
    return drops >= 2 ? cells : null;
  }

  /** The nearest solid, lava-free ground off the ledge, about level with it. */
  function landFrom(cells, radius = 48) {
    const feet = bot.entity.position.floored();
    const keys = new Set(cells.map(cellKey));
    let best = null;
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        const d = Math.hypot(dx, dz);
        if (d < 3 || d > radius || (best && d >= best.d)) continue;
        const p = feet.offset(dx, -1, dz);
        if (keys.has(cellKey(p.offset(0, 1, 0)))) continue;
        if (memory.ledgeBlocked?.has(cellKey(p))) continue;
        if (!landingAt(p.offset(0, 1, 0))) continue;
        best = { p, d };
      }
    }
    return best?.p || null;
  }

  /**
   * One step off a ledge: bridge toward land with the blocks carried. With
   * too few blocks it reports `ledge_no_blocks`, and the caller goes home
   * through the portal for some.
   */
  async function leaveLedge(ctx, cells) {
    if (!Number.isSafeInteger(memory.ledgeStandingY)) memory.ledgeStandingY = bot.entity.position.floored().y;
    if (landedHere()) { memory.ledgeTransit = false; return { ok: true, landed: true }; }
    memory.ledgeTransit = true;
    if (!bot.entity.onGround) return fail('bridge_not_grounded', { landed: false });
    if (bot.entity.position.floored().y !== memory.ledgeStandingY) return fail('bridge_height_changed', { landed: false });
    let reused;
    try { reused = await forwardBridge(ctx); }
    finally { if (ctx.signal?.aborted) actions.haltBody?.(bot); }
    if (reused) return reused;
    const remembered = memory.ledgeTarget && new Vec3(memory.ledgeTarget.x, memory.ledgeTarget.y, memory.ledgeTarget.z);
    const target = remembered && landingAt(remembered.offset(0, 1, 0)) ? remembered : landFrom(cells);
    if (target) memory.ledgeTarget = target;
    retainBridgeObservation();
    if (!target) return fail('ledge_no_land');
    if (bridgeBlocks() < 4) return fail('ledge_no_blocks', { blocks: bridgeBlocks() });
    ctx.record('ledge_bridge', { from: cellKey(bot.entity.position.floored()), to: cellKey(target), blocks: bridgeBlocks() });
    const start = bot.entity.position.clone();
    const initialFeet = start.floored();
    const last = memory.ledgeRoute?.[memory.ledgeRoute.length - 1];
    if (!last || !initialFeet.equals(last)) { memory.ledgeRoute = [initialFeet]; memory.ledgeLanding = null; }
    let stopped = null;
    for (let steps = 0; steps < 48; steps += 1) {
      if (landedHere()) break;
      const before = bot.entity.position.floored();
      const dx = target.x - before.x;
      const dz = target.z - before.z;
      const ahead = Math.abs(dx) >= Math.abs(dz) ? before.offset(Math.sign(dx) || 1, -1, 0) : before.offset(0, -1, Math.sign(dz) || 1);
      const hadSupport = bot.blockAt(ahead)?.boundingBox === 'block';
      const planned = protectedBridge ? portalExitTarget(ctx, before, target) : { ok: true, target: target.offset(0.5, 0, 0.5) };
      if (!planned.ok) { stopped = planned.reason; break; }
      const step = await end.bridgeStep(bot, ctx, planned.target, bridgeOptions(ctx));
      if (!hadSupport && bot.blockAt(ahead)?.boundingBox === 'block') memory.ledgeSupports.add(cellKey(ahead));
      retainBridgeObservation();
      if (!step.ok) { stopped = step.reason; break; }
      const confirmed = bot.entity.position.floored();
      const prior = memory.ledgeRoute[memory.ledgeRoute.length - 1];
      if (confirmed.y !== memory.ledgeStandingY || confirmed.y !== before.y
        || Math.abs(confirmed.x - before.x) + Math.abs(confirmed.z - before.z) !== 1
        || !bot.entity.onGround || !standable(confirmed)) { stopped = 'bridge_step_unconfirmed'; break; }
      if (bot.entity.onGround && standable(confirmed) && !confirmed.equals(prior)) memory.ledgeRoute.push(confirmed);
      retainBridgeObservation();
    }
    const moved = bot.entity.position.distanceTo(start);
    const landed = landedHere();
    memory.ledgeTransit = !landed;
    if (landed) memory.ledgeLanding = bot.entity.position.floored();
    retainBridgeObservation();
    ctx.record('ledge_bridge_end', { at: cellKey(bot.entity.position.floored()), moved: Math.round(moved), stopped,
      landed, target: cellKey(target), blocks: bridgeBlocks() });
    // Local preparation/material/ack failures do not prove the natural shore unreachable.
    if (landed) return { ok: true, moved: Math.round(moved), landed: true };
    if (stopped === 'bridge_step_unconfirmed') return fail(stopped, { landed: false, moved: Math.round(moved) });
    if (stopped === 'no_bridge_blocks') return fail('ledge_no_blocks', { landed: false, moved: Math.round(moved) });
    return moved >= 1 ? { ok: true, moved: Math.round(moved), landed: false, transit: true }
      : fail(stopped || 'ledge_blocked', { landed: false });
  }

  return { memory, enterNetherMode, leaveNetherMode, dispose, setBridgeResupply, framePlaced, portalProgress, wearGold, goThrough, toNether, toOverworld, netherPortal, inspectConfirmedBridgeReturn,
    ledge, landFrom, leaveLedge, bridgeBlocks };
}

module.exports = { createPortalTrip };
