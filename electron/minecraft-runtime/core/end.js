'use strict';
// The End: projectile aiming, void-safe movement, end crystals and the dragon.
//
// Everything the fight decides on is something the client sees: crystal
// entities, the dragon's synced phase and health, and the exit portal's
// end_portal blocks, which only appear once the server has counted the kill.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const actions = require('./actions');
const { waitUntil, sleep } = require('./confirm');
const { dimension } = require('./nether');

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const inEnd = (bot) => dimension(bot) === 'the_end';

// ---- projectiles -----------------------------------------------------------

// Vanilla 1.21 per tick: move by the velocity, then drag, then gravity.
// Arrows leave a fully drawn bow at 3 blocks/tick; pearls and eyes are thrown at 1.5.
const ARROW = { speed: 3.0, gravity: 0.05, drag: 0.99, maxTicks: 120 };
const PEARL = { speed: 1.5, gravity: 0.03, drag: 0.99, maxTicks: 160 };

/** Mineflayer's look convention: yaw 0 faces -z, pitch > 0 looks up. */
function direction(yaw, pitch) {
  return new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
}

/**
 * Flies a projectile from `origin`. Calls `visit(position, tick)` every tick;
 * a truthy return stops the flight. Returns the last position.
 */
function fly(origin, yaw, pitch, kind, visit) {
  let p = origin.clone();
  let v = direction(yaw, pitch).scaled(kind.speed);
  for (let tick = 1; tick <= kind.maxTicks; tick += 1) {
    const next = p.plus(v);
    if (visit(next, tick, p)) return next;
    p = next;
    v = v.scaled(kind.drag);
    v.y -= kind.gravity;
  }
  return p;
}

/** Height the projectile has at horizontal distance `d` (or null if it never gets there). */
function heightAt(origin, pitch, d, kind) {
  let y = null;
  let ticks = null;
  fly(new Vec3(0, origin.y, 0), Math.PI, pitch, kind, (p, tick, prev) => {
    if (p.z < d) return p.y < origin.y - 200;
    const f = (d - prev.z) / Math.max(1e-6, p.z - prev.z);
    y = prev.y + (p.y - prev.y) * f;
    ticks = tick;
    return true;
  });
  return y === null ? null : { y, ticks };
}

/**
 * Yaw and pitch that bring a projectile from `origin` to `target`. The flat
 * (low) arc by default; `high` picks the lob. Null if out of range.
 */
function aim(origin, target, kind = ARROW, { high = false } = {}) {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const d = Math.hypot(dx, dz);
  const yaw = Math.atan2(-dx, -dz);
  const err = (pitch) => {
    const h = heightAt(origin, pitch, d, kind);
    return h ? { e: h.y - target.y, ticks: h.ticks } : null;
  };
  // Coarse scan, then bisect the first bracket (low arc) or the last one (lob).
  const steps = [];
  for (let deg = -85; deg <= 85; deg += 2.5) steps.push(deg * Math.PI / 180);
  let brackets = [];
  let prev = null;
  for (const pitch of steps) {
    const r = err(pitch);
    if (prev && prev.r && r && Math.sign(prev.r.e) !== Math.sign(r.e)) brackets.push([prev.pitch, pitch, prev.r.e]);
    prev = { pitch, r };
  }
  if (brackets.length === 0) return null;
  brackets = high ? brackets.slice(-1) : brackets.slice(0, 1);
  let [lo, hi, eLo] = brackets[0];
  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2;
    const r = err(mid);
    if (!r) { hi = mid; continue; }
    if (Math.sign(r.e) === Math.sign(eLo)) { lo = mid; eLo = r.e; } else hi = mid;
  }
  const pitch = (lo + hi) / 2;
  return { yaw, pitch, ticks: err(pitch)?.ticks ?? null, distance: d };
}

const solid = (b) => b && b.boundingBox === 'block';

/**
 * Whether the flight from `origin` reaches within `radius` of `target`
 * without first passing through a solid block. `ignore(block)` lets the
 * target's own blocks (a gateway's bedrock caps) be skipped.
 */
function clearFlight(bot, origin, shot, target, kind, options = {}) {
  return flightInfo(bot, origin, shot, target, kind, options).hit;
}

