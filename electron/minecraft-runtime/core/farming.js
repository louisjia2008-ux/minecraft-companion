'use strict';
// Wheat farming skills: pick plots by water, till, plant, harvest, gather
// seeds. Each function does one thing and confirms it against the world
// (the block that is there afterwards), like every other skill.

const { Vec3 } = require('vec3');
const actions = require('./actions');
const { waitUntil } = require('./confirm');
const { posKey } = require('./blacklist');

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const isAbort = (error) => error?.code === 'aborted';
const v = (p) => new Vec3(p.x, p.y, p.z);
const TILLABLE = new Set(['grass_block', 'dirt', 'dirt_path', 'coarse_dirt', 'rooted_dirt']);
const SOFT_ABOVE = (b) => !b || b.boundingBox === 'empty' && !/water|lava/.test(b.name);
const RIPE = 7;

const isSourceWater = (b) => b?.name === 'water' && Number(b.getProperties?.().level ?? b.metadata ?? 0) === 0;

/**
 * Up to `count` ground cells to farm near `center`. Vanilla keeps farmland
 * moist with water up to 4 blocks away horizontally, at its own level or one
 * above, so plots sit beside a water source at or one below its level.
 * Without water nearby, dry plots next to `center` still grow, more slowly.
 */
function choosePlots(blockAt, center, { count = 16, radius = 24, exclude = () => false, findWater } = {}) {
  const c = { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) };
  const usable = (p) => {
    const ground = blockAt(p);
    return ground && TILLABLE.has(ground.name) && SOFT_ABOVE(blockAt({ ...p, y: p.y + 1 })) && !exclude(p);
  };
  const waters = (findWater ? findWater(c, radius) : []).filter((w) => w.y >= c.y - 6 && w.y <= c.y + 2);
  const plots = new Map();
  const distance = (p) => Math.hypot(p.x - c.x, p.z - c.z);
  for (const w of waters.sort((a, b) => distance(a) - distance(b))) {
    for (let dx = -4; dx <= 4; dx += 1) {
      for (let dz = -4; dz <= 4; dz += 1) {
        for (const y of [w.y, w.y - 1]) {
          const p = { x: w.x + dx, y, z: w.z + dz };
          if (!plots.has(posKey(p)) && usable(p)) plots.set(posKey(p), { ...p, hydrated: true });
        }
      }
    }
    if (plots.size >= count) break;
  }
  if (plots.size < count) {
    // Dry fallback: the ground right around the centre.
    for (let r = 2; r <= 8 && plots.size < count; r += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        for (let dz = -r; dz <= r; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          for (const dy of [-1, -2, 0]) {
            const p = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
            if (!plots.has(posKey(p)) && usable(p)) { plots.set(posKey(p), { ...p, hydrated: false }); break; }
          }
        }
      }
    }
  }
  return [...plots.values()]
    .sort((a, b) => (b.hydrated - a.hydrated) || distance(a) - distance(b))
    .slice(0, count);
}

function findWater(bot, center, radius) {
  const id = bot.registry.blocksByName.water?.id;
  if (id === undefined) return [];
  return bot.findBlocks({ matching: id, point: v(center), maxDistance: radius, count: 64 })
    .map((p) => bot.blockAt(p))
    .filter((b) => isSourceWater(b) && SOFT_ABOVE(bot.blockAt(b.position.offset(0, 1, 0))))
    .map((b) => ({ x: b.position.x, y: b.position.y, z: b.position.z }));
}

/** What a plot needs next, read from the world. */
function plotState(bot, plot) {
  const ground = bot.blockAt(v(plot));
  const above = bot.blockAt(v(plot).offset(0, 1, 0));
  if (!ground || !above) return 'unknown';
  if (ground.name === 'farmland') {
    if (above.name === 'wheat') return Number(above.getProperties?.().age ?? 0) >= RIPE ? 'ripe' : 'growing';
    return SOFT_ABOVE(above) ? 'empty' : 'blocked';
  }
  if (TILLABLE.has(ground.name)) return SOFT_ABOVE(above) ? 'untilled' : 'blocked';
  return 'lost';
}

async function equip(bot, match) {
  const item = bot.inventory.items().find((i) => match(i.name));
  if (!item) return false;
  try { await bot.equip(item, 'hand'); } catch { return false; }
  return bot.heldItem && match(bot.heldItem.name);
}

async function reach(bot, ctx, p) {
  if (actions.withinReach(bot, v(p).offset(0.5, 0.5, 0.5), 4)) return { ok: true };
  // Stand beside the plot, not on it: jumping onto farmland tramples it.
  const moved = await actions.goNear(bot, ctx, v(p).offset(0.5, 1, 0.5), 2, { timeoutMs: 30000 });
  return actions.withinReach(bot, v(p).offset(0.5, 0.5, 0.5), 4.5) ? { ok: true } : (moved.ok ? fail('out_of_reach') : moved);
}

