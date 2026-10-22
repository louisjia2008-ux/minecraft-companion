'use strict';
// Goal: build the hopper-fed furnace (blueprints/autoSmelter.js), load it and
// take out `count` smelted items that came through the output hopper.
//
// Every run() looks at the world and does exactly one thing:
//   1. no site yet              -> choose flat, solid ground near the bot
//   2. standing over the pit    -> step off first
//   3. a dig cell is filled     -> dig it out
//   4. a part is missing/wrong  -> dig the wrong block, or place the part
//                                  (hopper facing is checked on the server's block state)
//   5. input or fuel in the bag -> store it in the input or fuel chest
//   6. otherwise                -> wait for the furnace, take the output chest's contents
// The only memory kept across runs is the site and what was taken out.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { createAutoSmelter } = require('../blueprints/autoSmelter');
const { FACINGS } = require('../blueprints/cobbleGenerator');
const { createBlacklist } = require('../blacklist');
const { sleep } = require('../confirm');

const LIQUID = new Set(['water', 'lava', 'bubble_column']);
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/;
const DIGGABLE = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'stone',
  'andesite', 'diorite', 'granite', 'cobblestone', 'cobbled_deepslate', 'deepslate', 'tuff', 'clay', 'mud',
  'terracotta', 'moss_block', 'netherrack']);
// One item smelts in 10 s; the hoppers move one item every 0.4 s.
const SMELT_WAIT_MS = 11000;

const isAir = (block) => !block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
const isSoft = (block) => isAir(block) || (block.boundingBox === 'empty' && !LIQUID.has(block.name));
const isFloor = (block) => Boolean(block) && block.boundingBox === 'block' && !LIQUID.has(block.name) && !GRAVITY.test(block.name);
const key = (p) => `${p.x},${p.y},${p.z}`;
const v = (p) => new Vec3(p.x, p.y, p.z);

function evaluateSmelterSite(blockAt, anchor, facing) {
  const device = createAutoSmelter(anchor, facing);
  const at = (p) => blockAt(p.x, p.y, p.z);
  for (const p of device.dig) {
    const block = at(p);
    if (!block || !DIGGABLE.has(block.name)) return null;
  }
  for (const p of device.floor) if (!isFloor(at(p))) return null;
  for (const p of device.clearAbove) if (!isSoft(at(p))) return null;
  return device;
}

/** Nearest buildable spot; the anchor (furnace cell) is the top solid block of its column. */
function chooseSmelterSite(blockAt, around, { radius = 10 } = {}) {
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
        const device = evaluateSmelterSite(blockAt, { x: origin.x + dx, y, z: origin.z + dz }, facing);
        if (!device) continue;
        // Not right under the bot: it would have to dig the ground it stands on.
        const score = Math.hypot(dx, dz) + Math.abs(y + 1 - origin.y) * 2 + (Math.hypot(dx, dz) < 3 ? 6 : 0);
        if (!best || score < best.score) best = { device, score };
      }
    }
  }
  return best ? best.device : null;
}

