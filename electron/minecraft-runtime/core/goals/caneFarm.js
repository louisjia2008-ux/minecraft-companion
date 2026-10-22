'use strict';
// Goal: build one observer sugar cane column (blueprints/caneFarm.js) and
// collect `count` sugar cane that the piston harvested on its own.
//
// Every run() looks at the world and does exactly one thing:
//   1. no site yet             -> choose flat, solid ground near the bot
//   2. above a cell to dig     -> step off first
//   3. a dig cell is filled    -> dig it out
//   4. no water source         -> pour the water bucket
//   5. a part is missing/wrong -> dig the wrong block, or place the part
//                                 (piston and observer from their standing cell,
//                                  facing checked on the server's block state)
//   6. otherwise               -> wait in S for the cane to grow a step, or for
//                                 the piston to fire and pick up the drop
// Only cane gained after the column was cut while the bot waited counts.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { createCaneFarm } = require('../blueprints/caneFarm');
const { FACINGS } = require('../blueprints/cobbleGenerator');
const { waitUntil } = require('../confirm');

const LIQUID = new Set(['water', 'lava', 'bubble_column']);
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/;
// The cane grows on dirt-like ground; everything dug must be plain soil or stone.
const CANE_SOIL = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mycelium', 'mud', 'moss_block']);
const DIGGABLE = new Set([...CANE_SOIL, 'stone', 'andesite', 'diorite', 'granite', 'cobblestone', 'clay', 'terracotta']);
// At the normal random tick speed the top block ages one step about every
// 68 s (16 steps per block); each wait ends at the next step or the timeout.
const HARVEST_WAIT_MS = 60000;

const isAir = (block) => !block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
const isSoft = (block) => isAir(block) || (block.boundingBox === 'empty' && !LIQUID.has(block.name));
const isSolid = (block) => Boolean(block) && block.boundingBox === 'block' && !LIQUID.has(block.name) && !GRAVITY.test(block.name);
const key = (p) => `${p.x},${p.y},${p.z}`;
const v = (p) => new Vec3(p.x, p.y, p.z);

function evaluateCaneSite(blockAt, anchor, facing) {
  const farm = createCaneFarm(anchor, facing);
  const at = (p) => blockAt(p.x, p.y, p.z);
  for (const p of farm.dig) if (!DIGGABLE.has(at(p)?.name)) return null;
  if (!CANE_SOIL.has(at(farm.cells.dirt)?.name)) return null;
  for (const p of [...farm.solid, ...farm.standFloors]) if (!isSolid(at(p))) return null;
  for (const p of farm.clear) { const b = at(p); if (!b || !isSoft(b)) return null; }
  return farm;
}

/** Nearest buildable spot; the anchor (the cane's first cell) is the top solid block of its column. */
function chooseCaneSite(blockAt, around, { radius = 10 } = {}) {
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
        const farm = evaluateCaneSite(blockAt, { x: origin.x + dx, y, z: origin.z + dz }, facing);
        if (!farm) continue;
        const score = Math.hypot(dx, dz) + Math.abs(y + 1 - origin.y) * 2 + (Math.hypot(dx, dz) < 3 ? 6 : 0);
        if (!best || score < best.score) best = { farm, score };
      }
    }
  }
  return best ? best.farm : null;
}

