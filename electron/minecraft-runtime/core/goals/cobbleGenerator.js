'use strict';
// Goal: build a cobblestone generator (blueprints/cobbleGenerator.js) and prove
// it works by mining `harvest` cobblestone that it regenerated.
//
// Every run() looks at the world and does exactly one thing:
//   1. no site yet           -> choose flat, solid ground near the bot
//   2. a seal cell is open   -> fill it with cobblestone or dirt
//   3. an open cell is solid -> dig it out
//   4. no water source       -> pour the water bucket
//   5. no lava source        -> pour the lava bucket (only once the pit holds water)
//   6. device works          -> stand in S, mine C, see it come back
// The only memory kept across runs is the site and the harvest count, which
// counts only cobblestone seen regenerating in C and arriving in the inventory.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { createCobbleGenerator, FACINGS } = require('../blueprints/cobbleGenerator');
const { createBlacklist } = require('../blacklist');
const { sleep, waitUntil } = require('../confirm');

const FILLERS = ['cobblestone', 'dirt', 'cobbled_deepslate', 'stone', 'coarse_dirt'];
const LIQUID = new Set(['water', 'lava', 'bubble_column']);
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/;
const DIGGABLE = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'stone',
  'andesite', 'diorite', 'granite', 'cobblestone', 'cobbled_deepslate', 'deepslate', 'tuff', 'clay', 'mud',
  'terracotta', 'moss_block', 'netherrack']);
const REGENERATE_MS = 5000;

const isAir = (block) => !block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
const isSoft = (block) => isAir(block) || (block.boundingBox === 'empty' && !LIQUID.has(block.name));
// Lava burns flammable neighbours away (with fire ticks on), opening the seal.
const FLAMMABLE = /(_log|_wood|_stem|_hyphae|_leaves|_planks|_wool|_carpet|_slab|_stairs|_fence|bookshelf|hay_block|scaffolding|tnt|bamboo|dried_kelp_block|target|beehive|bee_nest|moss_block|coal_block)$/;
const isSeal = (block) => Boolean(block) && block.boundingBox === 'block' && !LIQUID.has(block.name)
  && !GRAVITY.test(block.name) && !FLAMMABLE.test(block.name);
const key = (p) => `${p.x},${p.y},${p.z}`;

/**
 * Scores a generator at `anchor` facing `facing`; null when it cannot be built
 * without terraforming. `blockAt(x, y, z)` returns null for unloaded chunks.
 */
function evaluateGeneratorSite(blockAt, anchor, facing, options = {}) {
  const device = createCobbleGenerator(anchor, facing, options);
  const at = (p) => blockAt(p.x, p.y, p.z);
  let fixes = 0;
  for (const p of [...device.open, ...device.parts.map((part) => part.position)]) {
    const block = at(p);
    if (!block) return null;
    if (!DIGGABLE.has(block.name)) return null;
  }
  for (const p of device.seal) {
    const block = at(p);
    if (!block || LIQUID.has(block.name)) return null;
    if (isSeal(block)) continue;
    if (!isSoft(block)) return null;
    fixes += 1;
  }
  for (const p of device.clearAbove) {
    const block = at(p);
    if (!block || !isSoft(block)) return null;
  }
  return { device, fixes };
}

/** Nearest buildable spot around `around`; `avoid(p)` rules out cells that belong to something else (the house). */
function chooseGeneratorSite(blockAt, around, { radius = 10, collector = false, avoid = null } = {}) {
  const origin = { x: Math.floor(around.x), y: Math.floor(around.y), z: Math.floor(around.z) };
  let best = null;
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      // The lava cell is the top solid block of its column.
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
        const site = evaluateGeneratorSite(blockAt, { x: origin.x + dx, y, z: origin.z + dz }, facing, { collector });
        if (!site || (avoid && footprint(site.device).some(avoid))) continue;
        // Keep a clear gap from the bot's own feet: it must not stand in a cell to dig.
        const score = site.fixes * 4 + Math.hypot(dx, dz) + Math.abs(y + 1 - origin.y) * 2 + (Math.hypot(dx, dz) < 3 ? 6 : 0);
        if (!best || score < best.score) best = { ...site, score };
      }
    }
  }
  return best ? best.device : null;
}

// Every cell the device digs, seals or keeps clear.
const footprint = (device) => [...device.open, ...device.seal, ...device.clearAbove, ...device.parts.map((part) => part.position)];

