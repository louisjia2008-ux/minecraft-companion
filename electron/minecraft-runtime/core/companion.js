'use strict';
// Wires the brain to a live Mineflayer bot: perception, survival behaviors,
// conservative movement settings and the decision tick.

const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { createBrain } = require('./brain');
const { perceive } = require('./perception');
const { createSurvivalBehaviors } = require('./behaviors/survival');
const { createGatherLogsGoal } = require('./goals/gatherBlocks');
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
  movements.maxDropDown = 3;
  movements.infiniteLiquidDropdownDistance = false;
  movements.canOpenDoors = true;
  const water = bot.registry.blocksByName.water;
  if (water) movements.blocksToAvoid.add(water.id);
  bot.pathfinder.setMovements(movements);
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
  const onDeath = () => { brain.stop('death').catch(() => {}); };
  bot.on('death', onDeath);

  return {
    brain,
    gatherLogs(count) {
      brain.setGoal(createGatherLogsGoal({ bot, count }));
      return brain.tick();
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
