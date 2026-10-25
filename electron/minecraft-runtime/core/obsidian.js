'use strict';
// Obsidian from two buckets, the way a player casts it: lava poured into a
// one-block pit turns to obsidian when water runs over it, and a diamond
// pickaxe mines it out. The pit (the mold) stays and is reused for every block.
//
// castStep does one thing per call, decided from the blocks:
//   1. no usable mold          -> choose one near the bot: a ground cell with
//                                 solid walls and floor, open air above, and a
//                                 dry cell beside its mouth for the water
//   2. pit holds obsidian      -> take the water back if it is still out, then mine it
//   3. pit holds lava          -> pour water beside the mouth; it runs over the lava
//   4. pit is solid            -> dig it out
//   5. pit is empty            -> pour the lava bucket in
// The only memory is the mold: { pit, water } cell positions.

const { Vec3 } = require('vec3');
const defaultSkills = require('./skills');
const defaultActions = require('./actions');
const { posKey } = require('./blacklist');
const { waitUntil } = require('./confirm');

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const AIR = new Set(['air', 'cave_air', 'void_air']);
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
// Soil and rock a pit can be dug in, that lava does not burn and nothing falls into.
const MOLD = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'stone', 'andesite', 'diorite',
  'granite', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'tuff', 'obsidian']);
const DIAMOND_PICKS = new Set(['diamond_pickaxe', 'netherite_pickaxe']);
// 9.4 s with a diamond pickaxe on the ground; five times that in water.
const OBSIDIAN_DIG_MS = 15000;
const WET_DIG_MS = 60000;

const v = (p) => new Vec3(p.x, p.y, p.z);
const isAir = (b) => Boolean(b) && AIR.has(b.name);
const solid = (b) => Boolean(b) && b.boundingBox === 'block' && MOLD.has(b.name);
const has = (bot, name) => bot.inventory.items().some((i) => i.name === name);

/** True when `pit` and `water` still make a mold: walls, floor and the water's floor solid, air above. */
function moldOk(bot, mold) {
  const pit = v(mold.pit);
  const water = v(mold.water);
  const inPit = bot.blockAt(pit);
  if (!inPit) return false;
  if (!solid(inPit) && !isAir(inPit) && !/^(lava|obsidian)$/.test(inPit.name)) return false;
  if (!solid(bot.blockAt(pit.offset(0, -1, 0)))) return false;
  for (const [dx, dz] of SIDES) if (!solid(bot.blockAt(pit.offset(dx, 0, dz)))) return false;
  if (!isAir(bot.blockAt(pit.offset(0, 1, 0))) && bot.blockAt(pit.offset(0, 1, 0))?.name !== 'water') return false;
  const atWater = bot.blockAt(water);
  return Boolean(atWater) && (isAir(atWater) || atWater.name === 'water') && solid(bot.blockAt(water.offset(0, -1, 0)));
}

// The water runs up to 7 blocks: kept off the lava and water pools it would
// otherwise turn to stone (the lava the next casts come from).
const DRY_RADIUS = 9;
const SEARCH = 16;

function liquidsNear(bot) {
  if (typeof bot.findBlocks !== 'function') return [];
  const ids = ['lava', 'water'].map((n) => bot.registry?.blocksByName[n]?.id).filter(Number.isInteger);
  if (!ids.length) return [];
  return bot.findBlocks({ matching: ids, maxDistance: SEARCH + DRY_RADIUS, count: 512 });
}

/** The nearest mold site 3-16 blocks from the bot, on its ground (or a step off), away from liquids. */
function findMold(bot, { avoid = () => false } = {}) {
  const here = bot.entity.position.floored();
  const wet = liquidsNear(bot);
  const dry = (p) => !wet.some((w) => Math.abs(w.x - p.x) <= DRY_RADIUS && Math.abs(w.z - p.z) <= DRY_RADIUS
    && Math.abs(w.y - p.y) <= 2);
  let best = null;
  for (let dx = -SEARCH; dx <= SEARCH; dx += 1) {
    for (let dz = -SEARCH; dz <= SEARCH; dz += 1) {
      const d = Math.abs(dx) + Math.abs(dz);
      if (d < 3 || (best && d >= best.d)) continue;
      for (const dy of [-1, -2, 0]) {
        const pit = here.offset(dx, dy, dz);
        if (avoid(pit) || !solid(bot.blockAt(pit)) || bot.blockAt(pit).name === 'obsidian' || !dry(pit)) continue;
        if (!isAir(bot.blockAt(pit.offset(0, 1, 0))) || !isAir(bot.blockAt(pit.offset(0, 2, 0)))) continue;
        for (const [sx, sz] of SIDES) {
          const mold = { pit, water: pit.offset(sx, 1, sz) };
          if (moldOk(bot, mold) && isAir(bot.blockAt(mold.water)) && isAir(bot.blockAt(mold.water.offset(0, 1, 0)))) {
            best = { ...mold, d };
            break;
          }
        }
        if (best?.d === d) break;
      }
    }
  }
  return best ? { pit: best.pit, water: best.water } : null;
}

