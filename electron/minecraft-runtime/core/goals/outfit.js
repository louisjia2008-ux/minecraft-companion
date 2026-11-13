'use strict';
// Goal: carry a list of items, gathered from nothing if need be, and wear the
// armour among them. What a player gets ready before a trip (the nether, the
// End): a full iron set, a bow and arrows, buckets, obsidian, eyes of ender.
//
// The gathering is deviceProject.js's: whatever the bag lacks is gathered
// into the home chest (gatherMaterials.js) and taken out again. The "device"
// here builds nothing; once everything is carried it puts the armour on.
// Food is the exception: put in the chest it is not there to eat, and a bot
// gathering iron for an hour starved with its meat stored at home. It is
// hunted last, straight into the bag (stockFood.js).

const { createDeviceProjectGoal } = require('./deviceProject');
const { createGatherMaterialsGoal } = require('./gatherMaterials');
const { createStockFoodGoal, FOOD_MOBS } = require('./stockFood');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultActions = require('../actions');
const defaultSkills = require('../skills');
const farming = require('../farming');
const { createBlacklist, posKey } = require('../blacklist');
const { createStarterHouse } = require('../blueprints/starterHouse');
const { sleep, waitUntil, abortError } = require('../confirm');
const { KNOWLEDGE, countKey } = require('../knowledge');
const { applyWalkOnlyMovements, dimension } = require('../nether');
const { upgrades } = require('../armor');
const { entityDimensions } = require('../entityGeometry');
const { isHostile } = require('../perception');
const { farmlandFooting, standable } = require('../caveRetreat');
const { createResupplyIrrigation } = require('./resupplyFarm');

// Tools and weapons stay in the bag as they are made: stored, the bot spent
// hours mining with stone picks and fighting bare-handed beside a chest
// holding its iron sword and pickaxe.
const CARRY = /(_sword|_pickaxe|_axe)$|^(shield|bow)$/;
const isAbort = (error) => error?.code === 'aborted';
const fail = (reason) => ({ ok: false, reason });
const HOME_FOOD = 12;
const HOME_HEALTH = 10;
const REGEN_FOOD = 18;
const LOCAL_FOOD_RADIUS = 24;
const RANGED_HOSTILES = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch']);
const RANGED_RANGE = 16;
const MELEE_RANGE = 8;
const SHELTER_MELEE_RANGE = 5;
const UNSAFE_ROUTE = 'unsafe_resupply_food_route';
const APPROACH_SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const APPROACH_HAZARD = /^(water|lava|bubble_column|fire|soul_fire|magma_block|cactus|powder_snow|sweet_berry_bush|campfire|soul_campfire)$/;
const AIR = Object.freeze({ name: 'air', boundingBox: 'empty', shapes: [] });
const noFailedSteps = new Set();
const dryBlock = (block) => block && !APPROACH_HAZARD.test(block.name) && block.getProperties?.()?.waterlogged !== true;
const clearBlock = (block) => dryBlock(block) && block.boundingBox === 'empty' && !block.shapes?.length;
const FULL_CUBE = [0, 0, 0, 1, 1, 1];
const fullBlock = (block) => dryBlock(block) && block.shapes?.some((shape) =>
  shape.length === FULL_CUBE.length && shape.every((value, index) => value === FULL_CUBE[index]));

// A damaged shell can still break a line of fire. Require full collision
// blocks across several body rays; missing chunks and partial blocks are no cover.
function blocksThreat(bot, hostile, position) {
  const delta = position.minus(hostile.position);
  const distance = delta.norm();
  if (distance <= 2.5) return false;
  const side = new Vec3(-delta.z, 0, delta.x).scaled(.3 / distance);
  const eye = hostile.position.offset(0, 1.5, 0);
  return [.35, 1.05, 1.65].every((height) => [-1, 1].every((edge) => {
    const ray = position.offset(0, height, 0).plus(side.scaled(edge)).minus(eye);
    const samples = Math.ceil(ray.norm() * 5);
    for (let index = 1; index < samples; index += 1) {
      const block = bot.blockAt(eye.plus(ray.scaled(index / samples)).floored());
      if (!block) return false;
      if (fullBlock(block)) return true;
    }
    return false;
  }));
}

function createKit({ bot, items, kb = KNOWLEDGE, resupplyFood }) {
  const carried = (state, r) => Math.min(r.count, countKey(r.key, state.inventory, kb));
  const food = items.find((r) => r.key === 'food');
  const gathered = items.filter((r) => r !== food);
  const hunt = food ? createStockFoodGoal({ bot, target: food.count, kb }) : null;
  return {
    name: 'kit',
    // A device with no site: deviceProject walks to a site only while this is unset.
    memory: { device: { kind: 'kit' } },
    needs: () => gathered,
    isDone: (state) => items.every((r) => carried(state, r) >= r.count) && upgrades(bot).length === 0,
    progress: (state) => items.reduce((n, r) => n + carried(state, r), 0) + (upgrades(bot).length === 0 ? 1 : 0),
    async run(ctx) {
      for (const [item, slot] of upgrades(bot)) {
        try {
          await bot.equip(item, slot);
          ctx.record('equip', { item: item.name, slot });
        } catch (error) {
          if (isAbort(error)) throw error;
          return { ok: false, reason: 'equip_failed', item: item.name };
        }
      }
      if (hunt && !hunt.isDone(ctx.perceive())) return (resupplyFood || hunt.run)(ctx);
      return { ok: true };
    },
  };
}

function atResupplyHome(state, home, { verticalSlack = 1 } = {}) {
  const at = state.position;
  if (!at) return false;
  const a = home.anchor;
  return a ? at.x >= a.x + 1 && at.x < a.x + 6 && at.z >= a.z + 1 && at.z < a.z + 6
    && at.y >= a.y - verticalSlack && at.y < a.y + 2
    : at.distanceTo(new Vec3(home.centre.x + .5, home.centre.y, home.centre.z + .5)) <= 2;
}