/**
 * Like clearFlight, also giving the slope of the flight where it arrives
 * (dy per block flown). `size` is the projectile's half width: blocks that
 * close to the path count as hit too.
 */
function flightInfo(bot, origin, shot, target, kind, { radius = 0.8, ignore = () => false, size = 0 } = {}) {
  let hit = false;
  let blocked = false;
  let slope = null;
  const offsets = size > 0 ? [new Vec3(0, 0, 0), new Vec3(0, size, 0), new Vec3(0, -size, 0)] : [new Vec3(0, 0, 0)];
  fly(origin, shot.yaw, shot.pitch, kind, (p, tick, prev) => {
    for (let i = 1; i <= 6; i += 1) {
      const q = prev.plus(p.minus(prev).scaled(i / 6));
      if (q.distanceTo(target) <= radius) {
        hit = true;
        const d = p.minus(prev);
        slope = d.y / (Math.hypot(d.x, d.z) || 1e-6);
        return true;
      }
      for (const o of offsets) {
        const b = bot.blockAt(q.plus(o));
        if (solid(b) && !ignore(b)) { blocked = true; return true; }
      }
    }
    return tick > 2 && p.y < target.y - 8 && p.y < origin.y - 8;
  });
  return { hit: hit && !blocked, slope };
}

const eye = (bot) => bot.entity.position.offset(0, 1.62 - 0.1, 0);

/** Holds `name` in the main hand; false if the bot has none. */
async function hold(bot, name) {
  if (bot.heldItem?.name === name) return true;
  const item = bot.inventory.items().find((i) => i.name === name);
  if (!item) return false;
  try { await bot.equip(item, 'hand'); } catch { return false; }
  return bot.heldItem?.name === name;
}

/**
 * Draws the bow fully and looses one arrow at `target` (a point, or a
 * function returning the point to lead a moving target). Returns the shot.
 */
async function shootArrow(bot, ctx, target, { high = false, drawMs = 1150 } = {}) {
  if (!bot.inventory.items().some((i) => i.name === 'arrow' || i.name === 'spectral_arrow')) return fail('no_arrows');
  if (!(await hold(bot, 'bow'))) return fail('no_bow');
  actions.haltBody(bot);
  const point = () => (typeof target === 'function' ? target() : target);
  let shot = aim(eye(bot), point(), ARROW, { high });
  if (!shot) return fail('out_of_range');
  await bot.look(shot.yaw, shot.pitch, true);
  bot.activateItem();
  try {
    const until = Date.now() + drawMs;
    while (Date.now() < until) {
      await sleep(100, ctx.signal);
      const again = aim(eye(bot), point(), ARROW, { high });
      if (again) { shot = again; await bot.look(shot.yaw, shot.pitch, true); }
    }
  } finally {
    bot.deactivateItem();
  }
  return { ok: true, shot };
}

/** Throws one ender pearl so that it flies into `target`. */
async function throwPearl(bot, ctx, target, { high = false } = {}) {
  const shot = aim(eye(bot), target, PEARL, { high });
  if (!shot) return fail('out_of_range');
  if (!(await hold(bot, 'ender_pearl'))) return fail('no_pearl');
  actions.haltBody(bot);
  await bot.look(shot.yaw, shot.pitch, true);
  await sleep(150, ctx.signal);
  bot.activateItem();
  await sleep(250, ctx.signal);
  return { ok: true, shot };
}

// ---- void-safe movement ----------------------------------------------------

/** Nothing below `p` all the way down: one step over the edge is death. */
function overVoid(bot, x, y, z) {
  for (let yy = Math.floor(y) - 1; yy >= Math.max(-1, Math.floor(y) - 64); yy -= 1) {
    const b = bot.blockAt(new Vec3(x, yy, z));
    if (!b) return false; // unloaded: unknown, not void
    if (b.boundingBox === 'block') return false;
  }
  return true;
}

/** No solid block within `depth` below `p`: a step there is a fall the bot may not survive. */
function deepDrop(bot, x, y, z, depth = 4) {
  for (let yy = Math.floor(y) - 1; yy >= Math.floor(y) - depth; yy -= 1) {
    const b = bot.blockAt(new Vec3(x, yy, z));
    if (!b || b.boundingBox === 'block') return false;
  }
  return true;
}

