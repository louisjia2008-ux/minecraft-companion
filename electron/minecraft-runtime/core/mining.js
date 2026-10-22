'use strict';
// Branch mining at a fixed height, one block of tunnel per call.
//
// The bot digs a walkable staircase down from the surface to the target
// height, then a 1x2 main tunnel with side branches every three blocks. Ore
// seen in the tunnel walls is mined on the way. Everything around a tunnel the
// bot dug itself is known rock, which is why this is safer than walking
// natural caves: a step that would open into a cave, touch water or lava, or
// sit under sand or gravel is not dug; the tunnel turns instead.
//
// The tunnel itself is the progress. `memory` only holds hints (where the
// front is, which way it runs); if the bot cannot get back to the front it
// simply starts a new staircase where it stands.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultActions = require('./actions');
const { posKey } = require('./blacklist');

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const LIQUID = /^(water|lava|bubble_column)$/;
const GRAVITY = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel']);
// Rubble kept when the bag fills up: one stack of stone for sealing and climbing.
const RUBBLE = new Set(['cobblestone', 'cobbled_deepslate', 'dirt', 'gravel', 'granite', 'diorite', 'andesite', 'tuff',
  'calcite', 'flint', 'sand', 'netherrack']);
const BRANCH_EVERY = 3;
const BRANCH_LENGTH = 16;
const TORCH_EVERY = 8;
const MAX_TURNS = 4;

const add = (p, dx, dy, dz) => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
const isPassable = (b) => b.boundingBox === 'empty' && !LIQUID.test(b.name);

/**
 * Checks one step of tunnel from `from` (the cell the feet are in) towards
 * `dir`, going down one block when `descend`. Pure: reads blocks through
 * `blockAt(x, y, z)` (null when unloaded). Returns { ok, target, dig } with the
 * cells to break top first, or { ok: false, reason }.
 *
 * Only cells that are dug have their surroundings checked. A cell that is
 * already open below `surfaceY` is a cave and is not entered.
 */
function inspectStep(blockAt, from, dir, { descend = false, surfaceY = Infinity } = {}) {
  const [dx, dz] = DIRS[dir];
  const target = add(from, dx, descend ? -1 : 0, dz);
  // Going down a stair the head sweeps through the cell above the target's head.
  const clear = descend ? [add(target, 0, 2, 0), add(target, 0, 1, 0), target] : [add(target, 0, 1, 0), target];
  const behind = [from, add(from, 0, 1, 0), add(from, 0, 2, 0)];
  const read = (p) => blockAt(p.x, p.y, p.z);
  const floor = read(add(target, 0, -1, 0));
  if (!floor) return fail('unloaded');
  if (LIQUID.test(floor.name)) return fail('liquid');
  if (floor.boundingBox !== 'block') return fail(floor.boundingBox === 'empty' ? 'cave' : 'no_floor');
  if (GRAVITY.has(floor.name)) return fail('gravity');
  const dig = [];
  for (const cell of clear) {
    const block = read(cell);
    if (!block) return fail('unloaded');
    if (LIQUID.test(block.name)) return fail('liquid');
    if (isPassable(block)) {
      if (cell.y < surfaceY) return fail('cave');
      continue;
    }
    if (GRAVITY.has(block.name)) return fail('gravity');
    if (block.diggable === false) return fail('undiggable');
    dig.push(cell);
  }
  const allowed = [...clear, ...behind];
  for (const cell of dig) {
    for (const [fx, fy, fz] of FACES) {
      const near = add(cell, fx, fy, fz);
      if (allowed.some((p) => same(p, near))) continue;
      const block = read(near);
      if (!block) return fail('unloaded');
      if (LIQUID.test(block.name)) return fail('liquid');
      if (fy === 1 && GRAVITY.has(block.name)) return fail('gravity');
      if (isPassable(block) && near.y < surfaceY) return fail('cave');
    }
  }
  return { ok: true, target, dig };
}

/** A block with an open, dry cell beside it: reachable without tunnelling to it. */
function exposed(bot, p) {
  return FACES.some(([x, y, z]) => {
    const near = bot.blockAt(new Vec3(p.x + x, p.y + y, p.z + z));
    return near && isPassable(near);
  });
}

/** Ore in the tunnel walls: open to a cell the bot can stand in, within reach of `at`. */
function visibleOre(bot, blocks, at, radius = 4) {
  const ids = Object.values(bot.registry.blocksByName).filter((b) => blocks(b.name)).map((b) => b.id);
  if (!ids.length) return [];
  return bot.findBlocks({ matching: ids, maxDistance: radius, count: 16, point: at })
    .map((p) => bot.blockAt(p))
    .filter((b) => b && exposed(bot, b.position) && !FACES.some(([x, y, z]) => LIQUID.test(bot.blockAt(b.position.offset(x, y, z))?.name || '')));
}

