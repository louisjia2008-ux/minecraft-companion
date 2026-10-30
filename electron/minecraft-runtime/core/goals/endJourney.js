'use strict';
// Goal: the whole End trip. Through the stronghold portal, kill the dragon,
// pearl through the gateway it opens and loot an end city. Each run() hands
// the body to whichever stage the world says is next; each stage keeps its
// own memory, so a stage interrupted by survival picks up where it was.
// With `home`, the trip ends back in the overworld: through the exit portal
// the dragon's death lights (the server sends the bot to its bed).

const { createEnterEndGoal } = require('./enterEnd');
const { createEndDragonGoal } = require('./endDragon');
const { createEndCityGoal } = require('./endCity');
const end = require('../end');
const defaultActions = require('../actions');
const { Vec3 } = require('vec3');
const { waitUntil } = require('../confirm');

/** The lit exit portal's cells, nearest first; [] where they are not loaded. */
function exitPortalCells(bot) {
  const cells = [];
  for (let x = -3; x <= 3; x += 1) {
    for (let z = -3; z <= 3; z += 1) {
      for (let y = 40; y <= 90; y += 1) {
        const p = new Vec3(x, y, z);
        if (bot.blockAt(p)?.name === 'end_portal') { cells.push(p); break; }
      }
    }
  }
  const here = bot.entity.position;
  return cells.sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
}

/** One try at stepping into the exit portal: walk to its rim, then walk in. */
async function exitStep(bot, ctx, actions) {
  const cells = exitPortalCells(bot);
  if (!cells.length) {
    const centre = end.surfaceAt(bot, 0, 4) || new Vec3(0, 64, 4);
    return end.walkTo(bot, ctx, centre, 2, 60000);
  }
  const target = cells[0];
  ctx.record('end_exit', { portal: `${target.x},${target.y},${target.z}` });
  const moved = await actions.goNear(bot, ctx, target.offset(0.5, 0, 0.5), 1, { timeoutMs: 60000 });
  if (!end.inEnd(bot)) return { ok: true };
  if (!moved.ok && bot.entity.position.distanceTo(target) > 4) return moved;
  // The last step by hand: the pathfinder does not walk into portal blocks.
  try {
    await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
    await waitUntil(() => !end.inEnd(bot), { timeoutMs: 4000, signal: ctx.signal });
  } finally {
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
  }
  // The credits, then the respawn: wait for the overworld before the next run.
  await waitUntil(() => !end.inEnd(bot), { timeoutMs: 20000, signal: ctx.signal });
  return end.inEnd(bot) ? { ok: false, reason: 'exit_portal_missed' } : { ok: true };
}

function createEndJourneyGoal({ bot, chests = 2, withCity = true, home = false, actions = defaultActions } = {}) {
  const stages = {
    portal: createEnterEndGoal({ bot }),
    dragon: createEndDragonGoal({ bot }),
    city: withCity ? createEndCityGoal({ bot, chests }) : null,
  };
  const memory = { stages, stage: null, finished: false };
  const dragonDone = () => stages.dragon.isDone();
  const cityDone = (state) => !stages.city || stages.city.isDone(state);
  // The dragon's kill is remembered once seen: back home its portal is out of sight.
  const allDone = (state) => {
    if (dragonDone() && cityDone(state)) memory.finished = true;
    return memory.finished && (!home || !end.inEnd(bot));
  };

  function current(state) {
    // Back in the overworld (died in the End): through the portal again,
    // unless everything out there is done.
    if (!end.inEnd(bot)) return memory.finished || (dragonDone() && cityDone(state)) ? null : stages.portal;
    if (!dragonDone()) return stages.dragon;
    if (stages.city && !stages.city.isDone(state)) return stages.city;
    return null;
  }

  return {
    name: 'end_journey',
    noProgressLimit: 30,
    maxRecoveries: 3,
    memory,
    isDone: allDone,
    // Each stage's progress is bounded; later stages count on top of earlier ones.
    progress(state) {
      // Once through, the portal stage stays counted: a death sends the bot
      // back to the overworld but undoes nothing out there.
      if (end.inEnd(bot)) memory.reachedEnd = true;
      const portal = memory.reachedEnd || memory.finished ? 100000 : stages.portal.progress(state);
      const dragon = memory.finished || dragonDone() ? 2000 : stages.dragon.progress(state);
      const city = stages.city ? stages.city.progress(state) : 0;
      return portal + dragon * 10 + city * 100 + (memory.finished && !end.inEnd(bot) ? 1 : 0);
    },
    recover() { for (const s of Object.values(stages)) s?.recover?.(); },
    async run(ctx) {
      const state = ctx.perceive();
      const stage = current(state);
      if (!stage) {
        if (home && memory.finished && end.inEnd(bot)) return exitStep(bot, ctx, actions);
        return { ok: true };
      }
      if (memory.stage !== stage.name) {
        ctx.record('end_stage', { stage: stage.name });
        memory.stage = stage.name;
      }
      return stage.run(ctx);
    },
    dispose() { for (const s of Object.values(stages)) s?.dispose?.(); },
  };
}

module.exports = { createEndJourneyGoal };
