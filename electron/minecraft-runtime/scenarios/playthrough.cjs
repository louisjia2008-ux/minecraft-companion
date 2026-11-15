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
//      then bow and arrows, buckets, obsidian         outfit (gathered into the house chest)
//   3. blaze rods from a nether fortress             netherExpedition
//   4. ender pearls from endermen, night after night huntPearls
//   5. eyes of ender                                 outfit
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

const MINUTE = 60 * 1000;
const EYES = 12;
const BLAZE_RODS = Math.ceil(EYES / 2) + 1;
// Asked again this many times before the run counts the bot as stuck.
const RETRIES = 8;
// Bread a trip to the farm brings back; asked for again whenever the bot goes hungry with nothing in the bag.
const SNACK = 3;
// A trip to the farm ends once the bag holds food again, or after this long
// with nothing grown (the bot then hunts on its way); the next trip waits as long.
const SNACK_MS = 20 * MINUTE;
// Plots growing wheat for the farm to count as started.
const SOWN = 8;
const COWS = 3;
const AUDIT_STATS = { wheat: ['mcPlayWheat', 'minecraft.mined:minecraft.wheat'],
  bread: ['mcPlayBread', 'minecraft.crafted:minecraft.bread'],
  bred: ['mcPlayBred', 'minecraft.custom:minecraft.animals_bred'] };

const GEAR = [
  { key: 'iron_helmet', count: 1 }, { key: 'iron_chestplate', count: 1 }, { key: 'iron_leggings', count: 1 },
  { key: 'iron_boots', count: 1 }, { key: 'iron_sword', count: 1 }, { key: 'shield', count: 1 },
  { key: 'iron_pickaxe', count: 1 }, { key: 'bow', count: 1 }, { key: 'arrow', count: 48 },
  { key: 'water_bucket', count: 1 }, { key: 'flint_and_steel', count: 1 }, { key: 'obsidian', count: 10 },
  { key: 'cobblestone', count: 64 }, { key: 'food', count: 24 },
];
// Armour first, as a player would: worn, it keeps the bot alive through the
// nights spent hunting spiders for the bow's string.
const ARMORY = (r) => /^iron_(helmet|chestplate|leggings|boots|sword)$/.test(r.key) || r.key === 'shield';
const ARMOR = GEAR.filter(ARMORY).concat([{ key: 'food', count: 12 }]);
// Armour pieces worn now; a new set is asked for at most this often.
const worn = (bot) => [5, 6, 7, 8].filter((i) => /_(helmet|chestplate|leggings|boots)$/.test(bot.inventory?.slots?.[i]?.name || '')).length;
const REARM_MS = 60 * MINUTE;
// Every pickaxe worn out too: a world was shut in a flooded cave hole with
// none to dig its way out.
const hasPick = (bot) => (bot.inventory?.items?.() || []).some((i) => /_pickaxe$/.test(i.name));
const REARM = ARMOR.concat([{ key: 'iron_pickaxe', count: 1 }]);
// Then the rest for the trip, armour not asked again: worn through the hours
// this takes, it broke piece by piece and the full list was never all carried
// at once (a world spent eight hours re-making it). Arrows wait for the End.
const TRIP = GEAR.filter((r) => !ARMORY(r)).map((r) => {
  if (r.key === 'arrow') return { key: 'arrow', count: 16 };
  if (r.key === 'food') return { key: 'food', count: 12 };
  return r;
});
const EYE_KIT = [{ key: 'ender_eye', count: EYES }, { key: 'arrow', count: 48 }, { key: 'food', count: 24 },
  { key: 'cobblestone', count: 64 }, { key: 'water_bucket', count: 1 }];

const have = (bot, key) => countKey(key, perceive(bot).inventory);
const kitDone = (bot, kit) => kit.every((r) => have(bot, r.key) >= r.count);
const houseOf = (companion) => companion.director.memory.homestead?.memory?.house || null;

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
  { id: 'gear', task: 'outfit', args: () => ({ items: TRIP }), done: ({ bot, state }) => state.gearDone || kitDone(bot, TRIP) },
  { id: 'nether', task: 'netherExpedition', args: () => ({ blazeRods: BLAZE_RODS, witherSkulls: 0, trades: 0 }), patient: true,
    done: ({ bot }) => have(bot, 'blaze_rod') + have(bot, 'ender_eye') / 2 >= BLAZE_RODS && bot.game?.dimension?.endsWith('overworld') },
  { id: 'pearls', task: 'huntPearls', args: ({ bot }) => ({ count: Math.max(1, EYES - have(bot, 'ender_eye')) }),
    when: ({ bot }) => bot.time?.timeOfDay >= 12500 && bot.time?.timeOfDay < 23000,
    done: ({ bot }) => have(bot, 'ender_pearl') + have(bot, 'ender_eye') >= EYES, nightly: true },
  { id: 'eyes', task: 'outfit', args: () => ({ items: EYE_KIT }), done: ({ bot }) => have(bot, 'ender_eye') >= EYES },
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

