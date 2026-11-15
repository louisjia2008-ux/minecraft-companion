/* global module, require, process */
'use strict';
// The whole game from an empty inventory in a fresh natural world, the way a
// player's requests reach the bot through the language model: one task at a
// time through submitTask, the next one asked for when the last has ended.
// This file plays the model's part. It only ever sees what a model would:
// the companion's status, the bag, the world time. A task that ends without
// its result is asked for again, as a model would; nothing is done for the bot.
//
//   1. build the starter house                        homestead
//      and a wheat farm by it, for bread whenever     farm
//      the animals around are hunted out
//   2. iron armour, worn                              outfit
//      then buckets and obsidian                      outfit (gathered into the house chest)
//   3. blaze rods from a nether fortress             netherExpedition
//   4. ender pearls from endermen, night after night huntPearls
//   5. eyes of ender, bow and arrows                 outfit
//   6. the End: find the stronghold, kill the dragon endJourney
//   7. back home: recheck/repair the same house and farm, then a cow pen
//      and the machines on its own
//      (cobblestone generator with a hopper, hopper-fed furnace)
//
// Judged by the server: the kill_dragon advancement, the house, the farm, the
// pen and both machines working.

const { verifyHomestead, testBlock, living } = require('./homestead.cjs');
const { advancement, playerDimension } = require('./end.cjs');
const { playerState } = require('./acceptance.cjs');
const { verifyMachines, productionSpecs } = require('./e2e.cjs');
const { installProductionEvidence } = require('./productionEvidence.cjs');
const { installFurnitureEvidence } = require('./furnitureEvidence.cjs');
const { Vec3 } = require('vec3');
const { perceive } = require('../core/perception');
const { countKey } = require('../core/knowledge');
const { RISKY_FOODS } = require('../core/actions');
const { homeOf } = require('../core/goals/registry');
const { homeResupplyReady } = require('../core/goals/outfit');
const { pearlCaveRecoveryNeeded, pearlHomeReturnNeeded, pearlWaterBank } = require('../core/goals/huntPearls');
const { expeditionFoodCount } = require('../core/goals/stockFood');
const { isThreateningMobEntity } = require('../vendor/server/minecraft/entitySemantics');

const MINUTE = 60 * 1000;
// Twelve portal frames plus two eyes lost during the seed 2 stronghold scouting run.
const EYES = 14;
const BLAZE_RODS = 7;
// Asked again this many times before the run counts the bot as stuck.
const RETRIES = 8;
// Bread a trip to the farm brings back; asked for again whenever the bot goes hungry with nothing in the bag.
const SNACK = 3;
// Leave time for more wheat to grow after a trip to the established farm.
const SNACK_MS = 20 * MINUTE;
// Plots growing wheat for the farm to count as started.
const SOWN = 8;
const COWS = 3;
const AUDIT_STATS = { wheat: ['mcPlayWheat', 'minecraft.mined:minecraft.wheat'],
  bread: ['mcPlayBread', 'minecraft.crafted:minecraft.bread'],
  bred: ['mcPlayBred', 'minecraft.custom:minecraft.animals_bred'] };

const IRON_ARMOR = [
  { key: 'iron_helmet', count: 1 }, { key: 'iron_chestplate', count: 1 }, { key: 'iron_leggings', count: 1 },
  { key: 'iron_boots', count: 1 }, { key: 'iron_sword', count: 1 }, { key: 'shield', count: 1 },
];
const TRIP_FOOD = { key: 'food', count: 12 };
const ARMOR = [...IRON_ARMOR, TRIP_FOOD];
// Armour pieces worn now; a new set is asked for at most this often.
const worn = (bot) => [5, 6, 7, 8].filter((i) => /_(helmet|chestplate|leggings|boots)$/.test(bot.inventory?.slots?.[i]?.name || '')).length;
const REARM_MS = 60 * MINUTE;
// Every pickaxe worn out too: a world was shut in a flooded cave hole with
// none to dig its way out.
const hasPick = (bot) => (bot.inventory?.items?.() || []).some((i) => /_pickaxe$/.test(i.name));
const REARM = ARMOR.concat([{ key: 'iron_pickaxe', count: 1 }]);
const RECOVERY_BASE_KIT = [
  { key: 'stone_tier_pickaxe', count: 1 }, { key: 'stone_sword', count: 1 }, { key: 'food', count: 3 },
];
const PEARL_REARM = [...IRON_ARMOR, { key: 'iron_pickaxe', count: 1 }, { key: 'food', count: 3 }];
const WORN_ARMOR = [[5, 'helmet'], [6, 'chestplate'], [7, 'leggings'], [8, 'boots']];
const fullArmorWorn = (bot) => WORN_ARMOR.every(([slot, kind]) =>
  ['iron', 'diamond', 'netherite'].some((material) => bot.inventory?.slots?.[slot]?.name === `${material}_${kind}`))
  && bot.inventory?.slots?.[45]?.name === 'shield';
// The Nether expedition uses melee. Finish the portal supplies before
// spending time on the bow and arrows needed for the End.
const PORTAL_GEAR = [
  { key: 'iron_pickaxe', count: 1 }, { key: 'water_bucket', count: 1 }, { key: 'flint_and_steel', count: 1 },
  { key: 'obsidian', count: 10 }, { key: 'cobblestone', count: 64 },
];
const TRIP = [...PORTAL_GEAR, TRIP_FOOD];
// The native seed 2 dragon test consumed 55 arrows. Carry a full stack.
const END_WEAPONS = [{ key: 'bow', count: 1 }, { key: 'arrow', count: 64 }];
const END_FOOD = { key: 'food', count: 24 };
const GEAR = [...IRON_ARMOR, PORTAL_GEAR[0], ...END_WEAPONS, ...PORTAL_GEAR.slice(1), END_FOOD];
const EYE_KIT = [{ key: 'ender_eye', count: EYES }, ...END_WEAPONS, END_FOOD,
  { key: 'cobblestone', count: 64 }, { key: 'water_bucket', count: 1 }];

