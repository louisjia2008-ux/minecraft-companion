'use strict';
// Goal: dig the underground mob farm (blueprints/mobFarm.js) and collect
// `count` mob drops that came down its shaft.
//
// Every run() looks at the world and does exactly one thing:
//   1. no site yet                    -> choose solid ground near the bot
//   2. still above the shaft:
//      a stairs, room or channel cell -> dig it (never the block underfoot)
//      b a water source missing       -> pour it
//      c otherwise                    -> stand on the hole and dig the block underfoot
//   3. in the shaft                   -> dig the block underfoot, one block at a time
//   4. at the bottom                  -> dig the alcove, step into it, dig and place
//                                        the chest and the hopper
//   5. otherwise                      -> wait in the alcove, empty the chest
// Only mob drops gained after the goal started count.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { createMobFarm } = require('../blueprints/mobFarm');
const { FACINGS } = require('../blueprints/cobbleGenerator');
const { waitUntil } = require('../confirm');

const LIQUID = new Set(['water', 'lava', 'bubble_column']);
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/;
const DIGGABLE = /^(stone|andesite|diorite|granite|tuff|deepslate|cobbled_deepslate|cobblestone|dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|clay|calcite|.*_ore)$/;
const MOB_DROPS = new Set(['rotten_flesh', 'bone', 'arrow', 'gunpowder', 'string', 'spider_eye', 'ender_pearl']);
// Mobs come one every few tens of seconds; the chest is emptied about as often.
const COLLECT_WAIT_MS = 20000;

const isAir = (block) => !block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
const isSolid = (block) => Boolean(block) && block.boundingBox === 'block' && !LIQUID.has(block.name) && !GRAVITY.test(block.name);
const key = (p) => `${p.x},${p.y},${p.z}`;
const v = (p) => new Vec3(p.x, p.y, p.z);

function evaluateMobFarmSite(blockAt, anchor, facing) {
  const farm = createMobFarm(anchor, facing);
  const at = (p) => blockAt(p.x, p.y, p.z);
  // The ground's top at the hole and at the stairs' exit, open air above both.
  const exit = farm.stairs[0];
  for (const p of [farm.anchor, exit]) {
    if (!isSolid(at(p)) || !isAir(at({ ...p, y: p.y + 1 }))) return null;
  }
  for (const p of [...farm.stairs, ...farm.room, ...farm.channels, ...farm.shaft, ...farm.bottom]) {
    if (!DIGGABLE.test(at(p)?.name || '')) return null;
  }
  for (const p of farm.solid) if (!isSolid(at(p))) return null;
  return farm;
}

/** Nearest spot with solid rock all the way down; the anchor is the ground's top block above the hole. */
function chooseMobFarmSite(blockAt, around, { radius = 6 } = {}) {
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
        const farm = evaluateMobFarmSite(blockAt, { x: origin.x + dx, y, z: origin.z + dz }, facing);
        if (!farm) continue;
        const score = Math.hypot(dx, dz) + Math.abs(y + 1 - origin.y) * 2;
        if (!best || score < best.score) best = { farm, score };
      }
    }
  }
  return best ? best.farm : null;
}