function homeResupplyReady(state, home) {
  return atResupplyHome(state, home) && state.health >= HOME_HEALTH && state.food >= HOME_FOOD;
}

function resupplyShelter(bot, home, actions, skills) {
  if (!home.anchor || !home.door) return null;
  const position = new Vec3(home.door.x, home.door.y, home.door.z);
  const upper = position.offset(0, 1, 0);
  const house = createStarterHouse(home.anchor);
  const shell = [...house.blocks.map((block) => block.position), ...house.foundation]
    .map(({ x, y, z }) => new Vec3(x, y, z));
  const blocks = () => [bot.blockAt(position), bot.blockAt(upper)];
  const doorOpen = () => {
    const [low, high] = blocks();
    const lo = low?.getProperties?.(), hi = high?.getProperties?.();
    if (!/_door$/.test(low?.name || '') || low.name === 'iron_door' || high?.name !== low.name
      || lo?.half !== 'lower' || hi?.half !== 'upper' || typeof lo.open !== 'boolean'
      || lo.open !== hi.open || lo.facing !== hi.facing || lo.hinge !== hi.hinge) return null;
    return lo.open;
  };
  const insideIntact = ({ position: at, hostiles = [] }) => bot.health > 0 && dimension(bot) === 'overworld'
    && atResupplyHome({ position: at }, home, { verticalSlack: 0 })
    && !hostiles.some((hostile) => atResupplyHome({ position: hostile.position }, home) || hostile.position.distanceTo(at) <= 2);
  // Perception checks the shell directly. Path search can consider many
  // nodes in one tick, so reuse only a brief snapshot of static blocks there.
  let checkedUntil = 0;
  let intact = false;
  const checkShell = () => shell.every((p) => fullBlock(bot.blockAt(p)));
  const hasIntactShell = () => {
    if (Date.now() >= checkedUntil) {
      checkedUntil = Date.now() + 100;
      intact = checkShell();
    }
    return intact;
  };
  const covered = (state) => {
    if (!insideIntact(state) || !hasIntactShell()) return false;
    if (doorOpen() === false) return true;
    const a = home.anchor;
    // The starter door faces north. Two blocks deep and off its centreline,
    // the solid wall shields the body from a direct shot through the opening.
    return state.position.z >= a.z + 2 && Math.abs(state.position.x - position.x - .5) >= 2;
  };
  const sealed = (state) => doorOpen() === false && insideIntact(state) && checkShell();
  const missingDoor = () => {
    const [low, high] = blocks();
    return Boolean(low && high && (!/_door$/.test(low.name) || !/_door$/.test(high.name)));
  };
  const refuge = (state) => {
    const at = state.position;
    const feet = at.floored();
    if (feet.y !== home.anchor.y || !insideIntact(state) || !standable((p) => bot.blockAt(p), feet)
      || !fullBlock(bot.blockAt(feet.offset(0, 2, 0)))) return false;
    const wall = (dx, dz) => {
      const a = home.anchor;
      const x = dx < 0 ? a.x : dx > 0 ? a.x + house.size - 1 : feet.x;
      const z = dz < 0 ? a.z : dz > 0 ? a.z + house.size - 1 : feet.z;
      const face = new Vec3(x, feet.y, z);
      return fullBlock(bot.blockAt(face)) && fullBlock(bot.blockAt(face.offset(0, 1, 0)));
    };
    return (wall(-1, 0) || wall(1, 0)) && (wall(0, -1) || wall(0, 1))
      && !(state.hostiles || []).some((hostile) => hostile.position.distanceTo(at)
        <= (RANGED_HOSTILES.has(hostile.name) ? RANGED_RANGE : MELEE_RANGE) && !blocksThreat(bot, hostile, at));
  };
  const insideDoor = position.offset(0, 0, 1);
  const underRoof = (p, padding) => p.x - padding >= home.anchor.x && p.x + padding < home.anchor.x + house.size
    && p.z - padding >= home.anchor.z && p.z + padding < home.anchor.z + house.size;
  const onCoveredDoorway = (p) => p.y === position.y && underRoof(p, Math.max(.3, (bot.entity.width || .6) / 2) + .01)
    && (p.floored().equals(position) || p.floored().equals(insideDoor));
  // This edge stays beneath the verified continuous roof. A phantom with
  // its entire body over that same roof cannot hit through it.
  const overheadPhantom = (hostile, from, to, livePosition = from) => {
    if (hostile.name !== 'phantom' || !from?.floored().equals(position) || !to.floored().equals(insideDoor)
      || hostile.position.y < home.anchor.y + 3 || doorOpen() !== true
      || ![from, to, livePosition].every(onCoveredDoorway)) return false;
    const size = entityDimensions(bot.entities?.[hostile.id] || hostile, bot.registry);
    return Boolean(size && underRoof(hostile.position, size.width / 2 + .1) && hasIntactShell());
  };
  let lastWait = null;
  let nextBed = 0;
  const waitInside = async (ctx, waitReason = 'sealed_until_daylight') => {
    const state = ctx.perceive();
    const isSealed = sealed(state);
    const coveredRoom = missingDoor() && refuge(state);
    const reason = isSealed ? waitReason : coveredRoom ? 'covered_room_until_safe' : 'shelter_unconfirmed';
    if (lastWait !== reason) ctx.record('resupply_shelter_wait', { reason, position: state.position.floored() });
    lastWait = reason;
    const bed = home.bed && new Vec3(home.bed.x, home.bed.y, home.bed.z);
    if ((isSealed || coveredRoom) && state.isDay === false && Date.now() >= nextBed && bed
      && /_bed$/.test(bot.blockAt(bed)?.name || '') && actions.withinReach(bot, bed)) {
      nextBed = Date.now() + 20000;
      const result = await skills.useBed(bot, ctx, { position: bed });
      if (result.slept === true) return result;
    }
    await sleep(2000, ctx.signal);
    return { ok: true, waited: true };
  };
  const setDoor = async (ctx, open) => {
    if (doorOpen() === open) return null;
    if (doorOpen() === null) return fail('resupply_door_unconfirmed');
    if (!actions.withinReach(bot, position)) return fail('resupply_door_out_of_reach');
    try { await bot.activateBlock(bot.blockAt(position)); } catch (error) { if (isAbort(error)) throw error; }
    const confirmed = await waitUntil(() => doorOpen() === open, { timeoutMs: 1500, signal: ctx.signal });
    ctx.record('resupply_door', { open, confirmed });
    return confirmed ? { ok: true } : fail('resupply_door_unchanged');
  };
  return { position, doorOpen, covered, sealed, missingDoor, refuge, overheadPhantom, waitInside, setDoor };
}