const have = (bot, key) => countKey(key, perceive(bot).inventory);
const kitDone = (bot, kit) => kit.every((r) => have(bot, r.key) >= r.count);
const houseOf = (companion) => companion.director.memory.homestead?.memory?.house || null;
const expeditionKitDone = (bot, kit) => {
  const inventory = perceive(bot).inventory;
  return kit.every(({ key, count }) => (key === 'food' ? expeditionFoodCount(bot, inventory) : countKey(key, inventory)) >= count);
};
const farmPlotPositions = (state) => (state?.goals?.farm?.memory?.plots || []).map(({ x, y, z }) => ({ x, y, z }));
const expeditionKitArgs = (items, state) => ({
  items, expeditionFood: true,
  farmPlots: farmPlotPositions(state),
});

// What the model asks for, in order. `done` reads the world as the model
// would see it (the bag, the dimension); `when` holds a step back (pearls at night).
const STEPS = [
  { id: 'house', task: 'homestead', args: () => ({}),
    done: ({ companion, bot }) => Boolean(companion.director.memory.homestead?.isDone(perceive(bot))) },
  { id: 'farm', task: 'farm', args: ({ companion }) => ({ bread: SNACK, center: farmCenter(companion) }),
    // Sown is enough: the wheat grows while the gear is gathered, and the bread is fetched when hungry.
    // Fewer plots by the water than that: all of them sown.
    done: ({ state, bot }) => state.goals.farm?.isDone?.(state.lastPerceive)
      || sown(bot, state.goals.farm) >= Math.min(SOWN, Math.max(1, state.goals.farm?.memory?.plots?.length || 0)) },
  { id: 'armor', task: 'outfit', args: () => ({ items: ARMOR }), done: ({ bot, state }) => state.armorDone || kitDone(bot, ARMOR) },
  { id: 'gear', task: 'outfit', args: ({ state } = {}) => expeditionKitArgs(TRIP, state),
    done: ({ bot, state }) => state.gearDone || expeditionKitDone(bot, TRIP) },
  { id: 'nether', task: 'netherExpedition', args: () => ({ blazeRods: BLAZE_RODS, witherSkulls: 0, trades: 0 }), patient: true,
    done: ({ bot }) => have(bot, 'blaze_rod') >= BLAZE_RODS && dimensionOf(bot) === 'overworld' },
  { id: 'pearls', task: 'huntPearls', args: ({ bot, state }) => {
    const coverage = pearlScoutCoverage(state);
    const directions = ['north', 'east', 'south', 'west'];
    const previous = state?.goals?.pearls?.memory?.scoutCoverage || {};
    const mostSampled = directions.reduce((best, d) => (previous[d] || 0) > (previous[best] || 0) ? d : best, 'north');
    const opposite = directions[(directions.indexOf(mostSampled) + 2) % directions.length];
    const scoutRadius = pearlScoutRadius(bot, state);
    const wide = scoutRadius === 80;
    const scoutSector = (wide ? ['south', 'east', 'west', 'north'] : [opposite, ...directions.filter((d) => d !== opposite)])
      .sort((a, b) => (coverage[a] || 0) - (coverage[b] || 0))[0];
    return { count: Math.max(1, EYES - have(bot, 'ender_eye')), ...(scoutRadius ? { scoutRadius } : {}),
      ...(wide || Object.keys(coverage).length ? { scoutSector } : {}) };
  },
    when: ({ bot, companion, state }) => {
      const { timeOfDay, day } = bot.time || {};
      if (timeOfDay >= 12500 && timeOfDay < 23000) return true;
      const home = companion?.director && houseOf(companion)?.interiorCenter;
      if (timeOfDay >= 10000 && timeOfDay < 12500 && pearlScoutRadius(bot, state) === 96
        && home && bot.entity?.position?.distanceTo(home) <= 16) return true;
      const feet = bot.entity?.position?.floored?.();
      const waterCell = feet && `${feet.x},${feet.y},${feet.z}`;
      return pearlCaveRecoveryNeeded(bot, home, bot.entity?.position)
        || (waterCell && state?.goals?.pearls?.memory?.waterReturnBlocked !== waterCell && Boolean(pearlWaterBank(bot, home)))
        || (Number.isFinite(timeOfDay) && timeOfDay < 12500 && (!Number.isFinite(day) || state?.goals?.pearls?.memory?.homeReturnBlockedDay !== day)
          && pearlHomeReturnNeeded(home, bot.entity?.position, bot));
    },
    done: ({ bot }) => have(bot, 'ender_pearl') + have(bot, 'ender_eye') >= EYES, nightly: true },
  { id: 'eyes', task: 'outfit', args: ({ state } = {}) => state?.endWeaponsRestock
    ? { items: END_WEAPONS } : expeditionKitArgs(EYE_KIT, state),
    done: ({ bot, state }) => expeditionKitDone(bot, state?.endWeaponsRestock ? END_WEAPONS : EYE_KIT) },
  { id: 'end', task: 'endJourney', args: () => ({ withCity: false, home: true }),
    done: ({ state }) => state.dragon === true && state.returnedOverworld?.pass === true },
  // This remains the original house-first journey, with explicit post-return
  // repair/use tasks. It does not claim a new house was built after the dragon.
  { id: 'house_after_end', task: 'homestead', args: () => ({}),
    done: ({ state }) => state.returnedHome?.pass === true && state.postReturnHouse?.pass === true },
  { id: 'farm_after_end', task: 'farm', args: ({ companion, state }) => ({ bread: SNACK,
    center: state.goals.farm?.memory?.center || farmCenter(companion) }),
    done: ({ state }) => state.postReturnFarm?.pass === true },
  { id: 'ranch', task: 'ranch', args: () => ({ kind: 'cow', target: COWS }), done: ({ state }) => state.goals.ranch?.isDone?.(state.lastPerceive) },
  { id: 'machines', autonomy: true, done: ({ companion, bot }) => machinesDone(companion, bot) },
];
const ARMOR_INDEX = STEPS.findIndex((step) => step.id === 'armor');
const GEAR_INDEX = STEPS.findIndex((step) => step.id === 'gear');
const EYES_INDEX = STEPS.findIndex((step) => step.id === 'eyes');
const END_INDEX = STEPS.findIndex((step) => step.id === 'end');