// Fields go a little way off the house, clear of the machine sites the director picks.
function farmCenter(companion) {
  const house = houseOf(companion);
  if (!house) return undefined;
  return { x: house.anchor.x - 12, y: house.anchor.y, z: house.anchor.z + 3 };
}

function sown(bot, farm) {
  return (farm?.memory?.plots || []).filter((p) => bot.blockAt(new Vec3(p.x, p.y + 1, p.z))?.name === 'wheat').length;
}

// The bag has no food and the stomach is low, in the overworld (the farm is there).
function hungry({ bot }) {
  return bot.food <= 6 && have(bot, 'food') === 0 && Boolean(bot.game?.dimension?.endsWith('overworld'));
}

function machinesDone(companion, bot) {
  const m = companion.director.memory;
  const state = perceive(bot);
  return Boolean(m.cobbleGenerator?.isDone(state) && m.autoSmelter?.isDone(state));
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
  write('model_ask', { step: step.id, task: step.task, args, ask: entry.asks, position: bot.entity?.position?.floored?.() });
  console.log(`    model: ${step.task}${entry.asks > 1 ? ` (again, ${entry.asks})` : ''}`);
  context.state.goals[step.id] = await companion.submitTask(step.task, args);
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
  if (death.respawn && !death.kitObserved && kitDone(bot, REARM)) {
    death.kitObserved = { at: Date.now(), clientInventory: bagOf(bot), phase: activeStage(state) };
    write('playthrough_kit_observed', { death: death.id, ...death.kitObserved,
      note: 'Client-observed rearm kit; does not prove original drops were recovered.' });
  }
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
    if (state.audit && ['goal_set', 'goal_done', 'goal_failed', 'goal_cleared', 'stopped'].includes(event.type)) {
      const evidence = { ...event, at: event.at || Date.now(), phase: activeStage(state) };
      state.audit.taskEvents.push(evidence);
      state.writeAudit?.('playthrough_task_event', evidence);
    }
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
    await observeReturn(context);
    const index = state.steps.findIndex((e) => !e.doneAt);
    if (index < 0) return;
    const step = STEPS[index];
    const entry = state.steps[index];
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
      write('model_step_done', { step: step.id, minute: entry.minute, asks: entry.asks });
      console.log(`    model: ${step.id} done at ${entry.minute}m`);
      return;
    }
    // Hungry with nothing to eat and the animals around the house long since
    // hunted: the model sends the bot to its farm for bread, then asks for
    // the step again (the detour is not counted as one of its asks).
    const goal = companion.status().goal;
    if (state.snack && (!goal || have(bot, 'food') > 0 || Date.now() - (state.snackAt || 0) > SNACK_MS)) {
      state.snack = false;
      state.snackEnd = Date.now();
      // The farm may still be running: the step asked again replaces it.
      state.replace = Boolean(goal);
      entry.asks = Math.max(0, entry.asks - 1);
    } else if (!state.snack && hungry(context) && state.steps[1].doneAt && step.id !== 'farm'
      && Date.now() - (state.snackEnd || 0) > SNACK_MS) {
      state.snack = true;
      state.snackAt = Date.now();
      state.activeStage = 'snack';
      write('model_ask', { step: 'snack', task: 'farm', args: { bread: SNACK } });
      console.log('    model: farm (hungry)');
      await companion.submitTask('farm', { bread: SNACK, center: farmCenter(companion) });
      return;
    }
    // Armour worn through (it breaks piece by piece over the nights): before
    // the next step out there, the model asks for a new set. Not counted as
    // one of the step's asks. A world hunted pearls twelve nights without a
    // piece on, died seventeen times and hid from every enderman it angered.
    if (state.rearm) {
      if (goal) return;
      state.rearm = false;
      state.replace = false;
    } else if (index > STEPS.findIndex((s) => s.id === 'gear') && (worn(bot) < 2 || !hasPick(bot)) && (!goal || entry.asks > 0)
      && bot.game?.dimension?.endsWith('overworld') && Date.now() - (state.rearmAt || 0) > REARM_MS) {
      state.rearm = true;
      state.rearmAt = Date.now();
      state.activeStage = 'rearm';
      write('model_ask', { step: 'rearm', task: 'outfit', args: { items: REARM } });
      console.log('    model: outfit (armour or pickaxe worn out)');
      await companion.submitTask('outfit', { items: REARM });
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

module.exports = { playthroughNatural, STEPS, GEAR, EYE_KIT, atHouse, readPlayer, verifyFarm, verifyRanch, observeReturn, observeRecovery };
