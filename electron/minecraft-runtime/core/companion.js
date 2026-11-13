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
const { createEndHazards } = require('./behaviors/endHazards');
const { createHomeMaintenance } = require('./behaviors/homeMaintenance');
const { createGatherLogsGoal } = require('./goals/gatherBlocks');
const { createHomesteadGoal } = require('./goals/homestead');
const { createFarmGoal } = require('./goals/farm');
const { createRanchGoal } = require('./goals/ranch');
const { installDigTimeFix } = require('./digTime');
const { installCheapDigging } = require('./mining');
const { installPlacedMemory } = require('./placed');
const { createGatherMaterialsGoal } = require('./goals/gatherMaterials');
const { createCobbleGeneratorGoal } = require('./goals/cobbleGenerator');
const { createAutoSmelterGoal } = require('./goals/autoSmelter');
const { createCaneFarmGoal } = require('./goals/caneFarm');
const { createMobFarmGoal } = require('./goals/mobFarm');
const { createIronFarmGoal } = require('./goals/ironFarm');
const { createVillageIronFarmGoal } = require('./goals/villageIronFarm');
const { createCarpetDuperGoal } = require('./goals/carpetDuper');
const { createFishingGoal } = require('./goals/fishing');
const { createRailDuperGoal } = require('./goals/railDuper');
const { createNetherQuartzGoal } = require('./goals/netherQuartz');
const { createNetherExpeditionGoal } = require('./goals/netherExpedition');
const { createEndDragonGoal } = require('./goals/endDragon');
const { createEnterEndGoal } = require('./goals/enterEnd');
const { createEndCityGoal } = require('./goals/endCity');
const { createEndJourneyGoal } = require('./goals/endJourney');
const { createDefaultCards, homeOf } = require('./goals/registry');
const { createOutfitGoal } = require('./goals/outfit');
const { createHuntPearlsGoal } = require('./goals/huntPearls');
const { createDirector } = require('./director');
const { haltBody } = require('./actions');
const { installInventoryCompatibility } = require('./inventory');
const { installEdgeNudge } = require('./edgeNudge');
const { installEntityGeometry } = require('./entityGeometry');
const { trackReturnPositions } = require('./pathReturn');
const { installOpenDoorPassage, uninstallOpenDoorPassage } = require('./openDoorPassage');

// How long a hunt for a night mob keeps night rest away after its last step.
const NIGHT_HUNT_MS = 5 * 60 * 1000;
// Goals that bring food themselves: hunger leaves the body to them.
const FEEDING_GOALS = new Set(['farm', 'stock_food']);

// Out after dark only with a sword in the bag and a chestplate on.
function fitForNight(bot) {
  return Boolean(bot.inventory?.items?.().some((i) => i.name.endsWith('_sword')) && bot.inventory?.slots?.[6]);
}

// Never build scaffolding, pillar up or parkour on the surface: the bot must not leave
// self-placed obstacles behind, and a target that needs such moves is skipped.
const SPRINT_FOOD = 18;
function configureMovements(bot) {
  const movements = new Movements(bot);
  movements.canDig = true;
  movements.allow1by1towers = false;
  movements.scafoldingBlocks = [];
  movements.allowParkour = false;
  // Sprinting costs a food point every 40 blocks; walking costs nothing. A
  // bot sprinting everywhere spent a third of its hours hunting for food.
  // It sprints only on a full stomach (whoever else turns sprinting off, the
  // nether and the End, still does).
  let sprint = true;
  Object.defineProperty(movements, 'allowSprinting', {
    configurable: true, enumerable: true,
    get: () => sprint && !(Number.isFinite(bot.food) && bot.food < SPRINT_FOOD),
    set: (value) => { sprint = Boolean(value); },
  });
  // What was set, hunger aside: saved and restored around the nether and the End.
  Object.defineProperty(movements, 'sprintSetting', { configurable: true, get: () => sprint });
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
  trackReturnPositions(bot, movements);
  installOpenDoorPassage(bot, movements);
  bot.pathfinder.setMovements(movements);
  // Mining paths through stone need more search time than surface walks.
  bot.pathfinder.thinkTimeout = 10000;
  return movements;
}