// Base supplies use existing dry paths. Explicit harvesting still goes
// through the normal gather and dig checks, with branch mining disabled.
async function onSurfacePath(bot, home, run, accept = () => true) {
  const restoreWalk = applyWalkOnlyMovements(bot);
  const movement = bot.pathfinder?.movements;
  const neighbors = movement?.getNeighbors;
  if (typeof neighbors !== 'function') {
    try { return await run(); } finally { restoreWalk(); }
  }
  const floor = Math.min(Math.floor(bot.entity.position.y), home.centre.y - 8);
  const hasNeighbor = Object.hasOwn(movement, 'getNeighbors');
  movement.getNeighbors = function (node, ...args) {
    return neighbors.call(this, node, ...args).filter((move) => {
      if (move.y < floor) return false;
      const p = new Vec3(move.x, move.y, move.z);
      return accept(p.offset(.5, 0, .5), new Vec3(node.x + .5, node.y, node.z + .5)) && [-1, 0, 1].every((dy) => {
        const block = bot.blockAt(p.offset(0, dy, 0));
        return block && !/lava|water|fire|magma|campfire|cactus|powder_snow|bubble_column/.test(block.name);
      });
    });
  };
  try {
    return await run();
  } finally {
    if (hasNeighbor) movement.getNeighbors = neighbors;
    else delete movement.getNeighbors;
    restoreWalk();
  }
}

// Find the next physical foothold, then let the native follower execute only
// that leg. An adjacent door can be crossed only after both halves are open.
function shelterApproach(read, shelter, from, target, accept, failed = noFailedSteps, farmlandStart = null) {
  const door = shelter.position;
  const isDoor = (p) => p.equals(door);
  const dry = (p) => standable(read, p) || isDoor(p) && shelter.doorOpen() === true
    && standable((cell) => cell.equals(door) || cell.equals(door.offset(0, 1, 0)) ? AIR : read(cell), p);
  const safeLeg = (a, b, actualOrigin) => {
    const dy = b.y - a.y;
    const farmOrigin = farmlandStart && a.equals(from);
    if (Math.abs(a.x - b.x) + Math.abs(a.z - b.z) !== 1 || Math.abs(dy) > 1 || (!farmOrigin && !dry(a)) || !dry(b)) return false;
    if (farmOrigin && dy !== 0) return false;
    if ((isDoor(a) || isDoor(b)) && (a.x !== b.x || dy !== 0)) return false;
    return (dy === 0 || clearBlock(read((dy > 0 ? a : b).offset(0, 2, 0))))
      && accept(b.offset(.5, 0, .5), actualOrigin || (farmOrigin ? farmlandStart : a.offset(.5, 0, .5)));
  };
  const floor = Math.max(door.y - 5, from.y - 1);
  const queue = [{ at: from, first: null, steps: 0 }];
  const seen = new Set([posKey(from)]);
  for (let i = 0; i < queue.length && i < 1200; i += 1) {
    const { at, first, steps } = queue[i];
    if (first && (typeof target === 'function' ? target(at) : at.equals(target))) return { first, safeLeg, dry, steps };
    if (steps >= 28) continue;
    for (const [x, z] of APPROACH_SIDES) for (const y of [0, 1, -1]) {
      const next = at.offset(x, y, z);
      const id = posKey(next);
      if (seen.has(id) || next.y < floor || next.y > door.y + 2 || Math.hypot(next.x - door.x, next.z - door.z) > 20
        || (!first && failed.has(`${posKey(at)}>${id}`)) || !safeLeg(at, next)) continue;
      seen.add(id);
      queue.push({ at: next, first: first || next, steps: steps + 1 });
    }
  }
  return null;
}

// Clear one adjacent dirt block only when that exact cut opens a complete
// dry approach. Never excavate toward the house through an unproven route.
function shelterStepRepair(bot, read, home, shelter, from, target, priorCut) {
  if (!standable(read, from) || !clearBlock(read(from.offset(0, 2, 0)))) return null;
  const a = home.anchor;
  let best = null;
  for (const [x, z] of APPROACH_SIDES) {
    const p = from.offset(x, 1, z);
    if (priorCut && !p.equals(priorCut) || p.x >= a.x - 1 && p.x <= a.x + 7 && p.z >= a.z - 1 && p.z <= a.z + 7) continue;
    const block = read(p);
    if (!/^(grass_block|dirt|coarse_dirt)$/.test(block?.name || '') || block.diggable !== true
      || bot.companionHomeSite?.(p) || bot.companionProtectBlock?.(block) || bot.companionPlacedRecently?.(p)
      || !bot.canDigBlock?.(block)) continue;
    if (!clearBlock(read(p.offset(0, 1, 0))) || !clearBlock(read(p.offset(0, 2, 0)))
      || !APPROACH_SIDES.every(([dx, dz]) => dryBlock(read(p.offset(dx, 0, dz))))) continue;
    const projected = (cell) => cell.equals(p) ? AIR : read(cell);
    const route = shelterApproach(projected, shelter, from, target, () => true);
    if (route?.first.equals(p) && (!best || route.steps < best.steps)) best = { position: p, block, steps: route.steps };
  }
  return best;
}