// Fields go a little way off the house, clear of the machine sites the director picks.
function farmCenter(companion) {
  const house = houseOf(companion);
  if (!house) return undefined;
  return { x: house.anchor.x - 12, y: house.anchor.y, z: house.anchor.z + 3 };
}

function sown(bot, farm) {
  return (farm?.memory?.plots || []).filter((p) => bot.blockAt(new Vec3(p.x, p.y + 1, p.z))?.name === 'wheat').length;
}

const safeFood = (bot) => (bot.inventory?.items?.() || []).some((item) => item.count > 0
  && !RISKY_FOODS.has(item.name) && (bot.registry?.foodsByName?.[item.name] || countKey('food', { [item.name]: 1 }) > 0));

function hungry({ bot }) {
  return (bot.food <= 12 || bot.health < 16 && bot.food < 18)
    && !safeFood(bot) && dimensionOf(bot) === 'overworld';
}

function fightingEnderman(bot, goal) {
  if (goal?.name !== 'hunt_pearls') return false;
  const here = bot.entity?.position;
  return here && Object.values(bot.entities || {}).some((entity) =>
    entity.name === 'enderman' && entity.position?.distanceTo(here) <= 16
    && isThreateningMobEntity(entity, bot.registry));
}

function snackFarm(context) {
  const { companion, bot, state } = context;
  const farm = state.goals.farm?.memory;
  const table = houseOf(companion)?.furniture?.crafting_table?.position;
  if (!farm?.center || !farm.plots?.length || !table) return null;
  // Unloaded plots may have grown while we were away. Only suppress a return
  // when we can actually observe that none of the old plots are ripe.
  const wheat = (bot.inventory?.items?.() || []).filter((item) => item.name === 'wheat')
    .reduce((sum, item) => sum + item.count, 0);
  const possible = farm.plots.filter((p) => {
    const crop = bot.blockAt?.(new Vec3(p.x, p.y + 1, p.z));
    return !crop || crop.name === 'wheat' && Number(crop.getProperties?.().age) >= 7;
  });
  if (wheat + possible.length < 3) return null;
  const plain = ({ x, y, z }) => ({ x, y, z });
  return { bread: Math.min(2, Math.ceil((18 - bot.food) / 5)),
    center: plain(farm.center), snackPlots: farm.plots.map(plain), home: { table: plain(table) } };
}

function machinesDone(companion, bot) {
  const m = companion.director.memory;
  const state = perceive(bot);
  return Boolean(m.cobbleGenerator?.isDone(state) && m.autoSmelter?.isDone(state));
}

function pearlScoutCoverage(state) {
  const coverage = { ...state?.pearlScoutCoverage };
  for (const [sector, count] of Object.entries(state?.goals?.pearls?.memory?.scoutCoverage || {})) {
    coverage[sector] = (coverage[sector] || 0) + count;
  }
  return coverage;
}

function pearlWantsWide(state) {
  return new Set(state?.pearlDryNights || []).size >= 3;
}

function pearlScoutRadius(bot, state) {
  if (!pearlWantsWide(state) || bot.health < 18 || bot.food < 16 || !fullArmorWorn(bot)) return undefined;
  const carried = expeditionFoodCount(bot, perceive(bot).inventory);
  if (state.pearlWideScoutDry && carried >= 2) return 96;
  return carried >= 3 ? 80 : undefined;
}

function observePearlNight(bot, state) {
  const { nightDay, pearlsBeforeNight, scoutCoverage } = state.goals?.pearls?.memory || {};
  const { day, timeOfDay } = bot.time || {};
  if (Number.isSafeInteger(nightDay) && (day > nightDay || day === nightDay && timeOfDay > 23460)
    && Object.values(scoutCoverage || {}).some((count) => count > 0) && have(bot, 'ender_pearl') === pearlsBeforeNight) {
    state.pearlDryNights = [...new Set([...(state.pearlDryNights || []), nightDay])];
  }
}

async function provisionPearlScouts(context) {
  const { companion, bot, state, write } = context;
  const day = bot.time?.day;
  const time = bot.time?.timeOfDay;
  const reserve = state.pearlWideScoutDry ? 2 : 3;
  const active = companion.status().goal;
  if (state.pearlFoodRestock && state.pearlFoodRestock.generation === active?.generation) {
    if ((!state.pearlFoodRestock.urgent && time >= 12500)
      || expeditionFoodCount(bot, state.lastPerceive.inventory) >= reserve) {
      state.pearlFoodRestock = null;
      state.replace = Boolean(active);
      return false;
    }
    return true;
  }
  state.pearlFoodRestock = null;
  const home = companion.director && houseOf(companion)?.interiorCenter;
  const position = bot.entity?.position;
  const cannotFightHungry = bot.food < 15 && !safeFood(bot);
  if (!Number.isSafeInteger(day) || !Number.isFinite(time) || !home || !position || !fullArmorWorn(bot)
    || state.pearlFoodRestockDay === day
    || (cannotFightHungry ? fightingEnderman(bot, active) || Boolean(active && active.name !== 'hunt_pearls')
      : time >= 10000 || active || position.distanceTo(home) > 16 || !pearlWantsWide(state))
    || expeditionFoodCount(bot, state.lastPerceive.inventory) >= reserve) return false;
  const farmPlots = farmPlotPositions(state);
  if (!farmPlots.length) return false;
  const args = { items: [{ key: 'food', count: reserve }], recoverAtHome: true, farmPlots };
  state.pearlFoodRestockDay = day;
  write('model_ask', { step: 'pearl_food_restock', task: 'outfit', args, day });
  await companion.submitTask('outfit', args);
  const goal = companion.status().goal;
  if (goal) state.pearlFoodRestock = { generation: goal.generation, urgent: cannotFightHungry };
  return true;
}

