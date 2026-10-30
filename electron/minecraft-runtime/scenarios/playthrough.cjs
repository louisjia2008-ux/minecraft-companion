/* global module, require */
'use strict';
// The whole game from an empty inventory in a fresh natural world, the way a
// player's requests reach the bot through the language model: one task at a
// time through submitTask, the next one asked for when the last has ended.
// This file plays the model's part. It only ever sees what a model would:
// the companion's status, the bag, the world time. A task that ends without
// its result is asked for again, as a model would; nothing is done for the bot.
//
//   1. build the starter house                        homestead
//   2. iron armour, bow and arrows, buckets, obsidian outfit (gathered into the house chest)
//   3. blaze rods from a nether fortress             netherExpedition
//   4. ender pearls from endermen, night after night huntPearls
//   5. eyes of ender                                 outfit
//   6. the End: find the stronghold, kill the dragon endJourney
//   7. back home: a wheat farm, a cow pen, then the machines on its own
//      (cobblestone generator with a hopper, hopper-fed furnace)
//
// Judged by the server: the kill_dragon advancement, the house, the farm, the
// pen and both machines working.

const { verifyHomestead, testBlock, living } = require('./homestead.cjs');
const { advancement } = require('./end.cjs');
const { verifyMachines, productionSpecs } = require('./e2e.cjs');
const { installProductionEvidence } = require('./productionEvidence.cjs');
const { installFurnitureEvidence } = require('./furnitureEvidence.cjs');
const { perceive } = require('../core/perception');
const { countKey } = require('../core/knowledge');

const MINUTE = 60 * 1000;
const EYES = 12;
const BLAZE_RODS = Math.ceil(EYES / 2) + 1;
// Asked again this many times before the run counts the bot as stuck.
const RETRIES = 8;

const GEAR = [
  { key: 'iron_helmet', count: 1 }, { key: 'iron_chestplate', count: 1 }, { key: 'iron_leggings', count: 1 },
  { key: 'iron_boots', count: 1 }, { key: 'iron_sword', count: 1 }, { key: 'shield', count: 1 },
  { key: 'iron_pickaxe', count: 1 }, { key: 'bow', count: 1 }, { key: 'arrow', count: 48 },
  { key: 'water_bucket', count: 1 }, { key: 'flint_and_steel', count: 1 }, { key: 'obsidian', count: 10 },
  { key: 'cobblestone', count: 64 }, { key: 'food', count: 24 },
];
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
  { id: 'gear', task: 'outfit', args: () => ({ items: GEAR }), done: ({ bot, state }) => state.gearDone || kitDone(bot, GEAR) },
  { id: 'nether', task: 'netherExpedition', args: () => ({ blazeRods: BLAZE_RODS, witherSkulls: 0, trades: 0 }),
    done: ({ bot }) => have(bot, 'blaze_rod') + have(bot, 'ender_eye') / 2 >= BLAZE_RODS && bot.game?.dimension?.endsWith('overworld') },
  { id: 'pearls', task: 'huntPearls', args: ({ bot }) => ({ count: Math.max(1, EYES - have(bot, 'ender_eye')) }),
    when: ({ bot }) => bot.time?.timeOfDay >= 12500 && bot.time?.timeOfDay < 23000,
    done: ({ bot }) => have(bot, 'ender_pearl') + have(bot, 'ender_eye') >= EYES, nightly: true },
  { id: 'eyes', task: 'outfit', args: () => ({ items: EYE_KIT }), done: ({ bot }) => have(bot, 'ender_eye') >= EYES },
  { id: 'end', task: 'endJourney', args: () => ({ withCity: false, home: true }),
    done: ({ state, bot }) => state.dragon === true && !bot.game?.dimension?.endsWith('the_end') },
  { id: 'farm', task: 'farm', args: ({ companion }) => ({ bread: 3, center: farmCenter(companion) }),
    done: ({ state }) => state.goals.farm?.isDone?.(state.lastPerceive) },
  { id: 'ranch', task: 'ranch', args: () => ({ kind: 'cow', target: 3 }), done: ({ state }) => state.goals.ranch?.isDone?.(state.lastPerceive) },
  { id: 'machines', autonomy: true, done: ({ companion, bot }) => machinesDone(companion, bot) },
];

// Fields go a little way off the house, clear of the machine sites the director picks.
function farmCenter(companion) {
  const house = houseOf(companion);
  if (!house) return undefined;
  return { x: house.anchor.x - 12, y: house.anchor.y, z: house.anchor.z + 3 };
}

function machinesDone(companion, bot) {
  const m = companion.director.memory;
  const state = perceive(bot);
  return Boolean(m.cobbleGenerator?.isDone(state) && m.autoSmelter?.isDone(state));
}

