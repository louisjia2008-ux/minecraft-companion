'use strict';
// Goal: dig a small pond (blueprints/fishPond.js) and fish from its edge until
// `count` catches are in the inventory.
//
// Every run() looks at the world and does exactly one thing:
//   1. no site yet              -> choose flat, solid ground near the bot
//   2. a pond cell is filled    -> dig it out (stepping off it first)
//   3. a water cell is dry      -> pour a water bucket; the other two cells
//                                  then become sources between them
//   4. otherwise                -> stand on the edge, cast and wait for a bite
// A catch counts once the reeled-in item is in the inventory.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { createFishPond } = require('../blueprints/fishPond');
const { FACINGS } = require('../blueprints/cobbleGenerator');
const { waitUntil, runCancellable } = require('../confirm');

const LIQUID = new Set(['water', 'lava', 'bubble_column']);
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/;
// A bite comes 5 to 30 s after the bobber lands (faster with Lure).
const BITE_TIMEOUT_MS = 45000;

// Pond cells are dug out: only plain soil or stone. Soil picked up late is never a catch.
const DIGGABLE = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'mud', 'moss_block',
  'stone', 'andesite', 'diorite', 'granite', 'cobblestone', 'clay', 'terracotta', 'deepslate', 'tuff']);
const isAir = (block) => !block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
const isSoft = (block) => isAir(block) || (block.boundingBox === 'empty' && !LIQUID.has(block.name));
const isSolid = (block) => Boolean(block) && block.boundingBox === 'block' && !LIQUID.has(block.name) && !GRAVITY.test(block.name);
const v = (p) => new Vec3(p.x, p.y, p.z);

function evaluatePondSite(blockAt, anchor, facing) {
  const pond = createFishPond(anchor, facing);
  const at = (p) => blockAt(p.x, p.y, p.z);
  for (const p of [...pond.floor, ...pond.rim]) if (!isSolid(at(p))) return null;
  for (const p of pond.pond) { const b = at(p); if (!isAir(b) && b?.name !== 'water' && !DIGGABLE.has(b?.name)) return null; }
  for (const p of pond.clear) if (!isSoft(at(p))) return null;
  return pond;
}

/** Nearest flat spot; the anchor is the ground block the bot stands on. */
function choosePondSite(blockAt, around, { radius = 8 } = {}) {
  const origin = { x: Math.floor(around.x), y: Math.floor(around.y), z: Math.floor(around.z) };
  let best = null;
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      let y = null;
      for (let top = origin.y + 3; top >= origin.y - 4; top -= 1) {
        const block = blockAt(origin.x + dx, top, origin.z + dz);
        if (!block) break;
        if (isSoft(block)) continue;
        y = top;
        break;
      }
      if (y === null) continue;
      for (const facing of Object.keys(FACINGS)) {
        const pond = evaluatePondSite(blockAt, { x: origin.x + dx, y, z: origin.z + dz }, facing);
        if (!pond) continue;
        const score = Math.hypot(dx, dz) + Math.abs(y + 1 - origin.y) * 2;
        if (!best || score < best.score) best = { pond, score };
      }
    }
  }
  return best ? best.pond : null;
}