async function dispatch(context, step, entry) {
  const { companion, write, bot } = context;
  context.state.activeStage = step.id;
  entry.asks += 1;
  entry.askedAt = Date.now();
  if (step.autonomy) {
    await companion.setAutonomy(true);
    write('model_ask', { step: step.id, autonomy: true, ask: entry.asks });
    return;
  }
  const args = step.args(context);
  const coverage = step.id === 'pearls' ? pearlScoutCoverage(context.state) : null;
  write('model_ask', { step: step.id, task: step.task, args, ask: entry.asks, position: bot.entity?.position?.floored?.() });
  console.log(`    model: ${step.task}${entry.asks > 1 ? ` (again, ${entry.asks})` : ''}`);
  context.state.goals[step.id] = await companion.submitTask(step.task, args);
  if (coverage) context.state.pearlScoutCoverage = coverage;
}

const positionOf = (bot) => bot.entity?.position ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null;
const dimensionOf = (bot) => String(bot.game?.dimension || '').replace(/^minecraft:/, '');
const bagOf = (bot) => Object.fromEntries(Object.entries(perceive(bot).inventory));
const activeStage = (state) => state.activeStage || state.steps?.find((entry) => !entry.doneAt)?.id || null;
// A farm task can finish immediately with bread already carried. In that
// case the original farm's server coordinates remain the thing to recheck.
const farmGoal = (state) => state.goals.farm_after_end?.memory?.plots?.length ? state.goals.farm_after_end : state.goals.farm;

function atHouse(position, house) {
  const a = house?.anchor;
  const size = house?.size || 7;
  return Boolean(position && a && position.x >= a.x && position.x < a.x + size
    && position.z >= a.z && position.z < a.z + size && position.y >= a.y - 1 && position.y <= a.y + 3);
}

async function readPlayer({ server, username, companion }) {
  const player = await playerState(server, username);
  const dimension = await playerDimension(server, username);
  return { ...player, dimension, alive: Number.isFinite(player.health) && player.health > 0,
    atHouse: dimension === 'overworld' && atHouse(player.position, houseOf(companion)) };
}