/**
 * End movement: no pathfinder bridging or towers (gaps over the void are
 * crossed with bridgeToward, one confirmed block at a time), every cell beside
 * a void column costs extra, no sprinting, and drops stay short.
 */
function applyEndMovements(bot) {
  const m = bot.pathfinder?.movements;
  if (!m || m.companionEnd) return () => {};
  const saved = {
    maxDropDown: m.maxDropDown, towers: m.allow1by1towers, scaffold: m.scafoldingBlocks, placeCost: m.placeCost,
    steps: m.exclusionAreasStep.length, cantBreak: new Set(m.blocksCantBreak), sprint: m.allowSprinting,
    parkour: m.allowParkour,
  };
  m.companionEnd = true;
  m.maxDropDown = 3;
  // No 1x1 towers: one dragon hit or slip up there is a fall to death.
  m.allow1by1towers = false;
  // A sprint carries the body past a ledge it meant to stop at.
  m.allowSprinting = false;
  // A parkour jump that comes up short over the void is the end of the bot.
  m.allowParkour = false;
  m.placeCost = 3;
  // No pathfinder bridging either: when its placement is not confirmed it
  // still walks on, into the void. Gaps are crossed with bridgeToward.
  m.scafoldingBlocks = [];
  for (const name of ['end_portal_frame', 'end_gateway', 'end_portal', 'obsidian', 'chest', 'ender_chest', 'brewing_stand']) {
    const id = bot.registry.blocksByName[name]?.id;
    if (Number.isInteger(id)) m.blocksCantBreak.add(id);
  }
  const cache = new Map();
  let cacheAt = 0;
  const voidAt = (x, y, z) => {
    // Islands do not move: a long-lived cache keeps the pathfinder fast.
    if (Date.now() - cacheAt > 30000 || cache.size > 200000) { cache.clear(); cacheAt = Date.now(); }
    const key = `${x},${Math.floor(y / 8)},${z}`;
    if (!cache.has(key)) cache.set(key, overVoid(bot, x, y, z));
    return cache.get(key);
  };
  m.exclusionAreasStep.push((block) => {
    const p = block?.position;
    if (!p) return 0;
    let cost = 0;
    if (voidAt(p.x, p.y, p.z)) cost += 6;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (voidAt(p.x + dx, p.y, p.z + dz)) cost += 3;
    return cost;
  });
  return () => {
    m.maxDropDown = saved.maxDropDown;
    m.allow1by1towers = saved.towers;
    m.scafoldingBlocks = saved.scaffold;
    m.placeCost = saved.placeCost;
    m.allowSprinting = saved.sprint;
    m.allowParkour = saved.parkour;
    m.exclusionAreasStep.length = saved.steps;
    m.blocksCantBreak = saved.cantBreak;
    m.companionEnd = false;
  };
}

// ---- bridging --------------------------------------------------------------

const BRIDGE = /^(cobblestone|end_stone|cobbled_deepslate|dirt|netherrack)$/;
const UNBREAKABLE = /^(bedrock|obsidian|end_portal_frame|end_gateway|end_portal|crying_obsidian)$/;

/**
 * One block of a straight bridge toward `target` at the bot's own level: dig
 * a wall in the way, lay a block over a gap, step forward. The step is taken
 * in short pulses that stop on the new block's centre. Returns { ok, moved }.
 */
const LIQUID = /^(water|lava)$/;
const touchesLiquid = (bot, p) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  .some(([x, y, z]) => LIQUID.test(bot.blockAt(p.offset(x, y, z))?.name || ''));

