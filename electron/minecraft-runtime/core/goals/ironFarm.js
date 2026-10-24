'use strict';
// Goal: dig the underground iron farm (blueprints/ironFarm.js), move in a
// zombie and three villagers, and pick up `count` iron ingots from its shafts.
//
// Every run() looks at the world and does exactly one thing:
//   1. no site yet                 -> choose solid ground near the bot
//   2. a cell still to dig         -> dig it (stairs, tunnel, room, slit, shafts, lava cells)
//   3. a part missing              -> place it (beds, torch, slab in the slit, ladders)
//   4. a lava cell dry             -> pour lava into it, clicking its far wall
//   5. no zombie behind the slit   -> spawn one with an egg, from the corridor
//   6. the room not sealed         -> step out and seal it
//   7. fewer than three villagers  -> spawn one with an egg, over the seal
//   8. otherwise                   -> pick up the drops by the shafts, or wait down the tunnel
// Only iron ingots gained after the goal started count.
//
// The villagers still have to sleep in their beds once before they call golems:
// the farm starts working after its first night.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { createIronFarm } = require('../blueprints/ironFarm');
const { FACINGS } = require('../blueprints/cobbleGenerator');
const { sleep, waitUntil } = require('../confirm');

const LIQUID = new Set(['water', 'lava', 'bubble_column']);
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/;
const DIGGABLE = /^(stone|andesite|diorite|granite|tuff|deepslate|cobbled_deepslate|cobblestone|dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|clay|calcite|.*_ore)$/;
const DROPS = new Set(['iron_ingot', 'poppy']);
const VILLAGERS = 3;
// Golems come about one a minute once the villagers have slept.
const WAIT_MS = 15000;

const isAir = (block) => !block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
const isSolid = (block) => Boolean(block) && block.boundingBox === 'block' && !LIQUID.has(block.name) && !GRAVITY.test(block.name);
const key = (p) => `${p.x},${p.y},${p.z}`;
const v = (p) => new Vec3(p.x, p.y, p.z);
const droppedName = (entity) => { try { return entity.getDroppedItem?.()?.name || null; } catch { return null; } };

function evaluateIronFarmSite(blockAt, anchor, facing) {
  const farm = createIronFarm(anchor, facing);
  const at = (p) => blockAt(p.x, p.y, p.z);
  const top = farm.cells.stairsTop;
  if (!isSolid(at({ ...top, y: top.y - 1 })) || !isAir(at(top)) || !isAir(at({ ...top, y: top.y + 1 }))) return null;
  for (const p of farm.digOrder) if (!DIGGABLE.test(at(p)?.name || '')) return null;
  for (const p of farm.solid) if (!isSolid(at(p))) return null;
  for (const part of farm.parts) if (!isSolid(at(part.against))) return null;
  return farm;
}

/** Nearest spot with solid rock under it; the anchor is the ground's top block above the corridor. */
function chooseIronFarmSite(blockAt, around, { radius = 6 } = {}) {
  const origin = { x: Math.floor(around.x), y: Math.floor(around.y), z: Math.floor(around.z) };
  let best = null;
  for (let dx = -radius; dx <= radius; dx += 2) {
    for (let dz = -radius; dz <= radius; dz += 2) {
      let y = null;
      for (let top = origin.y + 3; top >= origin.y - 4; top -= 1) {
        const block = blockAt(origin.x + dx, top, origin.z + dz);
        if (!block) break;
        if (isAir(block) || block.boundingBox === 'empty') continue;
        y = top;
        break;
      }
      if (y === null) continue;
      for (const facing of Object.keys(FACINGS)) {
        const farm = evaluateIronFarmSite(blockAt, { x: origin.x + dx, y, z: origin.z + dz }, facing);
        if (!farm) continue;
        const score = Math.hypot(dx, dz) + Math.abs(y + 1 - origin.y) * 2;
        if (!best || score < best.score) best = { farm, score };
      }
    }
  }
  return best ? best.farm : null;
}

