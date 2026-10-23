'use strict';
// Goal: get into the End through a stronghold portal.
//
// Throw an eye of ender, walk the way it flew, throw again every ~100 blocks
// (two sightings from different places cross over the stronghold). Once the
// portal room's frames show up in the chunk data, dig down to them, put an
// eye in every empty frame and hop into the portal. Every run() decides from
// what is in sight now; the sightings are the only thing remembered.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultActions = require('../actions');
const stronghold = require('../stronghold');
const { dimension } = require('../nether');
const end = require('../end');

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const at = (p) => (p ? `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : null);

function createEnterEndGoal({ bot, actions = defaultActions, rethrowEvery = 96 } = {}) {
  const memory = { sightings: [], estimate: null, ring: null, thrown: 0, broken: 0, walked: 0, entered: false, closest: Infinity };
  const eyes = (state) => state.inventory.ender_eye || 0;
  const emptyFrames = () => (memory.ring ? memory.ring.frames.filter((f) => !stronghold.hasEye(bot.blockAt(f.position))).length : 12);

  function lookForRing(ctx) {
    const ring = stronghold.portalRing(bot, 128);
    if (ring?.complete && (!memory.ring || memory.ring.center.distanceTo(ring.center) > 2)) {
      memory.ring = ring;
      ctx.record('portal_room_found', { center: at(ring.center), filled: ring.frames.filter((f) => stronghold.hasEye(f)).length });
    }
    return memory.ring;
  }

  async function sight(ctx) {
    const result = await stronghold.throwEye(bot, ctx);
    if (!result.ok) return result;
    memory.thrown += 1;
    if (!result.recovered) memory.broken += 1;
    ctx.record('eye_thrown', { from: at(result.start), to: at(result.last), travel: Math.round(result.travel * 10) / 10,
      recovered: result.recovered });
    if (!result.heading) return fail('eye_did_not_move');
    const s = { start: result.start, heading: result.heading, travel: result.travel, at: bot.entity.position.clone() };
    // A short flight means the stronghold is right here.
    if (result.travel < 9) memory.estimate = new Vec3(result.last.x, 0, result.last.z);
    else {
      const crossings = memory.sightings.map((o) => stronghold.crossing(o, s)).filter(Boolean)
        .filter((c) => c.distanceTo(new Vec3(s.start.x, 0, s.start.z)) < 3000);
      if (crossings.length) memory.estimate = crossings.at(-1);
    }
    memory.sightings.push(s);
    if (memory.estimate) ctx.record('stronghold_estimate', { at: at(memory.estimate) });
    return { ok: true };
  }

  async function travel(ctx) {
    const last = memory.sightings.at(-1);
    const here = bot.entity.position;
    const sinceThrow = Math.hypot(here.x - last.at.x, here.z - last.at.z);
    // Two sightings from one line never cross: step aside before the second throw.
    if (memory.sightings.length === 1 && last.travel >= 9 && sinceThrow >= 40) return sight(ctx);
    if (sinceThrow >= rethrowEvery) return sight(ctx);
    let target;
    if (memory.estimate) {
      const d = Math.hypot(memory.estimate.x - here.x, memory.estimate.z - here.z);
      if (d < 12) return sight(ctx);
      const step = Math.min(32, d) / d;
      target = new Vec3(here.x + (memory.estimate.x - here.x) * step, here.y, here.z + (memory.estimate.z - here.z) * step);
    } else {
      // Off at an angle after the first throw, so the second line crosses the first.
      const h = memory.sightings.length === 1
        ? new Vec3(last.heading.x * 0.6 - last.heading.z * 0.8, 0, last.heading.z * 0.6 + last.heading.x * 0.8)
        : last.heading;
      target = new Vec3(here.x + h.x * 32, here.y, here.z + h.z * 32);
    }
    ctx.record('stronghold_walk', { to: at(target), estimate: at(memory.estimate) });
    const before = here.clone();
    const moved = await actions.goTo(bot, ctx, new goals.GoalNearXZ(target.x, target.z, 4), { timeoutMs: 60000, arrived: () => true });
    const gone = bot.entity.position.distanceTo(before);
    memory.walked += gone;
    return gone >= 6 ? { ok: true } : fail(moved.ok ? 'walk_blocked' : moved.reason);
  }

  async function reachRing(ctx) {
    const ring = memory.ring;
    // Lit already: hop in.
    if (stronghold.portalLit(bot, ring.center)) {
      ctx.record('portal_enter', { center: at(ring.center) });
      const result = await stronghold.enterPortal(bot, ctx, ring);
      if (result.ok) memory.entered = true;
      return result;
    }
    const empty = ring.frames.map((f) => bot.blockAt(f.position)).filter((b) => b && !stronghold.hasEye(b));
    if (empty.length > (bot.inventory.items().filter((i) => i.name === 'ender_eye').reduce((n, i) => n + i.count, 0))) {
      return fail('not_enough_eyes', { empty: empty.length });
    }
    const here = bot.entity.position;
    empty.sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here));
    const frame = empty[0];
    if (frame.position.distanceTo(here) > 12) {
      ctx.record('portal_room_approach', { frame: at(frame.position), distance: Math.round(frame.position.distanceTo(here)) });
    }
    // Far above the room: the pathfinder will not plan that deep; dig a staircase down.
    if (here.y - frame.position.y > 8) {
      const down = await actions.digStairsDown(bot, ctx, frame.position.offset(0, 1, 0), { maxSteps: 16 });
      ctx.record('stairs_down', { steps: down, y: Math.floor(bot.entity.position.y), roomY: frame.position.y });
      if (down > 0) return { ok: true };
      // No way down from here (open water, a lava pocket): start from dry land nearby.
      if (bot.entity.position.y > frame.position.y + 30 || bot.entity.isInWater) {
        const land = stronghold.landNear(bot, ring.center);
        ctx.record('stairs_start', { at: at(land) });
        if (land && land.distanceTo(bot.entity.position) > 3) return actions.goNear(bot, ctx, land, 1, { timeoutMs: 90000 });
      }
    }
    const result = await stronghold.fillFrame(bot, ctx, frame, ring.center);
    if (result.ok) {
      ctx.record('frame_filled', { frame: at(frame.position), left: empty.length - 1 });
      return result;
    }
    // Level with the room but no path: tunnel straight toward it.
    const flatDistance = Math.hypot(ring.center.x - here.x, ring.center.z - here.z);
    if (flatDistance > 6 && Math.abs(here.y - frame.position.y) <= 8) {
      let steps = 0;
      for (; steps < 16; steps += 1) {
        const step = await end.bridgeStep(bot, ctx, ring.center.offset(0.5, 0, 0.5), { avoidLiquids: true });
        if (!step.ok) break;
      }
      ctx.record('tunnel', { steps, at: at(bot.entity.position) });
      if (steps > 0) return { ok: true };
    }
    return result;
  }

  return {
    name: 'enter_end',
    noProgressLimit: 16,
    maxRecoveries: 2,
    memory,
    isDone: () => end.inEnd(bot),
    progress() {
      if (end.inEnd(bot)) return 100000;
      const here = bot.entity.position;
      let closeness = 0;
      if (memory.ring) {
        const d = here.distanceTo(memory.ring.center);
        memory.closest = Math.min(memory.closest, d);
        closeness = 2000 - Math.floor(memory.closest) + (12 - emptyFrames()) * 100;
      } else {
        closeness = memory.sightings.length * 10 + Math.floor(memory.walked / 8);
      }
      return closeness;
    },
    recover() { memory.estimate = null; memory.sightings = memory.sightings.slice(-1); },
    async run(ctx) {
      if (dimension(bot) !== 'overworld') return fail('not_in_overworld');
      if (lookForRing(ctx)) return reachRing(ctx);
      if (eyes(ctx.perceive()) < 1) return fail('no_eyes');
      if (memory.sightings.length === 0) return sight(ctx);
      return travel(ctx);
    },
  };
}

module.exports = { createEnterEndGoal };
