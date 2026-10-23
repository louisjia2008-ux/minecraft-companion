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
      const here = bot.entity.position;
      const a = Math.atan2(here.z, here.x) + (memory.explored % 2 ? 0.6 : 0);
      memory.explored += 1;
      const stand = end.surfaceAt(bot, Math.round(Math.cos(a) * 70), Math.round(Math.sin(a) * 70));
      ctx.record('gateway_search', { to: at(stand) });
      if (!stand) return fail('no_gateway_in_sight');
      return end.walkTo(bot, ctx, stand, 3, 60000);
    }
    const here = bot.entity.position;
    gateways.sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here));
    const gateway = gateways[0];
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

  async function explore(ctx) {
    const here = bot.entity.position;
    if (!memory.heading || memory.blocked) {
      const base = city.outward(bot);
      const turn = memory.blocked ? (Math.random() - 0.5) * Math.PI : 0;
      memory.heading = new Vec3(base.x * Math.cos(turn) - base.z * Math.sin(turn), 0, base.x * Math.sin(turn) + base.z * Math.cos(turn));
      memory.blocked = false;
    }
    const target = here.plus(memory.heading.scaled(40));
    ctx.record('city_search', { to: at(target), explored: memory.explored });
    memory.explored += 1;
    const walked = await actions.goTo(bot, ctx, new end.goals.GoalNearXZ(target.x, target.z, 4), { timeoutMs: 45000, arrived: () => true });
    if (bot.entity.position.distanceTo(here) >= 12) return { ok: true };
    // Walked to the island's edge: bridge across.
    const bridged = await end.bridgeToward(bot, ctx, new Vec3(target.x, bot.entity.position.y, target.z), { maxSteps: 40 });
    memory.bridged += bridged.steps || 0;
    if (bot.entity.position.distanceTo(here) >= 6) return { ok: true };
    memory.blocked = true;
    return fail(walked.ok ? 'explore_blocked' : walked.reason);
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
    recover() { blacklist.clear(); memory.heading = null; },
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
      const chestsLeft = city.cityChests(bot, 96).filter((p) => !memory.looted.has(posKey(p)) && !blacklist.has(posKey(p)));
      if (chestsLeft.length) {
        const here = bot.entity.position;
        chestsLeft.sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
        return lootChest(ctx, chestsLeft[0]);
      }
      const purpur = city.findCity(bot, 160);
      if (purpur && bot.entity.position.distanceTo(purpur) > 12 && !blacklist.has(`city:${posKey(purpur)}`)) {
        if (!memory.cityAt) ctx.record('city_seen', { at: at(purpur) });
        memory.cityAt = purpur;
        const before = bot.entity.position.clone();
        const moved = await actions.goNear(bot, ctx, purpur, 4, { timeoutMs: 90000 });
        if (moved.ok || bot.entity.position.distanceTo(before) > 8) return moved.ok ? moved : { ok: true };
        const bridged = await end.bridgeToward(bot, ctx, new Vec3(purpur.x, bot.entity.position.y, purpur.z), { maxSteps: 48 });
        memory.bridged += bridged.steps || 0;
        if ((bridged.steps || 0) === 0) blacklist.add(`city:${posKey(purpur)}`, 'unreachable', 120000);
        return bridged;
      }
      return explore(ctx);
    },
    dispose() { restore?.(); restore = null; },
  };
}

module.exports = { createEndCityGoal };