function localFoodSafety(bot, home) {
  const centre = new Vec3(home.centre.x + .5, home.centre.y, home.centre.z + .5);
  const homeDistance = (position) => Math.hypot(position.x - centre.x, position.z - centre.z);
  const local = (position, radius = LOCAL_FOOD_RADIUS) => position.y >= centre.y - 7 && homeDistance(position) <= radius;
  const threatRange = (hostile, shelterRoute = false) => {
    if (RANGED_HOSTILES.has(hostile.name)) return RANGED_RANGE;
    return shelterRoute && hostile.name !== 'creeper' ? SHELTER_MELEE_RANGE : MELEE_RANGE;
  };
  const exposed = (position, hostiles, critical = false) => hostiles.some((hostile) => {
    const range = hostile.position.distanceTo(position);
    if (range <= MELEE_RANGE) return true;
    if (range > threatRange(hostile)) return false;
    if (critical) return true;

    if (typeof bot.world?.raycast !== 'function') return true;
    const from = hostile.position.offset(0, 1.5, 0);
    const delta = position.offset(0, 1.5, 0).minus(from);
    return !bot.world.raycast(from, delta.scaled(1 / range), range);
  });
  let refreshed = 0;
  let observed = [];
  const threats = (state, refresh = false) => {
    if (refresh || Date.now() >= refreshed) {
      refreshed = Date.now() + 100;
      // A skeleton at the farm can be in range of the next step while still
      // outside the ordinary perception radius from the house.
      observed = Object.values(bot.entities || {}).filter((entity) => entity.position && entity.isValid !== false
        && isHostile(entity) && !bot.companionSpare?.(entity));
    }
    return [...observed, ...(state.hostiles || []).filter((hostile) => hostile.selfAggressor)];
  };
  const safe = (position, hostiles) => local(position) && !exposed(position, hostiles, true);
  return { local, exposed, safe, threats, threatRange, homeDistance, centre };
}

function resupplyFoodFromSurface({ bot, home, actions, skills, kb, safety }) {
  const blacklist = createBlacklist({ ttlMs: 60000 });
  const farm = new Vec3(home.centre.x - 15, home.centre.y, home.centre.z);
  const explore = { around: { x: home.centre.x, z: home.centre.z, radius: 48 } };
  const harvestedPlots = new Map();
  const irrigation = createResupplyIrrigation({ bot, actions, skills, centre: home.centre });
  const find = (name, point, maxDistance, count, useExtraInfo) => {
    const id = bot.registry?.blocksByName?.[name]?.id;
    return Number.isInteger(id) && typeof bot.findBlocks === 'function'
      ? bot.findBlocks({ matching: id, point, maxDistance, count, ...(useExtraInfo ? { useExtraInfo } : {}) }) : [];
  };
  const plan = (state, critical) => {
    const inventory = state.inventory;
    if (home.stations?.crafting_table && countKey('wheat', inventory, kb) >= 3) return { kind: 'bread' };
    const hostiles = critical ? safety.threats(state) : [];
    const permitted = critical ? (p) => safety.local(p, LOCAL_FOOD_RADIUS - 2) && !safety.exposed(p, hostiles, true)
      : (p) => p.y >= home.centre.y - 7;
    for (const [key, plot] of harvestedPlots) {
      const stage = farming.plotState(bot, plot);
      if (!['empty', 'unknown'].includes(stage)) harvestedPlots.delete(key);
      if (inventory.wheat_seeds > 0 && stage === 'empty' && !blacklist.has(`plant:${key}`)
        && permitted(plot.offset(.5, 1, .5))) return { kind: 'plant', plot };
    }
    const crops = find('wheat', critical ? safety.centre : farm, 24, 64)
      .filter((p) => critical ? safety.local(p, LOCAL_FOOD_RADIUS - 2) : permitted(p))
      .map((p) => ({ position: p, plot: p.offset(0, -1, 0), state: farming.plotState(bot, p.offset(0, -1, 0)) }));
    const crop = crops.find(({ position, state }) => state === 'ripe'
      && !blacklist.has(posKey(position)) && permitted(position.offset(.5, 0, .5)));
    if (crop) return { kind: 'wheat', ...crop };
    if (!critical) return { kind: 'forage' };
    const berries = find('sweet_berry_bush', safety.centre, 24, 16, (b) => Number(b.getProperties?.().age) >= 2)
      .find((p) => !blacklist.has(`berry:${posKey(p)}`) && permitted(p.offset(.5, 0, .5)));
    if (berries) return { kind: 'berries', position: berries };
    const animal = Object.values(bot.entities || {}).find((entity) => FOOD_MOBS.includes(entity.name)
      && entity.position && !blacklist.has(`mob:${entity.id}`) && !bot.companionSpare?.(entity)
      && permitted(entity.position));
    if (animal) return { kind: 'animal', position: animal.position, animalId: animal.id };
    const growing = crops.filter((crop) => crop.state === 'growing');
    const basin = irrigation.plan(growing.map((crop) => crop.plot));
    if (basin && permitted(basin.offset(.5, 1, .5))) return { kind: 'irrigate', position: basin };
    return { kind: 'wait', growing: growing.length };
  };
  const run = async (ctx, target = plan(ctx.perceive(), false)) => {
    if (target.kind === 'bread') {
      return skills.craft(bot, ctx, { item: 'bread', times: 1, tablePosition: home.stations.crafting_table });
    }
    if (target.kind === 'plant') {
      const result = await farming.plant(bot, ctx, target.plot);
      const key = posKey(target.plot);
      if (result.ok) harvestedPlots.delete(key);
      else blacklist.add(`plant:${key}`, result.reason);
      return result;
    }
    if (target.kind === 'wheat') {
      harvestedPlots.set(posKey(target.plot), target.plot);
      const result = await farming.harvest(bot, ctx, target.plot);
      if (!result.ok || !result.gained) blacklist.add(posKey(target.position), result.reason || 'wheat_not_collected');
      return result;
    }
    if (target.kind === 'berries') {
      return skills.pickBerries(bot, ctx, { position: target.position, blacklist });
    }
    if (target.kind === 'irrigate') return irrigation.run(ctx, target.position);
    const hunted = await skills.huntOne(bot, ctx, { mobs: FOOD_MOBS, dropMatch: kb.food.match, blacklist, radius: 48,
      accept: (entity) => entity.position.y >= home.centre.y - 7 && !bot.companionSpare?.(entity)
        && (target.kind !== 'animal' || entity.id === target.animalId && safety.safe(entity.position, safety.threats(ctx.perceive()))) });
    if (target.kind === 'animal' || hunted.ok || hunted.reason !== 'no_mob_in_range') return hunted;
    return skills.explore(bot, ctx, explore);
  };
  return { plan, run };
}

