'use strict';
// Goal: kill the ender dragon.
//
// From the arrival platform the bot walks (bridging where needed) to the main
// island, shoots every end crystal it has a clear arrow at, and then shoots
// the dragon's head each time it perches on the exit portal. Done when the
// exit portal lights, which the server does only after the kill. Each run()
// decides from what is in sight now: crystals still standing, the dragon's
// synced phase and health.

const { Vec3 } = require('vec3');
const defaultActions = require('../actions');
const end = require('../end');
const { createBlacklist } = require('../blacklist');
const { sleep, waitUntil } = require('../confirm');

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const key = (e) => String(e.id);
const at = (p) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
// The exit portal sits on the column x = z = 0; the fight happens around it.
const CENTER = new Vec3(0, 64, 0);

function createEndDragonGoal({ bot, actions = defaultActions } = {}) {
  const crystalBlacklist = createBlacklist({ ttlMs: 240000 });
  const memory = {
    arrows: 0, crystalsSeen: new Set(), crystalsGone: 0, damage: 0, lastHealth: null,
    killed: false, spots: {}, shelter: null, opened: new Set(),
  };
  let restore = null;
  const enterMode = () => { if (!restore) restore = end.applyEndMovements(bot); };
  const leaveMode = () => { restore?.(); restore = null; };

  // Health is synced metadata: every drop is damage the server applied.
  const onMeta = (entity) => {
    if (entity?.name !== 'ender_dragon') return;
    const h = end.dragonHealth(bot, entity);
    if (h === null) return;
    if (memory.lastHealth !== null && h < memory.lastHealth) memory.damage += memory.lastHealth - h;
    memory.lastHealth = h;
    if (end.dragonPhase(bot, entity) === end.DYING || h <= 0) memory.killed = true;
  };
  const onGone = (entity) => {
    if (entity?.name === 'end_crystal' && memory.crystalsSeen.has(key(entity))
      && entity.position.distanceTo(bot.entity.position) < 96) memory.crystalsGone += 1;
  };
  bot.on('entityUpdate', onMeta);
  bot.on('entityGone', onGone);

  const done = () => memory.killed || end.exitPortalLit(bot);

  async function approach(ctx) {
    // From the platform (x = 100) in to about 20 blocks from the portal.
    const here = bot.entity.position;
    const flat = Math.hypot(here.x, here.z) || 1;
    const target = new Vec3(here.x / flat * 22, here.y, here.z / flat * 22);
    const stand = end.surfaceAt(bot, Math.round(target.x), Math.round(target.z));
    if (!bot.entity.onGround) await waitUntil(() => bot.entity.onGround, { timeoutMs: 5000, signal: ctx.signal });
    const feet = bot.entity.position.floored();
    const under = bot.blockAt(feet.offset(0, -1, 0))?.name || '';
    // The arrival platform floats off the island: bridge straight in first.
    const offIsland = under !== 'end_stone'
      || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => end.overVoid(bot, feet.x + x, feet.y, feet.z + z));
    ctx.record('end_approach', { from: `${Math.round(here.x)},${Math.round(here.y)},${Math.round(here.z)}`,
      stand: stand ? `${stand.x},${stand.y},${stand.z}` : null, bridge: offIsland });
    if (offIsland) {
      const bridged = await end.bridgeToward(bot, ctx, new Vec3(0, feet.y, 0), { maxSteps: 40 });
      ctx.record('end_bridge', { steps: bridged.steps ?? 0, stopped: bridged.stopped || bridged.reason || null });
      if (!bridged.ok || bridged.steps > 0) return bridged;
    }
    if (stand) return end.walkTo(bot, ctx, stand, 2, 90000);
    return actions.goNear(bot, ctx, target, 4, { timeoutMs: 90000 });
  }

  async function shootCrystal(ctx, crystal) {
    const target = crystal.position.offset(0, 1, 0);
    const k = key(crystal);
    let spots = memory.spots[k];
    if (!spots) {
      spots = end.firingSpots(bot, new Vec3(crystal.position.x, 0, crystal.position.z), target);
      memory.spots[k] = spots;
    }
    if (spots.length === 0) {
      ctx.record('crystal_no_spot', { crystal: `${Math.round(target.x)},${Math.round(target.y)},${Math.round(target.z)}` });
      crystalBlacklist.add(k, 'no_firing_spot');
      return fail('no_firing_spot');
    }
    const stand = spots[0];
    ctx.record('crystal_target', { crystal: `${Math.round(target.x)},${Math.round(target.y)},${Math.round(target.z)}`,
      stand: `${stand.x},${stand.y},${stand.z}`, options: spots.length });
    const moved = await end.walkTo(bot, ctx, stand, 1, 60000);
    if (!moved.ok && bot.entity.position.distanceTo(stand) > 4) {
      spots.shift();
      return moved;
    }
    for (let i = 0; i < 4; i += 1) {
      if (!bot.entities[crystal.id]) break;
      const shot = await end.shootArrow(bot, ctx, target, { high: Boolean(stand.high) });
      if (!shot.ok) return shot;
      memory.arrows += 1;
      await waitUntil(() => !bot.entities[crystal.id], { timeoutMs: 1800, signal: ctx.signal });
    }
    if (!bot.entities[crystal.id]) {
      ctx.record('crystal_destroyed', { crystal: k, arrows: memory.arrows });
      return { ok: true };
    }
    // Four misses from here: the aim is off from this spot; try the next one.
    spots.shift();
    return fail('crystal_missed');
  }

  /**
   * Sword on the perched dragon's head, from beside it (the breath goes out in
   * front). The head is its own part entity, so the hits do full damage.
   */
  async function meleePerched(ctx, dragon) {
    const eyeAt = () => bot.entity.position.offset(0, 1.62, 0);
    const head = () => end.headPosition(bot.entities[dragon.id] || dragon);
    const sitting = () => {
      const d = bot.entities[dragon.id];
      return d && end.PERCHED.has(end.dragonPhase(bot, d)) && end.dragonPhase(bot, d) !== 3;
    };
    // Beside the neck, behind the head: the breath cloud lands 2.5 blocks in
    // front of the head with a radius of 5, the wings reach out beside the body.
    const spot = () => {
      const d = bot.entities[dragon.id] || dragon;
      const h = end.headPosition(d);
      const forward = new Vec3(Math.sin(d.yaw), 0, Math.cos(d.yaw));
      const side = new Vec3(forward.z, 0, -forward.x);
      const sign = bot.entity.position.minus(h).dot(side) >= 0 ? 1 : -1;
      return h.minus(forward.scaled(2.5)).plus(side.scaled(2.5 * sign));
    };
    const there = () => {
      const p = spot();
      return Math.hypot(bot.entity.position.x - p.x, bot.entity.position.z - p.z) <= 1.2;
    };
    if (!there()) {
      const p = spot();
      await actions.goTo(bot, ctx, new end.goals.GoalNearXZ(p.x, p.z, 1), {
        timeoutMs: 12000, arrived: () => there() || !sitting(),
      });
    }
    ctx.record('dragon_melee_start', { dragon: at(dragon.position), yaw: Math.round(dragon.yaw * 100) / 100, head: at(head()),
      bot: at(bot.entity.position), reach: Math.round(eyeAt().distanceTo(head()) * 10) / 10 });
    await actions.equipBestWeapon(bot);
    const before = memory.damage;
    let swings = 0;
    for (let i = 0; i < 30 && sitting(); i += 1) {
      const d = bot.entities[dragon.id];
      const part = end.headPart(d);
      if (eyeAt().distanceTo(part.position) > 5.5 || !there()) {
        // It turned: back to the side of its neck.
        const p = spot();
        await actions.goTo(bot, ctx, new end.goals.GoalNearXZ(p.x, p.z, 1), { timeoutMs: 4000,
          arrived: () => there() || !sitting() });
        if (eyeAt().distanceTo(end.headPosition(bot.entities[dragon.id] || dragon)) > 5.5) continue;
      }
      await bot.lookAt(part.position, true);
      bot.attack(part);
      swings += 1;
      await sleep(650, ctx.signal);
    }
    ctx.record('dragon_melee', { swings, damage: Math.round(memory.damage - before), health: end.dragonHealth(bot) });
    return swings > 0 ? { ok: true } : fail('melee_out_of_reach');
  }

  /**
   * Opens a caged crystal's iron bars on one side: tower up beside the
   * pillar, break the bars facing the bot, dig the tower back down. The
   * arrows then go in through the gap. A caged crystal keeps healing the dragon.
   */
  async function uncage(ctx, crystal) {
    const c = crystal.position.floored();
    const here = bot.entity.position;
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => ({ x, z,
      stand: end.surfaceAt(bot, c.x + x * 3, c.z + z * 3, { yMax: c.y - 4 }) }))
      .filter((s) => s.stand && bot.blockAt(s.stand.offset(0, -1, 0))?.name === 'end_stone')
      // The side facing the island's middle: the firing spots are out there.
      .sort((a, b) => Math.hypot(a.stand.x, a.stand.z) - Math.hypot(b.stand.x, b.stand.z) + (a.stand.distanceTo(here) - b.stand.distanceTo(here)) * 0.1);
    if (sides.length === 0) {
      crystalBlacklist.add(`cage:${key(crystal)}`, 'no_side');
      return fail('cage_no_side');
    }
    const side = sides[0];
    const column = new Vec3(c.x + side.x * 3, 0, c.z + side.z * 3);
    const onColumn = () => bot.entity.position.floored().x === column.x && bot.entity.position.floored().z === column.z;
    if (!onColumn()) {
      const moved = await end.walkTo(bot, ctx, side.stand, 0, 30000);
      if (!onColumn()) {
        crystalBlacklist.add(`cage:${key(crystal)}`, moved.reason || 'not_at_column');
        return moved.ok ? fail('not_at_column') : moved;
      }
    }
    ctx.record('cage_climb', { crystal: at(c), from: at(bot.entity.position) });
    const placed = await end.pillarUp(bot, ctx, c.y, { maxSteps: c.y - side.stand.y + 2 });
    const feet = bot.entity.position.floored();
    if (feet.y < c.y) {
      ctx.record('cage_climb_short', { placed, y: feet.y, need: c.y });
      await end.digPillarDown(bot, ctx);
      return fail('cage_climb_short');
    }
    // The wall two cells out from the crystal, three bars wide, from the bedrock up.
    let broken = 0;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let s = -1; s <= 1; s += 1) {
        const p = new Vec3(c.x + side.x * 2 + side.z * s, c.y + dy, c.z + side.z * 2 + side.x * s);
        const b = bot.blockAt(p);
        if (b?.name !== 'iron_bars') continue;
        const dug = await actions.digBlock(bot, ctx, b, { timeoutMs: 8000 });
        if (dug.ok) broken += 1;
      }
    }
    memory.opened.add(key(crystal));
    delete memory.spots[key(crystal)];
    ctx.record('cage_opened', { crystal: at(c), broken });
    const down = await end.digPillarDown(bot, ctx);
    ctx.record('cage_descent', { steps: down, y: Math.floor(bot.entity.position.y) });
    return { ok: true };
  }

  const inShelter = () => memory.shelter && bot.entity.position.y < memory.shelter.y - 1
    && Math.hypot(bot.entity.position.x - memory.shelter.x - 0.5, bot.entity.position.z - memory.shelter.z - 0.5) < 0.8;

  /** Waits for a perch in a pit near the portal, out of reach of the dragon's wings. */
  async function watch(ctx) {
    if (inShelter()) {
      // Recovery and survival leave a sheltered bot where it is.
      bot.companionSheltered = true;
      await sleep(500, ctx.signal);
      return { ok: true, waited: true };
    }
    const here = bot.entity.position;
    const a = Math.atan2(here.z, here.x);
    for (const r of [9, 11, 13, 8, 15]) {
      const stand = end.surfaceAt(bot, Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r));
      if (!stand || bot.blockAt(stand.offset(0, -1, 0))?.name !== 'end_stone') continue;
      const moved = await end.walkTo(bot, ctx, stand, 0, 20000);
      if (!moved.ok && bot.entity.position.floored().distanceTo(stand) > 0.5) continue;
      const dug = await end.digShelter(bot, ctx);
      ctx.record('shelter', { at: at(stand), ok: dug.ok, reason: dug.reason || null });
      if (dug.ok) { memory.shelter = dug.top; bot.companionSheltered = true; return { ok: true }; }
    }
    await sleep(1000, ctx.signal);
    return { ok: true, waited: true };
  }

  async function leave(ctx) {
    bot.companionSheltered = false;
    const out = await end.leaveShelter(bot, ctx, memory.shelter);
    ctx.record('shelter_left', { ok: out.ok, reason: out.reason || null });
    if (out.ok) memory.shelter = null;
    return out;
  }

  return {
    name: 'end_dragon',
    noProgressLimit: 30,
    maxRecoveries: 2,
    memory,
    isDone: () => done(),
    progress: () => memory.crystalsGone * 40 + Math.floor(memory.damage) + (done() ? 1000 : 0),
    recover() { crystalBlacklist.clear(); memory.spots = {}; },
    async run(ctx) {
      if (!end.inEnd(bot)) return fail('not_in_end');
      enterMode();
      bot.companionSheltered = Boolean(inShelter());
      const worn = await end.wearArmor(bot);
      if (worn.length) ctx.record('equip', { items: worn });
      if (done()) return { ok: true };
      // Flung onto a pillar top by the dragon: spiral down its side first.
      if (end.stranded(bot)) {
        const down = await end.descendSpiral(bot, ctx);
        ctx.record('pillar_descent', { steps: down.steps ?? 0, reason: down.reason || null, y: Math.floor(bot.entity.position.y) });
        return down;
      }
      const here = bot.entity.position;
      if (Math.hypot(here.x, here.z) > 60) return approach(ctx);
      const dragon = end.dragonOf(bot);
      const phase = end.dragonPhase(bot, dragon);
      if (dragon && end.PERCHED.has(phase) && Math.hypot(dragon.position.x, dragon.position.z) < 20) {
        if (inShelter()) return leave(ctx);
        // Arrows only burn on a sitting dragon: close in with the sword.
        if (phase !== 3) return meleePerched(ctx, dragon);
        // Still landing: be at the portal when it sits.
        await end.walkTo(bot, ctx, end.surfaceAt(bot, 0, 9) || CENTER, 2, 6000);
        return { ok: true, waited: true };
      }
      const crystals = end.crystalsOf(bot);
      for (const c of crystals) memory.crystalsSeen.add(key(c));
      const nearest = (a, b) => a.position.distanceTo(here) - b.position.distanceTo(here);
      const open = crystals.filter((c) => !crystalBlacklist.has(key(c)) && (memory.opened.has(key(c)) || !end.caged(bot, c)))
        .sort(nearest);
      if (open.length) {
        if (inShelter()) return leave(ctx);
        return shootCrystal(ctx, open[0]);
      }
      const cagedLeft = crystals.filter((c) => !memory.opened.has(key(c)) && !crystalBlacklist.has(`cage:${key(c)}`)).sort(nearest);
      if (cagedLeft.length) {
        if (inShelter()) return leave(ctx);
        return uncage(ctx, cagedLeft[0]);
      }
      if (!memory.reportedAt || Date.now() - memory.reportedAt > 30000) {
        memory.reportedAt = Date.now();
        ctx.record('fight_state', { crystals: crystals.length, caged: crystals.filter((c) => end.caged(bot, c)).length,
          dragon: dragon ? { phase, health: end.dragonHealth(bot, dragon), at: `${Math.round(dragon.position.x)},${Math.round(dragon.position.y)},${Math.round(dragon.position.z)}` } : null });
      }
      return watch(ctx);
    },
    dispose() {
      leaveMode();
      bot.companionSheltered = false;
      bot.removeListener('entityUpdate', onMeta);
      bot.removeListener('entityGone', onGone);
    },
  };
}

module.exports = { createEndDragonGoal };
