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
const { waitUntil, runCancellable, sleep, abortError } = require('./confirm');
const { posKey } = require('./blacklist');
const { skyOpen, standable } = require('./caveRetreat');

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
const frameClearable = (b) => passable(b) && !b.shapes?.length && b.getProperties?.()?.waterlogged !== true;

/** A site needing no digging: solid ground under the frame and in front, open air above. */
function portalSiteOk(bot, base, axis) {
  const frame = portalFrame(base, axis);
  const home = bot.companionHomeSite;
  if (home && [...frame.cells.map((c) => c.pos), ...frame.interior].some((p) => home(p))) return false;
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

const SCOUT_SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function portalScoutStep(bot, from, to) {
  const dy = to.y - from.y;
  const read = (p) => bot.blockAt(p);
  if (Math.abs(from.x - to.x) + Math.abs(from.z - to.z) !== 1 || Math.abs(dy) > 1
    || !standable(read, from) || !standable(read, to)) return false;
  if (!dy) return true;
  const head = read((dy > 0 ? from : to).offset(0, 2, 0));
  return frameClearable(head);
}

// Probe nearby slopes from the construction stance, rather than guessing a
// portal base at the bot's present elevation and then hoping for a route.
function scoutPortalSite(bot) {
  const from = bot.entity.position.floored();
  if (!bot.entity.onGround || !standable((p) => bot.blockAt(p), from)) return null;
  const queue = [{ at: from, prior: null, depth: 0 }];
  const seen = new Set([posKey(from)]);
  for (let i = 0; i < queue.length && i < 1800; i += 1) {
    const node = queue[i];
    const { at, depth } = node;
    if (depth) {
      const base = at.offset(-1, 0, -1);
      const axis = ['x', 'z'].find((a) => portalSiteOk(bot, base, a));
      if (axis && skyOpen(bot, at)) {
        const path = [];
        for (let n = node; n; n = n.prior) path.push(n.at);
        return { site: { base, axis }, path: path.reverse() };
      }
    }
    if (depth >= 32) continue;
    for (const [dx, dz] of SCOUT_SIDES) for (const dy of [0, 1, -1]) {
      const next = at.offset(dx, dy, dz);
      const key = posKey(next);
      if (seen.has(key) || Math.abs(next.y - from.y) > 7
        || Math.max(Math.abs(next.x - from.x), Math.abs(next.z - from.z)) > 24
        || !portalScoutStep(bot, at, next)) continue;
      seen.add(key);
      queue.push({ at: next, prior: node, depth: depth + 1 });
    }
  }
  return null;
}

const FACES = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)];

/**
 * Places one block against a known neighbour without a line-of-sight check:
 * the server only checks reach, and the frame's top row faces are above eye level.
 */
