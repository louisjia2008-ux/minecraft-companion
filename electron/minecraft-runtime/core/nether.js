'use strict';
// Nether portals and nether-safe movement.
//
// A portal is a 4x5 frame standing on the ground: obsidian on the four sides,
// any block in the corners. The corners are cobblestone here: the side columns
// rest on the bottom corners and the top row is placed against the top
// corners, so no block needs a face the bot cannot click.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const actions = require('./actions');
const { waitUntil, runCancellable, sleep } = require('./confirm');
const { posKey } = require('./blacklist');

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const isAbort = (error) => error?.code === 'aborted';
const AIR = new Set(['air', 'cave_air', 'void_air']);
const CORNERS = new Set(['cobblestone', 'cobbled_deepslate', 'netherrack', 'dirt', 'stone', 'blackstone']);

function dimension(bot) {
  return String(bot?.game?.dimension || 'overworld').replace(/^minecraft:/, '');
}
const inNether = (bot) => dimension(bot) === 'the_nether';

/** Nearest lit portal block, or null. */
function findPortal(bot, maxDistance = 48) {
  const id = bot.registry.blocksByName.nether_portal?.id;
  if (!Number.isInteger(id)) return null;
  const found = bot.findBlocks({ matching: id, maxDistance, count: 32 });
  if (found.length === 0) return null;
  const here = bot.entity.position;
  // Stand in a bottom portal cell: the bot's feet go there.
  const bottoms = found.filter((p) => bot.blockAt(p.offset(0, -1, 0))?.name !== 'nether_portal');
  const list = bottoms.length ? bottoms : found;
  list.sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
  return list[0];
}

/**
 * Frame cells relative to `base` (the bottom-left corner, on the ground), in
 * build order. `axis` is 'x' or 'z': the direction the frame runs along.
 */
function portalFrame(base, axis = 'x') {
  const at = (u, y) => (axis === 'x' ? base.offset(u, y, 0) : base.offset(0, y, u));
  const cells = [];
  cells.push({ pos: at(0, 0), corner: true }, { pos: at(3, 0), corner: true });
  cells.push({ pos: at(1, 0) }, { pos: at(2, 0) });
  for (let y = 1; y <= 3; y += 1) cells.push({ pos: at(0, y) }, { pos: at(3, y) });
  cells.push({ pos: at(0, 4), corner: true }, { pos: at(3, 4), corner: true });
  // The top row hangs from the top corners.
  cells.push({ pos: at(1, 4), against: at(0, 4) }, { pos: at(2, 4), against: at(3, 4) });
  const interior = [];
  for (let u = 1; u <= 2; u += 1) for (let y = 1; y <= 3; y += 1) interior.push(at(u, y));
  const front = axis === 'x' ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0);
  return { cells, interior, front, ignite: at(1, 0), stand: at(1, 0).plus(front).offset(0, 0, 0) };
}

const passable = (b) => b && (AIR.has(b.name) || (b.boundingBox === 'empty' && !/water|lava|fire/.test(b.name)));
const ground = (b) => b && b.boundingBox === 'block' && !/lava|water|magma|_leaves|gravel|sand$/.test(b.name);

/** A site needing no digging: solid ground under the frame and in front, open air above. */
function portalSiteOk(bot, base, axis) {
  const frame = portalFrame(base, axis);
  for (let u = 0; u <= 3; u += 1) {
    const foot = axis === 'x' ? base.offset(u, 0, 0) : base.offset(0, 0, u);
    if (!ground(bot.blockAt(foot.offset(0, -1, 0)))) return false;
    for (let y = 0; y <= 5; y += 1) if (!passable(bot.blockAt(foot.offset(0, y, 0)))) return false;
    // Room to stand in front while building and to walk in.
    for (const side of [frame.front, frame.front.scaled(2)]) {
      const cell = foot.plus(side);
      if (!ground(bot.blockAt(cell.offset(0, -1, 0)))) return false;
      if (!passable(bot.blockAt(cell)) || !passable(bot.blockAt(cell.offset(0, 1, 0)))) return false;
    }
  }
  return true;
}

function findPortalSite(bot, radius = 16) {
  const here = bot.entity.position.floored();
  let best = null;
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dy = -3; dy <= 3; dy += 1) {
        const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 2;
        if (best && d >= best.d) continue;
        const base = here.offset(dx, dy, dz);
        for (const axis of ['x', 'z']) {
          if (portalSiteOk(bot, base, axis)) { best = { base, axis, d }; break; }
        }
      }
    }
  }
  return best;
}

const FACES = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)];

/**
 * Places one block against a known neighbour without a line-of-sight check:
 * the server only checks reach, and the frame's top row faces are above eye level.
 */