async function tossRubble(bot, ctx) {
  let kept = 0;
  const items = bot.inventory.items().filter((i) => RUBBLE.has(i.name)).sort((a, b) => b.count - a.count);
  for (const item of items) {
    if (!kept && (item.name === 'cobblestone' || item.name === 'cobbled_deepslate')) { kept = 1; continue; }
    try { await bot.tossStack(item); } catch (_) { /* best effort */ }
    if (ctx.signal?.aborted) break;
  }
}

/**
 * Does one thing towards ore of `blocks` at height `y`: mine a visible ore,
 * walk back to the tunnel front, or dig one more block of tunnel.
 */
async function mineStep(bot, ctx, memory, { blocks, dropMatch, y, blacklist, start = null, actions = defaultActions }) {
  const feet = bot.entity.position.floored();
  // Ore already open to the tunnel first.
  if (memory.mine) {
    const ore = visibleOre(bot, blocks, bot.entity.position).filter((b) => !blacklist.has(posKey(b.position)))[0];
    if (ore) {
      ctx.record('mine_ore', { block: ore.name, position: posKey(ore.position) });
      const reach = await actions.goToDig(bot, ctx, ore, { timeoutMs: 15000 });
      if (!reach.ok) { blacklist.add(posKey(ore.position), reach.reason); return reach; }
      const dug = await actions.digBlock(bot, ctx, bot.blockAt(ore.position) || ore);
      if (!dug.ok) { blacklist.add(posKey(ore.position), dug.reason); return dug; }
      return actions.collectDrops(bot, ctx, ore.position.offset(0.5, 0.5, 0.5), dropMatch);
    }
  }
  if (typeof bot.inventory.emptySlotCount === 'function' && bot.inventory.emptySlotCount() <= 3) {
    ctx.record('mine_toss_rubble', {});
    await tossRubble(bot, ctx);
  }
  if (!memory.mine) {
    const from = start || { x: feet.x, y: feet.y, z: feet.z };
    memory.mine = { entrance: from, front: from, surfaceY: from.y, dir: memory.mineDir ?? 0, phase: 'descend',
      mainSteps: 0, steps: 0, turns: 0, branch: null, cells: { [posKey(from)]: null }, walkFailures: 0 };
    ctx.record('mine_start', { at: posKey(from), y });
  }
  const mine = memory.mine;
  // Back to the front first (after a trip home, a death, a fight).
  if (!feet.equals(new Vec3(mine.front.x, mine.front.y, mine.front.z))) {
    ctx.record('mine_return', { front: posKey(mine.front) });
    const front = new Vec3(mine.front.x, mine.front.y, mine.front.z);
    const back = (await walkTunnel(bot, ctx, mine, 'front', actions))
      || await actions.goTo(bot, ctx, new goals.GoalBlock(front.x, front.y, front.z),
        { timeoutMs: 8000, arrived: (at) => at.floored().equals(front) });
    if (!back.ok && ++mine.walkFailures >= 3) {
      ctx.record('mine_abandoned', { reason: back.reason });
      memory.mineDir = (mine.dir + 1) % 4;
      memory.mine = null;
    }
    return back;
  }

  let dir = mine.dir;
  let descend = mine.phase === 'descend' && mine.front.y > y;
  if (mine.phase === 'descend' && !descend) { mine.phase = 'main'; mine.mainSteps = 0; }
  if (mine.phase === 'branch') dir = mine.branch.dir;
  const step = inspectStep((x, yy, z) => bot.blockAt(new Vec3(x, yy, z)), mine.front, dir,
    { descend, surfaceY: mine.surfaceY - 1 });
  if (!step.ok) return turn(ctx, mine, step.reason, memory);

  for (const cell of step.dig) {
    const block = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
    if (!block || block.boundingBox === 'empty') continue;
    const dug = await actions.digBlock(bot, ctx, block);
    if (!dug.ok) return dug;
    if (blocks(block.name)) await actions.collectDrops(bot, ctx, block.position.offset(0.5, 0.5, 0.5), dropMatch, { timeoutMs: 3000 });
  }
  const t = step.target;
  const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(t.x, t.y, t.z),
    { timeoutMs: 8000, arrived: (at) => at.floored().equals(new Vec3(t.x, t.y, t.z)) });
  if (!moved.ok) return moved;
  const previous = mine.front;
  mine.front = t;
  if (!(posKey(t) in mine.cells)) mine.cells[posKey(t)] = posKey(previous);
  mine.steps += 1;
  mine.turns = 0;
  await maybeTorch(bot, ctx, mine, previous);
  advance(mine);
  return { ok: true, mined: posKey(t) };
}

const LEG = 6;
const near = (a, b, d = 1.5) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= d;
const unkey = (k) => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; };

