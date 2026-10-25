'use strict';
// Shared goal for button-driven duplicators (carpet, rail): build the device
// from its blueprint, then press its button until `count` new items of the
// product are in the inventory.
//
// Every run() looks at the world and does exactly one thing:
//   1. no site yet             -> choose flat, solid ground near the bot
//   2. a hollow cell is filled -> dig it out (slime must not touch the ground)
//   3. a part is missing/wrong -> dig the wrong block, or place the part
//                                 (facings checked on the server's block state)
//   4. items lying nearby      -> pick them up
//   5. otherwise               -> stand by the button and press it once
// Only products gained beyond the seed item (placed as a part) count.
//
// A blueprint returns { kind, anchor, facing, parts, floor, clear, hollow,
// cells: { stand, button, buttonAim?, drop }, noStep }. A floor button is aimed
// at just above its cell's floor; a wall button at `buttonAim`.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { FACINGS } = require('../blueprints/cobbleGenerator');
const { sleep, waitUntil } = require('../confirm');

const LIQUID = new Set(['water', 'lava', 'bubble_column']);
// A stone button stays pressed 20 ticks; the sticky piston then pulls the slime back.
const CYCLE_MS = 1600;
// Hollow cells are dug out: only plain soil or stone.
const DIGGABLE = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'mud', 'moss_block',
  'stone', 'andesite', 'diorite', 'granite', 'cobblestone', 'clay', 'terracotta', 'deepslate', 'tuff']);

const isAir = (block) => !block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
const isSoft = (block) => isAir(block) || (block.boundingBox === 'empty' && !LIQUID.has(block.name));
const isFloor = (block) => Boolean(block) && block.boundingBox === 'block' && !LIQUID.has(block.name)
  && !/^(sand|red_sand|gravel|.*_concrete_powder)$/.test(block.name);
const droppedName = (entity) => { try { return entity.getDroppedItem?.()?.name || null; } catch { return null; } };
const key = (p) => `${p.x},${p.y},${p.z}`;
const v = (p) => new Vec3(p.x, p.y, p.z);

function evaluateDeviceSite(create, blockAt, anchor, facing) {
  const device = create(anchor, facing);
  const at = (p) => blockAt(p.x, p.y, p.z);
  for (const p of device.floor) if (!isFloor(at(p))) return null;
  for (const p of device.clear) if (!isSoft(at(p))) return null;
  for (const p of device.hollow || []) { const b = at(p); if (!isAir(b) && !DIGGABLE.has(b?.name)) return null; }
  return device;
}

/** Nearest flat spot for `create(anchor, facing)`; the anchor is a ground block. */
function chooseDeviceSite(create, blockAt, around, { radius = 8 } = {}) {
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
        const device = evaluateDeviceSite(create, blockAt, { x: origin.x + dx, y, z: origin.z + dz }, facing);
        if (!device) continue;
        // Not right where the bot stands: it would be in the way of its own parts.
        const score = Math.hypot(dx, dz) + Math.abs(y + 1 - origin.y) * 2 + (Math.hypot(dx, dz) < 3 ? 6 : 0);
        if (!best || score < best.score) best = { device, score };
      }
    }
  }
  return best ? best.device : null;
}