async function placeFrameBlock(bot, ctx, pos, itemMatch, against, stand) {
  const current = bot.blockAt(pos);
  if (current && itemMatch(current.name)) return { ok: true, already: true };
  if (current && !AIR.has(current.name)) {
    if (current.boundingBox !== 'empty') return fail('occupied', { block: current.name });
    const dug = await actions.digBlock(bot, ctx, current);
    if (!dug.ok) return dug;
  }
  const item = bot.inventory.items().find((i) => itemMatch(i.name));
  if (!item) return fail('no_material');
  if (!actions.withinReach(bot, pos, 4.2) || bodyIn(bot, pos)) {
    const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(stand.x, stand.y, stand.z), { timeoutMs: 20000 });
    if (!moved.ok && (!actions.withinReach(bot, pos, 4.5) || bodyIn(bot, pos))) return moved;
  }
  let ref = against ? bot.blockAt(against) : null;
  if (!ref || ref.boundingBox !== 'block') {
    ref = FACES.map((f) => bot.blockAt(pos.plus(f))).find((b) => b && b.boundingBox === 'block' && !/_door|chest|_bed|crafting_table|furnace/.test(b.name));
  }
  if (!ref) return fail('no_support');
  const face = pos.minus(ref.position);
  try {
    await bot.equip(item, 'hand');
    await bot.lookAt(ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5), true);
    await runCancellable(() => bot.placeBlock(ref, face), { signal: ctx.signal, timeoutMs: 6000, timeoutCode: 'place_timeout' });
  } catch (error) {
    if (isAbort(error)) throw error;
  }
  const placed = await waitUntil(() => itemMatch(bot.blockAt(pos)?.name || ''), { timeoutMs: 1500, signal: ctx.signal });
  if (placed) return { ok: true };
  ctx.record('place_failed', { target: posKey(pos), ref: posKey(ref.position), now: bot.blockAt(pos)?.name || null });
  return fail('place_unconfirmed');
}

function bodyIn(bot, cell) {
  const p = bot.entity.position;
  const w = 0.3;
  return p.x + w > cell.x && p.x - w < cell.x + 1 && p.z + w > cell.z && p.z - w < cell.z + 1
    && p.y < cell.y + 1 && p.y + 1.8 > cell.y;
}

/** Builds one missing frame block per call; ignites once the frame is whole. */
async function buildPortalStep(bot, ctx, site) {
  const frame = portalFrame(site.base, site.axis);
  if (frame.interior.some((p) => bot.blockAt(p)?.name === 'nether_portal')) return { ok: true, lit: true };
  const stand = frame.stand;
  for (const cell of frame.cells) {
    const block = bot.blockAt(cell.pos);
    const done = cell.corner ? block && block.boundingBox === 'block' : block?.name === 'obsidian';
    if (done) continue;
    const match = cell.corner ? (n) => CORNERS.has(n) : (n) => n === 'obsidian';
    const result = await placeFrameBlock(bot, ctx, cell.pos, match, cell.against, stand);
    return result.ok ? { ok: true, placed: posKey(cell.pos) } : result;
  }
  // Fire needs open air in the frame: clear anything that fell or grew inside.
  for (const p of frame.interior) {
    const b = bot.blockAt(p);
    if (b && !AIR.has(b.name) && b.name !== 'fire') {
      const dug = await actions.digBlock(bot, ctx, b);
      if (!dug.ok) return dug;
    }
  }
  return ignite(bot, ctx, frame);
}

async function ignite(bot, ctx, frame) {
  const tool = bot.inventory.items().find((i) => i.name === 'flint_and_steel' || i.name === 'fire_charge');
  if (!tool) return fail('no_igniter');
  if (!actions.withinReach(bot, frame.ignite, 4)) {
    const s = frame.stand;
    const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(s.x, s.y, s.z), { timeoutMs: 20000 });
    if (!moved.ok) return moved;
  }
  const floor = bot.blockAt(frame.ignite);
  try {
    await bot.equip(tool, 'hand');
    await bot.lookAt(floor.position.offset(0.5, 1, 0.5), true);
    await bot.activateBlock(floor, new Vec3(0, 1, 0));
  } catch (error) {
    if (isAbort(error)) throw error;
  }
  const lit = await waitUntil(() => frame.interior.every((p) => bot.blockAt(p)?.name === 'nether_portal'),
    { timeoutMs: 3000, signal: ctx.signal });
  return lit ? { ok: true, lit: true } : fail('portal_not_lit');
}

/**
 * Walks into the portal at `portal` (a bottom portal cell) and waits for the
 * server to move the bot to the other dimension. Confirmed by the dimension.
 */