async function bridgeStep(bot, ctx, target, { avoidLiquids = false } = {}) {
  const started = Date.now();
  // Never lay a block from mid-air: the walk before may still be settling.
  if (!bot.entity.onGround && !(await waitUntil(() => bot.entity.onGround, { timeoutMs: 1500, signal: ctx.signal }))) {
    return fail('bridge_not_grounded');
  }
  const feet = bot.entity.position.floored();
  const dx = target.x - (feet.x + 0.5);
  const dz = target.z - (feet.z + 0.5);
  const dir = Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx) || 1, 0, 0) : new Vec3(0, 0, Math.sign(dz) || 1);
  const ahead = feet.plus(dir);
  // Underground, opening a cell beside water or lava floods the tunnel.
  if (avoidLiquids && (touchesLiquid(bot, ahead) || touchesLiquid(bot, ahead.offset(0, 1, 0)))) return fail('liquid_ahead');
  for (const cell of [ahead.offset(0, 1, 0), ahead]) {
    const b = bot.blockAt(cell);
    if (!b || b.boundingBox === 'empty') continue;
    if (UNBREAKABLE.test(b.name) || !bot.canDigBlock(b)) return fail('bridge_wall', { block: b.name });
    const dug = await actions.digBlock(bot, ctx, b);
    if (!dug.ok) return dug;
  }
  const floor = bot.blockAt(ahead.offset(0, -1, 0));
  if (!floor || floor.boundingBox !== 'block') {
    const item = bot.inventory.items().find((i) => BRIDGE.test(i.name));
    if (!item) return fail('no_bridge_blocks');
    const under = bot.blockAt(feet.offset(0, -1, 0));
    if (!under || under.boundingBox !== 'block') return fail('no_bridge_support');
    try {
      await bot.equip(item, 'hand');
      await bot.placeBlock(under, dir);
    } catch (error) {
      if (error?.code === 'aborted') throw error;
    }
    const placed = await waitUntil(() => bot.blockAt(ahead.offset(0, -1, 0))?.boundingBox === 'block', { timeoutMs: 1500, signal: ctx.signal });
    if (!placed) return fail('bridge_place_failed');
  }
  // Step onto it sneaking, stopping on its centre: the physics never lets a
  // sneaking body walk off an edge, whatever the timing.
  const centre = ahead.offset(0.5, 0, 0.5);
  try {
    bot.setControlState('sprint', false);
    bot.companionSneaking = true;
    bot.setControlState('sneak', true);
    for (let i = 0; i < 60; i += 1) {
      const p = bot.entity.position;
      if (Math.hypot(p.x - centre.x, p.z - centre.z) < 0.3) break;
      await bot.lookAt(centre.offset(0, 1.6, 0), true);
      bot.setControlState('forward', true);
      await sleep(50, ctx.signal);
    }
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('sneak', false);
    bot.companionSneaking = false;
  }
  const now = bot.entity.position.floored();
  ctx.record('bridge_step', { to: `${ahead.x},${ahead.y},${ahead.z}`, ms: Date.now() - started, at: `${now.x},${now.y},${now.z}` });
  return now.x === ahead.x && now.z === ahead.z ? { ok: true, moved: 1 } : fail('bridge_step_failed');
}

/**
 * Bridges straight toward `target` until standing over solid ground that is
 * not just the bridge (or `maxBlocks` steps). Then the pathfinder takes over.
 */
async function bridgeToward(bot, ctx, target, { maxSteps = 48, stopOnLand = true } = {}) {
  let steps = 0;
  for (; steps < maxSteps; steps += 1) {
    const feet = bot.entity.position.floored();
    if (Math.hypot(target.x - feet.x, target.z - feet.z) < 2) break;
    const step = await bridgeStep(bot, ctx, target);
    if (!step.ok) return steps > 0 ? { ok: true, steps, stopped: step.reason } : step;
    // Natural ground on both sides: off the bridge.
    const f = bot.entity.position.floored();
    const landed = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .filter(([x, z]) => /end_stone/.test(bot.blockAt(f.offset(x, -1, z))?.name || '') && !overVoid(bot, f.x + x, f.y, f.z + z)).length >= 3;
    if (landed && stopOnLand) { steps += 1; break; }
  }
  return { ok: true, steps };
}

/**
 * Gets down from a height with no way down (a pillar top the dragon flung the
 * bot onto): a spiral of single blocks placed against the pillar's side, one
 * level lower each step, until a drop of three or less is left.
 */