async function auditStat(server, username, key) {
  const objective = AUDIT_STATS[key][0];
  const match = await server.query(`scoreboard players get ${username} ${objective}`,
    /has (-?\d+) \[|Can't get value|Unknown scoreboard objective/, 5000);
  if (match[1] === undefined) throw new Error(`Missing playthrough statistic ${objective}`);
  return Number(match[1]);
}

async function verifyFarm({ server, username, goal, afterReturn = null }) {
  const plots = [...new Map((goal?.memory?.plots || []).map((p) => [`${p.x},${p.y},${p.z}`, p])).values()];
  // Load only the known plot chunks. No land, crops or items are supplied.
  const chunks = new Map(plots.map((p) => [`${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`, p]));
  for (const p of chunks.values()) await server.query(`forceload add ${p.x} ${p.z}`, /(Marked|already|forceloaded|loaded)/i, 10000);
  let farmland = 0;
  let crops = 0;
  for (const p of plots) {
    const tilled = await testBlock(server, p, 'minecraft:farmland');
    if (tilled) farmland += 1;
    if (tilled && await testBlock(server, { ...p, y: p.y + 1 }, 'minecraft:wheat')) crops += 1;
  }
  const wheatHarvested = await auditStat(server, username, 'wheat');
  const breadCrafted = await auditStat(server, username, 'bread');
  const harvestedAfterReturn = afterReturn ? Math.max(0, wheatHarvested - afterReturn.wheatHarvested) : 0;
  // A healthy farm can be in its harvesting interval with no standing wheat.
  // Retain server-observed crops after return, plus the actual harvest count;
  // neither a goal flag nor bare farmland alone establishes a working crop.
  const cropEvidence = crops > 0 || (afterReturn?.crops > 0 && harvestedAfterReturn > 0);
  return { pass: farmland >= SOWN && cropEvidence, farmland, crops, wheatHarvested, breadCrafted,
    harvestedAfterReturn, knownPlots: plots.length };
}

async function verifyRanch({ server, username, goal }) {
  const pen = goal?.memory?.pen;
  if (!pen?.corner || !Number.isInteger(pen.size) || pen.size < 3 || !pen.fences?.length || !pen.gate) {
    return { pass: false, reason: 'no_pen', inPen: 0, target: COWS };
  }
  const c = pen.corner;
  await server.query(`forceload add ${c.x - 1} ${c.z - 1} ${c.x + pen.size} ${c.z + pen.size}`,
    /(Marked|already|forceloaded|loaded)/i, 10000);
  let fences = 0;
  for (const p of pen.fences) if (await testBlock(server, p, '#minecraft:fences')) fences += 1;
  const gateClosed = await testBlock(server, pen.gate, '#minecraft:fence_gates[open=false]');
  const region = `x=${c.x + 1},y=${c.y - 1},z=${c.z + 1},dx=${pen.size - 3},dy=3,dz=${pen.size - 3}`;
  const match = await server.query(`execute in minecraft:overworld if entity @e[type=minecraft:cow,${region}]`,
    /Test passed, count: (\d+)|Test failed/, 5000);
  const inPen = match[1] ? Number(match[1]) : 0;
  // A calf may have grown during the machine stage. Preserve breeding as a
  // separate server statistic rather than requiring a calf forever.
  const bred = await auditStat(server, username, 'bred');
  return { pass: inPen >= COWS && fences === pen.fences.length && gateClosed,
    inPen, target: COWS, fences, expectedFences: pen.fences.length, gateClosed, bred, corner: c };
}

async function observeRecovery(context) {
  const { state, bot, write } = context;
  const death = state.audit?.deaths.at(-1);
  if (!death) return;
  if (!death.respawn && bot.health > 0) {
    const player = await readPlayer(context);
    if (player.alive) {
      death.respawn = { at: Date.now(), ...player };
      write('playthrough_respawn_observed', { death: death.id, ...death.respawn,
        clientInventory: bagOf(bot), note: 'Life confirmed by server; equipment recovery is separate.' });
    }
  }
  if (death.respawn && !death.kitObserved && expeditionKitDone(bot, REARM)) {
    death.kitObserved = { at: Date.now(), clientInventory: bagOf(bot), phase: activeStage(state) };
    write('playthrough_kit_observed', { death: death.id, ...death.kitObserved,
      note: 'Client-observed rearm kit; does not prove original drops were recovered.' });
  }
}

async function runDeathRecovery(context, index, entry) {
  const { companion, bot, state, write } = context;
  const death = state.audit?.deaths.at(-1);
  if (!death || index < ARMOR_INDEX || index > END_INDEX) return false;
  if (state.deathRecovery?.death !== death.id) {
    state.deathRecovery = { death: death.id, phase: 'base', attempts: 0, goal: null };
    state.rearm = false;
    state.snack = false;
  }
  const recovery = state.deathRecovery;
  if (recovery.phase === 'done') return false;
  if (!death.respawn?.alive || !state.lastPerceive.alive) return true;
  const status = companion.status();
  if (dimensionOf(bot) === 'the_nether') {
    if (status.goal && status.goal.generation === recovery.returnGoal) return true;
    if ((recovery.returnAsks || 0) >= RETRIES) {
      if (!entry.stuck) {
        entry.stuck = true;
        write('model_stuck', { step: entry.id, recovery: 'return_overworld', death: death.id, asks: recovery.returnAsks });
      }
      return true;
    }
    // A resupply walk can be interrupted by portal transit. The expedition
    // with no targets uses the existing return route without hunting mobs.
    const args = { blazeRods: 0, witherSkulls: 0, trades: 0 };
    recovery.returnAsks = (recovery.returnAsks || 0) + 1;
    write('model_ask', { step: 'rearm', phase: 'return_overworld', death: death.id, task: 'netherExpedition', args, ask: recovery.returnAsks });
    await companion.submitTask('netherExpedition', args);
    recovery.returnGoal = companion.status().goal?.generation;
    return true;
  }
  // A dimension-specific task already in flight owns its way out. While the
  // respawn is outside the Overworld, don't advance or start a new stage.
  if (dimensionOf(bot) !== 'overworld') {
    if (status.paused) await companion.resumeTask();
    return true;
  }
  const home = homeOf(companion.director.memory);
  if (!home) return false;
  // A hunter stays within the home area and can revisit its farm. The long
  // Nether and End approaches still need their expedition reserves.
  const base = recovery.phase === 'base';
  const pearlRearm = !base && entry.id === 'pearls';
  const recoveryItems = base ? RECOVERY_BASE_KIT : pearlRearm ? PEARL_REARM : REARM;
  const ready = recovery.phase === 'base'
    ? kitDone(bot, recoveryItems) && homeResupplyReady(state.lastPerceive, home)
    : expeditionKitDone(bot, recoveryItems) && fullArmorWorn(bot)
      && (!pearlRearm || homeResupplyReady(state.lastPerceive, home));
  if (ready) {
    write('playthrough_death_recovery_verified', { death: death.id, phase: recovery.phase, position: positionOf(bot),
      health: state.lastPerceive.health, food: state.lastPerceive.food, inventory: bagOf(bot) });
    if (recovery.phase === 'base' && index > ARMOR_INDEX) {
      Object.assign(recovery, { phase: 'iron', attempts: 0, goal: null });
      return true;
    }
    recovery.phase = 'done';
    // Retire even a paused task with its kit already intact. The following
    // stage must never observe a stale, paused outfit and wait for it forever.
    if (status.goal || status.paused) await companion.cancelTask('playthrough_death_resupply_complete');
    state.replace = false;
    return false;
  }
  // Field food must be reachable before the iron pack is complete. The
  // expedition outfit only stocks food once its other items are gathered.
  const plots = !base && !pearlRearm && farmPlotPositions(state);
  if (recovery.foodGoal != null && recovery.foodGoal === status.goal?.generation) return true;
  if (plots?.length && hungry(context) && Date.now() >= (recovery.nextFoodAt || 0)) {
    const wheat = have(bot, 'wheat');
    const seeds = have(bot, 'wheat_seeds');
    const harvestable = plots.some(({ x, y, z }) => {
      const ground = bot.blockAt?.(new Vec3(x, y, z));
      const crop = bot.blockAt?.(new Vec3(x, y + 1, z));
      return ground?.name === 'farmland' && (crop?.name === 'wheat'
        || /^(air|cave_air)$/.test(crop?.name || '') && Number(ground.getProperties?.().moisture) > 0 && seeds > 0);
    });
    if (wheat >= 3 || harvestable) {
      const args = { items: [{ key: 'food', count: 2 }], recoverAtHome: true, farmPlots: plots };
      recovery.nextFoodAt = Date.now() + SNACK_MS;
      write('model_ask', { step: 'rearm', phase: 'iron_food', death: death.id, task: 'outfit', args });
      await companion.submitTask('outfit', args);
      if (state.audit?.deaths.at(-1)?.id === death.id) recovery.foodGoal = companion.status().goal?.generation;
      else await companion.pauseTask('playthrough_death_resupply');
      return true;
    }
  }
  if (recovery.goal && status.goal && status.goal.generation === recovery.goal.generation) return true;
  if (recovery.attempts >= RETRIES) {
    if (!entry.stuck) {
      entry.stuck = true;
      write('model_stuck', { step: entry.id, recovery: recovery.phase, death: death.id, asks: recovery.attempts });
    }
    return true;
  }
  const needsIronMine = pearlRearm && recovery.surfaceKitExhausted
    && !expeditionKitDone(bot, PEARL_REARM.filter(({ key }) => key !== 'food'));
  const mineForKit = needsIronMine && kitDone(bot, RECOVERY_BASE_KIT)
    && homeResupplyReady(state.lastPerceive, home)
    && bot.health >= 16 && bot.food >= 16;
  const args = base || pearlRearm && !mineForKit
    ? { items: needsIronMine ? RECOVERY_BASE_KIT : recoveryItems, recoverAtHome: true, farmPlots: farmPlotPositions(state) }
    : expeditionKitArgs(recoveryItems, state);
  recovery.attempts += 1;
  state.activeStage = 'rearm';
  write('model_ask', { step: 'rearm', phase: recovery.phase, death: death.id, task: 'outfit', args, ask: recovery.attempts,
    ...(needsIronMine && !mineForKit && { purpose: 'prepare_iron_mining' }) });
  await companion.submitTask('outfit', args);
  const running = companion.status().goal;
  // A concurrent death may pause this new invocation before dispatch returns.
  // Its successor will use the newer death receipt and recheck the whole kit.
  if (state.audit?.deaths.at(-1)?.id === death.id) recovery.goal = running ? { generation: running.generation, mineForKit } : null;
  else await companion.pauseTask('playthrough_death_resupply');
  return true;
}

async function observeReturn(context) {
  const { state, companion, write, server, username } = context;
  if (!state.dragon || state.returnedHome?.pass || !state.lastEndExitAt) return;
  const player = await readPlayer(context);
  const lastDeathAt = state.audit?.deaths.at(-1)?.at || 0;
  if (!player.alive || player.dimension !== 'overworld') return;
  // A broken bed may send the exit to world spawn. The existing homestead
  // task can then walk home/repair it; repeatedly entering the End cannot.
  if (!state.returnedOverworld?.pass && state.lastEndExitAt > lastDeathAt) {
    state.returnedOverworld = { pass: true, at: Date.now(), exitAttemptAt: state.lastEndExitAt, ...player };
    write('playthrough_return_overworld_verified', state.returnedOverworld);
  }
  if (!player.atHouse || !state.returnedOverworld?.pass) return;
  state.returnedHome = { pass: true, at: Date.now(), exitAttemptAt: state.lastEndExitAt,
    ...player, houseAnchor: { ...houseOf(companion).anchor },
    deathsAfterExit: (state.audit?.deaths || []).filter((d) => d.at >= state.returnedOverworld.at).length };
  const farm = await verifyFarm({ server, username, goal: state.goals.farm });
  state.returnFarmBaseline = farm;
  write('playthrough_return_home_verified', { ...state.returnedHome, farm });
}

const playthroughNatural = {
  name: 'playthrough-natural',
  description: 'Empty inventory, easy, day/night and mobs on, a fresh natural world. Tasks come one at a time as from'
    + ' the language model: house and farm first, iron gear, blaze rods, ender pearls, eyes of ender, the dragon,'
    + ' return to the same house, recheck/repair the house and farm, then pen and machines.'
    + ' No help from the harness; a task that ends unfinished is asked for again.',
  // A client/server mismatch on a Nether causeway got the bot kicked for
  // flying seven hours into a forty-hour run (the run now ends on a kick).
  // In the app a kick fails the task and the player reconnects; here it
  // would end the whole playthrough.
  serverProperties: { 'level-type': 'minecraft:normal', difficulty: 'easy', 'view-distance': 12, 'allow-flight': true },
  serverPerRun: (run, seed) => ({ 'level-seed': seed + run * 101 }),
  viewDistance: 12,
  defaultDifficulty: 'easy',
  autonomous: true,
  // Many hours a run: run on its own, not as a regression round.
  experimental: true,
  timeoutMs: (Number(process.env.PLAYTHROUGH_HOURS) || 16) * 60 * MINUTE,
  setupTimeoutMs: 180000,
  setup({ username, difficulty = 'easy', run = 0 }) {
    // PLAYTHROUGH_KEEP_INVENTORY=1: deaths keep the bag, to test the whole chain past the fights.
    const keep = process.env.PLAYTHROUGH_KEEP_INVENTORY === '1' ? ['gamerule keepInventory true'] : [];
    return { commands: [...living(username, difficulty), ...keep,
      ...Object.values(AUDIT_STATS).flatMap(([objective, criterion]) => [
        `scoreboard objectives add ${objective} ${criterion}`, `scoreboard players set ${username} ${objective} 0`,
      ]), `spreadplayers 0 0 0 24 false ${username}`],
    details: { keepInventory: keep.length > 0, acceptanceVariant: keep.length ? 'diagnostic_keep_inventory' : 'survival_death_drops',
      run, order: 'house/farm before dragon; repair/recheck after returning to the same house' } };
  },
  async initialize(context) {
    const { state, bot, write } = context;
    state.audit = { deaths: [], taskEvents: [] };
    state.writeAudit = write;
    state.onPlaythroughDeath = () => {
      const death = { id: state.audit.deaths.length + 1, at: Date.now(), phase: activeStage(state),
        dimension: dimensionOf(bot), position: positionOf(bot), positionSource: 'client_death_event', clientInventory: bagOf(bot) };
      state.audit.deaths.push(death);
      write('playthrough_death', death);
      const index = state.steps?.findIndex((step) => !step.doneAt);
      if (index >= ARMOR_INDEX && index <= END_INDEX && state.companion && houseOf(state.companion)) {
        // Block the old goal before the next brain tick can send the fresh
        // body back down the mine. Safety behaviours remain enabled.
        void state.companion.pauseTask('playthrough_death_resupply').catch((error) => {
          write('playthrough_death_pause_failed', { death: death.id, reason: error.message });
        });
      }
    };
    bot.on('death', state.onPlaythroughDeath);
    state.furnitureEvidence = await installFurnitureEvidence(context);
    state.production = installProductionEvidence({ ...context,
      resolve: (position) => state.companion && productionSpecs(state.companion).find((spec) =>
        [spec.output, spec.furnace].filter(Boolean).some((p) => p.x === position.x && p.y === position.y && p.z === position.z)) });
  },
  async dispose({ state, bot }) {
    if (state.onPlaythroughDeath) bot.removeListener('death', state.onPlaythroughDeath);
    await state.production?.dispose();
    await state.furnitureEvidence?.dispose();
  },
  async start(companion, state) {
    state.companion = companion;
    state.goals = {};
    state.steps = STEPS.map((s) => ({ id: s.id, asks: 0, askedAt: null, doneAt: null }));
    return null;
  },
  // The model reads why a task failed: a nether trip that could not build its
  // portal for want of obsidian (or flint and steel) sends it back for the gear.
  onEvent(event, state) {
    if (event.type === 'end_exit') state.lastEndExitAt = event.at || Date.now();
    if (event.type === 'pearl_wide_scout_dry_sortie' && event.behavior === 'goal:hunt_pearls' && event.radius === 80) {
      state.pearlWideScoutDry = true;
    }
    if (state.audit && ['goal_set', 'goal_done', 'goal_failed', 'goal_cleared', 'stopped'].includes(event.type)) {
      const evidence = { ...event, at: event.at || Date.now(), phase: activeStage(state) };
      state.audit.taskEvents.push(evidence);
      state.writeAudit?.('playthrough_task_event', evidence);
    }
    if (event.type === 'expedition_resupply_required' && event.behavior === 'goal:nether_expedition'
      && activeStage(state) === 'nether') state.netherFoodRestock ||= { asks: 0 };
    const recovery = state.deathRecovery;
    if (event.type === 'goal_failed' && event.goal === 'outfit' && recovery?.phase === 'iron'
      && recovery.goal?.generation != null && recovery.goal.generation === event.generation && !recovery.goal.mineForKit
      && event.reasons?.includes('surface_supply_requires_mine')) recovery.surfaceKitExhausted = true;
    if (event.type !== 'goal_failed' || event.goal !== 'nether_expedition' || !state.steps) return;
    const reasons = event.reasons || [];
    const short = reasons.filter((r) => r === 'missing_obsidian' || r === 'missing_flint_and_steel').length;
    if (short * 2 < reasons.length) return;
    const gear = state.steps.find((e) => e.id === 'gear');
    if (!gear?.doneAt) return;
    gear.doneAt = null;
    gear.asks = 0;
    state.gearDone = false;
  },
  async onTick(context) {
    if (context.signal?.aborted) return;
    const { companion, bot, state, server, username, write } = context;
    state.lastPerceive = perceive(bot);
    if (!state.dragon && await advancement(server, username, 'end/kill_dragon')) {
      state.dragon = true;
      write('dragon_killed', { minute: Math.round(context.elapsedMs / MINUTE) });
    }
    await observeRecovery(context);
    state.lastPerceive = perceive(bot);
    await observeReturn(context);
    const index = state.steps.findIndex((e) => !e.doneAt);
    if (index < 0) return;
    const step = STEPS[index];
    const entry = state.steps[index];
    if (await runDeathRecovery(context, index, entry) || context.signal?.aborted) return;
    if (step.id === 'pearls' && state.goals?.pearls?.memory?.distantScoutActive
      && companion.status().goal?.name === 'hunt_pearls') return;
    if (step.id === 'nether' && state.netherFoodRestock && dimensionOf(bot) === 'overworld' && !step.done(context)) {
      const restock = state.netherFoodRestock;
      const status = companion.status();
      if (expeditionKitDone(bot, [TRIP_FOOD])) {
        state.netherFoodRestock = null;
        if (status.goal) await companion.cancelTask('playthrough_nether_food_restock_complete');
        state.replace = true;
      } else {
        if (restock.generation != null && restock.generation === status.goal?.generation) return;
        if (restock.asks >= RETRIES) {
          entry.stuck = true;
          write('model_stuck', { step: 'nether', recovery: 'food_restock', asks: restock.asks });
          return;
        }
        const args = expeditionKitArgs([TRIP_FOOD], state);
        restock.asks += 1;
        write('model_ask', { step: 'nether_food_restock', task: 'outfit', args, ask: restock.asks });
        await companion.submitTask('outfit', args);
        restock.generation = companion.status().goal?.generation;
        return;
      }
    }
    // These are readbacks after an explicit task request, never completion
    // flags imported from the pre-dragon stage.
    if (entry.asks > 0 && step.id === 'house_after_end'
      && state.goals.house_after_end?.isDone?.(state.lastPerceive)) {
      state.postReturnHouse = await verifyHomestead({ ...context, goal: state.goals.house_after_end });
      write('playthrough_house_rechecked', state.postReturnHouse);
    }
    if (entry.asks > 0 && step.id === 'farm_after_end'
      && (state.goals.farm_after_end?.isDone?.(state.lastPerceive) || sown(bot, state.goals.farm_after_end) > 0)) {
      const facts = await verifyFarm({ server, username, goal: farmGoal(state),
        afterReturn: state.returnFarmBaseline });
      state.postReturnFarm = { ...facts, at: Date.now() };
      write('playthrough_farm_rechecked', state.postReturnFarm);
    }
    if (step.done(context)) {
      entry.doneAt = Date.now();
      entry.minute = Math.round(context.elapsedMs / MINUTE);
      if (step.id === 'gear') state.gearDone = true;
      if (step.id === 'armor') state.armorDone = true;
      if (step.id === 'eyes') {
        state.endWeaponsRestock = false;
        if (entry.asks > 0) state.replace = true;
      }
      write('model_step_done', { step: step.id, minute: entry.minute, asks: entry.asks });
      console.log(`    model: ${step.id} done at ${entry.minute}m`);
      return;
    }
    // Hungry with nothing to eat and the animals around the house long since
    // hunted: the model sends the bot to its farm for bread, then asks for
    // the step again (the detour is not counted as one of its asks).
    if (step.id === 'pearls') {
      observePearlNight(bot, state);
      if (await provisionPearlScouts(context)) return;
    }
    const goal = companion.status().goal;
    if (state.snack && (!goal || bot.food >= 18 || Date.now() - (state.snackAt || 0) > SNACK_MS)) {
      state.snack = false;
      state.snackEnd = Date.now();
      // The farm may still be running: the step asked again replaces it.
      state.replace = Boolean(goal);
      entry.asks = Math.max(0, entry.asks - 1);
    } else if (!state.snack && !fightingEnderman(bot, goal) && hungry(context)
      && state.steps[1].doneAt && step.id !== 'farm' && !state.rearm
      && Date.now() - (state.snackEnd || 0) > SNACK_MS) {
      const args = snackFarm(context);
      if (args) {
        state.snack = true;
        state.snackAt = Date.now();
        state.activeStage = 'snack';
        write('model_ask', { step: 'snack', task: 'farm', args });
        console.log('    model: farm (hungry)');
        await companion.submitTask('farm', args);
        return;
      }
    }
    // Armour worn through (it breaks piece by piece over the nights): before
    // the next step out there, the model asks for a new set. Not counted as
    // one of the step's asks. A world hunted pearls twelve nights without a
    // piece on, died seventeen times and hid from every enderman it angered.
    if (state.rearm) {
      if (goal) return;
      state.rearm = false;
      state.replace = false;
    } else if (index > GEAR_INDEX && (worn(bot) < 2 || !hasPick(bot)) && (!goal || entry.asks > 0)
      && bot.game?.dimension?.endsWith('overworld') && Date.now() - (state.rearmAt || 0) > REARM_MS) {
      state.rearm = true;
      state.rearmAt = Date.now();
      state.activeStage = 'rearm';
      write('model_ask', { step: 'rearm', task: 'outfit', args: { items: REARM } });
      console.log('    model: outfit (armour or pickaxe worn out)');
      await companion.submitTask('outfit', { items: REARM });
      return;
    }
    // A death or rearm after completing the eyes can leave the bow behind.
    // The End journey may already have used arrows once underway, so only
    // repeat equipment preparation before dispatching it from the Overworld.
    if (index === END_INDEX && !state.dragon && dimensionOf(bot) === 'overworld'
      && (!goal || state.replace) && !kitDone(bot, END_WEAPONS)) {
      const eyes = state.steps[EYES_INDEX];
      Object.assign(eyes, { doneAt: null, minute: null, asks: 0 });
      state.endWeaponsRestock = true;
      write('playthrough_end_gear_missing', { missing: END_WEAPONS.filter((r) => have(bot, r.key) < r.count) });
      return;
    }
    // The model waits for the bot to finish (or give up) before asking again.
    // A step asked for the first time replaces what the last one left running (a farm left growing).
    if (state.snack || (goal && entry.asks > 0 && !state.replace) || (step.autonomy && entry.asks > 0)) return;
    if (step.when && !step.when(context)) return;
    // Pearls are a night's work each: a night that ends short is no failure.
    // The nether search goes on ask after ask while it covers new ground.
    if (entry.asks >= RETRIES + (step.nightly ? 30 : 0) + (step.patient ? 12 : 0)) {
      if (!entry.stuck) { entry.stuck = true; write('model_stuck', { step: step.id, asks: entry.asks }); console.log(`    model: STUCK at ${step.id}`); }
      return;
    }
    state.replace = false;
    await dispatch(context, step, entry);
  },
  finishWhen: ({ state }) => state.steps?.every((e) => e.doneAt) || state.steps?.some((e) => e.stuck),
  async verify(context) {
    const { companion, server, username, state } = context;
    const dragon = await advancement(server, username, 'end/kill_dragon');
    const homestead = await verifyHomestead({ ...context, goal: companion.director.memory.homestead });
    const player = await readPlayer(context);
    const farm = await verifyFarm({ server, username, goal: farmGoal(state),
      afterReturn: state.returnFarmBaseline });
    const ranch = await verifyRanch({ server, username, goal: state.goals.ranch });
    const keepMatch = await server.query('gamerule keepInventory', /keepInventory is currently set to: (true|false)/, 5000);
    const survivalDeathDrops = keepMatch[1] === 'false';
    const machines = await verifyMachines(context);
    const steps = Object.fromEntries(state.steps.map((e) => [e.id, e.doneAt ? `${e.minute}m/${e.asks}` : `-/${e.asks}`]));
    const allStepsDone = STEPS.every((step) => state.steps.some((e) => e.id === step.id && e.doneAt && !e.stuck));
    const a = houseOf(companion)?.anchor;
    const returnedAnchor = state.returnedHome?.houseAnchor;
    const returnedHome = state.returnedHome?.pass === true && a && returnedAnchor
      && ['x', 'y', 'z'].every((key) => a[key] === returnedAnchor[key]);
    // Do not require all wheat to be standing at one instant: the explicit
    // post-return task recorded a real crop and final farmland must still exist.
    const farmPass = farm.farmland >= SOWN && state.postReturnFarm?.pass === true;
    const pass = dragon && player.alive && player.dimension === 'overworld' && returnedHome
      && homestead.pass && state.postReturnHouse?.pass === true && farmPass && ranch.pass
      && machines.pass && allStepsDone && survivalDeathDrops;
    const unmet = Object.entries({ dragon, alive: player.alive, overworld: player.dimension === 'overworld', returnedHome: Boolean(returnedHome),
      house: homestead.pass && state.postReturnHouse?.pass === true, farm: farmPass, ranch: ranch.pass,
      machines: machines.pass, allStepsDone, survivalDeathDrops }).filter(([, ok]) => !ok).map(([key]) => key);
    return { pass: Boolean(pass), details: { dragon, house: homestead.pass, farmland: farm.farmland, farm, ranch,
      pen: ranch.pass, machines: machines.pass, steps, allStepsDone, survivalDeathDrops, player,
      returnedHome: state.returnedHome || null, postReturnHouse: state.postReturnHouse || null,
      returnedOverworld: state.returnedOverworld || null,
      postReturnFarm: state.postReturnFarm || null, deaths: context.deaths,
      recoveryEvidence: state.audit || { deaths: [], taskEvents: [] }, unmet,
      order: 'house/farm built before dragon; same house/farm rechecked after return',
      homestead: homestead.details, ...machines.details,
      summary: `dragon=${dragon} alive=${player.alive} dim=${player.dimension} returnedHome=${Boolean(returnedHome)}`
        + ` house=${homestead.pass} farmland=${farm.farmland} crops=${farm.crops} cows=${ranch.inPen}/${COWS}`
        + ` machines=${machines.pass} unmet=${unmet.join('/') || '-'} steps=${JSON.stringify(steps)}` } };
  },
};

module.exports = { playthroughNatural, STEPS, GEAR, EYE_KIT, REARM, RECOVERY_BASE_KIT, atHouse, readPlayer,
  verifyFarm, verifyRanch, observeReturn, observeRecovery };