/** A cast under way: obsidian or lava in the pit, or the water still out. Finished before anything else. */
function pending(bot, mold) {
  if (!mold) return false;
  const inPit = bot.blockAt(v(mold.pit))?.name;
  if (inPit === 'obsidian') return true;
  if (inPit === 'lava' && has(bot, 'water_bucket')) return true;
  const water = bot.blockAt(v(mold.water));
  return water?.name === 'water' && defaultSkills.isFluidSource(water, 'water') && has(bot, 'bucket');
}

async function castStep(bot, ctx, memory, { skills = defaultSkills, actions = defaultActions, avoid } = {}) {
  if (memory.cast && !moldOk(bot, memory.cast)) {
    ctx.record('mold_lost', { pit: posKey(memory.cast.pit) });
    memory.cast = null;
  }
  if (!memory.cast) {
    const mold = findMold(bot, { avoid });
    if (!mold) return fail('no_mold_site');
    memory.cast = mold;
    ctx.record('mold_chosen', { pit: posKey(mold.pit), water: posKey(mold.water) });
  }
  const { pit, water } = { pit: v(memory.cast.pit), water: v(memory.cast.water) };
  const block = bot.blockAt(pit);
  const waterOut = skills.isFluidSource(bot.blockAt(water), 'water');
  ctx.record('cast_step', { pit: block.name, water: bot.blockAt(water)?.name || null });
  if (block.name === 'obsidian') {
    // The water first: it is the only one there is, and it would run into the empty pit.
    if (waterOut && has(bot, 'bucket')) return skills.scoopLiquid(bot, ctx, water, 'water');
    const pick = bot.inventory.items().find((i) => DIAMOND_PICKS.has(i.name));
    if (!pick) return fail('no_diamond_pickaxe');
    const reach = await actions.goToDig(bot, ctx, block, { timeoutMs: 30000 });
    if (!reach.ok) return reach;
    // The water runs off a few seconds after its source is gone: digging in it is slow.
    await waitUntil(() => !bot.entity.isInWater, { timeoutMs: 8000, signal: ctx.signal });
    const target = bot.blockAt(pit);
    try { await bot.equip(pick, 'hand'); } catch { /* digBlock equips again */ }
    ctx.record('obsidian_dig', { digMs: bot.digTime?.(target), inWater: bot.entity.isInWater, onGround: bot.entity.onGround,
      at: posKey(bot.entity.position.floored()), held: bot.heldItem?.name || null, effects: Object.keys(bot.entity.effects || {}) });
    const dug = await actions.digBlock(bot, ctx, target, { tool: pick,
      timeoutMs: bot.entity.isInWater ? WET_DIG_MS : OBSIDIAN_DIG_MS });
    if (!dug.ok) return dug;
    const got = await actions.collectDrops(bot, ctx, pit.offset(0.5, 0.5, 0.5), (n) => n === 'obsidian');
    ctx.record('obsidian_cast', { ok: got.ok });
    return got;
  }
  if (block.name === 'lava') {
    if (!skills.isFluidSource(block, 'lava')) {
      // Never back at once with nothing done: the goal would spin on it.
      await waitUntil(() => bot.blockAt(pit)?.name !== 'lava', { timeoutMs: 2000, signal: ctx.signal });
      return fail('lava_flowing');
    }
    if (waterOut) {
      // Water is out but the lava is still there: it may take a tick or two.
      const set = await waitUntil(() => bot.blockAt(pit)?.name === 'obsidian', { timeoutMs: 3000, signal: ctx.signal });
      if (set) return { ok: true };
      ctx.record('cast_stuck', { pit: bot.blockAt(pit)?.name, mouth: bot.blockAt(pit.offset(0, 1, 0))?.name,
        water: bot.blockAt(water)?.name });
      // Take it back and pour again.
      if (has(bot, 'bucket')) return skills.scoopLiquid(bot, ctx, water, 'water');
      return fail('lava_not_set');
    }
    return skills.pourLiquid(bot, ctx, water, 'water');
  }
  // An empty pit with water around would flood: take the water back first.
  if (waterOut && has(bot, 'bucket')) return skills.scoopLiquid(bot, ctx, water, 'water');
  if (!isAir(block)) {
    const reach = await actions.goToDig(bot, ctx, block, { timeoutMs: 30000 });
    if (!reach.ok) return reach;
    return actions.digBlock(bot, ctx, bot.blockAt(pit));
  }
  if (!has(bot, 'lava_bucket')) return fail('no_material', { missing: [{ name: 'lava_bucket', short: 1 }] });
  return skills.pourLiquid(bot, ctx, pit, 'lava');
}

module.exports = { castStep, findMold, moldOk, pending };
