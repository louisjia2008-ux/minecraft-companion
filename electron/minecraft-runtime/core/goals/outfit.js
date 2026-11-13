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
const defaultActions = require('../actions');
const defaultSkills = require('../skills');
const farming = require('../farming');
const { createBlacklist, posKey } = require('../blacklist');
const { createStarterHouse } = require('../blueprints/starterHouse');
const { sleep, waitUntil, abortError } = require('../confirm');
const { KNOWLEDGE, countKey } = require('../knowledge');
const { applyWalkOnlyMovements, dimension } = require('../nether');
const { upgrades } = require('../armor');
const { isHostile } = require('../perception');
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

function atResupplyHome(state, home) {
  const at = state.position;
  if (!at) return false;
  const a = home.anchor;
  return a ? at.x >= a.x + 1 && at.x < a.x + 6 && at.z >= a.z + 1 && at.z < a.z + 6
    && at.y >= a.y - 1 && at.y < a.y + 2
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
  const cube = [0, 0, 0, 1, 1, 1];
  const full = (block) => block?.shapes?.some((shape) =>
    shape.length === cube.length && shape.every((value, index) => value === cube[index]));
  const sealed = ({ position: at, hostiles = [] }) => bot.health > 0 && dimension(bot) === 'overworld'
    && atResupplyHome({ position: at }, home) && doorOpen() === false
    && !hostiles.some((hostile) => atResupplyHome({ position: hostile.position }, home) || hostile.distance <= 2)
    && shell.every((p) => full(bot.blockAt(p)));
  let lastWait = null;
  let nextBed = 0;
  const waitInside = async (ctx, waitReason = 'sealed_until_daylight') => {
    const state = ctx.perceive();
    const isSealed = sealed(state);
    const reason = isSealed ? waitReason : 'shelter_unconfirmed';
    if (lastWait !== reason) ctx.record('resupply_shelter_wait', { reason, position: state.position.floored() });
    lastWait = reason;
    const bed = home.bed && new Vec3(home.bed.x, home.bed.y, home.bed.z);
    if (isSealed && state.isDay === false && Date.now() >= nextBed && bed
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
  return { position, doorOpen, sealed, waitInside, setDoor };
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
      return accept(p.offset(.5, 0, .5)) && [-1, 0, 1].every((dy) => {
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

function localFoodSafety(bot, home) {
  const centre = new Vec3(home.centre.x + .5, home.centre.y, home.centre.z + .5);
  const local = (position, radius = LOCAL_FOOD_RADIUS) => position.y >= centre.y - 7
    && Math.hypot(position.x - centre.x, position.z - centre.z) <= radius;
  const exposed = (position, hostiles) => hostiles.some((hostile) => {
    const range = hostile.position.distanceTo(position);
    if (range <= 8) return true;
    if (range > 16 || !RANGED_HOSTILES.has(hostile.name)) return false;
    if (typeof bot.world?.raycast !== 'function') return true;
    const from = hostile.position.offset(0, 1.5, 0);
    const delta = position.offset(0, 1.5, 0).minus(from);
    return !bot.world.raycast(from, delta.scaled(1 / range), range);
  });
  let refreshed = 0;
  let observed = [];
  const threats = (state, refresh = false) => {
    if (refresh || Date.now() >= refreshed) {
      refreshed = Date.now() + 200;
      // A skeleton at the farm can be in range of the next step while still
      // outside the ordinary perception radius from the house.
      observed = Object.values(bot.entities || {}).filter((entity) => entity.position && entity.isValid !== false
        && isHostile(entity) && !bot.companionSpare?.(entity));
    }
    return [...observed, ...(state.hostiles || []).filter((hostile) => hostile.selfAggressor)];
  };
  const safe = (position, hostiles) => local(position) && !exposed(position, hostiles);
  return { local, exposed, safe, threats, centre };
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
    const permitted = critical ? (p) => safety.local(p, LOCAL_FOOD_RADIUS - 2) && !safety.exposed(p, hostiles)
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
  if (!recoverAtHome) return goal;

  goal.recoverAtHome = true;
  const runOutfit = goal.run;
  const shelter = resupplyShelter(bot, home, actions, skills);
  const shelterWitness = (state) => shelter?.sealed(state) === true;
  const clearShelter = () => {
    if (bot.companionResupplySheltered === shelterWitness) delete bot.companionResupplySheltered;
  };
  let returned = false;
  let checkedChest = false;
  let lastFoodWait = null;
  let routeInterrupted = false;
  const resetRecovery = () => { returned = false; checkedChest = false; lastFoodWait = null; routeInterrupted = false; clearShelter(); };
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
    if (dimension(bot) !== 'overworld') return fail('resupply_wrong_dimension');
    if (state.position.y < home.centre.y - 8 && defaultActions.underground(bot)) {
      // The high priority cave retreat owns the way out while critically hurt.
      // A healthy bot may also start rearm away from home after a death.
      if (state.health <= 6) { await sleep(1000, ctx.signal); return { ok: true, waited: true }; }
      return (await actions.surface(bot, ctx)) || fail('resupply_below_surface');
    }
    const completeKit = device.isDone(state);
    const critical = state.health < HOME_HEALTH;
    const needsProtection = critical || state.food < HOME_FOOD;
    const inside = atResupplyHome(state, home);
    const doorstep = shelter?.position.offset(.5, 0, -1.5);
    const nearbyHostiles = needsProtection ? safety.threats(state, true) : [];
    const threatened = needsProtection && (doorstep && safety.exposed(doorstep, nearbyHostiles)
      || critical && !inside && safety.exposed(state.position, nearbyHostiles));
    const waitForDay = needsProtection && (state.isDay === false || threatened);
    const carriedFood = countKey('food', state.inventory, kb);
    const foodTarget = checkedChest && needsProtection && state.food < REGEN_FOOD && carriedFood === 0 && !waitForDay
      ? resupplyFood.plan(state, critical) : null;
    const waitForFood = foodTarget?.kind === 'wait';
    const waitForHealing = critical && state.food >= REGEN_FOOD;
    const holdShelter = waitForDay || waitForFood || waitForHealing || critical && routeInterrupted;
    let guardFoodPath = false;
    const safeStep = (position) => !guardFoodPath || atResupplyHome({ position }, home)
      || safety.safe(position, safety.threats(state));
    return onSurfacePath(bot, home, async () => {
      if (!returned || completeKit || holdShelter || foodTarget?.kind === 'bread') {
        if (!inside) {
          if (shelter?.doorOpen() === false) {
            if (actions.withinReach(bot, shelter.position)) return shelter.setDoor(ctx, true);
            return actions.goNear(bot, ctx, doorstep, 1, { timeoutMs: 30000 });
          }
          return actions.goNear(bot, ctx, safety.centre, 1, { timeoutMs: 90000 });
        }
        if (!returned) {
          returned = true;
          ctx.record('resupply_home_arrived', { position: state.position.floored() });
        }
      }
      if (shelter && inside && holdShelter) {
        if (shelter.doorOpen() === true) {
          if (!actions.withinReach(bot, shelter.position)) {
            const insideDoor = shelter.position.offset(.5, 0, 1.5);
            return actions.goNear(bot, ctx, insideDoor, 1, { timeoutMs: 15000 });
          }
          return shelter.setDoor(ctx, false);
        }
        bot.companionResupplySheltered = shelterWitness;
      }
      if (!checkedChest) {
        const wanted = items.filter(({ key, count }) => countKey(key, state.inventory, kb) < count);
        if (wanted.length) {
          const result = await skills.takeItems(bot, ctx, { position: home.chest,
            itemMatch: (name) => wanted.some(({ key }) => kb[key].match(name))
              || (name === 'water_bucket' && critical && !state.inventory.water_bucket)
              || /^(stick|wheat|cobblestone|cobbled_deepslate|coal|charcoal)$/.test(name)
              || kb.log.match(name) || kb.planks.match(name) });
          ctx.record('resupply_chest_read', { ok: result.ok, reason: result.reason, taken: result.taken });
          if (!result.ok && result.reason !== 'chest_empty' && result.reason !== 'chest_missing') return result;
        }
        checkedChest = true;
        return { ok: true };
      }
      if (needsProtection) {
        if (state.food < REGEN_FOOD) {
          if (carriedFood > 0) return actions.eat(bot, ctx);
          if (home.stations?.crafting_table && countKey('wheat', state.inventory, kb) >= 3 && inside) {
            return resupplyFood.run(ctx, { kind: 'bread' });
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
        guardFoodPath = true;
        const { kind, plot, position } = foodTarget;
        ctx.record('resupply_food_target', { kind, position: position || plot });
        if (ctx.signal?.aborted) throw abortError(ctx.signal);
        // The planned route can become exposed when a mob moves after A*.
        const route = new AbortController();
        const signal = ctx.signal ? AbortSignal.any([ctx.signal, route.signal]) : route.signal;
        const monitor = setInterval(() => {
          if (!safeStep(bot.entity.position)) route.abort('unsafe_resupply_food_route');
        }, 200);
        try {
          return await resupplyFood.run({ ...ctx, signal }, foodTarget);
        } catch (error) {
          if (isAbort(error) && route.signal.aborted && !ctx.signal?.aborted) {
            routeInterrupted = true;
            return fail('unsafe_resupply_food_route');
          }
          throw error;
        } finally {
          clearInterval(monitor);
        }
      }
      if (shelter?.doorOpen() === false && inside) {
        clearShelter();
        return shelter.setDoor(ctx, true);
      }
      return runOutfit(ctx);
    }, safeStep);
  };
  return goal;
}

module.exports = { createOutfitGoal, homeResupplyReady, upgrades };
