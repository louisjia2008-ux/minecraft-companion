'use strict';
// Wires the brain to a live Mineflayer bot: perception, survival behaviors,
// conservative movement settings and the decision tick.

const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { createBrain } = require('./brain');
const { perceive } = require('./perception');
const { createSurvivalBehaviors } = require('./behaviors/survival');
const { createGatherLogsGoal } = require('./goals/gatherBlocks');
const { createHomesteadGoal } = require('./goals/homestead');
const { haltBody } = require('./actions');

// Never build scaffolding, pillar up, parkour or wade: the bot must not leave
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
  const water = bot.registry.blocksByName.water;
  if (water) movements.blocksToAvoid.add(water.id);
  bot.pathfinder.setMovements(movements);
  // Mining paths through stone need more search time than surface walks.
  bot.pathfinder.thinkTimeout = 10000;
  return movements;
}

function createCompanion({ bot, onEvent = () => {}, tickMs = 250 } = {}) {
  if (!bot) throw new TypeError('bot is required');
  if (!bot.pathfinder) bot.loadPlugin(pathfinder);
  configureMovements(bot);

  const brain = createBrain({
    perceive: () => perceive(bot),
    behaviors: createSurvivalBehaviors({ bot }),
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
      haltBody(bot);
    },
  };
}

module.exports = { createCompanion, configureMovements };