async function placeFrameBlock(bot, ctx, pos, itemMatch, against, stand, work = actions) {
  let current = bot.blockAt(pos);
  if (current && itemMatch(current.name)) return { ok: true, already: true };
  if (current && !frameClearable(current)) return fail('occupied', { block: current.name });
  const item = bot.inventory.items().find((i) => itemMatch(i.name));
  if (!item) return fail('no_material');
  if (!work.withinReach(bot, pos, 4.2) || bodyIn(bot, pos)) {
    const moved = await work.goTo(bot, ctx, new goals.GoalBlock(stand.x, stand.y, stand.z), { timeoutMs: 20000 });
    if (!work.withinReach(bot, pos, 4.5) || bodyIn(bot, pos)) return moved.ok ? fail('out_of_reach') : moved;
  }
  current = bot.blockAt(pos);
  if (current && itemMatch(current.name)) return { ok: true, already: true };
  if (!frameClearable(current)) return fail(current ? 'occupied' : 'portal_frame_unloaded', { block: current?.name });
  if (!AIR.has(current.name)) {
    const dug = await work.digBlock(bot, ctx, current);
    if (!dug.ok) return dug;
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
async function buildPortalStep(bot, ctx, site, work = actions) {
  const frame = portalFrame(site.base, site.axis);
  if (frame.interior.some((p) => bot.blockAt(p)?.name === 'nether_portal')) return { ok: true, lit: true };
  const stand = frame.stand;
  for (const cell of frame.cells) {
    const block = bot.blockAt(cell.pos);
    const done = cell.corner ? block && block.boundingBox === 'block' : block?.name === 'obsidian';
    if (done) continue;
    const match = cell.corner ? (n) => CORNERS.has(n) : (n) => n === 'obsidian';
    const result = await placeFrameBlock(bot, ctx, cell.pos, match, cell.against, stand, work);
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
async function travel(bot, ctx, portal, { timeoutMs = 20000, settleMs = 6000, cooldownMs = 2500, tries = 3 } = {}) {
  const from = dimension(bot);
  const p = new Vec3(portal.x, portal.y, portal.z);
  const inPortal = () => bot.blockAt(bot.entity.position.floored())?.name === 'nether_portal';
  // A portal sheet is a quarter block thick: a body at the edge of its cell
  // never touches it. Use short, unsneaked centring presses on the forced
  // portal's narrow ledge, on the initial entry and every re-entry.
  const centre = async () => {
    const mid = p.offset(0.5, 0, 0.5);
    try {
      for (let i = 0; i < 30 && dimension(bot) === from; i += 1) {
        const at = bot.entity.position;
        if (Math.hypot(at.x - mid.x, at.z - mid.z) < 0.15) break;
        await bot.lookAt?.(mid.offset(0, 1.6, 0), true);
        bot.setControlState?.('forward', true);
        await sleep(50, ctx.signal);
        bot.setControlState?.('forward', false);
        await sleep(50, ctx.signal);
      }
    } finally {
      bot.setControlState?.('forward', false);
    }
  };
  const cooled = async () => {
    const wait = (bot.companionLeftPortalAt || 0) + cooldownMs - Date.now();
    if (wait > 0) await sleep(wait, ctx.signal);
  };
  const enter = async () => {
    await cooled();
    const inside = await actions.goTo(bot, ctx, new goals.GoalBlock(p.x, p.y, p.z), {
      timeoutMs: 15000, arrived: () => inPortal() || dimension(bot) !== from,
    });
    if (!inside.ok && dimension(bot) === from) return inside;
    await centre();
    return { ok: true };
  };
  if (!bot.entity.position.floored().equals(p)) {
    const near = await actions.goNear(bot, ctx, p, 3, { timeoutMs: 60000 });
    if (!near.ok && bot.entity.position.distanceTo(p) > 6) return near;
    const inside = await enter();
    if (!inside.ok) return inside;
  } else {
    await centre();
  }
  actions.haltBody(bot);
  let moved = await waitUntil(() => dimension(bot) !== from, { timeoutMs: Math.min(settleMs, timeoutMs), signal: ctx.signal });
  // Standing in the arrival portal keeps its cooldown alive. Leave it,
  // wait off the sheet, then retry a bounded number of times.
  for (let i = 1; !moved && i < tries; i += 1) {
    await leavePortal(bot, ctx);
    ctx.record?.('portal_reenter', { attempt: i, out: !inPortal() });
    await sleep(cooldownMs, ctx.signal);
    if (dimension(bot) !== from) { moved = true; break; }
    const inside = await enter();
    if (!inside.ok) return inside;
    actions.haltBody(bot);
    moved = await waitUntil(() => dimension(bot) !== from, { timeoutMs, signal: ctx.signal });
  }
  if (!moved) {
    const at = bot.entity.position;
    const where = { at: `${at.x.toFixed(2)},${at.y.toFixed(2)},${at.z.toFixed(2)}`, inPortal: inPortal(), onGround: bot.entity.onGround };
    ctx.record?.('portal_no_transfer', where);
    return fail('portal_no_transfer', where);
  }
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
  const out = () => bot.blockAt(bot.entity.position.floored())?.name !== 'nether_portal';
  const result = await actions.goTo(bot, ctx, goal, { timeoutMs: 10000, arrived: out });
  if (out()) {
    bot.companionLeftPortalAt = Date.now();
    return result;
  }
  // On the 3x2 ledge of a forced portal there is no cell two blocks off:
  // one careful step beside the frame.
  await actions.nudge?.(bot, ctx, { accept: (cell) => bot.blockAt(cell)?.name !== 'nether_portal' });
  if (out()) bot.companionLeftPortalAt = Date.now();
  return out() ? { ok: true } : result;
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
/**
 * Blocks to bridge and tower with in the nether: netherrack, which every walk
 * here digs up, and the other rubble of the nether (a fortress walk digs nether
 * bricks, a bastion blackstone; with netherrack alone a run below a fortress
 * ran out and could not climb up to it for an hour). Cobblestone is kept for steps out of a lava sea; letting the
 * pathfinder build with it spent a whole stack on bridges in a minute.
 */
// Soul sand too: a bastion trade brings stacks of it, and one run ended on a
// basalt pillar in the lava sea with 49 soul sand and nothing else to build with.
const SCAFFOLD = ['netherrack', 'nether_bricks', 'blackstone', 'basalt', 'polished_basalt', 'smooth_basalt', 'soul_soil', 'soul_sand'];

function netherScaffolding(bot) {
  return SCAFFOLD.map((n) => bot.registry.itemsByName?.[n]?.id).filter(Number.isInteger);
}

/** How many blocks the bot carries that nether paths may build with. */
function scaffoldCount(bot) {
  return bot.inventory.items().filter((i) => SCAFFOLD.includes(i.name)).reduce((n, i) => n + i.count, 0);
}

function applyNetherMovements(bot) {
  const m = bot.pathfinder?.movements;
  if (!m || m.companionNether) return () => {};
  const saved = { maxDropDown: m.maxDropDown, digCost: m.digCost, cantBreak: new Set(m.blocksCantBreak), steps: m.exclusionAreasStep.length,
    scaffold: m.scafoldingBlocks, sprint: m.sprintSetting ?? m.allowSprinting };
  m.companionNether = true;
  m.maxDropDown = 3;
  // Netherrack breaks in an instant, so plain paths tunnel straight through
  // hills: one long walk wore out an iron pickaxe. Walk around when there is a way.
  m.digCost = 6;
  m.scafoldingBlocks = netherScaffolding(bot);
  for (const name of NEVER_BREAK) {
    const id = bot.registry.blocksByName[name]?.id;
    if (Number.isInteger(id)) m.blocksCantBreak.add(id);
  }
  // Fortress bridges hang 30 blocks over lava: no sprinting (a sprint overshoots
  // a turn and walks off the side). A cost on cells beside a drop was tried and
  // dropped: it sent walks the long way round, or tunnelling through hills.
  m.allowSprinting = false;
  m.exclusionAreasStep.push((block) => (block?.position ? lavaRisk(bot, block.position) : 0));
  return () => {
    m.maxDropDown = saved.maxDropDown;
    m.digCost = saved.digCost;
    m.scafoldingBlocks = saved.scaffold;
    m.allowSprinting = saved.sprint;
    m.blocksCantBreak = saved.cantBreak;
    m.exclusionAreasStep.length = saved.steps;
    m.companionNether = false;
  };
}

/** Quartz walks own their excavation: native paths may only use existing ground. */
function applyWalkOnlyMovements(bot) {
  const m = bot.pathfinder?.movements;
  if (!m || m.companionWalkOnly) return () => {};
  const keys = ['canDig', 'allowParkour', 'allow1by1towers', 'scafoldingBlocks', 'maxDropDown', 'companionWalkOnly',
    'infiniteLiquidDropdownDistance', 'getNeighbors', 'companionPhysicalDropLimit', 'companionPhysicalDropGuard'];
  const saved = keys.map((key) => [key, Object.hasOwn(m, key), m[key]]);
  m.companionWalkOnly = true;
  m.canDig = false;
  m.allowParkour = false;
  m.allow1by1towers = false;
  m.scafoldingBlocks = [];
  // The native limit compares feet to the supporting block, one below the
  // landing feet. A one-block physical descent therefore needs depth two.
  // Enforce the physical delta separately, including any upstream moves
  // that did not consult the native dropdown limit.
  m.maxDropDown = Math.min(m.maxDropDown ?? 2, 2);
  m.infiniteLiquidDropdownDistance = false;
  const neighbors = m.getNeighbors;
  if (typeof neighbors === 'function') {
    const guarded = function (node, ...args) {
      return neighbors.call(this, node, ...args).filter((move) => Number.isFinite(node.y) && Number.isFinite(move.y)
        && move.y >= node.y - 1 && move.y <= node.y + 1 && !move.toBreak?.length && !move.toPlace?.length);
    };
    m.getNeighbors = guarded;
    m.companionPhysicalDropLimit = 1;
    m.companionPhysicalDropGuard = guarded;
  }
  return () => {
    for (const [key, owned, value] of saved) {
      if (owned) m[key] = value;
      else delete m[key];
    }
  };
}

const LOOKOUT_HAZARD = /^(water|lava|bubble_column|fire|soul_fire|magma_block|campfire|soul_campfire|powder_snow|cactus)$/;
const LOOKOUT_LOOSE = /^(gravel|sand|red_sand|.*_concrete_powder)$/;
const LOOKOUT_ROCK = /^(netherrack|blackstone|basalt|soul_soil)$/;
const lookoutDry = (b) => b && !LOOKOUT_HAZARD.test(b.name) && b.getProperties?.()?.waterlogged !== true;
const lookoutOpen = (b) => lookoutDry(b) && b.boundingBox === 'empty';
const lookoutSupport = (b) => lookoutDry(b) && b.boundingBox === 'block' && !LOOKOUT_LOOSE.test(b.name)
  && b.shapes?.some(([x, y, z, right, top, back]) => x === 0 && y === 0 && z === 0 && right === 1 && top >= .75 && back === 1);

function lookoutMoveSafe(bot, node, move, read = (p) => bot.blockAt(p)) {
  const from = new Vec3(node.x, node.y, node.z);
  const to = new Vec3(move.x, move.y, move.z);
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  if (![dx, dy, dz].every(Number.isInteger) || Math.abs(dx) > 1 || Math.abs(dz) > 1 || Math.abs(dy) > 1
    || (!dx && !dz) || move.parkour || move.toPlace?.length) return false;
  if (!lookoutSupport(read(to.offset(0, -1, 0)))) return false;
  const cuts = move.toBreak || [];
  const breakable = (p) => {
    if (dy || (dx && dz) || p.x !== to.x || p.z !== to.z || p.y < to.y || p.y > to.y + 1) return false;
    const rock = read(p);
    const above = read(p.offset(0, 1, 0));
    return lookoutDry(rock) && LOOKOUT_ROCK.test(rock.name) && !bot.companionProtectBlock?.(rock)
      && lookoutDry(above) && !LOOKOUT_LOOSE.test(above.name)
      && FACES.every((face) => lookoutDry(read(p.plus(face))));
  };
  if (cuts.some((p) => !breakable(p))) return false;
  const clear = (p) => lookoutOpen(read(p)) || cuts.some((cut) => p.equals(cut));
  if (!clear(to) || !clear(to.offset(0, 1, 0))) return false;
  if (dy && !lookoutOpen(read((dy > 0 ? from : to).offset(0, 2, 0)))) return false;
  if (dx && dz) {
    // The body cuts across both corners. A native diagonal can otherwise
    // have a valid endpoint on the far side of an unsupported cliff edge.
    for (const corner of [from.offset(dx, 0, 0), from.offset(0, 0, dz)]) {
      const feet = corner.offset(0, dy, 0);
      if (!lookoutSupport(read(feet.offset(0, -1, 0))) || !lookoutOpen(read(feet)) || !lookoutOpen(read(feet.offset(0, 1, 0)))
        || dy && !lookoutOpen(read((dy > 0 ? corner : feet).offset(0, 2, 0)))) return false;
    }
  }
  return true;
}

// A search hint for the native pathfinder. The actual movement still replans
// each short leg with its native neighbors and the same terrain guard.
function lookoutCardinalMoves(bot, from, read) {
  const moves = [];
  for (const [dx, dz] of SCOUT_SIDES) for (const dy of [0, 1, -1]) {
    const to = new Vec3(from.x + dx, from.y + dy, from.z + dz);
    if (!lookoutSupport(read(to.offset(0, -1, 0)))) continue;
    const cuts = dy ? [] : [to, to.offset(0, 1, 0)].filter((p) => !lookoutOpen(read(p)));
    const move = Object.assign(to, { hash: posKey(to), cost: 1 + 1.25 * cuts.length, toBreak: cuts, toPlace: [] });
    if (lookoutMoveSafe(bot, from, move, read)) moves.push(move);
  }
  return moves;
}

/** Limits a plain Nether lookout leg to loaded ground or a checked horizontal cut. */
async function withLookoutTerrain(bot, run, accept = () => true) {
  const movements = bot.pathfinder?.movements;
  const neighbors = movements?.getNeighbors;
  if (typeof neighbors !== 'function') return run();
  const keys = ['getNeighbors', 'allowParkour', 'allow1by1towers', 'infiniteLiquidDropdownDistance'];
  const saved = keys.map((key) => [key, Object.hasOwn(movements, key), movements[key]]);
  const guarded = function (node, ...args) {
    return neighbors.call(this, node, ...args).filter((move) => accept(move) && lookoutMoveSafe(bot, node, move));
  };
  Object.assign(movements, { getNeighbors: guarded, allowParkour: false, allow1by1towers: false, infiniteLiquidDropdownDistance: false });
  try {
    return await run();
  } finally {
    if (movements.getNeighbors === guarded) for (const [key, owned, value] of saved) {
      if (owned) movements[key] = value;
      else delete movements[key];
    }
  }
}

const FORTRESS_COMBAT_RADIUS = 12;
const COMBAT_PORTAL = /^(nether_portal|end_portal|end_gateway)$/;
const combatOpen = (block) => lookoutOpen(block) && !COMBAT_PORTAL.test(block.name);

function combatFooting(bot, p) {
  return lookoutSupport(bot.blockAt(p.offset(0, -1, 0)))
    && combatOpen(bot.blockAt(p)) && combatOpen(bot.blockAt(p.offset(0, 1, 0)));
}

function combatBodyLane(bot, position, floorY, dx, dz, leaving = () => false) {
  // Native path nodes are centred, but following an entity can cut a corner
  // before that centre. Check the real 0.6-wide body and its braking distance.
  for (const fraction of [0, 0.5, 1]) {
    const x = position.x + dx * fraction;
    const z = position.z + dz * fraction;
    for (let i = Math.floor(x - .3 + 1e-6); i <= Math.floor(x + .3 - 1e-6); i += 1) {
      for (let j = Math.floor(z - .3 + 1e-6); j <= Math.floor(z + .3 - 1e-6); j += 1) {
        const cell = new Vec3(i, floorY, j);
        if (combatFooting(bot, cell)) continue;
        if (combatOpen(bot.blockAt(cell)) && combatFooting(bot, cell.offset(0, -1, 0))) continue;
        // A full step up or a wall physically stops the horizontal body. It
        // still needs a verified dry supporting face, rather than a fluid.
        if (lookoutSupport(bot.blockAt(cell)) || leaving(cell)) continue;
        return false;
      }
    }
  }
  return true;
}

// A grounded player may already be on magma or brush the rim of an adjacent
// blocked column. Withdraw from precisely that contact before letting the
// combat action decide where to move. Do not inherit an unrestricted goal.
async function leaveCombatFooting(bot, ctx, origin, from) {
  if (!bot.entity.onGround || bot.entity.isInLava || bot.entity.isInWater) return false;
  const read = (p) => bot.blockAt(p);
  if (!combatOpen(read(from)) || !combatOpen(read(from.offset(0, 1, 0)))) return false;
  const support = read(from.offset(0, -1, 0));
  if (!combatFooting(bot, from) && support?.name !== 'magma_block') return false;
  const centre = (p) => p.offset(.5, 0, .5);
  const touches = (cell) => Math.abs(cell.x + .5 - origin.x) < .8 - 1e-6
    && Math.abs(cell.z + .5 - origin.z) < .8 - 1e-6;
  const leaving = (cell) => touches(cell);
  const safeEdge = (to) => combatFooting(bot, to)
    && (from.equals(to) || lookoutMoveSafe(bot, from, to, read));
  const clearLane = (at, to) => combatBodyLane(bot, at, from.y, centre(to).x - at.x, centre(to).z - at.z, leaving);
  const retry = combatFooting(bot, from) ? [from] : SCOUT_SIDES.flatMap(([x, z]) =>
    [from.offset(x, 0, z), from.offset(x, 1, z)]);
  const to = retry.filter((p) => safeEdge(p) && clearLane(origin, p))
    .sort((a, b) => lavaRisk(bot, a) - lavaRisk(bot, b))[0];
  if (!to) return false;
  const target = centre(to);
  const arrived = () => bot.entity.onGround && bot.entity.position.floored().equals(to)
    && combatFooting(bot, to) && combatBodyLane(bot, bot.entity.position, to.y, 0, 0);
  const controller = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  const check = () => {
    const at = bot.entity.position;
    if (!inNether(bot) || bot.entity.isInLava || bot.entity.isInWater || !safeEdge(to)
      || at.y < from.y - .05 || at.y > Math.max(from.y, to.y) + 1.3
      || Math.abs(at.x - origin.x) + Math.abs(at.z - origin.z) > 1.65 || !clearLane(at, to)) {
      controller.abort('fortress_combat_exit_changed');
      actions.haltBody(bot);
    }
  };
  const movements = bot.pathfinder.movements;
  const native = movements.getNeighbors;
  bot.on?.('physicsTick', check);
  bot.on?.('forcedMove', check);
  try {
    if (from.equals(to)) await actions.recentre(bot, { ...ctx, signal });
    else {
      movements.getNeighbors = function (node, ...args) {
        return from.equals(node) ? native.call(this, node, ...args)
          .filter((move) => to.equals(move) && safeEdge(to) && !move.toBreak?.length && !move.toPlace?.length) : [];
      };
      try {
        await runCancellable(() => bot.pathfinder.goto(new goals.GoalBlock(to.x, to.y, to.z)),
          { signal, timeoutMs: 2300, cancel: () => actions.haltBody(bot) });
      } catch (error) {
        if (isAbort(error)) throw error;
      }
    }
    if (!await waitUntil(arrived, { timeoutMs: 550, signal })) return false;
    ctx.record?.('fortress_combat_reposition', { from: origin, to: target, support: support?.name });
    return true;
  } catch (error) {
    if (ctx.signal?.aborted || !controller.signal.aborted || !isAbort(error)) throw error;
    return false;
  } finally {
    bot.removeListener?.('physicsTick', check);
    bot.removeListener?.('forcedMove', check);
    movements.getNeighbors = native;
    actions.haltBody(bot);
  }
}

/** Keep combat, pursuit and drop recovery on nearby, loaded Nether footing. */
async function withFortressCombatTerrain(bot, ctx, run) {
  if (ctx.signal?.aborted) throw abortError(ctx.signal);
  const pathfinder = bot.pathfinder;
  const movements = pathfinder?.movements;
  if (!movements && typeof bot.blockAt !== 'function') return run(ctx);
  const position = bot.entity?.position;
  if (!position || typeof movements?.getNeighbors !== 'function' || typeof bot.blockAt !== 'function') {
    return fail('fortress_combat_unsafe_footing');
  }
  const origin = position.clone();
  const floorAt = (p) => Math.ceil(p.y - .001);
  let floorY = floorAt(origin);
  const controller = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  const atFoot = (p) => new Vec3(Math.floor(p.x), floorAt(p), Math.floor(p.z));
  const stop = (reason) => {
    controller.abort(reason);
    actions.haltBody(bot);
    ctx.record?.('fortress_combat_terrain_blocked', { reason, origin, position: bot.entity?.position, floorY });
  };
  if (!inNether(bot) || !bot.entity.onGround || bot.entity.isInLava || bot.entity.isInWater) {
    stop('fortress_combat_unsafe_footing');
    return fail(controller.signal.reason);
  }
  const check = () => {
    if (signal.aborted) return;
    const entity = bot.entity;
    const p = entity.position;
    if (!inNether(bot) || entity.isInLava || entity.isInWater || p.y < floorY - 1.05) {
      stop('fortress_combat_unsafe_footing');
      return;
    }
    if (p.distanceTo(origin) > FORTRESS_COMBAT_RADIUS) {
      stop('fortress_combat_move_limit');
      return;
    }
    if (entity.onGround && combatFooting(bot, atFoot(p))) floorY = floorAt(p);
    const controls = bot.controlState || {};
    const yaw = entity.yaw || 0;
    const along = Number(Boolean(controls.forward)) - Number(Boolean(controls.back));
    const across = Number(Boolean(controls.right)) - Number(Boolean(controls.left));
    const dx = (entity.velocity?.x || 0) * 1.8 - .24 * (along * Math.sin(yaw) + across * Math.cos(yaw));
    const dz = (entity.velocity?.z || 0) * 1.8 + .24 * (along * Math.cos(yaw) - across * Math.sin(yaw));
    if (!combatBodyLane(bot, p, floorY, dx, dz)) stop('fortress_combat_unsafe_footing');
  };
  const restoreWalk = applyWalkOnlyMovements(bot);
  const saved = [[movements, 'allowSprinting', movements.sprintSetting ?? movements.allowSprinting],
    [movements, 'allowFreeMotion', movements.allowFreeMotion], [pathfinder, 'enablePathShortcut', pathfinder.enablePathShortcut]]
    .map(([owner, key, value]) => [owner, key, Object.hasOwn(owner, key), value]);
  for (const [owner, key] of saved) owner[key] = false;
  bot.setControlState?.('sprint', false);
  try {
    const from = atFoot(origin);
    if (!combatFooting(bot, from) || !combatBodyLane(bot, origin, floorY, 0, 0)) {
      if (await leaveCombatFooting(bot, ctx, origin, from)) return { ok: true, repositioned: true };
      stop('fortress_combat_unsafe_footing');
      return fail(controller.signal.reason);
    }
    bot.on?.('physicsTick', check);
    bot.on?.('forcedMove', check);
    check();
    if (!controller.signal.aborted) {
      const accept = (move) => !move.toBreak?.length && combatFooting(bot, new Vec3(move.x, move.y, move.z))
        && lavaRisk(bot, new Vec3(move.x, move.y, move.z)) === 0
        && new Vec3(move.x + .5, move.y, move.z + .5).distanceTo(origin) <= FORTRESS_COMBAT_RADIUS;
      const result = await withLookoutTerrain(bot, () => run({ ...ctx, signal }), accept);
      if (ctx.signal?.aborted) throw abortError(ctx.signal);
      if (!controller.signal.aborted) return result;
    }
  } catch (error) {
    if (!controller.signal.aborted || ctx.signal?.aborted || !isAbort(error)) throw error;
  } finally {
    bot.removeListener?.('physicsTick', check);
    bot.removeListener?.('forcedMove', check);
    for (const [owner, key, owned, value] of saved) {
      if (owned) owner[key] = value;
      else delete owner[key];
    }
    restoreWalk();
  }
  return fail(controller.signal.reason);
}

/**
 * Runs `fn` with the nether movement's lava margins lifted: only a cell with
 * lava (or fire, or magma) at, under or over it stays shut. Boxed into a pocket
 * by magma and a lava pool, every way out runs beside lava, and with the full
 * margins the pathfinder ran out of time before it found one.
 */
async function withLavaMarginsLifted(bot, fn) {
  const m = bot.pathfinder?.movements;
  if (!m?.companionNether) return fn();
  const steps = m.exclusionAreasStep.slice();
  const digCost = m.digCost;
  const at = (p, dy) => bot.blockAt(p.offset(0, dy, 0))?.name || '';
  m.exclusionAreasStep.splice(0, m.exclusionAreasStep.length,
    (block) => (block?.position && [-1, 0, 1].some((dy) => LAVA.test(at(block.position, dy))) ? 1000 : 0));
  m.digCost = 1;
  try {
    return await fn();
  } finally {
    m.exclusionAreasStep.splice(0, m.exclusionAreasStep.length, ...steps);
    m.digCost = digCost;
  }
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
  SCAFFOLD,
  netherScaffolding, scaffoldCount, withLavaMarginsLifted,
  dimension, inNether, findPortal, portalFrame, portalSiteOk, findPortalSite, scoutPortalSite, portalScoutStep,
  buildPortalStep, ignite, travel, leavePortal,
  applyNetherMovements, applyWalkOnlyMovements, withLookoutTerrain, withFortressCombatTerrain, lookoutCardinalMoves, lavaRisk, lavaNear, NEVER_BREAK,
};
