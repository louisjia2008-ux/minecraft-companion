'use strict';
// Goal: loot an end city on the outer islands (and the elytra, if it has a ship).
//
// On the main island: find the gateway the dragon's death opened and throw an
// ender pearl into it. On the outer islands: purpur in the chunk data means a
// city; walk or bridge to it, empty its chests, and knock the elytra out of
// a ship's item frame when one is in sight. With no city in view, head away
// from the main island, bridging over the void between islands.

const { Vec3 } = require('vec3');
const defaultActions = require('../actions');
const defaultSkills = require('../skills');
const end = require('../end');
const city = require('../endCity');
const { createBlacklist, posKey } = require('../blacklist');
const { sleep, waitUntil } = require('../confirm');

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const at = (p) => (p ? `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : null);
const outer = (bot) => Math.hypot(bot.entity.position.x, bot.entity.position.z) > 400;

function createEndCityGoal({ bot, chests = 2, actions = defaultActions, skills = defaultSkills } = {}) {
  const blacklist = createBlacklist({ ttlMs: 300000 });
  const memory = { looted: new Set(), taken: 0, gatewayUsed: false, pearls: 0, cityAt: null, heading: null,
    explored: 0, elytra: false, bridged: 0, seenFrames: 0 };
  let restore = null;
  const enterMode = () => { if (!restore) restore = end.applyEndMovements(bot); };
  const hasElytra = () => actions.countItems(bot, (n) => n === 'elytra') > 0;

  async function useGateway(ctx) {
    const gateways = city.findGateway(bot, 160).filter((g) => !blacklist.has(posKey(g.position)));
    if (gateways.length === 0) {
      // The gateways ring the island 96 blocks out: walk out toward that ring.
      const here = bot.entity.position.clone();
      const a = Math.atan2(here.z, here.x) + (memory.explored % 2 ? 0.6 : 0);
      memory.explored += 1;
      const stand = end.surfaceAt(bot, Math.round(Math.cos(a) * 70), Math.round(Math.sin(a) * 70));
      ctx.record('gateway_search', { to: at(stand) });
      if (!stand) return fail('no_gateway_in_sight');
      return end.walkTo(bot, ctx, stand, 3, 60000);
    }
    const here = bot.entity.position.clone();
    gateways.sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here));
    const gateway = gateways[0];
    if (!blacklist.has(`tower:${posKey(gateway.position)}`)) return towerPearl(ctx, gateway);
    const spots = city.pearlSpots(bot, gateway);
    ctx.record('gateway_target', { gateway: at(gateway.position), spots: spots.length });
    if (spots.length === 0) {
      blacklist.add(posKey(gateway.position), 'no_pearl_spot');
      return fail('no_pearl_spot');
    }
    const { stand, high } = spots[0];
    ctx.record('pearl_spot', { stand: at(stand), high, below: bot.blockAt(stand.offset(0, -1, 0))?.name || null });
    const moved = await end.walkTo(bot, ctx, stand, 0, 60000);
    if (!moved.ok && bot.entity.position.distanceTo(stand.offset(0.5, 0, 0.5)) > 1.2) return moved;
    const from = bot.entity.position.clone();
    const target = gateway.position.offset(0.5, 0.5, 0.5);
    const thrown = await end.throwPearl(bot, ctx, target, { high });
    if (!thrown.ok) return thrown;
    memory.pearls += 1;
    const jumped = await waitUntil(() => bot.entity.position.distanceTo(from) > 200, { timeoutMs: 6000, signal: ctx.signal });
    ctx.record('pearl_thrown', { gateway: at(gateway.position), from: at(from), high, through: jumped });
    if (!jumped) return fail('pearl_missed');
    memory.gatewayUsed = true;
    try { await bot.waitForChunksToLoad(); } catch (_) { /* re-checked next run */ }
    await waitUntil(() => bot.entity.onGround, { timeoutMs: 5000, signal: ctx.signal });
    return { ok: true };
  }

  /**
   * Towers up three blocks out from the gateway to its own level and throws
   * the pearl straight in: from there a pearl cannot clip the bedrock caps.
   */
  async function towerPearl(ctx, gateway) {
    const g = gateway.position;
    const tag = `tower:${posKey(g)}`;
    const here = bot.entity.position.clone();
    const columns = [[3, 0], [-3, 0], [0, 3], [0, -3]].map(([x, z]) => end.surfaceAt(bot, g.x + x, g.z + z, { yMax: g.y - 2 }))
      .filter((s) => s && bot.blockAt(s.offset(0, -1, 0))?.name === 'end_stone' && g.y - s.y <= 30)
      .sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
    if (columns.length === 0) {
      // The gateway hangs off the island's edge: bridge out to a column on
      // its island side, three blocks short of it, and tower from there.
      const n = Math.hypot(g.x, g.z) || 1;
      const p = new Vec3(Math.round(g.x - (g.x / n) * 3), 0, Math.round(g.z - (g.z / n) * 3));
      const feet = bot.entity.position.floored();
      if (Math.hypot(feet.x - p.x, feet.z - p.z) > 1 && !memory.bridgedToGateway) {
        memory.bridgedToGateway = true;
        const land = end.surfaceAt(bot, Math.round(p.x - (g.x / n) * 12), Math.round(p.z - (g.z / n) * 12), { yMax: g.y - 2 });
        if (land) await end.walkTo(bot, ctx, land, 1, 60000);
        const y = bot.entity.position.floored().y;
        const bridged = await end.bridgeToward(bot, ctx, new Vec3(p.x + 0.5, y, p.z + 0.5), { maxSteps: 24, stopOnLand: false });
        ctx.record('gateway_bridge', { to: at(p), steps: bridged.steps || 0, reason: bridged.reason || null });
      }
      const f = bot.entity.position.floored();
      if (Math.hypot(f.x - p.x, f.z - p.z) > 1.5) { blacklist.add(tag, 'no_column'); return fail('no_tower_column'); }
      columns.push(f);
    }
    const stand = columns[0];
    const onColumn = () => { const f = bot.entity.position.floored(); return f.x === stand.x && f.z === stand.z; };
    if (!onColumn()) {
      const moved = await end.walkTo(bot, ctx, stand, 0, 60000);
      if (!onColumn()) { blacklist.add(tag, moved.reason || 'not_at_column'); return moved.ok ? fail('not_at_column') : moved; }
    }
    const placed = await end.pillarUp(bot, ctx, g.y - 1, { maxSteps: g.y - stand.y + 2 });
    ctx.record('gateway_tower', { gateway: at(g), placed, y: Math.floor(bot.entity.position.y) });
    const from = bot.entity.position.clone();
    let jumped = false;
    if (bot.entity.position.floored().y >= g.y - 1) {
      const thrown = await end.throwPearl(bot, ctx, g.offset(0.5, 0.5, 0.5));
      if (thrown.ok) {
        memory.pearls += 1;
        jumped = await waitUntil(() => bot.entity.position.distanceTo(from) > 200, { timeoutMs: 6000, signal: ctx.signal });
      }
    }
    ctx.record('pearl_thrown', { gateway: at(g), from: at(from), tower: true, through: jumped });
    if (!jumped) {
      blacklist.add(tag, 'missed');
      await end.digPillarDown(bot, ctx);
      return fail('pearl_missed');
    }
    memory.gatewayUsed = true;
    try { await bot.waitForChunksToLoad(); } catch (_) { /* re-checked next run */ }
    await waitUntil(() => bot.entity.onGround, { timeoutMs: 5000, signal: ctx.signal });
    return { ok: true };
  }

  async function takeElytra(ctx, frame) {
    const p = frame.position;
    if (bot.entity.position.distanceTo(p) > 3) {
      const moved = await actions.goNear(bot, ctx, p, 2, { timeoutMs: 90000 });
      if (!moved.ok && bot.entity.position.distanceTo(p) > 4) { blacklist.add(`frame:${frame.id}`, moved.reason); return moved; }
    }
    await bot.lookAt(p, true);
    bot.attack(frame);
    await sleep(400, ctx.signal);
    const got = await actions.collectDrops(bot, ctx, p, (n) => n === 'elytra', { radius: 6, timeoutMs: 8000 });
    if (hasElytra()) {
      memory.elytra = true;
      ctx.record('elytra_taken', { at: at(p) });
      return { ok: true };
    }
    return got.ok ? got : fail('elytra_not_taken');
  }

  async function lootChest(ctx, p) {
    const before = bot.inventory.items().reduce((n, i) => n + i.count, 0);
    if (bot.entity.position.distanceTo(p) > 24) {
      const moved = await actions.goNear(bot, ctx, p, 3, { timeoutMs: 120000 });
      if (!moved.ok && bot.entity.position.distanceTo(p) > 8) { blacklist.add(posKey(p), moved.reason); return moved; }
    }
    const result = await skills.takeItems(bot, ctx, { position: p, itemMatch: () => true });
    if (result.ok || result.reason === 'chest_empty') {
      memory.looted.add(posKey(p));
      memory.taken += Math.max(0, bot.inventory.items().reduce((n, i) => n + i.count, 0) - before);
      ctx.record('chest_looted', { at: at(p), taken: result.taken || 0, looted: memory.looted.size });
      return { ok: true };
    }
    blacklist.add(posKey(p), result.reason);
    return result;
  }

  /**
   * Search rings around where the bot came out of the gateway: chunks load
   * a view distance around it, so waypoints at 3/4 and 1 1/2 of that (from
   * straight out, then round) bring every city within 2 1/2 views into sight.
   */
  function waypoint(here) {
    if (!memory.arrival) memory.arrival = here.clone();
    if (!memory.waypoints) {
      const out = city.outward(bot);
      const a0 = Math.atan2(out.z, out.x);
      memory.waypoints = [];
      const view = Math.max(96, ((bot.settings?.viewDistance && Number(bot.settings.viewDistance)) || 10) * 16);
      for (const [r, n] of [[view * 0.75, 8], [view * 1.5, 12]]) {
        for (let i = 0; i < n; i += 1) {
          // Round the ring from straight out.
          const a = a0 + (i * 2 * Math.PI) / n;
          memory.waypoints.push(new Vec3(memory.arrival.x + Math.cos(a) * r, 0, memory.arrival.z + Math.sin(a) * r));
        }
      }
    }
    if (memory.blocked) { memory.stuck = (memory.stuck || 0) + 1; memory.blocked = false; }
    while (memory.waypoints.length && (Math.hypot(memory.waypoints[0].x - here.x, memory.waypoints[0].z - here.z) < 24
      || memory.stuck >= 3)) {
      memory.waypoints.shift();
      memory.stuck = 0;
    }
    return memory.waypoints[0] || null;
  }

  /** Void cells crossed going 40 blocks from `here` along `dir` (bridge blocks it would take). */
  function gapAlong(here, dir) {
    let gap = 0;
    for (let d = 1; d <= 40; d += 1) {
      const x = Math.floor(here.x + dir.x * d);
      const z = Math.floor(here.z + dir.z * d);
      if (end.deepDrop(bot, x, here.y, z, 6)) gap += 1;
    }
    return gap;
  }

  /** The heading toward the waypoint, turned up to 60 degrees where that crosses much less void. */
  function gapAwareHeading(here, dir) {
    let best = null;
    for (const turn of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05]) {
      const h = new Vec3(dir.x * Math.cos(turn) - dir.z * Math.sin(turn), 0, dir.x * Math.sin(turn) + dir.z * Math.cos(turn));
      const cost = gapAlong(here, h) * 2 - Math.cos(turn) * 40;
      if (!best || cost < best.cost) best = { h, cost };
    }
    return best.h;
  }

  /**
   * Over a gap too wide to bridge cheaply: throw a pearl onto island ground
   * 12 to 36 blocks ahead (a flight that lands on it, nothing in the way).
   */
  async function pearlHop(ctx, dir) {
    if (bot.health < 14 || actions.countItems(bot, (n) => n === 'ender_pearl') < 2) return null;
    const here = bot.entity.position.clone();
    const origin = here.offset(0, 1.52, 0);
    for (const turn of [0, 0.3, -0.3, 0.6, -0.6]) {
      const h = new Vec3(dir.x * Math.cos(turn) - dir.z * Math.sin(turn), 0, dir.x * Math.sin(turn) + dir.z * Math.cos(turn));
      for (let d = 36; d >= 12; d -= 2) {
        const x = Math.floor(here.x + h.x * d);
        const z = Math.floor(here.z + h.z * d);
        const stand = end.surfaceAt(bot, x, z, { yMax: Math.floor(here.y) + 6, yMin: Math.floor(here.y) - 12 });
        if (!stand || bot.blockAt(stand.offset(0, -1, 0))?.name !== 'end_stone') continue;
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => end.deepDrop(bot, x + a, stand.y, z + b, 4))) continue;
        const target = stand.offset(0.5, 0.1, 0.5);
        const shot = end.aim(origin, target, end.PEARL);
        if (!shot || !end.flightInfo(bot, origin, shot, target, end.PEARL, { radius: 0.8, size: 0.15 }).hit) continue;
        const thrown = await end.throwPearl(bot, ctx, target);
        if (!thrown.ok) return thrown;
        memory.pearls += 1;
        const landed = await waitUntil(() => bot.entity.position.distanceTo(here) > 8, { timeoutMs: 5000, signal: ctx.signal });
        ctx.record('pearl_hop', { to: at(stand), from: at(here), landed });
        if (landed) await waitUntil(() => bot.entity.onGround, { timeoutMs: 3000, signal: ctx.signal });
        return landed ? { ok: true } : fail('pearl_hop_missed');
      }
    }
    return null;
  }

  const atEdge = () => {
    const feet = bot.entity.position.floored();
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => end.deepDrop(bot, feet.x + x, feet.y, feet.z + z));
  };

  async function explore(ctx) {
    const here = bot.entity.position.clone();
    // Back where the last search started (pulled back, or walking in circles): next waypoint.
    if (memory.searchFrom && here.distanceTo(memory.searchFrom) < 8) memory.blocked = true;
    else memory.stuck = 0;
    memory.searchFrom = here;
    const goal = waypoint(here);
    if (!goal) return fail('search_exhausted');
    const toGoal = Math.hypot(goal.x - here.x, goal.z - here.z);
    memory.heading = gapAwareHeading(here, new Vec3((goal.x - here.x) / toGoal, 0, (goal.z - here.z) / toGoal));
    const target = here.plus(memory.heading.scaled(Math.min(40, toGoal)));
    ctx.record('city_search', { to: at(target), waypoint: at(goal), left: memory.waypoints.length, explored: memory.explored });
    memory.explored += 1;
    // On a bridge or an island's lip the pathfinder walks off the edge: keep bridging.
    const feet = here.floored();
    // A wide gap ahead (or no blocks left to bridge it): pearl across.
    if (gapAlong(here, memory.heading) >= 10 || bridgeBlocks() < 16) {
      const hop = await pearlHop(ctx, memory.heading);
      if (hop) return hop;
    }
    if (atEdge()) {
      const bridged = await end.bridgeToward(bot, ctx, new Vec3(target.x, feet.y, target.z), { maxSteps: 40 });
      memory.bridged += bridged.steps || 0;
      if ((bridged.steps || 0) > 0) return { ok: true };
      memory.blocked = true;
      return fail(bridged.reason || 'explore_blocked');
    }
    const walked = await actions.goTo(bot, ctx, new end.goals.GoalNearXZ(target.x, target.z, 4), { timeoutMs: 20000, arrived: () => true });
    if (bot.entity.position.distanceTo(here) >= 12) return { ok: true };
    ctx.record('explore_walk_short', { moved: Math.round(bot.entity.position.distanceTo(here)), reason: walked.reason || null });
    // Walked to the island's edge, or the pathfinder is lost in its hills:
    // straight on, digging through and bridging over whatever is in the way.
    const bridged = await end.bridgeToward(bot, ctx, new Vec3(target.x, bot.entity.position.y, target.z), { maxSteps: 32, stopOnLand: false });
    memory.bridged += bridged.steps || 0;
    ctx.record('explore_bridge', { steps: bridged.steps || 0, reason: bridged.reason || bridged.stopped || null });
    if (bot.entity.position.distanceTo(here) >= 6) return { ok: true };
    memory.blocked = true;
    return fail(walked.ok ? 'explore_blocked' : walked.reason);
  }

  const bridgeBlocks = () => actions.countItems(bot, (n) => /^(cobblestone|end_stone|cobbled_deepslate|dirt|netherrack)$/.test(n));

  /**
   * Mines end stone at or above foot level near the bot (never the ground it
   * stands on or the cells beside it) until it carries `target` blocks.
   */
  async function gatherStone(ctx, target) {
    const id = bot.registry.blocksByName.end_stone?.id;
    const start = bridgeBlocks();
    let dug = 0;
    for (let i = 0; i < 48 && bridgeBlocks() < target; i += 1) {
      const feet = bot.entity.position.floored();
      const found = bot.findBlocks({ matching: id, maxDistance: 5, count: 64 })
        .filter((p) => p.y >= feet.y && actions.withinReach(bot, p, 4.2))
        .sort((a, b) => b.y - a.y);
      // No hill to cut into: take surface blocks two or more cells away, leaving the floor around the bot.
      const pick = found[0] || bot.findBlocks({ matching: id, maxDistance: 4, count: 64 })
        .find((p) => p.y === feet.y - 1 && Math.max(Math.abs(p.x - feet.x), Math.abs(p.z - feet.z)) >= 2
          && !end.deepDrop(bot, p.x, p.y, p.z, 3) && actions.withinReach(bot, p, 4.2));
      if (!pick) break;
      const r = await actions.digBlock(bot, ctx, bot.blockAt(pick), { timeoutMs: 6000 });
      if (!r.ok) break;
      dug += 1;
      if (dug % 6 === 0) await actions.collectDrops(bot, ctx, bot.entity.position, (n) => n === 'end_stone', { radius: 6, timeoutMs: 4000 });
    }
    await actions.collectDrops(bot, ctx, bot.entity.position, (n) => n === 'end_stone', { radius: 6, timeoutMs: 4000 });
    ctx.record('stone_gathered', { dug, blocks: bridgeBlocks(), before: start });
    return bridgeBlocks() > start ? { ok: true } : fail('no_stone_here');
  }

  const done = () => hasElytra() || memory.looted.size >= chests;

  return {
    name: 'end_city',
    noProgressLimit: 24,
    maxRecoveries: 3,
    memory,
    isDone: () => done(),
    progress: () => (memory.gatewayUsed ? 100 : 0) + memory.looted.size * 100 + (hasElytra() ? 500 : 0)
      + Math.floor(memory.explored / 2) + Math.floor(memory.bridged / 8),
    recover() { blacklist.clear(); memory.heading = null; memory.blocked = true; },
    async run(ctx) {
      if (!end.inEnd(bot)) return fail('not_in_end');
      enterMode();
      await end.wearArmor(bot);
      if (done()) return { ok: true };
      // A pearl that hit the gateway's bedrock leaves the bot up on it.
      if (!outer(bot) && end.stranded(bot)) {
        const down = await end.descendSpiral(bot, ctx);
        ctx.record('descent', { steps: down.steps ?? 0, reason: down.reason || null });
        return down;
      }
      if (!outer(bot)) {
        if (!end.exitPortalLit(bot) && !city.findGateway(bot, 160).length) return fail('dragon_alive');
        return useGateway(ctx);
      }
      const frame = city.elytraFrames(bot).find((f) => !blacklist.has(`frame:${f.id}`));
      if (frame) {
        memory.seenFrames += 1;
        return takeElytra(ctx, frame);
      }
      // A scan of the loaded chunks for purpur takes seconds: once per 32
      // blocks travelled or 20 s, and chests are looked for only near a city.
      const now = Date.now();
      const pos = bot.entity.position;
      if (!memory.scan || now - memory.scan.at > 20000 || pos.distanceTo(memory.scan.from) > 32) {
        memory.scan = { at: now, from: pos.clone(), purpur: city.findCity(bot, 256) };
      }
      const nearCity = memory.scan.purpur && pos.distanceTo(memory.scan.purpur) < 128;
      const chestsLeft = !nearCity ? [] : city.cityChests(bot, 96).filter((p) => !memory.looted.has(posKey(p)) && !blacklist.has(posKey(p)));
      if (chestsLeft.length) {
        const here = bot.entity.position.clone();
        chestsLeft.sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
        return lootChest(ctx, chestsLeft[0]);
      }
      const purpur = memory.scan.purpur;
      if (purpur && bot.entity.position.distanceTo(purpur) > 12 && !blacklist.has(`city:${posKey(purpur)}`)) {
        if (!memory.cityAt) ctx.record('city_seen', { at: at(purpur) });
        memory.cityAt = purpur;
        const before = bot.entity.position.clone();
        // Still on a bridge or a lip: the pathfinder walks off it. Bridge on.
        if (atEdge()) {
          const bridged = await end.bridgeToward(bot, ctx, new Vec3(purpur.x, before.y, purpur.z), { maxSteps: 48 });
          memory.bridged += bridged.steps || 0;
          if ((bridged.steps || 0) > 0) return { ok: true };
          blacklist.add(`city:${posKey(purpur)}`, 'unreachable', 120000);
          return fail(bridged.reason || 'city_blocked');
        }
        const moved = await actions.goNear(bot, ctx, purpur, 4, { timeoutMs: 90000 });
        if (moved.ok || bot.entity.position.distanceTo(before) > 8) return moved.ok ? moved : { ok: true };
        const bridged = await end.bridgeToward(bot, ctx, new Vec3(purpur.x, bot.entity.position.y, purpur.z), { maxSteps: 48 });
        memory.bridged += bridged.steps || 0;
        if ((bridged.steps || 0) === 0) blacklist.add(`city:${posKey(purpur)}`, 'unreachable', 120000);
        return bridged;
      }
      // Bridging eats blocks: top up from an island's end stone before
      // leaving it (out on a bridge there is nothing to mine).
      const under = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))?.name;
      if (bridgeBlocks() < 160 && under === 'end_stone' && !memory.stoneTriedAt?.equals?.(bot.entity.position.floored())) {
        memory.stoneTriedAt = bot.entity.position.floored();
        const got = await gatherStone(ctx, 256);
        if (got.ok) return got;
      }
      return explore(ctx);
    },
    dispose() { restore?.(); restore = null; },
  };
}

module.exports = { createEndCityGoal };