async function descendSpiral(bot, ctx, { maxSteps = 48, safeDrop = 3 } = {}) {
  const empty = (p) => { const b = bot.blockAt(p); return b && b.boundingBox === 'empty' && !LIQUID.test(b.name); };
  const solidAt = (p) => bot.blockAt(p)?.boundingBox === 'block';
  const dropBelow = (p) => {
    for (let d = 1; d <= 64; d += 1) { const b = bot.blockAt(p.offset(0, -d, 0)); if (!b) return 64; if (b.boundingBox === 'block') return d - 1; }
    return 64;
  };
  const HORIZONTAL = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
  let last = null;
  let steps = 0;
  for (; steps < maxSteps; steps += 1) {
    const feet = bot.entity.position.floored();
    // Low enough: an ordinary drop is safe from here.
    const open = HORIZONTAL.find((d) => empty(feet.plus(d)) && empty(feet.plus(d).offset(0, 1, 0)) && dropBelow(feet.plus(d)) <= safeDrop);
    if (open) break;
    const choices = HORIZONTAL.filter((d) => !(last && d.x === -last.x && d.z === -last.z)).map((d) => {
      const into = feet.plus(d);
      const support = into.offset(0, -2, 0);
      if (!empty(into) || !empty(into.offset(0, 1, 0)) || !empty(into.offset(0, -1, 0))) return null;
      if (solidAt(support)) return { d, support, ref: null };
      const ref = HORIZONTAL.map((f) => support.plus(f)).find((q) => solidAt(q));
      return ref ? { d, support, ref } : null;
    }).filter(Boolean);
    if (choices.length === 0) return steps > 0 ? { ok: true, steps } : fail('no_way_down');
    // Keep hugging the pillar: prefer the support with the most solid neighbours.
    const score = (c) => HORIZONTAL.filter((f) => solidAt(c.support.plus(f))).length + (last && c.d.equals(last) ? -0.5 : 0);
    choices.sort((a, b) => score(b) - score(a));
    const { d, support, ref } = choices[0];
    if (ref) {
      const item = bot.inventory.items().find((i) => BRIDGE.test(i.name));
      if (!item) return fail('no_bridge_blocks');
      try {
        await bot.equip(item, 'hand');
        await bot.placeBlock(bot.blockAt(ref), support.minus(ref));
      } catch (error) {
        if (error?.code === 'aborted') throw error;
      }
      const placed = await waitUntil(() => solidAt(support), { timeoutMs: 1500, signal: ctx.signal });
      if (!placed) return steps > 0 ? { ok: true, steps } : fail('spiral_place_failed');
    }
    const target = feet.plus(d).offset(0.5, -1, 0.5);
    try {
      for (let i = 0; i < 30; i += 1) {
        const p = bot.entity.position;
        if (Math.hypot(p.x - target.x, p.z - target.z) < 0.3 && p.y < feet.y - 0.5) break;
        await bot.lookAt(target.offset(0, 1.6, 0), true);
        bot.setControlState('forward', true);
        await sleep(60, ctx.signal);
        bot.setControlState('forward', false);
        await sleep(40, ctx.signal);
      }
    } finally {
      bot.setControlState('forward', false);
    }
    await waitUntil(() => bot.entity.onGround, { timeoutMs: 1500, signal: ctx.signal });
    if (bot.entity.position.y > feet.y - 0.5) return steps > 0 ? { ok: true, steps } : fail('spiral_step_failed');
    last = d;
  }
  return { ok: true, steps };
}

/**
 * A three-deep pit in the end stone, roofed over, where the bot waits out
 * the dragon's passes: its wings throw anything in the open off the island
 * (or onto a pillar) but cannot push a body out of a hole with walls on all
 * sides, it cannot break end stone, and the roof keeps the breath clouds of
 * its fireballs (which burst on whatever they hit) above the bot's head.
 */