function createMobFarmGoal({ bot, anchor = null, facing = 'east', count = 4,
  skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  const memory = { farm: anchor ? createMobFarm(anchor, facing) : null, baseline: null, taken: 0, lastCheck: 0, guarded: false };
  const blockAt = (p) => bot.blockAt(v(p));
  const facingOf = (block) => block?.getProperties?.().facing;
  const partOk = (part) => {
    const block = blockAt(part.position);
    return block?.name === part.block && (!part.facing || facingOf(block) === part.facing);
  };
  const drops = () => actions.countItems(bot, (n) => MOB_DROPS.has(n));
  const gained = () => (memory.baseline === null ? 0 : Math.max(0, drops() - memory.baseline));
  const dug = (p) => isAir(blockAt(p)) || LIQUID.has(blockAt(p)?.name);

  function guardFarm() {
    const movements = bot.pathfinder?.movements;
    if (memory.guarded || !movements || !memory.farm) return;
    memory.guarded = true;
    const f = memory.farm;
    const noBreak = new Set([...f.solid, ...f.parts.map((p) => p.position)].map(key));
    // The channels' water carries anything in it into the hole: walk round them.
    // (A prohibitive cost would make every route to the hole time out.)
    const noStep = new Set(f.channels.map(key));
    movements.exclusionAreasBreak.push((block) => (block?.position && noBreak.has(key(block.position)) ? 100 : 0));
    movements.exclusionAreasStep.push((block) => (block?.position && noStep.has(key(block.position)) ? 20 : 0));
  }

  function inspect() {
    const f = memory.farm;
    const partAt = new Map(f.parts.map((p) => [key(p.position), p]));
    const upper = [...f.stairs, ...f.room, ...f.channels].find((p) => !dug(p)) || null;
    const water = f.water.find((p) => !skills.isFluidSource(blockAt(p), 'water')) || null;
    const shaft = f.shaft.find((p) => !dug(p)) || null;
    const bottom = f.bottom.find((p) => {
      if (dug(p)) return false;
      const part = partAt.get(key(p));
      return !part || blockAt(p)?.name !== part.block;
    }) || null;
    const nextPart = f.parts.find((p) => !partOk(p)) || null;
    const done = [...f.stairs, ...f.room, ...f.channels, ...f.shaft].filter(dug).length
      + f.water.length - f.water.filter((p) => !skills.isFluidSource(blockAt(p), 'water')).length
      + f.parts.filter(partOk).length;
    return { upper, water, shaft, bottom, nextPart, done };
  }

  const feet = () => bot.entity.position.floored();
  const below = () => bot.entity.position.y < memory.farm.levels.feet - 1.5;
  const inColumn = (p) => feet().x === p.x && feet().z === p.z;
  const inStand = () => {
    const s = memory.farm.cells.stand;
    return inColumn(s) && Math.abs(bot.entity.position.y - s.y) < 0.5;
  };

  async function dig(ctx, p) {
    const block = blockAt(p);
    if (!actions.withinReach(bot, v(p))) {
      const reach = await actions.goToDig(bot, ctx, block);
      if (!reach.ok) return reach;
    }
    const f = feet();
    // The route may end right on top of the cell: never dig out the ground underfoot.
    if (p.x === f.x && p.z === f.z && p.y === f.y - 1) return stepAside(ctx, p);
    return actions.digBlock(bot, ctx, blockAt(p));
  }

  // Off the cell about to be dug, onto a dug neighbour with a floor.
  async function stepAside(ctx, p) {
    const spots = Object.values(FACINGS).map((u) => ({ x: p.x + u.x, y: p.y + 1, z: p.z + u.z }))
      .filter((c) => isAir(blockAt(c)) && isAir(blockAt({ ...c, y: c.y + 1 })) && isSolid(blockAt({ ...c, y: c.y - 1 })));
    for (const c of spots) {
      const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(c.x, c.y, c.z), { timeoutMs: 8000 });
      if (moved.ok && !inColumn(p)) return { ok: true };
    }
    return { ok: false, reason: 'no_spot_beside' };
  }

  // Standing in the shaft's column: dig the next block underfoot and drop onto the one below it.
  async function digDown(ctx) {
    const under = { ...feet(), y: feet().y - 1 };
    if (dug(under)) {
      await waitUntil(() => bot.entity.onGround, { timeoutMs: 2000, signal: ctx.signal });
      return { ok: true };
    }
    const result = await actions.digBlock(bot, ctx, blockAt(under));
    if (result.ok) await waitUntil(() => bot.entity.onGround && feet().y === under.y, { timeoutMs: 2000, signal: ctx.signal });
    return result;
  }

  async function collect(ctx) {
    const f = memory.farm;
    if (!inStand()) {
      const s = f.cells.stand;
      const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(s.x, s.y, s.z), { timeoutMs: 15000, arrived: inStand });
      if (!inStand()) return moved.ok ? { ok: false, reason: 'not_in_stand' } : moved;
    }
    const before = gained();
    const wait = memory.lastCheck + COLLECT_WAIT_MS - Date.now();
    if (wait > 0) await waitUntil(() => gained() > before, { timeoutMs: wait, signal: ctx.signal });
    if (gained() > before) {
      ctx.record('mob_drops', { gained: gained() });
      return { ok: true };
    }
    memory.lastCheck = Date.now();
    const result = await skills.takeItems(bot, ctx, { position: f.cells.chest, itemMatch: (n) => MOB_DROPS.has(n) });
    if (result.ok) memory.taken += result.taken;
    // Hostile mobs in the bot's view, to tell a farm that spawns nothing from one that drops nothing.
    const mobs = Object.values(bot.entities).filter((e) => e.type === 'hostile').length;
    ctx.record('mob_drops', { gained: gained(), taken: memory.taken, reason: result.reason, mobs });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason === 'chest_empty' ? 'no_mobs_yet' : result.reason };
  }

  return {
    name: 'mob_farm',
    memory,
    // Mobs come at their own pace once the farm is dug.
    noProgressLimit: 40,
    isDone: () => Boolean(memory.farm) && inspect().nextPart === null && gained() >= count,
    progress: () => (memory.farm ? inspect().done + gained() : 0),
    async run(ctx) {
      if (memory.baseline === null) memory.baseline = drops();
      if (!memory.farm) {
        const farm = chooseMobFarmSite((x, y, z) => bot.blockAt(new Vec3(x, y, z)), bot.entity.position);
        if (!farm) return { ok: false, reason: 'no_site' };
        memory.farm = farm;
        ctx.record('device_site', { kind: farm.kind, anchor: farm.anchor, facing: farm.facing });
      }
      guardFarm();
      const f = memory.farm;
      const s = inspect();

      if (!below()) {
        if (s.upper) return dig(ctx, s.upper);
        if (s.water) return skills.pourLiquid(bot, ctx, s.water, 'water');
        const top = { ...f.cells.hole, y: f.levels.feet };
        if (!inColumn(top) || Math.abs(bot.entity.position.y - top.y) > 0.5) {
          const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(top.x, top.y, top.z), { timeoutMs: 30000 });
          if (!inColumn(top)) return moved.ok ? { ok: false, reason: 'not_on_hole' } : moved;
        }
        return digDown(ctx);
      }
      if (s.shaft && inColumn(f.cells.hole)) return digDown(ctx);
      if (s.bottom) {
        const c = f.cells;
        // The alcove is dug from the shaft's bottom; the rest from inside the alcove.
        if ((s.bottom === c.alcoveHead || s.bottom === c.stand) || inStand()) return dig(ctx, s.bottom);
        const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(c.stand.x, c.stand.y, c.stand.z), { timeoutMs: 15000, arrived: inStand });
        return inStand() ? { ok: true } : (moved.ok ? { ok: false, reason: 'not_in_stand' } : moved);
      }
      if (s.nextPart) {
        const part = s.nextPart;
        if (!isAir(blockAt(part.position))) return dig(ctx, part.position); // wrong block or facing
        const toward = new Vec3(part.against.x - part.position.x, part.against.y - part.position.y, part.against.z - part.position.z);
        const result = await skills.placeAt(bot, ctx, part.position, (n) => n === part.block, {
          faces: [toward], sneak: Boolean(part.sneak), verify: () => partOk(part),
        });
        ctx.record('device_part', { part: part.key, ok: result.ok, reason: result.reason, facing: facingOf(blockAt(part.position)) });
        return result;
      }
      return collect(ctx);
    },
  };
}

module.exports = { createMobFarmGoal, chooseMobFarmSite, evaluateMobFarmSite, MOB_DROPS };