function createAutoSmelterGoal({ bot, anchor = null, facing = 'east', input = 'raw_iron', output = 'iron_ingot',
  fuel = 'coal', count = 8, skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  const memory = {
    device: anchor ? createAutoSmelter(anchor, facing) : null,
    taken: 0,
    lastCheck: 0,
    guarded: false,
  };
  const blacklist = createBlacklist({ ttlMs: 60000 });
  const blockAt = (p) => bot.blockAt(v(p));
  const have = (name) => actions.countItems(bot, (n) => n === name);

  function guardDevice() {
    const movements = bot.pathfinder?.movements;
    if (memory.guarded || !movements || !memory.device) return;
    memory.guarded = true;
    const d = memory.device;
    const noStep = new Set([...d.dig, ...d.parts.map((p) => p.position)].map(key));
    const noBreak = new Set([...d.parts.map((p) => p.position), ...d.floor].map(key));
    movements.exclusionAreasStep.push((block) => (block?.position && noStep.has(key(block.position)) ? 1000 : 0));
    movements.exclusionAreasBreak.push((block) => (block?.position && noBreak.has(key(block.position)) ? 100 : 0));
  }

  const facingOf = (block) => block?.getProperties?.().facing;
  const partOk = (part) => {
    const block = blockAt(part.position);
    return block?.name === part.block && (!part.facing || facingOf(block) === part.facing);
  };

  // Feet in the pit, or on ground about to be dug out.
  function overPit() {
    const feet = bot.entity.position.floored();
    return memory.device.dig.some((p) => feet.x === p.x && feet.z === p.z && feet.y <= p.y + 1);
  }

  async function stepOff(ctx) {
    const a = memory.device.anchor;
    const away = new goals.GoalInvert(new goals.GoalNear(a.x, a.y + 1, a.z, 2.5));
    await actions.goTo(bot, ctx, away, { timeoutMs: 15000, arrived: () => !overPit() });
    if (!overPit()) return { ok: true };
    const result = await actions.unstick(bot, ctx);
    ctx.record('device_step_off', { result: result.ok ? result.moved : result.reason });
    return overPit() ? { ok: false, reason: 'trapped_in_device' } : { ok: true };
  }

  function inspect() {
    const d = memory.device;
    if (!d) return null;
    const partAt = new Map(d.parts.map((p) => [key(p.position), p]));
    const toDig = d.dig.filter((p) => {
      const block = blockAt(p);
      if (!block || isAir(block)) return false;
      const part = partAt.get(key(p));
      return !part || block.name !== part.block; // a right block with the wrong facing is handled with its part
    });
    const nextPart = d.parts.find((p) => !partOk(p)) || null;
    return { toDig, nextPart, built: d.parts.filter(partOk).length };
  }

  return {
    name: 'auto_smelter',
    memory,
    noProgressLimit: 8,
    isDone: () => Boolean(memory.device) && inspect().nextPart === null && memory.taken >= count,
    progress: () => (memory.device ? inspect().built + memory.taken : 0),
    async run(ctx) {
      if (!memory.device) {
        const device = chooseSmelterSite((x, y, z) => bot.blockAt(new Vec3(x, y, z)), bot.entity.position);
        if (!device) return { ok: false, reason: 'no_site' };
        memory.device = device;
        ctx.record('device_site', { kind: device.kind, anchor: device.anchor, facing: device.facing });
      }
      guardDevice();
      const d = memory.device;
      const s = inspect();

      if (s.toDig.length || s.nextPart) {
        if (overPit() && s.toDig.length) return stepOff(ctx);
        const target = s.toDig[0] || (s.nextPart && !isAir(blockAt(s.nextPart.position)) ? s.nextPart.position : null);
        if (target) {
          const block = blockAt(target);
          const reach = await actions.goToDig(bot, ctx, block);
          if (!reach.ok) return reach;
          return actions.digBlock(bot, ctx, block);
        }
        const part = s.nextPart;
        const toward = new Vec3(part.against.x - part.position.x, part.against.y - part.position.y, part.against.z - part.position.z);
        const result = await skills.placeAt(bot, ctx, part.position, (n) => n === part.block, {
          faces: [toward], sneak: Boolean(part.sneak), verify: () => partOk(part),
        });
        if (!result.ok) blacklist.add(key(part.position), result.reason);
        ctx.record('device_part', { part: part.key, ok: result.ok, reason: result.reason, facing: facingOf(blockAt(part.position)) });
        return result;
      }

      // Built: the hoppers feed whatever is in the chests.
      if (have(input) > 0) return skills.storeItems(bot, ctx, { position: d.cells.inChest, items: [{ name: input }] });
      if (have(fuel) > 0) return skills.storeItems(bot, ctx, { position: d.cells.fuelChest, items: [{ name: fuel }] });
      const wait = memory.lastCheck + SMELT_WAIT_MS - Date.now();
      if (wait > 0) await sleep(wait, ctx.signal);
      memory.lastCheck = Date.now();
      const result = await skills.takeItems(bot, ctx, { position: d.cells.outChest, itemMatch: (n) => n === output });
      if (result.ok) memory.taken += result.taken;
      ctx.record('smelter_output', { ok: result.ok, reason: result.reason, taken: memory.taken });
      return result;
    },
  };
}

module.exports = { createAutoSmelterGoal, chooseSmelterSite, evaluateSmelterSite };