async function travel(bot, ctx, portal, { timeoutMs = 20000 } = {}) {
  const from = dimension(bot);
  const p = new Vec3(portal.x, portal.y, portal.z);
  if (!bot.entity.position.floored().equals(p)) {
    const near = await actions.goNear(bot, ctx, p, 3, { timeoutMs: 60000 });
    if (!near.ok && bot.entity.position.distanceTo(p) > 6) return near;
    const inside = await actions.goTo(bot, ctx, new goals.GoalBlock(p.x, p.y, p.z), {
      timeoutMs: 15000, arrived: () => bot.blockAt(bot.entity.position.floored())?.name === 'nether_portal' || dimension(bot) !== from,
    });
    if (!inside.ok && dimension(bot) === from) return inside;
  }
  actions.haltBody(bot);
  const moved = await waitUntil(() => dimension(bot) !== from, { timeoutMs, signal: ctx.signal });
  if (!moved) return fail('portal_no_transfer');
  // New dimension: wait for the ground to load before anything plans a path.
  try {
    await runCancellable(() => bot.waitForChunksToLoad(), { signal: ctx.signal, timeoutMs: 20000, timeoutCode: 'chunks_timeout' });
  } catch (error) {
    if (isAbort(error)) throw error;
  }
  await sleep(500, ctx.signal);
  return { ok: true, dimension: dimension(bot) };
}

/** Steps out of the arrival portal so standing in it cannot send the bot back. */
async function leavePortal(bot, ctx) {
  const feet = bot.entity.position.floored();
  if (bot.blockAt(feet)?.name !== 'nether_portal') return { ok: true };
  const goal = new goals.GoalInvert(new goals.GoalNear(feet.x, feet.y, feet.z, 2));
  return actions.goTo(bot, ctx, goal, { timeoutMs: 10000,
    arrived: () => bot.blockAt(bot.entity.position.floored())?.name !== 'nether_portal' });
}

// ---- movement -------------------------------------------------------------

const LAVA = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire)$/;
// Mining gold near piglins angers all of them.
const NEVER_BREAK = ['nether_gold_ore', 'gilded_blackstone', 'gold_block', 'chest', 'trapped_chest', 'barrel', 'nether_portal', 'obsidian'];

/**
 * Nether movement: no long drops (a ledge may hide a lava lake), a heavy cost
 * on every cell next to lava or fire, never stand on magma, never dig gold.
 * Returns a function that restores the overworld settings.
 */
function applyNetherMovements(bot) {
  const m = bot.pathfinder?.movements;
  if (!m || m.companionNether) return () => {};
  const saved = { maxDropDown: m.maxDropDown, digCost: m.digCost, cantBreak: new Set(m.blocksCantBreak), steps: m.exclusionAreasStep.length };
  m.companionNether = true;
  m.maxDropDown = 3;
  // Netherrack breaks in an instant, so plain paths tunnel straight through
  // hills: one long walk wore out an iron pickaxe. Walk around when there is a way.
  m.digCost = 6;
  for (const name of NEVER_BREAK) {
    const id = bot.registry.blocksByName[name]?.id;
    if (Number.isInteger(id)) m.blocksCantBreak.add(id);
  }
  m.exclusionAreasStep.push((block) => (block?.position ? lavaRisk(bot, block.position) : 0));
  return () => {
    m.maxDropDown = saved.maxDropDown;
    m.digCost = saved.digCost;
    m.blocksCantBreak = saved.cantBreak;
    m.exclusionAreasStep.length = saved.steps;
    m.companionNether = false;
  };
}

/** Extra path cost for standing in `p`: lava or fire beside, below, or under the floor. */
function lavaRisk(bot, p) {
  const at = (dx, dy, dz) => bot.blockAt(p.offset(dx, dy, dz))?.name || '';
  if (LAVA.test(at(0, -1, 0)) || LAVA.test(at(0, 0, 0)) || LAVA.test(at(0, 1, 0))) return 1000;
  let risk = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (LAVA.test(at(dx, 0, dz)) || LAVA.test(at(dx, 1, dz))) risk += 60;
    // Next to a drop into lava: one slip and the bot burns.
    if (LAVA.test(at(dx, -1, dz)) || LAVA.test(at(dx, -2, dz))) risk += 30;
  }
  return risk;
}

/** Any lava within `range` cells of the bot's feet (for logging and checks). */
function lavaNear(bot, range = 2) {
  const feet = bot.entity.position.floored();
  for (let dx = -range; dx <= range; dx += 1) {
    for (let dy = -2; dy <= 1; dy += 1) {
      for (let dz = -range; dz <= range; dz += 1) if (bot.blockAt(feet.offset(dx, dy, dz))?.name === 'lava') return true;
    }
  }
  return false;
}

module.exports = {
  dimension, inNether, findPortal, portalFrame, portalSiteOk, findPortalSite, buildPortalStep, travel, leavePortal,
  applyNetherMovements, lavaRisk, lavaNear, NEVER_BREAK,
};