/** Walks back towards the farm until its plots are in loaded chunks again. */
async function returnTo(bot, ctx, p) {
  const moved = await actions.goNear(bot, ctx, v(p).offset(0.5, 1, 0.5), 4, { timeoutMs: 60000 });
  return plotState(bot, p) === 'unknown' ? (moved.ok ? fail('farm_out_of_sight') : moved) : { ok: true };
}

async function useOn(bot, ctx, block) {
  try {
    await bot.lookAt(block.position.offset(0.5, 1, 0.5), true);
    await bot.activateBlock(block, new Vec3(0, 1, 0));
  } catch (error) {
    if (isAbort(error)) throw error;
  }
}

/** Hoe a grass or dirt block into farmland; plants on top are cleared first. */
async function till(bot, ctx, plot) {
  const moved = await reach(bot, ctx, plot);
  if (!moved.ok) return moved;
  const above = bot.blockAt(v(plot).offset(0, 1, 0));
  if (above && above.name !== 'air' && SOFT_ABOVE(above)) {
    const cleared = await actions.digBlock(bot, ctx, above);
    if (!cleared.ok) return cleared;
  }
  if (!await equip(bot, (n) => n.endsWith('_hoe'))) return fail('no_hoe');
  await useOn(bot, ctx, bot.blockAt(v(plot)));
  const done = await waitUntil(() => bot.blockAt(v(plot))?.name === 'farmland', { timeoutMs: 1500, signal: ctx.signal });
  return done ? { ok: true } : fail('till_unconfirmed');
}

async function plant(bot, ctx, plot, seed = 'wheat_seeds') {
  const moved = await reach(bot, ctx, plot);
  if (!moved.ok) return moved;
  if (!await equip(bot, (n) => n === seed)) return fail('no_seeds');
  await useOn(bot, ctx, bot.blockAt(v(plot)));
  const done = await waitUntil(() => bot.blockAt(v(plot).offset(0, 1, 0))?.name === 'wheat', { timeoutMs: 1500, signal: ctx.signal });
  return done ? { ok: true } : fail('plant_unconfirmed');
}

async function harvest(bot, ctx, plot) {
  const moved = await reach(bot, ctx, plot);
  if (!moved.ok) return moved;
  const crop = bot.blockAt(v(plot).offset(0, 1, 0));
  if (crop?.name !== 'wheat') return fail('no_crop');
  const before = actions.countItems(bot, (n) => n === 'wheat');
  const dug = await actions.digBlock(bot, ctx, crop);
  if (!dug.ok) return dug;
  await actions.collectDrops(bot, ctx, crop.position.offset(0.5, 0.5, 0.5), (n) => n === 'wheat' || n === 'wheat_seeds',
    { radius: 4, timeoutMs: 3000 });
  return { ok: true, gained: actions.countItems(bot, (n) => n === 'wheat') - before };
}

/** Breaks the nearest grass for a chance (1 in 8) at seeds. */
async function gatherSeeds(bot, ctx, { radius = 32, blacklist, exclude = () => false } = {}) {
  const ids = ['short_grass', 'tall_grass'].map((n) => bot.registry.blocksByName[n]?.id).filter(Number.isInteger);
  const here = bot.entity.position;
  const grass = bot.findBlocks({ matching: ids, maxDistance: radius, count: 32 })
    .filter((p) => !blacklist?.has(`grass:${posKey(p)}`) && !exclude(p))
    .sort((a, b) => a.distanceTo(here) - b.distanceTo(here))
    .map((p) => bot.blockAt(p)).filter(Boolean)[0];
  if (!grass) return fail('no_grass');
  blacklist?.add(`grass:${posKey(grass.position)}`, 'tried');
  const moved = await actions.goToDig(bot, ctx, grass, { timeoutMs: 30000 });
  if (!moved.ok) return moved;
  const before = actions.countItems(bot, (n) => n === 'wheat_seeds');
  const dug = await actions.digBlock(bot, ctx, grass);
  if (!dug.ok) return dug;
  await actions.collectDrops(bot, ctx, grass.position.offset(0.5, 0.5, 0.5), (n) => n === 'wheat_seeds', { radius: 3, timeoutMs: 1500 });
  // No seed this time is still a block of work done, not a failure.
  return { ok: true, seeds: actions.countItems(bot, (n) => n === 'wheat_seeds') - before };
}

module.exports = { choosePlots, findWater, plotState, till, plant, harvest, gatherSeeds, returnTo, TILLABLE, RIPE };
