'use strict';
// Goal: a fenced pen holding `target` animals of one kind, bred from the
// ones led in. Each run() reads the pen and the animals from the world and
// does one thing: make or place fences, set the gate, lead an animal in, or
// breed two adults.

const { Vec3 } = require('vec3');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const defaultHusbandry = require('../husbandry');
const { planNext } = require('../planner');
const { KNOWLEDGE, countKey } = require('../knowledge');
const { createBlacklist, posKey } = require('../blacklist');
const { sleep } = require('../confirm');
const { createPlannerRunner, DOWN } = require('./common');

const BREED_COOLDOWN_MS = 5 * 60 * 1000 + 5000; // vanilla: 6000 ticks

function createRanchGoal({ bot, kind = 'cow', target = 3, size = 6, center = null,
  skills = defaultSkills, actions = defaultActions, husbandry = defaultHusbandry, kb = KNOWLEDGE, exclude = () => false, waitMs = 3000 } = {}) {
  const blacklist = createBlacklist({ ttlMs: 60000 });
  const herdTarget = typeof target === 'function' ? target : () => target;
  const memory = { kind, center, pen: null, table: null, steps: 0, bredAt: 0, born: 0 };
  const blockAt = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));
  const inPenArea = (p) => memory.pen && p.x >= memory.pen.corner.x - 1 && p.x <= memory.pen.corner.x + size
    && p.z >= memory.pen.corner.z - 2 && p.z <= memory.pen.corner.z + size;
  const { step, inventoryFor, tableHere } = createPlannerRunner({ bot, skills, kb, memory, blacklist,
    avoid: (p) => inPenArea(p) || exclude(p) });

  const penCount = () => (memory.pen ? husbandry.animalsIn(bot, memory.pen, kind).length : 0);
  // Hunting for food never takes the herd: animals in the pen, and the kind
  // being gathered while the pen is still short of it.
  bot.companionSpared = (e) => Boolean(memory.pen && e.position
    && (memory.pen.contains(e.position) || (e.name === kind && penCount() < herdTarget())));

  async function runOnce(ctx) {
    const state = ctx.perceive();
    if (!memory.pen) {
      const corner = husbandry.choosePenSite(blockAt, memory.center || bot.entity.position, { size, exclude });
      if (!corner) return skills.explore(bot, ctx, memory);
      memory.pen = husbandry.penLayout(corner, size);
      ctx.record('pen_chosen', { corner });
      return { ok: true };
    }
    const pen = memory.pen;
    // Away from the pen (or it is out of sight): go back before judging it,
    // or a missing gate is just an unloaded chunk.
    const centre = new Vec3(pen.corner.x + size / 2, pen.corner.y, pen.corner.z + size / 2);
    if (!blockAt(pen.gate) || bot.entity.position.distanceTo(centre) > 32) {
      ctx.record('ranch', { action: 'return', distance: Math.round(bot.entity.position.distanceTo(centre)) });
      return actions.goNear(bot, ctx, new Vec3(pen.outside.x + 0.5, pen.outside.y, pen.outside.z + 0.5), 3, { timeoutMs: 90000 });
    }
    const inventory = inventoryFor(state);
    const stations = { crafting_table: tableHere() };

    // The gate first, so the bot is never fenced in (it cannot dig through
    // fences), then the fence line.
    let gate = blockAt(pen.gate);
    if (!gate?.name.endsWith('_fence_gate')) {
      const need = planNext({ requirements: [{ key: 'fence_gate', count: 1 }], inventory, stations, kb });
      if (need) return step(ctx, need);
      ctx.record('ranch', { action: 'gate' });
      // Placed from just outside, so it spans the fence line (faces north-south).
      return skills.placeAt(bot, ctx, pen.gate, (n) => kb.fence_gate.match(n),
        { faces: DOWN, stand: { x: pen.gate.x, y: pen.gate.y, z: pen.gate.z - 1 } });
    }
    const missing = pen.fences.filter((p) => !kb.fence.match(blockAt(p)?.name || '') && !blacklist.has(posKey(p)));
    if (missing.length) {
      const need = planNext({ requirements: [{ key: 'fence', count: missing.length }], inventory, stations, kb });
      if (need && countKey('fence', inventory, kb) === 0) return step(ctx, need);
      ctx.record('ranch', { action: 'fence', position: posKey(missing[0]) });
      const placed = await skills.placeAt(bot, ctx, missing[0], (n) => kb.fence.match(n), { faces: DOWN });
      if (!placed.ok) blacklist.add(posKey(missing[0]), placed.reason, 15000);
      return placed;
    }
    gate = blockAt(pen.gate);
    const facing = gate.getProperties?.().facing;
    if (facing && facing !== 'north' && facing !== 'south') {
      ctx.record('ranch', { action: 'gate_turned', facing });
      // Turned across the opening it lets animals walk past: take it up and place it again.
      const reach = await actions.goToDig(bot, ctx, gate, { timeoutMs: 20000 });
      if (!reach.ok) return reach;
      const dug = await actions.digBlock(bot, ctx, gate);
      if (dug.ok) await actions.collectDrops(bot, ctx, gate.position.offset(0.5, 0.5, 0.5), (n) => kb.fence_gate.match(n), { radius: 4, timeoutMs: 3000 });
      return dug;
    }

    const inside = husbandry.animalsIn(bot, pen, kind);
    const adults = inside.filter((e) => !husbandry.isBaby(bot, e));
    if (!husbandry.FOOD[kind]?.some((n) => (state.inventory[n] || 0) > 0)) return { ok: false, reason: 'no_food' };
    if (adults.length >= 2 && Date.now() - memory.bredAt > BREED_COOLDOWN_MS) {
      ctx.record('ranch', { action: 'breed', adults: adults.length });
      const result = await husbandry.breed(bot, ctx, pen, kind);
      memory.bredAt = Date.now();
      if (result.born) memory.born += 1;
      return result;
    }
    // Leading an animal starts outside the pen.
    if (pen.contains(bot.entity.position) && !(adults.length >= 2 && Date.now() - memory.bredAt > BREED_COOLDOWN_MS)) {
      const left = await husbandry.leave(bot, ctx, pen);
      if (!left.ok) return left;
    }
    // More to lead in: the nearest one outside the pen.
    const outside = Object.values(bot.entities)
      .filter((e) => e.name === kind && e.position && !pen.contains(e.position) && !blacklist.has(`mob:${e.id}`)
        && !husbandry.isBaby(bot, e) && e.position.distanceTo(bot.entity.position) < 64)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (outside && adults.length < Math.max(2, herdTarget() - 1)) {
      ctx.record('ranch', { action: 'lure', id: outside.id, distance: Math.round(outside.position.distanceTo(bot.entity.position)) });
      const result = await husbandry.lure(bot, ctx, pen, outside);
      if (!result.ok) blacklist.add(`mob:${outside.id}`, result.reason, 60000);
      return result;
    }
    // Animals of this kind still in sight (only set aside after a failed
    // attempt): wait for them rather than wander off.
    const seen = Object.values(bot.entities).some((e) => e.name === kind && e.position && !pen.contains(e.position)
      && e.position.distanceTo(bot.entity.position) < 64);
    if (adults.length < 2 && !seen) return skills.explore(bot, ctx, memory);
    // Parents on cooldown: wait it out, out of the pen.
    if (pen.contains(bot.entity.position)) return husbandry.leave(bot, ctx, pen);
    await sleep(waitMs, ctx.signal);
    return { ok: true, waited: true };
  }

  return {
    name: 'ranch',
    noProgressLimit: 30,
    memory,
    isDone: () => penCount() >= herdTarget() && (!memory.pen || !memory.pen.contains(bot.entity.position)),
    progress: () => memory.steps,
    async run(ctx) {
      const result = await runOnce(ctx);
      if (result.ok && !result.waited) memory.steps += 1;
      return result;
    },
  };
}

module.exports = { createRanchGoal };