async function dispatch(context, step, entry) {
  const { companion, write, bot } = context;
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

const playthroughNatural = {
  name: 'playthrough-natural',
  description: 'Empty inventory, easy, day/night and mobs on, a fresh natural world. Tasks come one at a time as from'
    + ' the language model: house, iron gear, blaze rods, ender pearls, eyes of ender, the dragon, then farm, pen and'
    + ' the machines. No help from the harness; a task that ends unfinished is asked for again.',
  serverProperties: { 'level-type': 'minecraft:normal', difficulty: 'easy', 'view-distance': 12 },
  serverPerRun: (run, seed) => ({ 'level-seed': seed + run * 101 }),
  viewDistance: 12,
  defaultDifficulty: 'easy',
  autonomous: true,
  timeoutMs: 16 * 60 * MINUTE,
  setupTimeoutMs: 180000,
  setup({ username, difficulty = 'easy' }) {
    return { commands: [...living(username, difficulty), `spreadplayers 0 0 0 24 false ${username}`], details: {} };
  },
  async initialize(context) {
    const { state } = context;
    state.furnitureEvidence = await installFurnitureEvidence(context);
    state.production = installProductionEvidence({ ...context,
      resolve: (position) => state.companion && productionSpecs(state.companion).find((spec) =>
        [spec.output, spec.furnace].filter(Boolean).some((p) => p.x === position.x && p.y === position.y && p.z === position.z)) });
  },
  async dispose({ state }) { await state.production?.dispose(); await state.furnitureEvidence?.dispose(); },
  async start(companion, state) {
    state.companion = companion;
    state.goals = {};
    state.steps = STEPS.map((s) => ({ id: s.id, asks: 0, askedAt: null, doneAt: null }));
    return null;
  },
  async onTick(context) {
    if (context.signal?.aborted) return;
    const { companion, bot, state, server, username, write } = context;
    state.lastPerceive = perceive(bot);
    if (!state.dragon && await advancement(server, username, 'end/kill_dragon')) {
      state.dragon = true;
      write('dragon_killed', { minute: Math.round(context.elapsedMs / MINUTE) });
    }
    const index = state.steps.findIndex((e) => !e.doneAt);
    if (index < 0) return;
    const step = STEPS[index];
    const entry = state.steps[index];
    if (step.done(context)) {
      entry.doneAt = Date.now();
      entry.minute = Math.round(context.elapsedMs / MINUTE);
      if (step.id === 'gear') state.gearDone = true;
      write('model_step_done', { step: step.id, minute: entry.minute, asks: entry.asks });
      console.log(`    model: ${step.id} done at ${entry.minute}m`);
      return;
    }
    // The model waits for the bot to finish (or give up) before asking again.
    if (companion.status().goal || (step.autonomy && entry.asks > 0)) return;
    if (step.when && !step.when(context)) return;
    // Pearls are a night's work each: a night that ends short is no failure.
    if (entry.asks >= RETRIES + (step.nightly ? 30 : 0)) {
      if (!entry.stuck) { entry.stuck = true; write('model_stuck', { step: step.id, asks: entry.asks }); console.log(`    model: STUCK at ${step.id}`); }
      return;
    }
    await dispatch(context, step, entry);
  },
  finishWhen: ({ state }) => state.steps?.every((e) => e.doneAt) || state.steps?.some((e) => e.stuck),
  async verify(context) {
    const { companion, server, username, state } = context;
    const dragon = await advancement(server, username, 'end/kill_dragon');
    const homestead = await verifyHomestead({ ...context, goal: companion.director.memory.homestead });
    const farm = state.goals.farm?.memory?.plots || [];
    let farmland = 0;
    for (const p of farm) if (await testBlock(server, p, 'minecraft:farmland')) farmland += 1;
    const pen = state.goals.ranch?.memory?.pen || null;
    const machines = await verifyMachines(context);
    const steps = Object.fromEntries(state.steps.map((e) => [e.id, e.doneAt ? `${e.minute}m/${e.asks}` : `-/${e.asks}`]));
    const pass = dragon && homestead.pass && farmland >= 8 && Boolean(pen) && machines.pass;
    return { pass, details: { dragon, house: homestead.pass, farmland, pen: Boolean(pen), machines: machines.pass, steps,
      homestead: homestead.details, ...machines.details,
      summary: `dragon=${dragon} house=${homestead.pass} farmland=${farmland} pen=${Boolean(pen)} machines=${machines.pass} steps=${JSON.stringify(steps)}` } };
  },
};

module.exports = { playthroughNatural, STEPS, GEAR, EYE_KIT };
