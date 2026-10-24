'use strict';
// Wires the brain to a live Mineflayer bot: perception, survival behaviors,
// conservative movement settings and the decision tick.

const { Vec3 } = require('vec3');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { createBrain } = require('./brain');
const { perceive } = require('./perception');
const { createSurvivalBehaviors } = require('./behaviors/survival');
const { createRecovery } = require('./behaviors/recovery');
const { createNightRest } = require('./behaviors/nightRest');
const { createHomeMaintenance } = require('./behaviors/homeMaintenance');
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
const { createNetherExpeditionGoal } = require('./goals/netherExpedition');
const { createDefaultCards } = require('./goals/registry');
const { createDirector } = require('./director');
const { haltBody } = require('./actions');
const { installInventoryCompatibility } = require('./inventory');
const { installEdgeNudge } = require('./edgeNudge');
const { installOpenDoorPassage, uninstallOpenDoorPassage } = require('./openDoorPassage');

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
  // Fences and gates are someone's pen; the furniture and machine parts are
  // home (chasing a skeleton out of the house once broke the bed, and the bot
  // slept outside after that). Paths walk around or through, never dig them.
  const KEEP = /(_fence|_fence_gate|_bed|_door|^chest|^trapped_chest|^furnace|^crafting_table|^hopper|^barrel)$/;
  for (const block of Object.values(bot.registry.blocksByName)) {
    if (KEEP.test(block.name)) movements.blocksCantBreak.add(block.id);
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
  installOpenDoorPassage(bot, movements);
  bot.pathfinder.setMovements(movements);
  // Mining paths through stone need more search time than surface walks.
  bot.pathfinder.thinkTimeout = 10000;
  return movements;
}

function createCompanion({ bot, onEvent = () => {}, tickMs = 250, autonomy = false } = {}) {
  if (!bot) throw new TypeError('bot is required');
  const priorHomeProtection = bot.companionProtectBlock;
  installInventoryCompatibility(bot);
  const removeEdgeNudge = installEdgeNudge(bot);
  if (!bot.pathfinder) bot.loadPlugin(pathfinder);
  const configuredMovements = configureMovements(bot);

  // Stuck bodies, full bags and death loops are recovered for every goal alike.
  const recovery = createRecovery({ bot });
  // Animals the current goal keeps (a ranch's herd) are not hunted for food.
  let spare = () => false;
  let director = null;
  let brain = null;
  // Nights after the house is done: home to bed, whatever goal runs. The
  // homestead goal keeps handling its own nights while it builds.
  const nightRest = createNightRest({ bot, home: () => {
    const house = director?.memory.homestead?.memory?.house;
    if (!house || brain?.status().goal?.name === 'homestead') return null;
    const bed = house.furniture.bed.position;
    const block = bot.blockAt(new Vec3(bed.x, bed.y, bed.z));
    // Out of sight means far away (it digs in there); seen and gone means sleep without it.
    return { bed: !block || block.name.endsWith('_bed') ? bed : null, centre: house.interiorCenter };
  } });
  const homeMaintenance = createHomeMaintenance({ bot, home: () => director?.memory.homestead,
    activeGoal: () => brain?.status().goal?.name });
  const behaviors = [...createSurvivalBehaviors({ bot, spare: (entity) => spare(entity) }), ...recovery.behaviors,
    nightRest, homeMaintenance];
  const usedGoals = new Set();
  const useGoal = (goal) => { usedGoals.add(goal); spare = goal.spares || (() => false); brain.setGoal(goal); };
  brain = createBrain({
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
  // Its goals go through useGoal too, so an autonomous ranch also spares its herd.
  const directorBrain = { status: () => brain.status(), setGoal: useGoal, clearGoal: (reason) => brain.clearGoal(reason) };
  director = createDirector({ brain: directorBrain, perceive: () => perceive(bot), cards, stageOf, onEvent });
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
    /** Fortress (blaze rods, wither skulls) and bastion (piglin bartering), then home. */
    netherExpedition(options = {}) {
      const goal = createNetherExpeditionGoal({ bot, ...options });
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
      useGoal(goal);
      return brain.tick().then(() => goal);
    },
    mobFarm(options = {}) {
      const goal = createMobFarmGoal({ bot, ...options });
      director.notePlayerGoal();
      useGoal(goal);
      return brain.tick().then(() => goal);
    },
    ironFarm(options = {}) {
      const goal = createIronFarmGoal({ bot, ...options });
      director.notePlayerGoal();
      useGoal(goal);
      return brain.tick().then(() => goal);
    },
    carpetDuper(options = {}) {
      const goal = createCarpetDuperGoal({ bot, ...options });
      director.notePlayerGoal();
      useGoal(goal);
      return brain.tick().then(() => goal);
    },
    railDuper(options = {}) {
      const goal = createRailDuperGoal({ bot, ...options });
      director.notePlayerGoal();
      useGoal(goal);
      return brain.tick().then(() => goal);
    },
    fishing(options = {}) {
      const goal = createFishingGoal({ bot, ...options });
      director.notePlayerGoal();
      useGoal(goal);
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
      for (const goal of usedGoals) await goal.dispose?.();
      usedGoals.clear();
      for (const behavior of behaviors) behavior.dispose?.();
      recovery.dispose();
      if (bot.companionProtectBlock === director.memory.homestead?.memory.protectBlock) {
        if (priorHomeProtection === undefined) delete bot.companionProtectBlock;
        else bot.companionProtectBlock = priorHomeProtection;
      }
      haltBody(bot);
      uninstallOpenDoorPassage(bot, configuredMovements);
    },
  };
}

module.exports = { createCompanion, configureMovements };