function createFishingGoal({ bot, anchor = null, facing = 'east', count = 5,
  skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  const memory = { pond: anchor ? createFishPond(anchor, facing) : null, catches: 0, casts: 0, caught: {} };
  const blockAt = (p) => bot.blockAt(v(p));
  const isSource = (p) => skills.isFluidSource(blockAt(p), 'water');
  const inStand = () => {
    const s = memory.pond.cells.stand;
    const at = bot.entity.position;
    return Math.floor(at.x) === s.x && Math.floor(at.z) === s.z && Math.abs(at.y - s.y) < 0.5;
  };
  const inspect = () => {
    const p = memory.pond;
    return {
      dig: p.pond.find((c) => !isAir(blockAt(c)) && !LIQUID.has(blockAt(c)?.name)) || null,
      dry: p.water.find((c) => !isSource(c)) || null,
      full: p.pond.every(isSource),
    };
  };

  async function goStand(ctx) {
    if (inStand()) return { ok: true };
    const s = memory.pond.cells.stand;
    const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(s.x, s.y, s.z), { timeoutMs: 15000, arrived: inStand });
    if (inStand()) return { ok: true };
    return moved.ok ? { ok: false, reason: 'not_in_stand' } : moved;
  }

  async function cast(ctx) {
    const rod = bot.inventory.items().find((item) => item.name === 'fishing_rod');
    if (!rod) return { ok: false, reason: 'no_material', missing: [{ name: 'fishing_rod', short: 1 }] };
    const standing = await goStand(ctx);
    if (!standing.ok) return standing;
    const names = new Map(bot.inventory.items().map((item) => [item.name, item.count]));
    try {
      await bot.equip(rod, 'hand');
      await bot.lookAt(v(memory.pond.target), true);
      memory.casts += 1;
      // On timeout or preemption a second use of the rod reels the bobber in,
      // and the wait ends at once even if no bobber ever landed.
      let stop = null;
      await runCancellable(() => new Promise((resolve, reject) => { stop = reject; bot.fish().then(resolve, reject); }), {
        signal: ctx.signal, timeoutMs: BITE_TIMEOUT_MS, timeoutCode: 'no_bite',
        cancel: () => { bot.activateItem(); stop?.(new Error('reeled_in')); },
      });
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      if (error.code === 'no_bite') return { ok: false, reason: 'no_bite' };
      return { ok: false, reason: 'cast_failed', message: error.message };
    }
    // Item by item: a rod that breaks on this catch leaves the inventory as the catch arrives.
    const newItems = () => bot.inventory.items()
      .filter((item) => item.name !== 'fishing_rod' && !DIGGABLE.has(item.name) && item.count > (names.get(item.name) || 0));
    const landed = await waitUntil(() => newItems().length > 0, { timeoutMs: 3000, signal: ctx.signal });
    if (!landed) return { ok: false, reason: 'catch_not_collected' };
    memory.catches += 1;
    for (const item of newItems()) {
      memory.caught[item.name] = (memory.caught[item.name] || 0) + item.count - (names.get(item.name) || 0);
    }
    ctx.record('fish_caught', { catches: memory.catches, casts: memory.casts, caught: memory.caught });
    return { ok: true };
  }

  return {
    name: 'fishing',
    memory,
    noProgressLimit: 8,
    isDone: () => memory.catches >= count,
    progress: () => {
      if (!memory.pond) return 0;
      const p = memory.pond;
      return p.pond.filter((c) => isAir(blockAt(c)) || LIQUID.has(blockAt(c)?.name)).length
        + p.pond.filter(isSource).length + memory.catches;
    },
    async run(ctx) {
      if (!memory.pond) {
        const pond = choosePondSite((x, y, z) => bot.blockAt(new Vec3(x, y, z)), bot.entity.position);
        if (!pond) return { ok: false, reason: 'no_site' };
        memory.pond = pond;
        ctx.record('device_site', { kind: pond.kind, anchor: pond.anchor, facing: pond.facing });
      }
      const s = inspect();
      if (s.dig) {
        // Standing on a cell about to be dug drops the bot into the pond.
        const feet = bot.entity.position.floored();
        if (memory.pond.pond.some((c) => c.x === feet.x && c.y === feet.y - 1 && c.z === feet.z)) return goStand(ctx);
        const block = blockAt(s.dig);
        const reach = await actions.goToDig(bot, ctx, block);
        if (!reach.ok) return reach;
        return actions.digBlock(bot, ctx, block);
      }
      if (s.dry) {
        // Both buckets in: the cells between the two sources fill by themselves.
        if (!bot.inventory.items().some((item) => item.name === 'water_bucket')) {
          if (await waitUntil(() => inspect().full, { timeoutMs: 3000, signal: ctx.signal })) return { ok: true };
          const spare = memory.pond.pond.find(isSource);
          if (!spare) return { ok: false, reason: 'no_material', missing: [{ name: 'water_bucket', short: 1 }] };
          return skills.scoopLiquid(bot, ctx, spare, 'water');
        }
        return skills.pourLiquid(bot, ctx, s.dry, 'water');
      }
      if (!s.full && !(await waitUntil(() => inspect().full, { timeoutMs: 3000, signal: ctx.signal }))) {
        return { ok: false, reason: 'pond_not_full' };
      }
      return cast(ctx);
    },
  };
}

module.exports = { createFishingGoal, choosePondSite, evaluatePondSite };