async function digShelter(bot, ctx) {
  const feet = bot.entity.position.floored();
  const isStone = (p) => bot.blockAt(p)?.name === 'end_stone';
  for (const depth of [1, 2, 3]) {
    const below = feet.offset(0, -depth, 0);
    if (!isStone(below) || !isStone(below.offset(0, -1, 0))) return fail('no_shelter_ground');
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (bot.blockAt(below.offset(x, 0, z))?.boundingBox !== 'block') return fail('shelter_wall_open');
  }
  for (const depth of [1, 2, 3]) {
    const below = feet.offset(0, -depth, 0);
    const dug = await actions.digBlock(bot, ctx, bot.blockAt(below));
    if (!dug.ok) return dug;
    await waitUntil(() => bot.entity.onGround && bot.entity.position.y < below.y + 0.5, { timeoutMs: 2000, signal: ctx.signal });
  }
  if (bot.entity.position.y > feet.y - 2.5) return fail('shelter_not_entered');
  // The roof goes in the top cell of the pit, against the ground beside it.
  const roof = feet.offset(0, -1, 0);
  const item = bot.inventory.items().find((i) => BRIDGE.test(i.name));
  if (item) {
    try {
      await bot.equip(item, 'hand');
      await bot.placeBlock(bot.blockAt(roof.offset(1, 0, 0)), new Vec3(-1, 0, 0));
    } catch (error) {
      if (error?.code === 'aborted') throw error;
    }
  }
  return { ok: true, top: feet, roofed: bot.blockAt(roof)?.boundingBox === 'block' };
}

/** Climbs out of the shelter: breaks the roof, then places blocks under itself (jump, place, land). */
async function leaveShelter(bot, ctx, top) {
  const roof = bot.blockAt(top.offset(0, -1, 0));
  if (roof && roof.boundingBox === 'block') {
    const dug = await actions.digBlock(bot, ctx, roof);
    if (!dug.ok) return dug;
  }
  await pillarUp(bot, ctx, top.y, { maxSteps: 5 });
  return bot.entity.position.y >= top.y - 0.5 ? { ok: true } : fail('still_in_shelter');
}

/** Jumps and places a block underfoot until the feet are at `y`. Returns the blocks placed. */
async function pillarUp(bot, ctx, y, { maxSteps = 32, stop = () => false, dig = false } = {}) {
  let placed = 0;
  let misses = 0;
  for (let i = 0; i < maxSteps && bot.entity.position.y < y - 0.5 && misses < 3 && !stop(); i += 1) {
    const item = bot.inventory.items().find((it) => BRIDGE.test(it.name));
    if (!item) break;
    const feet = bot.entity.position.floored();
    const below = bot.blockAt(feet.offset(0, -1, 0));
    if (!below || below.boundingBox !== 'block') break;
    // With `dig`, floors and ceilings overhead are cut through on the way.
    const head = bot.blockAt(feet.offset(0, 2, 0));
    if (head && head.boundingBox === 'block') {
      if (!dig || UNBREAKABLE.test(head.name) || /chest|shulker_box/.test(head.name)) break;
      const cut = await actions.digBlock(bot, ctx, head, { timeoutMs: 8000 });
      if (!cut.ok) break;
    }
    try {
      await bot.equip(item, 'hand');
      await bot.look(bot.entity.yaw, -Math.PI / 2, true);
      bot.setControlState('jump', true);
      await waitUntil(() => bot.entity.position.y > feet.y + 1.05, { timeoutMs: 800, signal: ctx.signal });
      bot.setControlState('jump', false);
      await bot.placeBlock(below, new Vec3(0, 1, 0)).then(() => { placed += 1; }).catch(() => {});
    } catch (error) {
      if (error?.code === 'aborted') throw error;
    } finally {
      bot.setControlState('jump', false);
    }
    await waitUntil(() => bot.entity.onGround, { timeoutMs: 1500, signal: ctx.signal });
    misses = bot.entity.position.y < feet.y + 0.5 ? misses + 1 : 0;
  }
  return placed;
}

/** Digs its own pillar out from under itself, one block at a time, down to ground that is not `what`. */
async function digPillarDown(bot, ctx, { what = BRIDGE, maxSteps = 40 } = {}) {
  let steps = 0;
  for (; steps < maxSteps; steps += 1) {
    const feet = bot.entity.position.floored();
    const below = bot.blockAt(feet.offset(0, -1, 0));
    if (!below || !what.test(below.name) || below.name === 'end_stone') break;
    const dug = await actions.digBlock(bot, ctx, below, { timeoutMs: 8000 });
    if (!dug.ok) break;
    await waitUntil(() => bot.entity.onGround && bot.entity.position.y < feet.y - 0.5, { timeoutMs: 2000, signal: ctx.signal });
  }
  return steps;
}

