'use strict';
// Wires the brain to a live Mineflayer bot: perception, survival behaviors,
// conservative movement settings and the decision tick.

const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { createBrain } = require('./brain');
const { perceive } = require('./perception');
const { createSurvivalBehaviors } = require('./behaviors/survival');
const { createGatherLogsGoal } = require('./goals/gatherBlocks');
const { createHomesteadGoal } = require('./goals/homestead');
const { createFarmGoal } = require('./goals/farm');
const { createRanchGoal } = require('./goals/ranch');
const { createMineGoal } = require('./goals/mine');
const { createLifeGoal } = require('./goals/life');
const { haltBody } = require('./actions');
const { installInventoryCompatibility } = require('./inventory');

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

function createCompanion({ bot, onEvent = () => {}, tickMs = 250 } = {}) {
  if (!bot) throw new TypeError('bot is required');
  installInventoryCompatibility(bot);
  if (!bot.pathfinder) bot.loadPlugin(pathfinder);
  configureMovements(bot);

  const behaviors = createSurvivalBehaviors({ bot });
  const brain = createBrain({
    perceive: () => perceive(bot),
    behaviors,
    onEvent,
  });
  const timer = setInterval(() => { brain.tick().catch(() => {}); }, tickMs);
  timer.unref?.();
  // Death interrupts the current action only: progress lives in the world, so
  // after respawning the goal simply re-plans from what is left.
  const onDeath = () => { brain.interrupt('death').catch(() => {}); };
  bot.on('death', onDeath);

  return {
    brain,
    gatherLogs(count) {
      brain.setGoal(createGatherLogsGoal({ bot, count }));
      return brain.tick();
    },
    homestead(options = {}) {
      const goal = createHomesteadGoal({ bot, ...options });
      brain.setGoal(goal);
      return brain.tick().then(() => goal);
    },
    farm(options = {}) {
      const goal = createFarmGoal({ bot, ...options });
      brain.setGoal(goal);
      return brain.tick().then(() => goal);
    },
    ranch(options = {}) {
      const goal = createRanchGoal({ bot, ...options });
      brain.setGoal(goal);
      return brain.tick().then(() => goal);
    },
    mine(options = {}) {
      const goal = createMineGoal({ bot, ...options });
      brain.setGoal(goal);
      return brain.tick().then(() => goal);
    },
    life(options = {}) {
      const goal = createLifeGoal({ bot, ...options });
      brain.setGoal(goal);
      return brain.tick().then(() => goal);
    },
    setGoal(goal) {
      brain.setGoal(goal);
      return brain.tick();
    },
    async stop(reason = 'user_stop') {
      await brain.stop(reason);
      haltBody(bot);
    },
    status: () => brain.status(),
    async dispose() {
      clearInterval(timer);
      bot.removeListener('death', onDeath);
      await brain.dispose();
      for (const behavior of behaviors) behavior.dispose?.();
      haltBody(bot);
    },
  };
}

module.exports = { createCompanion, configureMovements };