/** `items`: [{ key, count }] in the knowledge's keys; `home`: { chest, stations, centre } of the finished house. */
function createOutfitGoal({ bot, items, home, kb = KNOWLEDGE, actions = defaultActions, skills = defaultSkills,
  createGather = createGatherMaterialsGoal, recoverAtHome = false, ...rest } = {}) {
  if (!Array.isArray(items) || items.length === 0) throw new TypeError('items must be a non-empty list');
  for (const r of items) {
    if (!kb[r?.key] || !Number.isSafeInteger(r.count) || r.count < 1) throw new TypeError(`bad item ${JSON.stringify(r)}`);
  }
  const safety = recoverAtHome ? localFoodSafety(bot, home) : null;
  const resupplyFood = recoverAtHome ? resupplyFoodFromSurface({ bot, home, actions, skills, kb, safety }) : undefined;
  const device = createKit({ bot, items, kb, resupplyFood: resupplyFood?.run });
  const goal = createDeviceProjectGoal({ bot, name: 'outfit', device, home, kb, actions, skills, carry: (key) => CARRY.test(key),
    createGather: recoverAtHome ? (options) => createGather({ ...options, surfaceOnly: true }) : createGather,
    ...rest, countWorn: true });
  const ownsGatherRoute = () => goal.memory.gather?.ownsRouteRecovery?.() === true;
  goal.ownsRouteRecovery = ownsGatherRoute;
  if (!recoverAtHome) return goal;

  goal.recoverAtHome = true;
  const runOutfit = goal.run;
  const shelter = resupplyShelter(bot, home, actions, skills);
  const shelterWitness = (state) => shelter?.sealed(state) === true || shelter?.missingDoor() === true
    && shelter.refuge({ ...state, hostiles: safety.threats(state) });
  const clearShelter = () => {
    if (bot.companionResupplySheltered === shelterWitness) delete bot.companionResupplySheltered;
  };
  let returned = false;
  let checkedChest = false;
  let lastFoodWait = null;
  let routeInterrupted = false;
  let routeDestination = null;
  let ownsShelterRoute = false;
  let homeCut = null;
  const failedApproaches = createBlacklist({ ttlMs: 12000 });
  const nearShelter = (position) => Boolean(shelter && position && typeof actions.goTo === 'function'
    && position.y >= shelter.position.y - 5 && Math.hypot(position.x - shelter.position.x, position.z - shelter.position.z) <= 16);
  goal.ownsRouteRecovery = () => ownsGatherRoute() || ownsShelterRoute
    || dimension(bot) === 'overworld' && bot.health > 0 && bot.health < HOME_HEALTH && nearShelter(bot.entity?.position);
  const resetRecovery = () => {
    returned = false; checkedChest = false; lastFoodWait = null; routeInterrupted = false; routeDestination = null;
    ownsShelterRoute = false;
    homeCut = null;
    failedApproaches.clear();
    clearShelter();
  };
  bot.on?.('death', resetRecovery);
  const disposeOutfit = goal.dispose;
  goal.dispose = () => {
    bot.removeListener?.('death', resetRecovery);
    clearShelter();
    return disposeOutfit();
  };
  goal.isDone = (state) => returned && dimension(bot) === 'overworld' && homeResupplyReady(state, home) && device.isDone(state);
  goal.progress = (state) => (returned ? 1 : 0) + (checkedChest ? 1 : 0) + device.progress(state);
  goal.run = async (ctx) => {
    if (ctx.signal?.aborted) throw abortError(ctx.signal);
    const state = ctx.perceive();
    const read = (p) => bot.blockAt(p);
    if (dimension(bot) !== 'overworld') return fail('resupply_wrong_dimension');
    if (state.position.y < home.centre.y - 8 && defaultActions.underground(bot)) {
      // The high priority cave retreat owns the way out while critically hurt.
      // A healthy bot may also start rearm away from home after a death.
      if (state.health <= 6) { await sleep(1000, ctx.signal); return { ok: true, waited: true }; }
      return (await actions.surface(bot, ctx)) || fail('resupply_below_surface');
    }
    const completeKit = device.isDone(state);
    const critical = state.health < HOME_HEALTH;
    const nightStone = state.isDay === false && goal.memory.gather?.ownsRouteRecovery?.() === true;
    const unarmed = countKey('stone_sword', state.inventory, kb) === 0;
    const needsProtection = critical || state.food < HOME_FOOD;
    const missingDoor = shelter?.missingDoor() === true;
    const inside = atResupplyHome(state, home, { verticalSlack: (critical || missingDoor) && shelter ? 0 : 1 });
    const doorstep = shelter?.position.offset(.5, 0, -.5);
    const nearbyHostiles = needsProtection || unarmed ? safety.threats(state, true) : [];
    const exposedUnarmed = unarmed && nearbyHostiles.some((hostile) => RANGED_HOSTILES.has(hostile.name)
      && hostile.position.distanceTo(state.position) <= RANGED_RANGE);
    const unarmedShelter = Boolean(shelter && unarmed && (state.isDay === false || exposedUnarmed));
    const threatened = needsProtection && (doorstep && safety.exposed(doorstep, nearbyHostiles, critical)
      || critical && !inside && safety.exposed(state.position, nearbyHostiles, true));
    const waitForDay = nightStone || unarmedShelter || needsProtection && (state.isDay === false || threatened);
    const carriedFood = countKey('food', state.inventory, kb);
    const foodTarget = checkedChest && needsProtection && state.food < REGEN_FOOD && carriedFood === 0 && !waitForDay
      ? resupplyFood.plan(state, critical) : null;
    const waitForFood = foodTarget?.kind === 'wait';
    const waitForHealing = critical && state.food >= REGEN_FOOD;
    const holdShelter = waitForDay || waitForFood || waitForHealing || critical && routeInterrupted;
    const guardRoute = critical || unarmedShelter;
    ownsShelterRoute = missingDoor && nearShelter(state.position) && (!inside || holdShelter);
    if (shelter && holdShelter) bot.companionResupplySheltered = shelterWitness;
    else clearShelter();
    // All low-health local travel uses the same live checks. A return may
    // back away from a threat already beside the starting cell, but cannot
    // move closer to it or enter another shooter's range.
    let routeHome = false;
    let shelterRoute = false;
    let preparingStep = null;
    let inwardDoorStep = null;
    let destinationStillSafe = null;
    let relaxedReturn = null;
    let deniedStep = false;
    const radius = returned ? Math.max(LOCAL_FOOD_RADIUS, safety.homeDistance(state.position) + 1) : Infinity;
    let scannedAt = 0;
    let observed = nearbyHostiles;
    const activeThreats = () => {
      if (Date.now() >= scannedAt) {
        scannedAt = Date.now() + 100;
        observed = safety.threats(ctx.perceive(), true);
      }
      return observed;
    };
    const refuge = (position, hostiles) => missingDoor && shelter.refuge({ position, hostiles });
    const cover = (position, hostiles) => shelter?.covered({ position, hostiles }) === true || refuge(position, hostiles);
    const screenedByRoof = (hostile, from, to, livePosition) => shelterRoute
      && shelter?.overheadPhantom(hostile, from, to, livePosition) === true;
    const unsafeToDig = (at, step, hostiles) => hostiles.some((hostile) => {
      const range = safety.threatRange(hostile, true);
      return Math.min(at.distanceTo(hostile.position), step.distanceTo(hostile.position)) <= range;
    });
    const screenedByWall = (hostile, position) => missingDoor && blocksThreat(bot, hostile, position);
    const safeStep = (position, from) => {
      if (!guardRoute && !shelterRoute) return true;
      if (routeDestination && !position.floored().equals(routeDestination)) return false;
      if (safety.homeDistance(position) > radius) return false;
      const hostiles = activeThreats();
      if (atResupplyHome({ position }, home) && cover(position, hostiles)) return true;
      const accepted = hostiles.every((hostile) => {
        const distance = position.distanceTo(hostile.position);
        const range = safety.threatRange(hostile, shelterRoute);
        return distance > range || screenedByRoof(hostile, from, position) || screenedByWall(hostile, position)
          || routeHome && from && from.distanceTo(hostile.position) <= range
          && distance > from.distanceTo(hostile.position) + .05;
      });
      deniedStep ||= !accepted;
      return accepted;
    };
    const guarded = async (label, run, homebound = false, cardinalApproach = false) => {
      if (!guardRoute && !(missingDoor && cardinalApproach)) return run(ctx);
      routeHome = homebound;
      shelterRoute = cardinalApproach;
      deniedStep = false;
      const origin = bot.entity.position.clone();
      const previous = new Map(activeThreats().map((threat) => [threat.id, origin.distanceTo(threat.position)]));
      const route = new AbortController();
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, route.signal]) : route.signal;
      let last = origin;
      let safetyBlocked = false;
      const check = () => {
        const here = bot.entity.position;
        const hostiles = activeThreats();
        if (shelterRoute && routeDestination && !destinationStillSafe?.() || relaxedReturn && !relaxedReturn()) {
          route.abort(UNSAFE_ROUTE);
          return;
        }
        if (preparingStep && unsafeToDig(here, preparingStep, hostiles)) { route.abort(UNSAFE_ROUTE); return; }
        if (cover(here, hostiles)) { last = here.clone(); return; }
        const moving = here.distanceTo(last) > .15;
        for (const threat of hostiles) {
          const distance = here.distanceTo(threat.position);
          const range = safety.threatRange(threat, shelterRoute);
          if (distance > range) continue;
          const doorPhantom = inwardDoorStep && threat.name === 'phantom';
          if (doorPhantom && screenedByRoof(threat, inwardDoorStep.from, inwardDoorStep.to, here)
            || screenedByWall(threat, here)) continue;
          if (doorPhantom || !homebound || !previous.has(threat.id) || previous.get(threat.id) > range
            || moving && distance < last.distanceTo(threat.position) - .1) {
            route.abort(UNSAFE_ROUTE);
            return;
          }
        }
        if (safety.homeDistance(here) > radius) route.abort(UNSAFE_ROUTE);
        if (moving) last = here.clone();
      };
      const monitor = setInterval(check, 100);
      try {
        check();
        if (signal.aborted) throw abortError(signal);
        const result = await run({ ...ctx, signal });
        if (signal.aborted) throw abortError(signal);
        if (!result?.ok && deniedStep && ['NoPath', 'Timeout', 'path_timeout', 'no_progress', 'not_arrived'].includes(result?.reason)) safetyBlocked = true;
        if (!safetyBlocked) return result;
      } catch (error) {
        if (!(isAbort(error) && route.signal.aborted && !ctx.signal?.aborted)) throw error;
      } finally {
        clearInterval(monitor);
      }
      routeInterrupted = true;
      ctx.record('resupply_route_interrupted', { leg: label, position: bot.entity.position.floored() });
      await sleep(500, ctx.signal);
      return { ok: true, waited: true, reason: UNSAFE_ROUTE };
    };
    const approachShelter = async (scoped) => {
      const feet = bot.entity.position.floored();
      const farmlandStart = farmlandFooting(read, bot.entity);
      // Pathfinder starts at the logical block above the observed farmland
      // collision surface. Only the initial node may use this partial floor.
      const from = farmlandStart ? feet.offset(0, 1, 0) : feet;
      const entrance = doorstep.floored();
      const open = shelter.doorOpen();
      const wait = async (reason) => {
        scoped.record('resupply_home_approach_wait', { reason, position: feet });
        await sleep(500, scoped.signal);
        return { ok: true, waited: true, reason };
      };
      if (missingDoor) {
        const hostiles = activeThreats().filter((h) => h.position.distanceTo(state.position) <= RANGED_RANGE
          || h.position.distanceTo(safety.centre) <= RANGED_RANGE);
        const target = (p) => refuge(p.offset(.5, 0, .5), hostiles);
        const path = shelterApproach(read, shelter, from, target, safeStep, failedApproaches, farmlandStart);
        if (path) return followStep(scoped, path, from, feet, farmlandStart, false, null, wait);
        if (hostiles.length) {
          const screening = hostiles.filter((h) => h.position.distanceTo(state.position) <= safety.threatRange(h, true));
          const safer = (p) => {
            if (!screening.length) return false;
            const next = p.offset(.5, 0, .5);
            const fromDistance = Math.min(...screening.map((h) => h.position.distanceTo(state.position)));
            const nextDistance = Math.min(...screening.map((h) => h.position.distanceTo(next)));
            return nextDistance > fromDistance + .05 || screening.every((h) => blocksThreat(bot, h, next));
          };
          const retreat = shelterApproach(read, shelter, from, safer, safeStep, failedApproaches, farmlandStart);
          if (retreat) return followStep(scoped, retreat, from, feet, farmlandStart, false, null, wait);
        }
        if (!hostiles.length && !needsProtection && !unarmed && completeKit && state.isDay === true) {
          const stillQuiet = () => activeThreats().every((h) => h.position.distanceTo(bot.entity.position) > RANGED_RANGE
            && h.position.distanceTo(safety.centre) > RANGED_RANGE);
          relaxedReturn = stillQuiet;
          try {
            if (!stillQuiet()) return wait('resupply_damaged_shelter_no_safe_route');
            scoped.record('resupply_damaged_shelter_daylight_return', { from: feet });
            const result = await actions.goNear(bot, scoped, safety.centre, 1, { timeoutMs: 30000 });
            return result.ok && atResupplyHome(ctx.perceive(), home, { verticalSlack: 0 }) && bot.entity.onGround
              ? result : wait(result.reason || 'resupply_damaged_shelter_arrival_unconfirmed');
          } finally {
            relaxedReturn = null;
          }
        }
        return wait('resupply_damaged_shelter_no_safe_route');
      }
      if (open === null) return wait('resupply_door_unconfirmed');
      if (open === false && from.equals(entrance) && bot.entity.onGround) return shelter.setDoor(scoped, true);
      const target = open ? shelter.position.offset(0, 0, 1) : entrance;
      const path = shelterApproach(read, shelter, from, target, safeStep, failedApproaches, farmlandStart);
      if (!path) {
        if (shelterApproach(read, shelter, from, target, () => true, noFailedSteps, farmlandStart)) return wait('resupply_home_route_unsafe');
        const cut = !farmlandStart && !returned && bot.entity.onGround && actions.digBlock
          && shelterStepRepair(bot, read, home, shelter, from, target, homeCut);
        if (!cut) return wait('resupply_no_dry_home_route');
        if (unsafeToDig(bot.entity.position, cut.position.offset(.5, 0, .5), activeThreats())) return wait('resupply_home_cut_unsafe');
        const cutKey = `cut:${posKey(cut.position)}`;
        if (failedApproaches.has(cutKey)) return wait('resupply_home_cut_cooldown');
        homeCut = cut.position;
        preparingStep = cut.position.offset(.5, 0, .5);
        failedApproaches.add(cutKey, 'resupply_home_cut_attempt');
        const result = await actions.digBlock(bot, scoped, cut.block);
        const confirmed = result.ok && standable(read, cut.position);
        scoped.record('resupply_home_cut', { from, position: cut.position, block: cut.block.name, confirmed, reason: result.reason });
        return confirmed ? { ok: true } : wait(result.reason || 'resupply_home_cut_unconfirmed');
      }
      return followStep(scoped, path, from, feet, farmlandStart, open, target, wait);
    };
    const followStep = async (scoped, path, from, feet, farmlandStart, open, target, wait) => {
      const { first, safeLeg, dry } = path;
      const arrived = () => bot.entity.onGround && bot.entity.position.floored().equals(first) && dry(first);
      const throughDoor = open === true && from.equals(shelter.position) && first.equals(target);
      const actualOrigin = throughDoor ? bot.entity.position : undefined;
      if (!bot.entity.onGround || (farmlandStart && !farmlandFooting(read, bot.entity))
        || !safeLeg(from, first, actualOrigin)) return wait('resupply_home_step_changed');
      if (throughDoor) {
        inwardDoorStep = { from: actualOrigin.clone(), to: first.offset(.5, 0, .5) };
      }
      routeDestination = first;
      destinationStillSafe = () => dry(first);
      let moved;
      try {
        moved = await actions.goTo(bot, scoped, new goals.GoalBlock(first.x, first.y, first.z),
          { timeoutMs: 6500, retryNoProgress: false });
        if (moved.ok) await waitUntil(arrived, { timeoutMs: 600, signal: scoped.signal });
      } finally {
        routeDestination = null;
        destinationStillSafe = null;
      }
      if (!arrived()) {
        failedApproaches.add(`${posKey(from)}>${posKey(first)}`, moved.reason || 'resupply_home_step_unconfirmed');
        return wait(moved.reason || 'resupply_home_step_unconfirmed');
      }
      scoped.record('resupply_home_step', { from: feet, to: first, ...(farmlandStart ? { partialFloor: 'farmland' } : {}) });
      return { ok: true };
    };
    return onSurfacePath(bot, home, async () => {
      if (!inside && (needsProtection || nightStone || unarmedShelter)) {
        const left = await guarded('leave_supply_quarry', (scoped) => goal.memory.gather?.leaveSurfaceQuarry?.(scoped), true);
        if (left) return left;
      }
      if (!returned || completeKit || holdShelter || foodTarget?.kind === 'bread') {
        if (!inside) {
          const goHome = (action, cardinal = false) => guarded(
            foodTarget?.kind === 'bread' ? 'return_for_bread' : 'return_home', action, true, cardinal);
          if ((guardRoute || missingDoor) && nearShelter(state.position)) return goHome(approachShelter, true);
          if (shelter?.doorOpen() === false) {
            if (actions.withinReach(bot, shelter.position)) return goHome((scoped) => shelter.setDoor(scoped, true));
            return goHome((scoped) => actions.goNear(bot, scoped, doorstep, 1, { timeoutMs: 30000 }));
          }
          return goHome((scoped) => actions.goNear(bot, scoped, safety.centre, 1, { timeoutMs: 90000 }));
        }
        if (!returned) {
          returned = true;
          ctx.record('resupply_home_arrived', { position: state.position.floored() });
        }
      }
      if (shelter && inside && holdShelter) {
        if (missingDoor && guardRoute && nearShelter(state.position) && !refuge(state.position, activeThreats())) {
          return guarded('damaged_shelter', approachShelter, true, true);
        }
        if (!missingDoor && shelter.doorOpen() === true) {
          if (!actions.withinReach(bot, shelter.position)) {
            const insideDoor = shelter.position.offset(.5, 0, 1.5);
            return guarded('close_shelter', (scoped) => actions.goNear(bot, scoped, insideDoor, 1, { timeoutMs: 15000 }));
          }
          return shelter.setDoor(ctx, false);
        }
      }
      if (!checkedChest) {
        const wanted = items.filter(({ key, count }) => countKey(key, state.inventory, kb) < count);
        if (wanted.length) {
          const result = await guarded('read_home_chest', (scoped) => skills.takeItems(bot, scoped, { position: home.chest,
            itemMatch: (name) => wanted.some(({ key }) => kb[key].match(name))
              || (name === 'water_bucket' && critical && !state.inventory.water_bucket)
              || /^(stick|wheat|cobblestone|cobbled_deepslate|coal|charcoal)$/.test(name)
              || kb.log.match(name) || kb.planks.match(name) }));
          ctx.record('resupply_chest_read', { ok: result.ok, reason: result.reason, taken: result.taken });
          if (result.waited) return result;
          if (!result.ok && result.reason !== 'chest_empty' && result.reason !== 'chest_missing') return result;
        }
        checkedChest = true;
        return { ok: true };
      }
      if (needsProtection || nightStone || unarmedShelter) {
        if (needsProtection && state.food < REGEN_FOOD) {
          if (carriedFood > 0) return actions.eat(bot, ctx);
          if (home.stations?.crafting_table && countKey('wheat', state.inventory, kb) >= 3 && inside) {
            return guarded('craft_bread', (scoped) => resupplyFood.run(scoped, { kind: 'bread' }));
          }
        }
        if (holdShelter) {
          const reason = threatened ? 'nearby_hostile' : waitForDay ? 'sealed_until_daylight'
            : waitForHealing ? 'awaiting_health_recovery' : routeInterrupted ? 'unsafe_resupply_food_route'
              : foodTarget?.growing ? 'awaiting_crop_regrowth' : 'no_safe_local_food';
          routeInterrupted = false;
          if (waitForFood) {
            const growing = foodTarget.growing;
            if (lastFoodWait !== growing) ctx.record('resupply_food_wait', { reason, growing });
            lastFoodWait = growing;
          }
          if (shelter) return shelter.waitInside(ctx, reason);
          await sleep(2000, ctx.signal);
          return { ok: true, waited: true };
        }
        lastFoodWait = null;
        if (shelter?.doorOpen() === false && inside) {
          clearShelter();
          return shelter.setDoor(ctx, true);
        }
        if (!critical) return resupplyFood.run(ctx, foodTarget);
        const { kind, plot, position } = foodTarget;
        ctx.record('resupply_food_target', { kind, position: position || plot });
        return guarded(kind, (scoped) => resupplyFood.run(scoped, foodTarget));
      }
      if (shelter?.doorOpen() === false && inside) {
        return shelter.setDoor(ctx, true);
      }
      return runOutfit(ctx);
    }, safeStep);
  };
  return goal;
}

module.exports = { createOutfitGoal, homeResupplyReady, upgrades };