/** Standing high above the island with no ordinary way down (a pillar top). */
function stranded(bot) {
  const feet = bot.entity.position.floored();
  const under = bot.blockAt(feet.offset(0, -1, 0))?.name || '';
  return inEnd(bot) && feet.y >= 72 && /obsidian|bedrock|iron_bars|cobble/.test(under);
}

// ---- armor -----------------------------------------------------------------

const ARMOR_RANK = ['leather', 'golden', 'chainmail', 'iron', 'diamond', 'netherite'];
const ARMOR_SLOTS = [['helmet', 'head', 5], ['chestplate', 'torso', 6], ['leggings', 'legs', 7], ['boots', 'feet', 8]];

/**
 * Wears the best armor carried. In the End the head gets a carved pumpkin:
 * endermen then ignore the bot's gaze, and the fight looks around a lot.
 */
async function wearArmor(bot, { pumpkin = inEnd(bot) } = {}) {
  const worn = [];
  for (const [kind, slot, index] of ARMOR_SLOTS) {
    const current = bot.inventory.slots[index]?.name || '';
    const score = (name) => (name === 'carved_pumpkin' ? (pumpkin ? 100 : -1)
      : name.endsWith(`_${kind}`) ? ARMOR_RANK.indexOf(name.split('_')[0]) : -1);
    const best = bot.inventory.items().filter((i) => score(i.name) >= 0 && (kind === 'helmet' || i.name !== 'carved_pumpkin'))
      .sort((a, b) => score(b.name) - score(a.name))[0];
    if (!best || score(best.name) <= score(current)) continue;
    try { await bot.equip(best, slot); worn.push(best.name); } catch { /* next run tries again */ }
  }
  return worn;
}

// ---- the fight -------------------------------------------------------------

const PHASE_INDEX = (bot) => bot.registry.entitiesByName.ender_dragon?.metadataKeys?.indexOf('phase') ?? -1;
const HEALTH_INDEX = (bot) => bot.registry.entitiesByName.ender_dragon?.metadataKeys?.indexOf('health') ?? -1;
// Landing, then the three sitting phases: the dragon is on the exit portal.
const PERCHED = new Set([3, 5, 6, 7]);
const DYING = 9;

function dragonOf(bot) {
  return Object.values(bot.entities).find((e) => e.name === 'ender_dragon' && e.isValid !== false) || null;
}
function dragonPhase(bot, dragon = dragonOf(bot)) {
  const i = PHASE_INDEX(bot);
  const value = dragon?.metadata?.[i];
  return Number.isInteger(value) ? value : null;
}
function dragonHealth(bot, dragon = dragonOf(bot)) {
  const i = HEALTH_INDEX(bot);
  const value = dragon?.metadata?.[i];
  return Number.isFinite(value) ? value : null;
}

function crystalsOf(bot) {
  return Object.values(bot.entities).filter((e) => e.name === 'end_crystal' && e.position && e.isValid !== false
    // The four the respawn ritual places on the exit portal are not on pillars.
    && Math.hypot(e.position.x, e.position.z) > 12);
}

/** A crystal inside an iron-bar cage: arrows cannot reach it. */
function caged(bot, crystal) {
  const c = crystal.position.floored();
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      for (let dy = -1; dy <= 3; dy += 1) if (bot.blockAt(c.offset(dx, dy, dz))?.name === 'iron_bars') return true;
    }
  }
  return false;
}

/** Lingering breath clouds (the dragon's breath and fireballs) over `p`, with `margin` to spare. */
function cloudOver(bot, p, margin = 1) {
  const index = bot.registry.entitiesByName.area_effect_cloud?.metadataKeys?.indexOf('radius') ?? -1;
  return Object.values(bot.entities).some((e) => e.name === 'area_effect_cloud' && e.position
    && Math.hypot(e.position.x - p.x - 0.5, e.position.z - p.z - 0.5) <= (Number(e.metadata?.[index]) || 3) + margin
    && Math.abs(e.position.y - p.y) <= 3);
}