function createCompanion({ bot, onEvent = () => {}, tickMs = 250, autonomy = false, retirementTimeoutMs = 20000 } = {}) {
  if (!bot) throw new TypeError('bot is required');
  if (!Number.isFinite(retirementTimeoutMs) || retirementTimeoutMs <= 0 || retirementTimeoutMs > 2147483647) {
    throw new TypeError('retirementTimeoutMs must be a positive timer duration');
  }
  const priorHomeProtection = bot.companionProtectBlock;
  installInventoryCompatibility(bot);
  installDigTimeFix(bot);
  const removeEdgeNudge = installEdgeNudge(bot);
  if (!bot.pathfinder) bot.loadPlugin(pathfinder);
  installCheapDigging(bot);
  const removePlacedMemory = installPlacedMemory(bot);
  const removeEntityGeometry = installEntityGeometry(bot);
  const configuredMovements = configureMovements(bot);

  // Stuck bodies, full bags and death loops are recovered for every goal alike.
  const recovery = createRecovery({ bot, activeGoal: () => brain?.status().goal?.name,
    ownsRouteRecovery: () => !paused && goalOwner?.goal?.ownsRouteRecovery?.() === true });
  // Animals the current goal keeps (a ranch's herd) are not hunted for food.
  let spare = () => false;
  let director = null;
  let brain = null;
  let paused = false;
  let disposed = false;
  let disposal = null;
  let taskEpoch = 0;
  let dispatch = Promise.resolve();
  let dispatching = 0;
  let retirement = Promise.resolve();
  let retiring = 0;
  let retirementFailed = false;
  let goalOwner = null;
  // The connection owns this evidence even while a cached goal is retired.
  // Goal-local death listeners cannot witness deaths during other tasks.
  const priorBodyLife = Object.getOwnPropertyDescriptor(bot, 'companionBodyLife');
  const bodyLifeOwner = Object.freeze({});
  let bodyLifeEpoch = 0;
  const readBodyLife = () => !disposed && bot.companionBodyLife === readBodyLife
    ? { owner: bodyLifeOwner, epoch: bodyLifeEpoch } : null;
  Object.defineProperty(bot, 'companionBodyLife', { value: readBodyLife, writable: true, configurable: true });
  const assertActive = () => {
    if (disposed) throw Object.assign(new Error('Companion is disposed'), { code: 'disposed' });
  };
  const assertBodyAvailable = () => {
    assertActive();
    if (brain?.status().blocked) throw Object.assign(new Error('An aborted behavior still owns the body; wait for it to settle'),
      { code: 'retirement_timeout', retryable: false });
  };
  async function joinRetirement() {
    let timer;
    try {
      await Promise.race([retirement, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Goal retirement has not settled'),
          { code: 'retirement_timeout', retryable: false })), retirementTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  // Nights after the house is done: home to bed, whatever goal runs. The
  // homestead goal keeps handling its own nights while it builds.
  const nightRest = createNightRest({ bot, home: () => {
    const house = director?.memory.homestead?.memory?.house;
    // Building the house handles its own nights; pearls are hunted in the dark.
    if (!house || goalOwner?.goal?.recoverAtHome === true
      || ['homestead', 'hunt_pearls'].includes(brain?.status().goal?.name)) return null;
    // Nor while a goal hunts a mob that only comes out at night (spiders for a bow's string):
    // sleeping skips the very night it waits for. Only armed and armoured, though: respawned
    // empty-handed it went straight back out and died again and again.
    const hunt = bot.companionNightHunt;
    if (brain?.status().goal && hunt && Date.now() - hunt.at < NIGHT_HUNT_MS && fitForNight(bot)) return null;
    const bed = house.furniture.bed.position;
    const block = bot.blockAt(new Vec3(bed.x, bed.y, bed.z));
    // Out of sight means far away (it digs in there); seen and gone means sleep without it.
    return { bed: !block || block.name.endsWith('_bed') ? bed : null, centre: house.interiorCenter };
  } });
  const homeMaintenance = createHomeMaintenance({ bot, home: () => director?.memory.homestead,
    activeGoal: () => brain?.status().goal?.name });
  const behaviors = [...createSurvivalBehaviors({ bot, spare: (entity) => spare(entity),
    feeding: () => FEEDING_GOALS.has(brain?.status().goal?.name),
    resupplying: () => goalOwner?.goal?.recoverAtHome === true,
    farmSnack: () => !paused && goalOwner?.goal?.farmSnack === true && brain?.status().goal?.name === 'farm',
    expeditionStocking: (state) => !paused && goalOwner?.goal?.expeditionStocking?.(state) === true,
    activeGoal: () => brain?.status().goal?.name,
    home: () => (director ? homeOf(director.memory)?.centre || null : null) }), ...recovery.behaviors,
    nightRest, homeMaintenance, ...createEndHazards({ bot, onEvent: (event) => onEvent(event) })];
  const usedGoals = new Set();
  function retireGoal(owner) {
    if (!owner || owner.retiring) return retirement;
    owner.retiring = true;
    if (goalOwner === owner) goalOwner = null;
    // Capture only the old invocation, never a later task's promise. Goal
    // terminal events are emitted before the running body has fully settled.
    const settled = brain.idleGoal(owner.generation);
    retiring += 1;
    retirement = retirement.then(() => settled).then(async () => {
      await owner.goal.dispose?.();
      usedGoals.delete(owner.goal);
    }).catch((error) => {
      retirementFailed = true;
      void director?.disable('goal_cleanup_failed').catch(() => {});
      const failure = Object.assign(new Error(String(error?.message || error), { cause: error }),
        { code: 'cleanup_failed', retryable: false });
      try { onEvent({ type: 'goal_cleanup_error', at: Date.now(), goal: owner.goal.name,
        taskId: owner.taskId, generation: owner.generation, reason: failure.message,
        code: failure.code, retryable: false }); } catch { /* observer */ }
      throw failure;
    }).finally(() => { retiring -= 1; });
    // The failed cleanup is joined by cancellation/new dispatch/disposal, but
    // natural completion can begin it without any waiting caller.
    retirement.catch(() => {});
    return retirement;
  }
  const useGoal = (goal, metadata) => {
    assertActive();
    const owner = { goal, taskId: metadata?.taskId ?? goal.metadata?.taskId ?? goal.taskId };
    goalOwner = owner;
    usedGoals.add(goal);
    spare = goal.spares || (() => false);
    try { brain.setGoal(goal, metadata); } catch (error) { retireGoal(owner); throw error; }
  };
  brain = createBrain({
    abandonMs: retirementTimeoutMs,
    perceive: () => perceive(bot),
    behaviors,
    onEvent: (event) => {
      if (event.type === 'behavior_abandoned') haltBody(bot);
      if (event.type === 'goal_set' && goalOwner) goalOwner.generation = event.generation;
      // Release invocation-owned listeners/movement hooks, not a historical
      // list of all goals ever submitted to this long-lived companion.
      if (['goal_done', 'goal_failed', 'goal_cleared', 'stopped'].includes(event.type)) {
        spare = () => false;
        if (goalOwner && event.generation === goalOwner.generation) retireGoal(goalOwner);
      }
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
  // Where home is, for a bot lost at sea (actions.swimAshore).
  bot.companionHomeAt = () => homeOf(director.memory)?.centre || null;
  if (autonomy) director.enable();
  const timer = setInterval(() => {
    if (disposed) return;
    try { if (!paused && !dispatching && !retiring && !retirementFailed && !brain.status().blocked) director.tick(); } catch (error) { onEvent({ type: 'autonomy_error', at: Date.now(), reason: String(error?.message || error) }); }
    brain.tick().catch(() => {});
  }, tickMs);
  timer.unref?.();
  // Death interrupts the current action only: progress lives in the world, so
  // after respawning the goal simply re-plans from what is left. The body stops
  // too: a path goal set by a chase outlives the action, and after a nether death
  // the pathfinder walked on towards its nether coordinates across the overworld.
  // Effects die with the body too, but the server sends no removal for them:
  // a fire resistance kept on the client after a death meant the bot never
  // drank again, and burned to death at the next blaze.
  const onDeath = () => {
    if (disposed) return;
    bodyLifeEpoch += 1;
    if (bot.entity?.effects) bot.entity.effects = {};
    haltBody(bot);
    brain.interrupt('death').catch(() => {});
  };
  const onRespawn = () => { if (!disposed) haltBody(bot); };
  bot.on('death', onDeath);
  bot.on('respawn', onRespawn);

  function startPlayerGoal(create, metadata, returnGoal = true) {
    assertBodyAvailable();
    const epoch = ++taskEpoch;
    dispatching += 1;
    const operation = dispatch.then(async () => {
      assertActive();
      if (epoch !== taskEpoch) throw Object.assign(new Error('Task dispatch was cancelled'), { code: 'aborted' });
      if (goalOwner) await brain.clearGoal('replaced');
      await joinRetirement();
      assertBodyAvailable();
      if (epoch !== taskEpoch) throw Object.assign(new Error('Task dispatch was cancelled'), { code: 'aborted' });
      // Factories themselves can install listeners or movement overrides, so
      // construct only after the previous invocation restored its resources.
      const goal = create();
      director.notePlayerGoal();
      paused = false;
      useGoal(goal, metadata);
      const running = brain.status().running;
      const takingOver = goal.recoverAtHome === true && ['provision', 'recover_drops'].includes(running)
        || running === 'provision' && (goal.farmSnack === true || goal.expeditionStocking?.(perceive(bot)) === true);
      if (epoch === taskEpoch && takingOver) {
        // Release an old hunt before the new goal takes responsibility for food.
        const reason = goal.farmSnack === true ? 'farm_snack' : goal.recoverAtHome === true ? 'home_resupply' : 'expedition_food';
        await brain.interrupt(reason);
        assertActive();
        if (epoch !== taskEpoch) throw Object.assign(new Error('Task dispatch was cancelled'), { code: 'aborted' });
      }
      await brain.tick();
      return returnGoal ? goal : undefined;
    }).finally(() => { dispatching -= 1; });
    dispatch = operation.catch(() => {});
    return operation;
  }
  const goalMethod = (create) => (options = {}, metadata) => startPlayerGoal(
    () => create({ bot, ...options }), metadata ?? { taskId: options?.taskId });
  const tasks = {
    gatherLogs: (count, metadata) => startPlayerGoal(() => createGatherLogsGoal({ bot, count }), metadata, false),
    homestead(options = {}, metadata) {
      return startPlayerGoal(() => {
        // One house per run: keep building the house the player asked for.
        const goal = Object.keys(options).length === 0 && director.memory.homestead
          ? director.memory.homestead : createHomesteadGoal({ bot, ...options });
        director.memory.homestead = goal;
        // Asked again: the search for a site starts over.
        if (goal.memory) goal.memory.exploreStreak = 0;
        return goal;
      }, metadata ?? { taskId: options?.taskId });
    },
    farm: goalMethod(createFarmGoal),
    ranch: goalMethod(createRanchGoal),
    netherQuartz: goalMethod(createNetherQuartzGoal),
    /** Fortress (blaze rods, wither skulls) and bastion (piglin bartering), then home. */
    netherExpedition: goalMethod(createNetherExpeditionGoal),
    enterEnd: goalMethod(createEnterEndGoal),
    endJourney: goalMethod(createEndJourneyGoal),
    endCity: goalMethod(createEndCityGoal),
    endDragon: goalMethod(createEndDragonGoal),
    gatherMaterials: goalMethod(createGatherMaterialsGoal),
    cobbleGenerator: goalMethod(createCobbleGeneratorGoal),
    autoSmelter: goalMethod(createAutoSmelterGoal),
    caneFarm: goalMethod(createCaneFarmGoal),
    mobFarm: goalMethod(createMobFarmGoal),
    ironFarm: goalMethod(createIronFarmGoal),
    villageIronFarm: goalMethod(createVillageIronFarmGoal),
    carpetDuper: goalMethod(createCarpetDuperGoal),
    railDuper: goalMethod(createRailDuperGoal),
    fishing: goalMethod(createFishingGoal),
    /** Endermen at night until the bag holds `count` pearls (or the night ends). */
    huntPearls: goalMethod(createHuntPearlsGoal),
    /** Carry `items` ([{ key, count }]), gathered into the house chest first, and wear the armour among them. */
    outfit(options = {}, metadata) {
      const home = homeOf(director.memory);
      if (!home) return Promise.reject(Object.assign(new Error('No finished house yet'), { code: 'no_home' }));
      return startPlayerGoal(() => createOutfitGoal({ bot, ...options, home }), metadata ?? { taskId: options?.taskId });
    },
  };

  function dispose() {
    if (disposal) return disposal;
    if (!disposed) {
      disposed = true;
      taskEpoch += 1;
      paused = false;
      clearInterval(timer);
      bot.removeListener('death', onDeath);
      bot.removeListener('respawn', onRespawn);
      removeEdgeNudge();
      removePlacedMemory();
      removeEntityGeometry();
    }
    // Both calls start synchronously: director cannot choose more work, and
    // brain cannot restart a reflex while an abort or goal cleanup is pending.
    const stoppingDirector = director.disable('disposed');
    const stoppingBrain = brain.dispose();
    stoppingDirector.catch(() => {});
    const operation = (async () => {
      // Never dispose invocation-owned resources while its continuation can
      // still use them. A timeout rejects shutdown; a later call may retry.
      const errors = [];
      for (const join of [() => stoppingBrain, () => stoppingDirector, joinRetirement]) {
        try { await join(); } catch (error) {
          if (error?.code === 'retirement_timeout') { haltBody(bot); throw error; }
          errors.push(error);
        }
      }
      const attempt = async (cleanup) => { try { await cleanup(); } catch (error) { errors.push(error); } };
      for (const behavior of behaviors) await attempt(() => behavior.dispose?.());
      await attempt(() => recovery.dispose());
      for (const goal of usedGoals) await attempt(() => goal.dispose?.());
      usedGoals.clear();
      goalOwner = null;
      if (bot.companionBodyLife === readBodyLife) {
        if (priorBodyLife) Object.defineProperty(bot, 'companionBodyLife', priorBodyLife);
        else delete bot.companionBodyLife;
      }
      if (bot.companionProtectBlock === director.memory.homestead?.memory.protectBlock) {
        if (priorHomeProtection === undefined) delete bot.companionProtectBlock;
        else bot.companionProtectBlock = priorHomeProtection;
      }
      haltBody(bot);
      uninstallOpenDoorPassage(bot, configuredMovements);
      if (errors.length) throw new AggregateError(errors, 'Companion cleanup failed');
    })();
    disposal = operation;
    operation.catch((error) => { if (error?.code === 'retirement_timeout' && disposal === operation) disposal = null; });
    return operation;
  }

  return {
    brain,
    director,
    ...tasks,
    /** Built-in, data-only dispatch. Resolves at dispatch, not task completion. */
    async submitTask(name, args = {}, metadata = {}) {
      assertActive();
      if (typeof name !== 'string' || !Object.hasOwn(tasks, name)) throw Object.assign(new Error(`Unknown task: ${name}`), { code: 'unknown_task' });
      validateTaskArgs(args);
      return tasks[name](name === 'gatherLogs' ? args.count : args, metadata);
    },
    setGoal(goal, metadata) {
      return startPlayerGoal(() => goal, metadata, false);
    },
    /** Lets the bot choose its own goals while no player task is set. */
    setAutonomy(on) {
      assertActive();
      if (on) assertBodyAvailable();
      if (on && retirementFailed) throw Object.assign(new Error('Goal cleanup failed; dispose this companion'),
        { code: 'cleanup_failed', retryable: false });
      if (on) director.enable();
      else return director.disable();
      return Promise.resolve();
    },
    /** Cancel task/autonomy only; survival and maintenance remain active. */
    async cancelTask(reason = 'task_cancelled') {
      assertActive();
      taskEpoch += 1;
      paused = false;
      await Promise.all([director.disable(reason), brain.clearGoal(reason)]);
      await joinRetirement();
    },
    /** Suspend task selection and goal work, without suspending safety. */
    async pauseTask(reason = 'task_paused') {
      assertActive();
      paused = true;
      await brain.pauseGoal(reason);
    },
    async resumeTask() {
      assertActive();
      paused = false;
      await brain.resumeGoal();
    },
    /** Legacy stop is not an all-stop: subsequent ticks still run safety. */
    async stop(reason = 'user_stop') {
      assertActive();
      taskEpoch += 1;
      paused = false;
      await Promise.all([director.disable(reason), brain.stop(reason)]);
      await joinRetirement();
      haltBody(bot);
    },
    status: () => ({ ...brain.status(), paused, disposed, cleanupFailed: retirementFailed, recovery: recovery.status(), autonomy: director.status() }),
    /** Terminal all-stop; construct a new companion to restart. Does not disconnect the bot. */
    stopAll: dispose,
    dispose,
  };
}

// The embedding entry point accepts data, never executable goal definitions or
// dependency overrides. Legacy in-process goal methods remain unrestricted.
function validateTaskArgs(args) {
  const seen = new Set();
  function visit(value) {
    if (value === null || ['string', 'boolean'].includes(typeof value)) return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || seen.has(value)) throw new TypeError('Task arguments must be plain JSON data');
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new TypeError('Task arguments must be plain JSON data');
    }
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !('value' in descriptor)) throw new TypeError('Task arguments must be plain JSON data');
      visit(descriptor.value);
    }
    seen.delete(value);
  }
  if (!args || Array.isArray(args) || typeof args !== 'object') throw new TypeError('Task arguments must be an object');
  visit(args);
  for (const key of ['bot', 'actions', 'skills', 'kb', '__proto__', 'constructor', 'prototype']) {
    if (Object.hasOwn(args, key)) throw new TypeError(`Task argument is not allowed: ${key}`);
  }
}

module.exports = { createCompanion, configureMovements };
