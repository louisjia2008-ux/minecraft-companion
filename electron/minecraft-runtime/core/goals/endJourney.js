'use strict';
// Goal: the whole End trip. Through the stronghold portal, kill the dragon,
// pearl through the gateway it opens and loot an end city. Each run() hands
// the body to whichever stage the world says is next; each stage keeps its
// own memory, so a stage interrupted by survival picks up where it was.

const { createEnterEndGoal } = require('./enterEnd');
const { createEndDragonGoal } = require('./endDragon');
const { createEndCityGoal } = require('./endCity');
const end = require('../end');

function createEndJourneyGoal({ bot, chests = 2, withCity = true } = {}) {
  const stages = {
    portal: createEnterEndGoal({ bot }),
    dragon: createEndDragonGoal({ bot }),
    city: withCity ? createEndCityGoal({ bot, chests }) : null,
  };
  const memory = { stages, stage: null };
  const dragonDone = () => stages.dragon.isDone();

  function current(state) {
    // Back in the overworld (died in the End): through the portal again,
    // unless everything out there is done.
    if (!end.inEnd(bot)) return dragonDone() && (!stages.city || stages.city.isDone(state)) ? null : stages.portal;
    if (!dragonDone()) return stages.dragon;
    if (stages.city && !stages.city.isDone(state)) return stages.city;
    return null;
  }

  return {
    name: 'end_journey',
    noProgressLimit: 30,
    maxRecoveries: 3,
    memory,
    isDone: (state) => dragonDone() && (!stages.city || stages.city.isDone(state)),
    // Each stage's progress is bounded; later stages count on top of earlier ones.
    progress(state) {
      // Once through, the portal stage stays counted: a death sends the bot
      // back to the overworld but undoes nothing out there.
      if (end.inEnd(bot)) memory.reachedEnd = true;
      const portal = memory.reachedEnd || dragonDone() ? 100000 : stages.portal.progress(state);
      const dragon = dragonDone() ? 2000 : stages.dragon.progress(state);
      const city = stages.city ? stages.city.progress(state) : 0;
      return portal + dragon * 10 + city * 100;
    },
    recover() { for (const s of Object.values(stages)) s?.recover?.(); },
    async run(ctx) {
      const stage = current(ctx.perceive());
      if (!stage) return { ok: true };
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
