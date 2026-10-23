'use strict';
// Wires the brain to a live Mineflayer bot: perception, survival behaviors,
// conservative movement settings and the decision tick.

const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { createBrain } = require('./brain');
const { perceive } = require('./perception');
const { createSurvivalBehaviors } = require('./behaviors/survival');
const { createRecovery } = require('./behaviors/recovery');
const { createGatherLogsGoal } = require('./goals/gatherBlocks');
const { createHomesteadGoal } = require('./goals/homestead');
const { createFarmGoal } = require('./goals/farm');
const { createRanchGoal } = require('./goals/ranch');
const { createGatherMaterialsGoal } = require('./goals/gatherMaterials');
const { createCobbleGeneratorGoal } = require('./goals/cobbleGenerator');
const { createAutoSmelterGoal } = require('./goals/autoSmelter');
const { createCaneFarmGoal } = require('./goals/caneFarm');
const { createMobFarmGoal } = require('./goals/mobFarm');
const { createIronFarmGoal } = require('./goals/ironFarm');
const { createCarpetDuperGoal } = require('./goals/carpetDuper');
const { createFishingGoal } = require('./goals/fishing');
const { createRailDuperGoal } = require('./goals/railDuper');
const { createNetherQuartzGoal } = require('./goals/netherQuartz');
const { createDefaultCards } = require('./goals/registry');
const { createDirector } = require('./director');
const { haltBody } = require('./actions');
const { installInventoryCompatibility } = require('./inventory');
const { installEdgeNudge } = require('./edgeNudge');

// Never build scaffolding, pillar up or parkour on the surface: the bot must not leave
// self-placed obstacles behind, and a target that needs such moves is skipped.
function configureMovements(bot) {
  const movements = new Movements(bot);
  movements.canDig = true;
  movements.allow1by1towers = false;
  movements.scafoldingBlocks = [];
  movements.allowParkour = false;
  movements.allowSprinting = true;
  movements.maxDropDown = 4; // a 4-block drop costs one heart; 3 strands the bot on tree tops
  movements.infiniteLiquidDropdownDistance = false;
  movements.canOpenDoors = true;
  // Fences and gates are someone's pen: walk around or through, never dig them.
  for (const block of Object.values(bot.registry.blocksByName)) {
    if (/_fence(_gate)?$/.test(block.name)) movements.blocksCantBreak.add(block.id);
  }
  // Water is allowed but costly: banning it left the bot unable to reach
  // anything across a lake (all the animals on the far shore).
  movements.liquidCost = 5;
  // Walking across tree canopies strands the bot on leaves with long drops on
  // every side; stepping onto leaves is allowed but costly.
  const leaves = new Set(Object.values(bot.registry.blocksByName).filter((b) => b.name.endsWith('_leaves')).map((b) => b.id));
  movements.exclusionAreasStep.push((block) => {
    if (!block?.position) return 0;
    const below = bot.blockAt(block.position.offset(0, -1, 0));
    return below && leaves.has(below.type) ? 25 : 0;
  });
  bot.pathfinder.setMovements(movements);
  // Mining paths through stone need more search time than surface walks.
  bot.pathfinder.thinkTimeout = 10000;
  return movements;
}