function createDuperGoal({ bot, name, create, product, seedKey, pickup = (n) => n === product, anchor = null,
  facing = 'east', count = 8, skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  const memory = { device: anchor ? create(anchor, facing) : null, baseline: null, presses: 0, misses: new Map() };
  const blockAt = (p) => bot.blockAt(v(p));
  const facingOf = (block) => block?.getProperties?.().facing;
  const partOk = (part) => {
    const block = blockAt(part.position);
    return block?.name === part.block && (!part.facing || facingOf(block) === part.facing);
  };
  const owned = () => actions.countItems(bot, (n) => n === product);
  // The seed item leaves the inventory when it is placed; it is not a gain.
  const gained = () => {
    if (memory.baseline === null) return 0;
    const seedPlaced = memory.device && partOk(memory.device.parts.find((p) => p.key === seedKey)) ? 1 : 0;
    return Math.max(0, owned() + seedPlaced - memory.baseline);
  };
  // Never dig a part, and keep off the cells the blueprint marks (a fan has no
  // collision but the carpet above it blocks the head, so a path there stalls).
  function guardDevice() {
    const movements = bot.pathfinder?.movements;
    if (memory.guarded || !movements || !memory.device) return;
    memory.guarded = true;
    const d = memory.device;
    const noBreak = new Set(d.parts.map((p) => key(p.position)));
    const noStep = new Set((d.noStep || []).map(key));
    movements.exclusionAreasBreak.push((block) => (block?.position && noBreak.has(key(block.position)) ? 100 : 0));
    movements.exclusionAreasStep.push((block) => (block?.position && noStep.has(key(block.position)) ? 100 : 0));
  }
  const inStand = () => {
    const s = memory.device.cells.stand;
    const at = bot.entity.position;
    return Math.floor(at.x) === s.x && Math.floor(at.z) === s.z && Math.abs(at.y - s.y) < 0.5;
  };
  const inspect = () => {
    const d = memory.device;
    const hollowCells = d.hollow || [];
    const hollow = hollowCells.find((p) => !isAir(blockAt(p))) || null;
    return { hollow, nextPart: d.parts.find((p) => !partOk(p)) || null,
      built: d.parts.filter(partOk).length + hollowCells.filter((p) => isAir(blockAt(p))).length };
  };
  // Drops the bot already failed to reach twice are left alone, so they never
  // hold up the next press.
  const drops = () => Object.values(bot.entities).filter((e) => e.name === 'item' && e.position
    && e.position.distanceTo(v(memory.device.cells.drop)) < 6 && pickup(droppedName(e))
    && (memory.misses.get(e.id) || 0) < 2);
  const lying = () => drops().length > 0;

  // Items land on the ground around the device (some under the slime row,
  // picked up from the next cell) and on top of it (reached over the bridge).
  async function collect(ctx) {
    const before = actions.countItems(bot, pickup);
    const deadline = Date.now() + 15000;
    const near = (e) => e.position.distanceTo(bot.entity.position);
    for (const drop of drops().sort((a, b) => near(a) - near(b))) {
      if (Date.now() >= deadline) break;
      if (!bot.entities[drop.id]) continue;
      await actions.goNear(bot, ctx, drop.position.clone(), 1, { timeoutMs: Math.min(6000, Math.max(1000, deadline - Date.now())) });
      const taken = await waitUntil(() => !bot.entities[drop.id], { timeoutMs: 800, signal: ctx.signal });
      if (!taken) memory.misses.set(drop.id, (memory.misses.get(drop.id) || 0) + 1);
    }
    const left = drops();
    if (left.length && actions.countItems(bot, pickup) <= before) {
      ctx.record(`${name}_drops_out_of_reach`, { items: left.map((e) => ({ name: droppedName(e),
        x: +e.position.x.toFixed(2), y: +e.position.y.toFixed(2), z: +e.position.z.toFixed(2) })) });
    }
    return actions.countItems(bot, pickup) > before ? { ok: true } : { ok: false, reason: 'drops_not_collected' };
  }

  async function press(ctx) {
    const d = memory.device;
    if (!inStand()) {
      const s = d.cells.stand;
      const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(s.x, s.y, s.z), { timeoutMs: 15000, arrived: inStand });
      if (!inStand()) return moved.ok ? { ok: false, reason: 'not_in_stand' } : moved;
    }
    const before = gained();
    const button = blockAt(d.cells.button);
    try {
      await bot.lookAt(v(d.cells.buttonAim || { ...d.cells.button, y: d.cells.button.y + 0.1 }).offset(0.5, 0, 0.5), true);
      await bot.activateBlock(button);
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      return { ok: false, reason: 'press_failed' };
    }
    memory.presses += 1;
    await sleep(CYCLE_MS, ctx.signal);
    await waitUntil(() => gained() > before || lying(), { timeoutMs: 1000, signal: ctx.signal });
    ctx.record(`${name}_press`, { presses: memory.presses, gained: gained() });
    // Whatever flew out is picked up next run.
    return gained() > before || lying() ? { ok: true } : { ok: false, reason: `no_${product}_this_press` };
  }

  return {
    name,
    memory,
    noProgressLimit: 12,
    isDone: () => Boolean(memory.device) && !inspect().hollow && inspect().nextPart === null && gained() >= count,
    progress: () => (memory.device ? inspect().built + gained() : 0),
    async run(ctx) {
      if (memory.baseline === null) memory.baseline = owned();
      if (!memory.device) {
        const device = chooseDeviceSite(create, (x, y, z) => bot.blockAt(new Vec3(x, y, z)), bot.entity.position);
        if (!device) return { ok: false, reason: 'no_site' };
        memory.device = device;
        ctx.record('device_site', { kind: device.kind, anchor: device.anchor, facing: device.facing });
      }
      guardDevice();
      const s = inspect();
      if (s.hollow) {
        const block = blockAt(s.hollow);
        const reach = await actions.goToDig(bot, ctx, block);
        if (!reach.ok) return reach;
        return actions.digBlock(bot, ctx, block);
      }
      if (s.nextPart) {
        const part = s.nextPart;
        const current = blockAt(part.position);
        if (!isAir(current)) {
          const reach = await actions.goToDig(bot, ctx, current);
          if (!reach.ok) return reach;
          return actions.digBlock(bot, ctx, current);
        }
        const names = new Set([part.block, part.item || part.block]);
        const toward = new Vec3(part.against.x - part.position.x, part.against.y - part.position.y, part.against.z - part.position.z);
        const result = await skills.placeAt(bot, ctx, part.position, (n) => names.has(n), {
          faces: [toward], stand: part.stand, verify: () => partOk(part),
        });
        ctx.record('device_part', { part: part.key, ok: result.ok, reason: result.reason, facing: facingOf(blockAt(part.position)) });
        return result;
      }
      if (lying()) {
        const result = await collect(ctx);
        if (result.ok) return result;
      }
      return press(ctx);
    },
  };
}

module.exports = { createDuperGoal, chooseDeviceSite, evaluateDeviceSite };