function createCaneFarmGoal({ bot, anchor = null, facing = 'east', count = 4,
  skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  const memory = { farm: anchor ? createCaneFarm(anchor, facing) : null, harvested: 0, harvests: 0, growth: 0, guarded: false };
  const blockAt = (p) => bot.blockAt(v(p));
  const facingOf = (block) => block?.getProperties?.().facing;
  const nameOk = (part, name) => name === part.block || Boolean(part.accept?.includes(name));
  const partOk = (part) => {
    const block = blockAt(part.position);
    return nameOk(part, block?.name) && (!part.facing || facingOf(block) === part.facing);
  };

  function guardFarm() {
    const movements = bot.pathfinder?.movements;
    if (memory.guarded || !movements || !memory.farm) return;
    memory.guarded = true;
    const f = memory.farm;
    const c = f.cells;
    // Never walk into the cane column or onto the water's cover, never break the device.
    const noStep = new Set([c.cane1, c.cane2, c.cover, { ...c.cover, y: c.cover.y + 1 }].map(key));
    const noBreak = new Set([...f.parts.map((p) => p.position), ...f.solid].map(key));
    movements.exclusionAreasStep.push((block) => (block?.position && noStep.has(key(block.position)) ? 1000 : 0));
    movements.exclusionAreasBreak.push((block) => (block?.position && noBreak.has(key(block.position)) ? 100 : 0));
  }

  // Feet in or right above a cell still to be dug.
  function overDig() {
    const feet = bot.entity.position.floored();
    return memory.farm.dig.some((p) => !isAir(blockAt(p)) && !LIQUID.has(blockAt(p)?.name)
      && feet.x === p.x && feet.z === p.z && feet.y >= p.y && feet.y <= p.y + 1);
  }

  // Down in the water hole (dug two deep before the cover goes on).
  function inWaterHole() {
    const feet = bot.entity.position.floored();
    const w = memory.farm.cells.water;
    return feet.x === w.x && feet.z === w.z && feet.y <= w.y + 1;
  }

  async function stepOff(ctx) {
    const f = memory.farm;
    if (inWaterHole()) {
      // Swim up and out toward the open ground beyond the hole.
      const out = f.parts.find((p) => p.key === 'piston').stand;
      try {
        await bot.lookAt(new Vec3(out.x + 0.5, out.y + 1.6, out.z + 0.5), true);
        bot.setControlState('jump', true);
        bot.setControlState('forward', true);
        await waitUntil(() => !inWaterHole(), { timeoutMs: 4000, signal: ctx.signal });
      } finally {
        bot.setControlState('jump', false);
        bot.setControlState('forward', false);
      }
    }
    const a = f.anchor;
    const away = new goals.GoalInvert(new goals.GoalNear(a.x, a.y + 1, a.z, 2));
    await actions.goTo(bot, ctx, away, { timeoutMs: 15000, arrived: () => !overDig() && !inWaterHole() });
    if (!overDig() && !inWaterHole()) return { ok: true };
    const result = await actions.unstick(bot, ctx);
    ctx.record('device_step_off', { result: result.ok ? result.moved : result.reason });
    return overDig() || inWaterHole() ? { ok: false, reason: 'trapped_in_device' } : { ok: true };
  }

  function inspect() {
    const f = memory.farm;
    const partAt = new Map(f.parts.map((p) => [key(p.position), p]));
    const water = skills.isFluidSource(blockAt(f.cells.water), 'water');
    const toDig = f.dig.filter((p) => {
      const block = blockAt(p);
      if (!block || isAir(block)) return false;
      if (p === f.cells.water) return block.name !== 'water';
      if (LIQUID.has(block.name)) return false; // water poured in the wrong cell is scooped up, not dug
      // Before the water is in, the cover cell's grass is ground to dig, not the finished cover.
      const part = partAt.get(key(p));
      return !part || !water || !nameOk(part, block.name);
    });
    const nextPart = f.parts.find((p) => !partOk(p)) || null;
    // A pour that missed the floor leaves its source in the cover cell or on the ground beside the hole.
    const w = f.cells.water;
    let stray = null;
    if (!water) {
      for (let dy = 1; dy <= 2 && !stray; dy += 1) {
        for (let dx = -1; dx <= 1 && !stray; dx += 1) {
          for (let dz = -1; dz <= 1 && !stray; dz += 1) {
            const p = { x: w.x + dx, y: w.y + dy, z: w.z + dz };
            if (skills.isFluidSource(blockAt(p), 'water')) stray = p;
          }
        }
      }
    }
    return { toDig, water, stray, nextPart, built: f.parts.filter(partOk).length };
  }

  async function goToStand(ctx) {
    const s = memory.farm.cells.stand;
    const inStand = () => {
      const at = bot.entity.position;
      return Math.floor(at.x) === s.x && Math.floor(at.z) === s.z && Math.abs(at.y - s.y) < 0.5;
    };
    if (inStand()) return { ok: true };
    const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(s.x, s.y, s.z), { timeoutMs: 30000, arrived: inStand });
    return inStand() ? { ok: true } : (moved.ok ? { ok: false, reason: 'not_in_stand' } : moved);
  }

  // Waits in S for the next change of the cane: a growth step (the top block's
  // age, or a new block) or the piston cutting it. Growth counts as progress, so
  // a farm growing at normal speed (minutes per block) is not given up on.
  async function waitForHarvest(ctx) {
    const moved = await goToStand(ctx);
    if (!moved.ok) return moved;
    const c = memory.farm.cells;
    const cane = (n) => n === 'sugar_cane';
    const column = [c.cane1, c.cane2, c.cane3];
    const height = () => {
      let h = 0;
      while (h < column.length && blockAt(column[h])?.name === 'sugar_cane') h += 1;
      return h;
    };
    const growth = () => {
      const h = height();
      return `${h}:${h ? blockAt(column[h - 1])?.getProperties?.().age : ''}`;
    };
    const before = actions.countItems(bot, cane);
    const startHeight = height();
    const start = growth();
    const changed = await waitUntil(() => growth() !== start, { timeoutMs: HARVEST_WAIT_MS, signal: ctx.signal });
    if (!changed) return { ok: false, reason: 'cane_not_growing' };
    const h = height();
    if (h === 0) return { ok: false, reason: 'cane_lost' }; // replanted as a part next run
    if (h > startHeight && h < column.length) {
      memory.growth += 1;
      ctx.record('cane_growth', { height: h, growth: memory.growth });
      return { ok: true };
    }
    if (h === startHeight && h > 0) { memory.growth += 1; return { ok: true }; }
    // The 3rd block appeared (the observer fires at once) or the column was cut.
    const cut = await waitUntil(() => height() <= 1, { timeoutMs: 3000, signal: ctx.signal });
    if (!cut) return { ok: false, reason: 'piston_not_firing' };
    memory.harvests += 1;
    await waitUntil(() => actions.countItems(bot, cane) > before, { timeoutMs: 3000, signal: ctx.signal });
    const gained = actions.countItems(bot, cane) - before;
    memory.harvested += Math.max(0, gained);
    ctx.record('cane_harvest', { gained, harvested: memory.harvested, harvests: memory.harvests });
    return gained > 0 ? { ok: true } : { ok: false, reason: 'drop_not_collected' };
  }

  return {
    name: 'cane_farm',
    memory,
    noProgressLimit: 20,
    isDone: () => Boolean(memory.farm) && inspect().nextPart === null && memory.harvested >= count,
    progress: () => (memory.farm ? inspect().built + memory.growth + memory.harvests + memory.harvested : 0),
    async run(ctx) {
      if (!memory.farm) {
        const farm = chooseCaneSite((x, y, z) => bot.blockAt(new Vec3(x, y, z)), bot.entity.position);
        if (!farm) return { ok: false, reason: 'no_site' };
        memory.farm = farm;
        ctx.record('device_site', { kind: farm.kind, anchor: farm.anchor, facing: farm.facing });
      }
      guardFarm();
      const f = memory.farm;
      const s = inspect();

      if (inWaterHole()) return stepOff(ctx);
      if (s.toDig.length) {
        if (overDig()) return stepOff(ctx);
        const block = blockAt(s.toDig[0]);
        const reach = await actions.goToDig(bot, ctx, block);
        if (!reach.ok) return reach;
        // The route may end right on top of the cell: never dig out the ground underfoot.
        if (overDig()) return stepOff(ctx);
        return actions.digBlock(bot, ctx, block);
      }
      if (s.stray) {
        const result = await skills.scoopLiquid(bot, ctx, s.stray, 'water');
        ctx.record('water_scooped', { at: s.stray, ok: result.ok, reason: result.reason });
        return result;
      }
      if (!s.water) return skills.pourLiquid(bot, ctx, f.cells.water, 'water');
      if (s.nextPart) {
        const part = s.nextPart;
        const current = blockAt(part.position);
        if (!isAir(current) && current.boundingBox !== 'empty') {
          const reach = await actions.goToDig(bot, ctx, current);
          if (!reach.ok) return reach;
          return actions.digBlock(bot, ctx, current);
        }
        const names = new Set([part.block, part.item || part.block]);
        const result = await skills.placeAt(bot, ctx, part.position, (n) => names.has(n), {
          stand: part.stand, verify: () => partOk(part),
        });
        ctx.record('device_part', { part: part.key, ok: result.ok, reason: result.reason, facing: facingOf(blockAt(part.position)) });
        // Placed, but facing the wrong way: dig it up next run and try again.
        return result;
      }
      return waitForHarvest(ctx);
    },
  };
}

module.exports = { createCaneFarmGoal, chooseCaneSite, evaluateCaneSite };