function createCompanion({ bot, onEvent = () => {}, tickMs = 250, autonomy = false } = {}) {
  if (!bot) throw new TypeError('bot is required');
  installInventoryCompatibility(bot);
  const removeEdgeNudge = installEdgeNudge(bot);
  if (!bot.pathfinder) bot.loadPlugin(pathfinder);
  configureMovements(bot);

  // Stuck bodies, full bags and death loops are recovered for every goal alike.
  const recovery = createRecovery({ bot });
  // Animals the current goal keeps (a ranch's herd) are not hunted for food.
  let spare = () => false;
  const behaviors = [...createSurvivalBehaviors({ bot, spare: (entity) => spare(entity) }), ...recovery.behaviors];
  let director = null;
  const useGoal = (goal) => { spare = goal.spares || (() => false); brain.setGoal(goal); };
  const brain = createBrain({
    perceive: () => perceive(bot),
    behaviors,
    onEvent: (event) => {
      // A finished goal no longer keeps its herd from the cooking pot.
      if (['goal_done', 'goal_failed', 'goal_cleared', 'stopped'].includes(event.type)) spare = () => false;
      recovery.observe(event);
      director?.handleEvent(event);
      onEvent(event);
    },
  });
  recovery.attach(brain);
  // With no player task the director picks the next goal itself; off unless asked for.
  const { cards, stageOf } = createDefaultCards({ bot });
  director = createDirector({ brain, perceive: () => perceive(bot), cards, stageOf, onEvent });
  if (autonomy) director.enable();
  const timer = setInterval(() => {
    try { director.tick(); } catch (error) { onEvent({ type: 'autonomy_error', at: Date.now(), reason: String(error?.message || error) }); }
    brain.tick().catch(() => {});
  }, tickMs);
  timer.unref?.();
  // Death interrupts the current action only: progress lives in the world, so
  // after respawning the goal simply re-plans from what is left.
  const onDeath = () => { brain.interrupt('death').catch(() => {}); };
  bot.on('death', onDeath);

  return {
    brain,
    director,
    gatherLogs(count) {
      director.notePlayerGoal();
      useGoal(createGatherLogsGoal({ bot, count }));
      return brain.tick();
    },
    homestead(options = {}) {
      // One house per run: the director keeps building the one the player asked for.
      const goal = Object.keys(options).length === 0 && director.memory.homestead
        ? director.memory.homestead
        : createHomesteadGoal({ bot, ...options });
      director.memory.homestead = goal;
      director.notePlayerGoal();
      useGoal(goal);
      return brain.tick().then(() => goal);
    },
    farm(options = {}) {
      const goal = createFarmGoal({ bot, ...options });
      director.notePlayerGoal();
      useGoal(goal);
      return brain.tick().then(() => goal);
    },
    ranch(options = {}) {
      const goal = createRanchGoal({ bot, ...options });
      director.notePlayerGoal();
      useGoal(goal);
      return brain.tick().then(() => goal);
    },
    netherQuartz(options = {}) {
      const goal = createNetherQuartzGoal({ bot, ...options });
      director.notePlayerGoal();
      useGoal(goal);
      return brain.tick().then(() => goal);
    },
    /** Materials for a machine, stored in the chest at `chest` (see goals/gatherMaterials.js). */
    gatherMaterials(options) {
      const goal = createGatherMaterialsGoal({ bot, ...options });
      director.notePlayerGoal();
      useGoal(goal);
      return brain.tick().then(() => goal);
    },
    cobbleGenerator(options = {}) {
      const goal = createCobbleGeneratorGoal({ bot, ...options });
      director.notePlayerGoal();
      useGoal(goal);
      return brain.tick().then(() => goal);
    },
    autoSmelter(options = {}) {
      const goal = createAutoSmelterGoal({ bot, ...options });
      director.notePlayerGoal();
      useGoal(goal);
      return brain.tick().then(() => goal);
    },
    caneFarm(options = {}) {
      const goal = createCaneFarmGoal({ bot, ...options });
      director.notePlayerGoal();
      brain.setGoal(goal);
      return brain.tick().then(() => goal);
    },
    mobFarm(options = {}) {
      const goal = createMobFarmGoal({ bot, ...options });
      director.notePlayerGoal();
      brain.setGoal(goal);
      return brain.tick().then(() => goal);
    },
    ironFarm(options = {}) {
      const goal = createIronFarmGoal({ bot, ...options });
      director.notePlayerGoal();
      brain.setGoal(goal);
      return brain.tick().then(() => goal);
    },
    carpetDuper(options = {}) {
      const goal = createCarpetDuperGoal({ bot, ...options });
      director.notePlayerGoal();
      brain.setGoal(goal);
      return brain.tick().then(() => goal);
    },
    railDuper(options = {}) {
      const goal = createRailDuperGoal({ bot, ...options });
      director.notePlayerGoal();
      brain.setGoal(goal);
      return brain.tick().then(() => goal);
    },
    fishing(options = {}) {
      const goal = createFishingGoal({ bot, ...options });
      director.notePlayerGoal();
      brain.setGoal(goal);
      return brain.tick().then(() => goal);
    },
    setGoal(goal) {
      director.notePlayerGoal();
      useGoal(goal);
      return brain.tick();
    },
    /** Lets the bot choose its own goals while no player task is set. */
    setAutonomy(on) {
      if (on) director.enable();
      else return director.disable();
      return Promise.resolve();
    },
    async stop(reason = 'user_stop') {
      // A player's stop also stops the bot from picking new goals on its own.
      await director.disable(reason);
      await brain.stop(reason);
      haltBody(bot);
    },
    status: () => ({ ...brain.status(), recovery: recovery.status(), autonomy: director.status() }),
    async dispose() {
      clearInterval(timer);
      await director.disable('disposed');
      bot.removeListener('death', onDeath);
      removeEdgeNudge();
      await brain.dispose();
      for (const behavior of behaviors) behavior.dispose?.();
      recovery.dispose();
      haltBody(bot);
    },
  };
}

module.exports = { createCompanion, configureMovements };