function createCobbleGeneratorGoal({ bot, anchor = null, facing = 'east', harvest = 8, collector = false, avoid = null,
  skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(harvest) || harvest < 1) throw new TypeError('harvest must be a positive integer');
  const memory = {
    device: anchor ? createCobbleGenerator(anchor, facing, { collector }) : null,
    harvested: 0,
    regenerated: 0,
    guarded: false,
  };
  const blacklist = createBlacklist({ ttlMs: 60000 });
  const blockAt = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));

  // The pathfinder must never walk into the liquid cells or C (lava flows in
  // behind a mined cobblestone), nor break the seal while routing.
  function guardDevice() {
    const movements = bot.pathfinder?.movements;
    if (memory.guarded || !movements || !memory.device) return;
    memory.guarded = true;
    const d = memory.device;
    // Standing on top of L, C, P or W is as bad: digging there drops the bot in.
    const above = (p) => ({ x: p.x, y: p.y + 1, z: p.z });
    const noStep = new Set(liquidCells().flatMap((p) => [p, above(p)]).map(key));
    const noBreak = new Set([...d.seal, d.cells.cobble].map(key));
    // Until the collector is in, S and the cells under it are holes to dig, not
    // places to stand: digging S's floor from S drops the bot into a 1x1 shaft.
    const collectorCells = new Set(d.parts.flatMap((part) => [part.position, above(part.position)]).map(key));
    movements.exclusionAreasStep.push((block) => {
      if (!block?.position) return 0;
      const k = key(block.position);
      if (noStep.has(k)) return 1000;
      return collectorCells.has(k) && d.parts.some((part) => !partOk(part)) ? 1000 : 0;
    });
    movements.exclusionAreasBreak.push((block) => (block?.position && noBreak.has(key(block.position)) ? 100 : 0));
  }

  const liquidCells = () => {
    const c = memory.device.cells;
    return [c.lava, c.cobble, c.pitTop, c.pitBottom, c.water];
  };

  const facingOf = (block) => block?.getProperties?.().facing;
  const partOk = (part) => {
    const block = blockAt(part.position);
    return block?.name === part.block && (!part.facing || facingOf(block) === part.facing);
  };

  // In one of L, C, P or W, or standing on one (and about to dig it out), or
  // above a collector part still to be dug out or placed.
  function trappedCell() {
    const feet = bot.entity.position.floored();
    const pending = memory.device.parts.filter((part) => !partOk(part)).map((part) => part.position);
    return [...liquidCells(), ...pending].find((p) => feet.x === p.x && feet.z === p.z && feet.y >= p.y && feet.y <= p.y + 1) || null;
  }

  // Out of the pit or off a cell: swim up through the pit's water, otherwise
  // walk off, otherwise the generic unstick (which may pillar out of a dry pit).
  async function stepOff(ctx) {
    const cell = trappedCell();
    if (!cell) return { ok: true };
    const surfaceY = memory.device.anchor.y + 1;
    if (bot.entity.position.y < surfaceY - 0.5 && bot.entity.isInWater) {
      const exit = memory.device.cells.stand;
      try {
        await bot.lookAt(new Vec3(exit.x + 0.5, surfaceY + 1.6, exit.z + 0.5), true);
        bot.setControlState('jump', true);
        bot.setControlState('forward', true);
        await waitUntil(() => !trappedCell(), { timeoutMs: 4000, signal: ctx.signal });
      } finally {
        bot.setControlState('jump', false);
        bot.setControlState('forward', false);
      }
      if (!trappedCell()) return { ok: true };
    }
    const away = new goals.GoalInvert(new goals.GoalNear(cell.x, surfaceY, cell.z, 1));
    await actions.goTo(bot, ctx, away, { timeoutMs: 10000, arrived: () => !trappedCell() });
    if (!trappedCell()) return { ok: true };
    const result = await actions.unstick(bot, ctx);
    ctx.record('device_step_off', { from: key(cell), result: result.ok ? result.moved : result.reason });
    return trappedCell() ? { ok: false, reason: 'trapped_in_device' } : { ok: true };
  }

  function inspect() {
    const d = memory.device;
    if (!d) return null;
    const c = d.cells;
    const lava = skills.isFluidSource(blockAt(c.lava), 'lava');
    const water = skills.isFluidSource(blockAt(c.water), 'water');
    const openSeal = d.seal.filter((p) => !isSeal(blockAt(p)));
    const accepts = (p, name) => {
      if (isAir({ name })) return true;
      if (p === c.lava) return name === 'lava';
      if (p === c.water || p === c.pitTop || p === c.pitBottom) return name === 'water';
      if (p === c.cobble) return (lava && name === 'cobblestone') || name === 'lava';
      return false; // the standing cell stays empty
    };
    const toDig = d.open.filter((p) => { const b = blockAt(p); return b && !accepts(p, b.name); });
    const headBlocked = !isSoft(blockAt(c.head));
    const pitWater = blockAt(c.pitBottom)?.name === 'water';
    const nextPart = d.parts.find((part) => !partOk(part)) || null;
    const working = lava && water && pitWater && openSeal.length === 0 && toDig.length === 0 && !nextPart;
    return { lava, water, pitWater, openSeal, toDig, headBlocked, nextPart, working };
  }

  function progressOf() {
    const s = inspect();
    if (!s) return 0;
    const d = memory.device;
    const built = (d.seal.length - s.openSeal.length) + (d.open.length - s.toDig.length)
      + d.parts.filter(partOk).length + (s.water ? 1 : 0) + (s.lava ? 1 : 0);
    return built + memory.regenerated + memory.harvested;
  }

  // Exactly into S: from the surface next to it the drop is out of pickup range.
  async function goToStand(ctx) {
    const c = memory.device.cells;
    const stand = new Vec3(c.stand.x, c.stand.y, c.stand.z);
    // Standing on the collector chest (0.875 high) puts the feet just below S.
    const inStand = () => {
      const at = bot.entity.position;
      return Math.floor(at.x) === stand.x && Math.floor(at.z) === stand.z && Math.abs(at.y - stand.y) < 0.5;
    };
    if (inStand()) return { ok: true };
    const moved = await actions.goTo(bot, ctx, new goals.GoalXZ(stand.x, stand.z), {
      timeoutMs: 30000, arrived: inStand,
    });
    if (inStand()) return { ok: true };
    ctx.record('stand_unreached', { reason: moved.reason, at: bot.entity.position.toString(),
      stand: stand.toString(), cells: Object.fromEntries(Object.entries(c).map(([k, p]) => [k, blockAt(p)?.name])) });
    return moved.ok ? { ok: false, reason: 'not_in_stand' } : moved;
  }

  async function harvestOnce(ctx) {
    const c = memory.device.cells;
    const moved = await goToStand(ctx);
    if (!moved.ok) return moved;
    let block = blockAt(c.cobble);
    if (block?.name !== 'cobblestone') {
      // Just mined (by us or someone else): lava needs about 1.5 s to flow back.
      const back = await waitUntil(() => blockAt(c.cobble)?.name === 'cobblestone', { timeoutMs: REGENERATE_MS, signal: ctx.signal });
      if (!back) return { ok: false, reason: 'no_regeneration' };
      block = blockAt(c.cobble);
    }
    if (memory.device.collector && (memory.regenerated >= memory.harvested + 4 || memory.regenerated >= harvest)) {
      // Empty the collector chest under S now and then; the hopper fills it.
      const taken = await skills.takeItems(bot, ctx, { position: c.collectorChest, itemMatch: (n) => n === 'cobblestone' });
      if (taken.ok) memory.harvested += taken.taken;
      ctx.record('generator_collect', { ok: taken.ok, reason: taken.reason, harvested: memory.harvested });
      if (taken.ok || memory.harvested >= harvest) return taken;
    }
    const before = actions.countItems(bot, (n) => n === 'cobblestone');
    const dug = await actions.digBlock(bot, ctx, block);
    if (!dug.ok) return dug;
    // The drop lands at the bot's feet; it is picked up without moving (10-tick delay).
    const back = await waitUntil(() => blockAt(c.cobble)?.name === 'cobblestone', { timeoutMs: REGENERATE_MS, signal: ctx.signal });
    if (back) memory.regenerated += 1;
    if (memory.device.collector) {
      ctx.record('generator_harvest', { regenerated: back, count: memory.regenerated });
      return back ? { ok: true } : { ok: false, reason: 'no_regeneration' };
    }
    const got = actions.countItems(bot, (n) => n === 'cobblestone') > before
      || await waitUntil(() => actions.countItems(bot, (n) => n === 'cobblestone') > before, { timeoutMs: 1000, signal: ctx.signal });
    if (got && back) memory.harvested += actions.countItems(bot, (n) => n === 'cobblestone') - before;
    ctx.record('generator_harvest', { picked: got, regenerated: back, harvested: memory.harvested,
      at: bot.entity.position.floored().toString() });
    if (!back) return { ok: false, reason: 'no_regeneration' };
    return got ? { ok: true } : { ok: false, reason: 'drop_not_collected' };
  }

  // Items still to be brought for the parts not yet in the world, as
  // knowledge keys; before a site is chosen, everything a site may take.
  function needs() {
    const s = inspect();
    if (!s) {
      const probe = createCobbleGenerator({ x: 0, y: 0, z: 0 }, 'east', { collector });
      return [{ key: 'water_bucket', count: 1 }, { key: 'lava_bucket', count: 1 }, { key: 'cobblestone', count: Math.min(probe.seal.length, 12) },
        ...probe.parts.map((part) => ({ key: part.block, count: 1 }))];
    }
    const list = [];
    if (!s.water) list.push({ key: 'water_bucket', count: 1 });
    if (!s.lava) list.push({ key: 'lava_bucket', count: 1 });
    if (s.openSeal.length) list.push({ key: 'cobblestone', count: s.openSeal.length });
    for (const part of memory.device.parts) if (!partOk(part)) list.push({ key: part.block, count: 1 });
    return list;
  }

  return {
    name: 'cobble_generator',
    memory,
    needs,
    noProgressLimit: 8,
    isDone: () => Boolean(inspect()?.working) && memory.harvested >= harvest,
    progress: progressOf,
    async run(ctx) {
      if (!memory.device) {
        const p = bot.entity.position;
        const device = chooseGeneratorSite((x, y, z) => bot.blockAt(new Vec3(x, y, z)), p, { collector, avoid });
        if (!device) return { ok: false, reason: 'no_site' };
        memory.device = device;
        ctx.record('device_site', { kind: device.kind, anchor: device.anchor, facing: device.facing });
      }
      guardDevice();
      if (trappedCell()) return stepOff(ctx);
      const s = inspect();
      const d = memory.device;

      if (s.openSeal.length) {
        const target = s.openSeal.find((p) => !blacklist.has(key(p))) || s.openSeal[0];
        const result = await skills.placeAt(bot, ctx, target, (n) => FILLERS.includes(n));
        if (!result.ok) blacklist.add(key(target), result.reason);
        return result;
      }
      if (s.toDig.length || s.headBlocked) {
        const target = s.toDig[0] || d.cells.head;
        const block = blockAt(target);
        const reach = await actions.goToDig(bot, ctx, block);
        if (!reach.ok) return reach;
        return actions.digBlock(bot, ctx, block);
      }
      if (s.nextPart) {
        const part = s.nextPart;
        if (!isAir(blockAt(part.position))) {
          const block = blockAt(part.position);
          const reach = await actions.goToDig(bot, ctx, block);
          if (!reach.ok) return reach;
          return actions.digBlock(bot, ctx, block);
        }
        const toward = new Vec3(part.against.x - part.position.x, part.against.y - part.position.y, part.against.z - part.position.z);
        const result = await skills.placeAt(bot, ctx, part.position, (n) => n === part.block, {
          faces: [toward], sneak: Boolean(part.sneak), verify: () => partOk(part),
        });
        ctx.record('device_part', { part: part.key, ok: result.ok, reason: result.reason, facing: facingOf(blockAt(part.position)) });
        return result;
      }
      if (!s.water) return skills.pourLiquid(bot, ctx, d.cells.water, 'water');
      if (!s.pitWater) {
        // Flowing water takes a few ticks to fill the pit.
        const filled = await waitUntil(() => blockAt(d.cells.pitBottom)?.name === 'water', { timeoutMs: 3000, signal: ctx.signal });
        return filled ? { ok: true } : { ok: false, reason: 'pit_not_filled' };
      }
      if (!s.lava) {
        const result = await skills.pourLiquid(bot, ctx, d.cells.lava, 'lava');
        if (result.ok) await sleep(500, ctx.signal);
        return result;
      }
      return harvestOnce(ctx);
    },
  };
}

module.exports = { createCobbleGeneratorGoal, chooseGeneratorSite, evaluateGeneratorSite };