/** The tunnel cell the bot stands in (or right next to), as a key into mine.cells. */
function cellAt(mine, feet) {
  const own = posKey(feet);
  if (own in mine.cells) return own;
  return Object.keys(mine.cells).find((k) => near(unkey(k), feet)) || null;
}

/** Keys from `k` up to the entrance. */
function chain(mine, k) {
  const out = [];
  for (let at = k; at; at = mine.cells[at]) out.push(at);
  return out;
}

/**
 * One leg (a few blocks) along the bot's own tunnel, towards the entrance
 * ('out') or the front ('front'). Every dug cell remembers the cell it was
 * entered from, so the tunnel is a tree and both ways are walks along it.
 * Long paths through solid rock make the pathfinder search the whole
 * hillside; short legs along known open cells do not. Returns null when
 * there is nowhere to go (already there, or not in the tunnel).
 */
async function walkTunnel(bot, ctx, mine, towards, actions = defaultActions) {
  const go = async (p, timeoutMs = 20000) => {
    const result = await actions.goTo(bot, ctx, new goals.GoalBlock(p.x, p.y, p.z),
      { timeoutMs, arrived: (at) => near(at.floored(), p, 0.5) });
    if (result.ok) mine.walkFailures = 0;
    return result;
  };
  const here = cellAt(mine, bot.entity.position.floored());
  if (!here) return towards === 'out' ? null : go(mine.entrance, 90000); // outside: to the entrance first
  const up = chain(mine, here);
  let target;
  if (towards === 'out') {
    target = up[Math.min(LEG, up.length - 1)];
  } else {
    const down = chain(mine, posKey(mine.front)); // front ... entrance
    const at = down.indexOf(here);
    if (at >= 0) target = down[Math.max(0, at - LEG)]; // on the way to the front: go deeper
    else {
      // In a side branch off the way: back towards where it joins.
      const join = up.findIndex((k) => down.includes(k));
      target = up[Math.min(LEG, join < 0 ? up.length - 1 : join)];
    }
  }
  if (target === here) return null;
  return go(unkey(target));
}

/** Below the mine's entrance: one leg back up towards it, else null. */
function leaveMine(bot, ctx, memory, actions = defaultActions) {
  const mine = memory.mine;
  if (!mine || bot.entity.position.y >= mine.surfaceY - 1) return null;
  ctx.record('mine_leave', { at: posKey(bot.entity.position.floored()) });
  return walkTunnel(bot, ctx, mine, 'out', actions);
}

/** Moves the plan on after a step: count main tunnel steps, open and close branches. */
function advance(mine) {
  if (mine.phase === 'main') {
    mine.mainSteps += 1;
    if (mine.mainSteps % BRANCH_EVERY === 0) {
      mine.phase = 'branch';
      mine.branch = { origin: mine.front, side: 1, dir: (mine.dir + 1) % 4, steps: 0 };
    }
  } else if (mine.phase === 'branch') {
    mine.branch.steps += 1;
    if (mine.branch.steps >= BRANCH_LENGTH) endBranch(mine);
  }
}

function endBranch(mine) {
  const b = mine.branch;
  mine.front = b.origin; // walk back to the junction on the next call
  if (b.side === 1) mine.branch = { origin: b.origin, side: -1, dir: (mine.dir + 3) % 4, steps: 0 };
  else { mine.phase = 'main'; mine.branch = null; }
}

function turn(ctx, mine, reason, memory) {
  ctx.record('mine_turn', { phase: mine.phase, reason, at: posKey(mine.front) });
  if (mine.phase === 'branch') { endBranch(mine); return { ok: true, turned: reason }; }
  mine.turns += 1;
  if (mine.turns >= MAX_TURNS) {
    memory.mineDir = (mine.dir + 1) % 4;
    memory.mine = null;
    return fail(`mine_blocked:${reason}`);
  }
  mine.dir = (mine.dir + 1) % 4;
  return { ok: true, turned: reason };
}

async function maybeTorch(bot, ctx, mine, cell) {
  if (mine.steps % TORCH_EVERY !== 0) return;
  const torch = bot.inventory.items().find((i) => i.name === 'torch');
  const below = bot.blockAt(new Vec3(cell.x, cell.y - 1, cell.z));
  if (!torch || below?.boundingBox !== 'block' || typeof bot.placeBlock !== 'function') return;
  try {
    await bot.equip(torch, 'hand');
    await bot.placeBlock(below, new Vec3(0, 1, 0));
    ctx.record('mine_torch', { at: posKey(cell) });
  } catch (_) { /* a torch is a nicety, not progress */ }
}

module.exports = { inspectStep, mineStep, leaveMine, walkTunnel, visibleOre, exposed, advance, DIRS, BRANCH_EVERY, BRANCH_LENGTH };