/** Exit portal lit: the server has counted the dragon as killed. */
// Checked every brain tick: a direct look at the portal's few columns, cached.
let litCache = { at: 0, bot: null, value: false };
function exitPortalLit(bot) {
  if (!inEnd(bot)) return false;
  if (litCache.bot === bot && Date.now() - litCache.at < 2000) return litCache.value;
  let value = false;
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
    for (let y = 40; y <= 90 && !value; y += 1) {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (!b) break;
      if (b.name === 'end_portal') value = true;
    }
    if (value) break;
  }
  litCache = { at: Date.now(), bot, value };
  return value;
}

/** Highest standable cell in column (x, z) between yMax and yMin, or null. */
function surfaceAt(bot, x, z, { yMax = 100, yMin = 30 } = {}) {
  for (let y = yMax; y >= yMin; y -= 1) {
    const below = bot.blockAt(new Vec3(x, y - 1, z));
    if (!below) return null;
    if (below.boundingBox !== 'block') continue;
    const feet = bot.blockAt(new Vec3(x, y, z));
    const head = bot.blockAt(new Vec3(x, y + 1, z));
    if (feet?.boundingBox === 'empty' && head?.boundingBox === 'empty' && !/water|lava/.test(feet.name)) {
      return new Vec3(x, y, z);
    }
    return null;
  }
  return null;
}

/** Ground cells around `center` (in rings) from which a clear arrow reaches `target`. */
function firingSpots(bot, center, target, { radii = [12, 16, 20, 26, 32, 40], kind = ARROW, radius = 0.9, ignore } = {}) {
  const spots = [];
  for (const r of radii) {
    for (let i = 0; i < 16; i += 1) {
      const a = (i / 16) * Math.PI * 2;
      const x = Math.round(center.x + Math.cos(a) * r);
      const z = Math.round(center.z + Math.sin(a) * r);
      // Island ground only: never the top of another pillar.
      const stand = surfaceAt(bot, x, z, { yMax: 75 });
      if (!stand || overVoid(bot, x, stand.y, z)) continue;
      const origin = stand.offset(0.5, 1.52, 0.5);
      // The flat shot if it is clear, else the lob coming down over the pillar's edge.
      for (const high of [false, true]) {
        const shot = aim(origin, target, kind, { high });
        if (shot && clearFlight(bot, origin, shot, target, kind, { radius, ignore })) { stand.high = high; spots.push(stand); break; }
      }
    }
  }
  const here = bot.entity.position.clone();
  return spots.sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
}

/**
 * Centre of the dragon's head part (a 1x1 box): 6.5 blocks along its yaw,
 * one block down while it sits (EnderDragon#aiStep). Mineflayer's yaw is
 * pi minus the game's, so the game's (sin, -cos) becomes (sin, cos).
 */
function headPosition(dragon) {
  const y = dragon.yaw;
  return dragon.position.offset(Math.sin(y) * 6.5, -0.5, Math.cos(y) * 6.5);
}
const headAim = (bot, dragon) => headPosition(dragon);
// The head is its own entity on the server: the dragon's id plus one.
const headPart = (dragon) => ({ id: dragon.id + 1, position: headPosition(dragon) });

async function walkTo(bot, ctx, p, range = 1, timeoutMs = 60000) {
  if (bot.entity.position.distanceTo(p.offset(0.5, 0, 0.5)) <= range + 0.8) return { ok: true };
  return actions.goNear(bot, ctx, p.offset(0.5, 0, 0.5), range, { timeoutMs });
}

module.exports = {
  inEnd, ARROW, PEARL, flightInfo, bridgeStep, bridgeToward, descendSpiral, stranded, digShelter, leaveShelter, pillarUp, digPillarDown, direction, fly, aim, clearFlight, shootArrow, throwPearl, hold, overVoid, deepDrop, applyEndMovements,
  wearArmor, dragonOf, dragonPhase, dragonHealth, crystalsOf, caged, cloudOver, exitPortalLit, surfaceAt, firingSpots, headAim, headPosition, headPart,
  walkTo, PERCHED, DYING, waitUntil, goals,
};
