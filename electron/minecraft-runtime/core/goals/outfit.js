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

// Tools and weapons stay in the bag as they are made: stored, the bot spent
// hours mining with stone picks and fighting bare-handed beside a chest
// holding its iron sword and pickaxe.
const CARRY = /(_sword|_pickaxe|_axe)$|^(shield|bow)$/;
const isAbort = (error) => error?.code === 'aborted';
const fail = (reason) => ({ ok: false, reason });
const HOME_FOOD = 12;
const HOME_HEALTH = 10;

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
  const waitInside = async (ctx) => {
    const state = ctx.perceive();
    const reason = sealed(state) ? 'sealed_until_daylight' : 'shelter_unconfirmed';
    if (lastWait !== reason) ctx.record('resupply_shelter_wait', { reason, position: state.position.floored() });
    lastWait = reason;
    const bed = home.bed && new Vec3(home.bed.x, home.bed.y, home.bed.z);
    if (reason === 'sealed_until_daylight' && state.isDay === false && Date.now() >= nextBed && bed
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
async function onSurfacePath(bot, home, run) {
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
      return [-1, 0, 1].every((dy) => {
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

function resupplyFoodFromSurface({ bot, home, skills, kb }) {
  const blacklist = createBlacklist({ ttlMs: 60000 });
  const farm = new Vec3(home.centre.x - 15, home.centre.y, home.centre.z);
  const explore = { around: { x: home.centre.x, z: home.centre.z, radius: 48 } };
  let harvestedPlot = null;
  return async (ctx) => {
    const inventory = ctx.perceive().inventory;
    const table = home.stations?.crafting_table;
    if (table && countKey('wheat', inventory, kb) >= 3) {
      return skills.craft(bot, ctx, { item: 'bread', times: 1, tablePosition: table });
    }
    if (harvestedPlot) {
      const plot = harvestedPlot;
      harvestedPlot = null;
      if (inventory.wheat_seeds > 0 && farming.plotState(bot, plot) === 'empty') return farming.plant(bot, ctx, plot);
    }
    const wheat = bot.registry?.blocksByName?.wheat?.id;
    if (Number.isInteger(wheat) && typeof bot.findBlocks === 'function') {
      const crops = bot.findBlocks({ matching: wheat, point: farm, maxDistance: 24, count: 64 })
        .filter((p) => p.y >= home.centre.y - 7 && !blacklist.has(posKey(p)))
        .find((p) => farming.plotState(bot, p.offset(0, -1, 0)) === 'ripe');
      if (crops) {
        const plot = crops.offset(0, -1, 0);
        const result = await farming.harvest(bot, ctx, plot);
        if (result.ok) harvestedPlot = plot;
        if (!result.ok || !result.gained) blacklist.add(posKey(crops), result.reason || 'wheat_not_collected');
        return result;
      }
    }
    const hunted = await skills.huntOne(bot, ctx, { mobs: FOOD_MOBS, dropMatch: kb.food.match, blacklist, radius: 48,
      accept: (entity) => entity.position.y >= home.centre.y - 7 && !bot.companionSpare?.(entity) });
    if (hunted.ok || hunted.reason !== 'no_mob_in_range') return hunted;
    return skills.explore(bot, ctx, explore);
  };
}

/** `items`: [{ key, count }] in the knowledge's keys; `home`: { chest, stations, centre } of the finished house. */
function createOutfitGoal({ bot, items, home, kb = KNOWLEDGE, actions = defaultActions, skills = defaultSkills,
  createGather = createGatherMaterialsGoal, recoverAtHome = false, ...rest } = {}) {
  if (!Array.isArray(items) || items.length === 0) throw new TypeError('items must be a non-empty list');
  for (const r of items) {
    if (!kb[r?.key] || !Number.isSafeInteger(r.count) || r.count < 1) throw new TypeError(`bad item ${JSON.stringify(r)}`);
  }
  const resupplyFood = recoverAtHome ? resupplyFoodFromSurface({ bot, home, skills, kb }) : undefined;
  const device = createKit({ bot, items, kb, resupplyFood });
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
  const resetRecovery = () => { returned = false; checkedChest = false; clearShelter(); };
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
    return onSurfacePath(bot, home, async () => {
      const completeKit = device.isDone(state);
      const needsProtection = state.health < HOME_HEALTH || state.food < HOME_FOOD;
      const waitForDay = needsProtection && (state.isDay === false || shelter && state.hostiles?.some((hostile) =>
        hostile.position.distanceTo(shelter.position) <= 8));
      if (!returned || completeKit || waitForDay) {
        if (!atResupplyHome(state, home)) {
          if (shelter?.doorOpen() === false) {
            if (actions.withinReach(bot, shelter.position)) return shelter.setDoor(ctx, true);
            const doorstep = shelter.position.offset(.5, 0, -1.5);
            return actions.goNear(bot, ctx, doorstep, 1, { timeoutMs: 30000 });
          }
          const { x, y, z } = home.centre;
          return actions.goNear(bot, ctx, new Vec3(x + .5, y, z + .5), 1, { timeoutMs: 90000 });
        }
        if (!returned) {
          returned = true;
          ctx.record('resupply_home_arrived', { position: state.position.floored() });
        }
      }
      if (shelter && atResupplyHome(state, home) && waitForDay) {
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
              || /^(stick|wheat|cobblestone|cobbled_deepslate|coal|charcoal)$/.test(name)
              || kb.log.match(name) || kb.planks.match(name) });
          ctx.record('resupply_chest_read', { ok: result.ok, reason: result.reason, taken: result.taken });
          if (!result.ok && result.reason !== 'chest_empty' && result.reason !== 'chest_missing') return result;
        }
        checkedChest = true;
        return { ok: true };
      }
      if (state.food < HOME_FOOD || state.health < HOME_HEALTH) {
        if (state.food < 18) {
          if (countKey('food', state.inventory, kb) > 0) return actions.eat(bot, ctx);
          if (home.stations?.crafting_table && countKey('wheat', state.inventory, kb) >= 3 && atResupplyHome(state, home)) {
            return skills.craft(bot, ctx, { item: 'bread', times: 1, tablePosition: home.stations.crafting_table });
          }
          if (shelter && waitForDay) return shelter.waitInside(ctx);
          if (shelter?.doorOpen() === false && atResupplyHome(state, home)) {
            clearShelter();
            return shelter.setDoor(ctx, true);
          }
          return resupplyFood(ctx);
        }
        await sleep(2000, ctx.signal);
        return { ok: true, waited: true };
      }
      if (shelter?.doorOpen() === false && atResupplyHome(state, home)) {
        clearShelter();
        return shelter.setDoor(ctx, true);
      }
      return runOutfit(ctx);
    });
  };
  return goal;
}

module.exports = { createOutfitGoal, homeResupplyReady, upgrades };
