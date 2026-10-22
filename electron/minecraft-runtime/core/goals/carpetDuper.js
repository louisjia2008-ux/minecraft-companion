'use strict';
// Goal: build the button-driven carpet duplicator (blueprints/carpetDuper.js)
// and press it until `count` new carpets are in the inventory.
//
// Every run() looks at the world and does exactly one thing:
//   1. no site yet             -> choose flat, solid ground near the bot
//   2. ground under the slime  -> dig it out
//   3. a part is missing/wrong -> dig the wrong block, or place the part
//                                 (piston and fan facing checked on the server's block state)
//   4. carpets lying nearby    -> pick them up
//   5. otherwise               -> stand beside the fan and press the button once
// Only carpets gained beyond the seed carpet count.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { createCarpetDuper } = require('../blueprints/carpetDuper');
const { FACINGS } = require('../blueprints/cobbleGenerator');
const { sleep, waitUntil } = require('../confirm');

const LIQUID = new Set(['water', 'lava', 'bubble_column']);
// A stone button stays pressed 20 ticks; the sticky piston then pulls the slime back.
const CYCLE_MS = 1600;

const isAir = (block) => !block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
const isSoft = (block) => isAir(block) || (block.boundingBox === 'empty' && !LIQUID.has(block.name));
const isFloor = (block) => Boolean(block) && block.boundingBox === 'block' && !LIQUID.has(block.name)
  && !/^(sand|red_sand|gravel|.*_concrete_powder)$/.test(block.name);
const isCarpet = (name) => name === 'white_carpet';
const droppedName = (entity) => { try { return entity.getDroppedItem?.()?.name || null; } catch (_) { return null; } };
const v = (p) => new Vec3(p.x, p.y, p.z);

function evaluateCarpetDuperSite(blockAt, anchor, facing) {
  const device = createCarpetDuper(anchor, facing);
  const at = (p) => blockAt(p.x, p.y, p.z);
  for (const p of device.floor) if (!isFloor(at(p))) return null;
  for (const p of device.clear) if (!isSoft(at(p))) return null;
  for (const p of device.hollow) if (LIQUID.has(at(p)?.name)) return null;
  return device;
}

/** Nearest flat spot; the anchor is the ground block under the piston. */
function chooseCarpetDuperSite(blockAt, around, { radius = 8 } = {}) {
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
        const device = evaluateCarpetDuperSite(blockAt, { x: origin.x + dx, y, z: origin.z + dz }, facing);
        if (!device) continue;
        // Not right where the bot stands: it would be in the way of its own parts.
        const score = Math.hypot(dx, dz) + Math.abs(y + 1 - origin.y) * 2 + (Math.hypot(dx, dz) < 3 ? 6 : 0);
        if (!best || score < best.score) best = { device, score };
      }
    }
  }
  return best ? best.device : null;
}

function createCarpetDuperGoal({ bot, anchor = null, facing = 'east', count = 8,
  skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  const memory = { device: anchor ? createCarpetDuper(anchor, facing) : null, baseline: null, presses: 0 };
  const blockAt = (p) => bot.blockAt(v(p));
  const facingOf = (block) => block?.getProperties?.().facing;
  const partOk = (part) => {
    const block = blockAt(part.position);
    return block?.name === part.block && (!part.facing || facingOf(block) === part.facing);
  };
  const carpets = () => actions.countItems(bot, isCarpet);
  // The seed carpet leaves the inventory when it is placed; it is not a gain.
  const gained = () => {
    if (memory.baseline === null) return 0;
    const seedPlaced = memory.device && partOk(memory.device.parts.find((p) => p.key === 'carpet')) ? 1 : 0;
    return Math.max(0, carpets() + seedPlaced - memory.baseline);
  };
  // The fan has no collision but the carpet above it blocks the head: a path
  // through that cell stalls. Never step there, and never dig a part.
  function guardDevice() {
    const movements = bot.pathfinder?.movements;
    if (memory.guarded || !movements || !memory.device) return;
    memory.guarded = true;
    const d = memory.device;
    const key = (p) => `${p.x},${p.y},${p.z}`;
    const noBreak = new Set(d.parts.map((p) => key(p.position)));
    const noStep = new Set([d.cells.fan, d.cells.carpet, d.cells.button].map(key));
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
    const hollow = d.hollow.find((p) => !isAir(blockAt(p))) || null;
    return { hollow, nextPart: d.parts.find((p) => !partOk(p)) || null,
      built: d.parts.filter(partOk).length + d.hollow.length - (hollow ? 1 : 0) };
  };

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
      await bot.lookAt(v(d.cells.button).offset(0.5, 0.1, 0.5), true);
      await bot.activateBlock(button);
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      return { ok: false, reason: 'press_failed' };
    }
    memory.presses += 1;
    await sleep(CYCLE_MS, ctx.signal);
    await waitUntil(() => gained() > before, { timeoutMs: 1000, signal: ctx.signal });
    ctx.record('carpet_press', { presses: memory.presses, gained: gained() });
    return gained() > before ? { ok: true } : { ok: false, reason: 'no_carpet_this_press' };
  }

  return {
    name: 'carpet_duper',
    memory,
    noProgressLimit: 12,
    isDone: () => Boolean(memory.device) && !inspect().hollow && inspect().nextPart === null && gained() >= count,
    progress: () => (memory.device ? inspect().built + gained() : 0),
    async run(ctx) {
      if (memory.baseline === null) memory.baseline = carpets();
      if (!memory.device) {
        const device = chooseCarpetDuperSite((x, y, z) => bot.blockAt(new Vec3(x, y, z)), bot.entity.position);
        if (!device) return { ok: false, reason: 'no_site' };
        memory.device = device;
        ctx.record('device_site', { kind: device.kind, anchor: device.anchor, facing: device.facing });
      }
      guardDevice();
      const d = memory.device;
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
      // Carpets that flew past the bot.
      const lying = Object.values(bot.entities).some((e) => e.name === 'item' && e.position
        && e.position.distanceTo(v(d.cells.carpet)) < 6 && isCarpet(droppedName(e)));
      if (lying) {
        const result = await actions.collectDrops(bot, ctx, v(d.cells.carpet), isCarpet, { radius: 6, timeoutMs: 6000 });
        if (result.ok) return result;
      }
      return press(ctx);
    },
  };
}

module.exports = { createCarpetDuperGoal, chooseCarpetDuperSite, evaluateCarpetDuperSite };
