'use strict';
// Mining skills: a staircase down to an ore layer and a two-high tunnel
// along it, mining the ore that shows in the walls. Never a straight shaft
// (caves and lava below), never a block next to water or lava, a filler
// block under any gap in the floor, and a torch every few blocks.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const actions = require('./actions');

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const LIQUID = /^(water|lava|flowing_water|flowing_lava|bubble_column)$/;
const FILLERS = new Set(['cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff']);
const ORES = /(_ore$|^ancient_debris$)/;
const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const HEADINGS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

const liquidAt = (bot, p) => LIQUID.test(bot.blockAt(p)?.name || '');
const nearLiquid = (bot, p) => liquidAt(bot, p) || SIDES.some(([x, y, z]) => liquidAt(bot, p.offset(x, y, z)));
const solid = (b) => b && b.boundingBox === 'block';

async function clear(bot, ctx, p) {
  const block = bot.blockAt(p);
  if (!block || block.boundingBox === 'empty') return { ok: true };
  if (!bot.canDigBlock(block)) return fail('cannot_dig');
  return actions.digBlock(bot, ctx, block);
}

async function placeFiller(bot, ctx, skills, p) {
  return skills.placeAt(bot, ctx, p, (n) => FILLERS.has(n));
}

/**
 * Cells a step `kind` ('down' or 'level') along `heading` from `feet` must
 * clear, and the cell the bot ends on.
 */
function stepCells(feet, heading, kind) {
  const [hx, hz] = heading;
  const ahead = feet.offset(hx, 0, hz);
  if (kind === 'down') {
    const next = ahead.offset(0, -1, 0);
    return { next, dig: [ahead.offset(0, 1, 0), ahead, next], floor: next.offset(0, -1, 0) };
  }
  return { next: ahead, dig: [ahead.offset(0, 1, 0), ahead], floor: ahead.offset(0, -1, 0) };
}

/** Is the step safe to dig: no liquid next to anything it opens, floor fixable. */
function stepSafe(bot, cells) {
  return !cells.dig.some((p) => nearLiquid(bot, p)) && !liquidAt(bot, cells.floor);
}

/** One step of a staircase down or a level tunnel; turns when the way ahead touches liquid. */
async function step(bot, ctx, skills, memory, kind) {
  const feet = bot.entity.position.floored();
  let cells = stepCells(feet, memory.tunnel, kind);
  if (!stepSafe(bot, cells)) {
    const turned = HEADINGS.filter((h) => h[0] !== memory.tunnel[0] || h[1] !== memory.tunnel[1])
      .find((h) => stepSafe(bot, stepCells(feet, h, kind)));
    if (!turned) return fail('liquid_all_around');
    ctx.record('mine_turn', { from: memory.tunnel, to: turned });
    memory.tunnel = turned;
    cells = stepCells(feet, turned, kind);
  }
  for (const p of cells.dig) {
    const dug = await clear(bot, ctx, p);
    if (!dug.ok) return dug;
  }
  // A cave or a drop under the next step: fill it before stepping onto it.
  if (!solid(bot.blockAt(cells.floor))) {
    const filled = await placeFiller(bot, ctx, skills, cells.floor);
    if (!filled.ok) return filled;
  }
  const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(cells.next.x, cells.next.y, cells.next.z), { timeoutMs: 8000 });
  if (!moved.ok && !bot.entity.position.floored().equals(cells.next)) return moved;
  memory.length = (memory.length || 0) + 1;
  if (memory.length % 7 === 0) await placeTorch(bot, ctx, skills, cells.next);
  return { ok: true };
}

/** A torch on the floor beside the tunnel, if there is one to place. */
async function placeTorch(bot, ctx, skills, at) {
  if (!bot.inventory.items().some((i) => i.name === 'torch')) return { ok: false, reason: 'no_torch' };
  // Behind the bot, on the floor of the cell it came from.
  for (const [dx, dz] of HEADINGS) {
    const p = at.offset(dx, 0, dz);
    if (bot.blockAt(p)?.name === 'air' && solid(bot.blockAt(p.offset(0, -1, 0)))) {
      return skills.placeAt(bot, ctx, p, (n) => n === 'torch', { faces: [new Vec3(0, -1, 0)] });
    }
  }
  return { ok: false, reason: 'no_torch_spot' };
}

/** Ore showing within `radius` of the bot (an open face next to air), nearest first. */
function visibleOre(bot, match, radius = 5) {
  const ids = Object.values(bot.registry.blocksByName).filter((b) => ORES.test(b.name) && match(b.name)).map((b) => b.id);
  if (!ids.length) return [];
  const here = bot.entity.position;
  return bot.findBlocks({ matching: ids, maxDistance: radius, count: 16 })
    .filter((p) => SIDES.some(([x, y, z]) => bot.blockAt(p.offset(x, y, z))?.boundingBox === 'empty')
      && !nearLiquid(bot, p))
    .sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
}

module.exports = { step, stepCells, stepSafe, visibleOre, placeTorch, nearLiquid, HEADINGS, ORES };