function createIronFarmGoal({ bot, anchor = null, facing = 'east', count = 3,
  skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  const memory = { farm: anchor ? createIronFarm(anchor, facing) : null, baseline: null, guarded: false,
    eggs: 0, ready: false };
  const blockAt = (p) => bot.blockAt(v(p));
  const props = (block) => block?.getProperties?.() || {};
  const partOk = (part) => {
    const block = blockAt(part.position);
    if (block?.name !== part.block || (part.facing && props(block).facing !== part.facing)) return false;
    return !part.head || blockAt(part.head)?.name === part.block;
  };
  const iron = () => actions.countItems(bot, (n) => n === 'iron_ingot');
  const gained = () => (memory.baseline === null ? 0 : Math.max(0, iron() - memory.baseline));
  const dug = (p) => isAir(blockAt(p)) || LIQUID.has(blockAt(p)?.name);
  const near = (e, p, r) => e.position && e.position.distanceTo(v(p).offset(0.5, 0, 0.5)) <= r;
  const mobsIn = (type, cells, r) => Object.values(bot.entities).filter((e) => e.name === type && cells.some((c) => near(e, c, r)));
  const zombieIn = () => mobsIn('zombie', [memory.farm.cells.zombie], 1.2).length > 0;
  const villagers = () => {
    const beds = memory.farm.parts.filter((p) => p.head).flatMap((p) => [p.position, p.head]);
    return mobsIn('villager', [...memory.farm.cells.corridor, ...beds], 1.2).length;
  };
  // Natural rock there before the tunnel reaches the room is not the seal.
  const sealed = () => blockAt(memory.farm.cells.seal)?.name === 'cobblestone';

  function guardFarm() {
    const movements = bot.pathfinder?.movements;
    if (memory.guarded || !movements || !memory.farm) return;
    memory.guarded = true;
    const f = memory.farm;
    const noBreak = new Set([...f.solid, ...f.parts.map((p) => p.position), f.cells.seal].map(key));
    // Never into the zombie's cell or a lava cell, and keep out of the shafts.
    const noStep = new Set([...f.zombie, ...f.lava, ...f.shafts].map(key));
    movements.exclusionAreasBreak.push((block) => (block?.position && noBreak.has(key(block.position)) ? 100 : 0));
    movements.exclusionAreasStep.push((block) => (block?.position && noStep.has(key(block.position)) ? 100 : 0));
  }

  function inspect() {
    const f = memory.farm;
    // Beds, the slab, the ladders and the seal go into dug cells: placed, those count as dug.
    const placed = new Set(f.parts.filter(partOk).flatMap((p) => (p.head ? [p.position, p.head] : [p.position])).map(key));
    if (sealed()) placed.add(key(f.cells.seal));
    const cell = f.digOrder.find((p) => !dug(p) && !placed.has(key(p))) || null;
    const nextPart = f.parts.find((p) => !partOk(p)) || null;
    const dry = f.lava.find((p) => !skills.isFluidSource(blockAt(p), 'lava')) || null;
    const done = f.digOrder.filter((p) => dug(p) || placed.has(key(p))).length + f.parts.filter(partOk).length + f.lava.length
      - f.lava.filter((p) => !skills.isFluidSource(blockAt(p), 'lava')).length;
    return { cell, nextPart, dry, done };
  }

  const feet = () => bot.entity.position.floored();
  const standingOn = (p) => feet().x === p.x && feet().z === p.z && Math.abs(bot.entity.position.y - p.y) < 0.6;

  async function goStand(ctx, p, timeoutMs = 30000) {
    if (standingOn(p)) return { ok: true };
    const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(p.x, p.y, p.z), { timeoutMs, arrived: () => standingOn(p) });
    if (standingOn(p)) return { ok: true };
    return moved.ok ? { ok: false, reason: 'not_in_stand' } : moved;
  }

  async function dig(ctx, p) {
    const block = blockAt(p);
    if (!actions.withinReach(bot, v(p))) {
      const reach = await actions.goToDig(bot, ctx, block);
      if (!reach.ok) return reach;
    }
    const f = feet();
    // The route may end right on top of the cell: never dig out the ground underfoot.
    if (p.x === f.x && p.z === f.z && p.y === f.y - 1) {
      const spots = Object.values(FACINGS).map((u) => ({ x: p.x + u.x, y: p.y + 1, z: p.z + u.z }))
        .filter((c) => isAir(blockAt(c)) && isAir(blockAt({ ...c, y: c.y + 1 })) && isSolid(blockAt({ ...c, y: c.y - 1 })));
      for (const c of spots) {
        const moved = await goStand(ctx, c, 8000);
        if (moved.ok) return { ok: true };
      }
      return { ok: false, reason: 'no_spot_beside' };
    }
    return actions.digBlock(bot, ctx, blockAt(p));
  }

  // A spawn egg on a block's face: the mob appears in the cell beyond that face.
  // The server only checks the distance, so the click needs no clear view.
  async function useEgg(ctx, item, position, normal, stand) {
    const moved = await goStand(ctx, stand);
    if (!moved.ok) return moved;
    const egg = bot.inventory.items().find((i) => i.name === item);
    if (!egg) return { ok: false, reason: 'no_material', missing: [{ name: item, short: 1 }] };
    try {
      await bot.equip(egg, 'hand');
      await bot.lookAt(v(position).offset(0.5 + normal.x * 0.5, 0.5 + normal.y * 0.5, 0.5 + normal.z * 0.5), true);
      await bot.activateBlock(blockAt(position), normal, new Vec3(0.5 + normal.x * 0.5, 0.5 + normal.y * 0.5, 0.5 + normal.z * 0.5));
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      return { ok: false, reason: 'egg_failed' };
    }
    memory.eggs += 1;
    await sleep(500, ctx.signal);
    return { ok: true };
  }

  const drops = () => Object.values(bot.entities).filter((e) => e.name === 'item' && DROPS.has(droppedName(e))
    && memory.farm.cells.shafts.some((s) => near(e, s, 3)));

  async function collect(ctx) {
    const f = memory.farm;
    const lying = drops();
    if (lying.length) {
      const before = iron();
      for (const drop of lying) {
        if (!bot.entities[drop.id]) continue;
        await actions.goNear(bot, ctx, drop.position.clone(), 1, { timeoutMs: 8000 });
        await waitUntil(() => !bot.entities[drop.id], { timeoutMs: 1000, signal: ctx.signal });
      }
      ctx.record('iron_farm_drops', { gained: gained() });
      if (iron() > before) return { ok: true };
    }
    // Out of the shafts' way: a bot beside a shaft keeps a golem from fitting in.
    const moved = await goStand(ctx, f.cells.wait);
    if (!moved.ok) return moved;
    const before = drops().length;
    await waitUntil(() => drops().length > before, { timeoutMs: WAIT_MS, signal: ctx.signal });
    const golems = Object.values(bot.entities).filter((e) => e.name === 'iron_golem').length;
    ctx.record('iron_farm_wait', { gained: gained(), golems, villagers: villagers(), zombie: zombieIn() });
    return drops().length > before ? { ok: true } : { ok: false, reason: 'no_golem_yet' };
  }

  return {
    name: 'iron_farm',
    memory,
    // Golems come at their own pace, and only after the villagers' first night.
    noProgressLimit: 60,
    isDone: () => Boolean(memory.farm) && memory.ready && gained() >= count,
    progress: () => (memory.farm ? inspect().done + (zombieIn() ? 1 : 0) + (sealed() ? 1 : 0) + villagers() + gained() : 0),
    async run(ctx) {
      if (memory.baseline === null) memory.baseline = iron();
      if (!memory.farm) {
        const farm = chooseIronFarmSite((x, y, z) => bot.blockAt(new Vec3(x, y, z)), bot.entity.position);
        if (!farm) return { ok: false, reason: 'no_site' };
        memory.farm = farm;
        ctx.record('device_site', { kind: farm.kind, anchor: farm.anchor, facing: farm.facing });
      }
      guardFarm();
      const f = memory.farm;
      // The zombie behind the slit can't reach the bot: never fight it.
      bot.companionSpare = (entity) => entity.name === 'zombie' && near(entity, f.cells.zombie, 1.5);
      const c = f.cells;
      const s = inspect();
      if (s.cell) {
        const result = await dig(ctx, s.cell);
        if (!result.ok) ctx.record('iron_farm_dig', { cell: s.cell, reason: result.reason, at: feet() });
        return result;
      }
      if (s.nextPart) {
        const part = s.nextPart;
        if (!isAir(blockAt(part.position))) return dig(ctx, part.position); // wrong block or facing
        const names = new Set([part.block, part.item || part.block]);
        const toward = new Vec3(part.against.x - part.position.x, part.against.y - part.position.y, part.against.z - part.position.z);
        const result = await skills.placeAt(bot, ctx, part.position, (n) => names.has(n), {
          faces: [toward], stand: part.stand, verify: () => partOk(part), alsoClear: part.head ? [part.head] : [],
        });
        ctx.record('device_part', { part: part.key, ok: result.ok, reason: result.reason, facing: props(blockAt(part.position)).facing });
        return result;
      }
      if (s.dry) {
        // Its floor is above the bot's eyes: click the far wall from the tunnel.
        const along = FACINGS[f.facing];
        return skills.pourLiquid(bot, ctx, s.dry, 'lava', { against: { x: s.dry.x + along.x, y: s.dry.y, z: s.dry.z + along.z } });
      }
      if (!sealed() && !zombieIn()) {
        const wall = c.zombieWall;
        const normal = new Vec3(c.zombie.x - wall.x, 0, c.zombie.z - wall.z);
        const result = await useEgg(ctx, 'zombie_spawn_egg', wall, normal, c.eggStand);
        if (!result.ok) return result;
        const there = await waitUntil(zombieIn, { timeoutMs: 3000, signal: ctx.signal });
        ctx.record('iron_farm_zombie', { ok: there });
        return there ? { ok: true } : { ok: false, reason: 'no_zombie' };
      }
      if (!sealed()) {
        const result = await skills.placeAt(bot, ctx, c.seal, (n) => n === 'cobblestone', {
          faces: [new Vec3(0, -1, 0)], stand: c.villagerStand,
        });
        ctx.record('device_part', { part: 'seal', ok: result.ok, reason: result.reason });
        return result;
      }
      const have = villagers();
      if (!memory.ready && have < VILLAGERS) {
        const floor = c.corridor.map((p) => ({ ...p, y: p.y - 1 }))[memory.eggs % c.corridor.length];
        const result = await useEgg(ctx, 'villager_spawn_egg', floor, new Vec3(0, 1, 0), c.villagerStand);
        if (!result.ok) return result;
        const more = await waitUntil(() => villagers() > have, { timeoutMs: 3000, signal: ctx.signal });
        ctx.record('iron_farm_villager', { ok: more, villagers: villagers() });
        return more ? { ok: true } : { ok: false, reason: 'no_villager' };
      }
      if (!memory.ready) {
        memory.ready = true;
        ctx.record('iron_farm_ready', { villagers: have, zombie: zombieIn() });
      }
      return collect(ctx);
    },
  };
}

module.exports = { createIronFarmGoal, chooseIronFarmSite, evaluateIronFarmSite };
