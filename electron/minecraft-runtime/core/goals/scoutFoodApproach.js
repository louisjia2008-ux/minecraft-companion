'use strict';

const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { MeleeFollowGoal, meleeGeometry, meleeSight } = require('../entityGeometry');
const { sleep } = require('../confirm');

const NEAR_HUNT = 12;
const FAR_HUNT = 24;
const MAX_ROUTE_STEPS = 32;
const CANDIDATE_LIMIT = 3;

const clearSight = (bot, entity) => meleeSight(bot, meleeGeometry(bot.entity, entity, bot.registry)) === 'clear';

async function shorterPath(bot, ctx, from, goal, mayContinue) {
  const pathfinder = bot.pathfinder;
  const iterator = pathfinder.getPathFromTo(pathfinder.movements, from, goal, {
    optimizePath: false, timeout: 160, tickTimeout: 12, searchRadius: MAX_ROUTE_STEPS,
  });
  for (const { result } of iterator) {
    if (!mayContinue()) return null;
    if (result.status === 'partial') {
      await sleep(0, ctx.signal);
      continue;
    }
    return result.status === 'success' && result.path.length <= MAX_ROUTE_STEPS
      && result.path.every((p) => !p.parkour && !p.toBreak?.length && !p.toPlace?.length) ? result.path : null;
  }
  return null;
}

// The caller holds the existing dry cardinal scout profile while this runs.
async function planScoutFoodApproach(bot, ctx, { mobs, accept, mayContinue, maxLegSteps }) {
  if (typeof bot.pathfinder?.getPathFromTo !== 'function' || !bot.entity.onGround || !mayContinue()) return null;
  const position = bot.entity.position.clone();
  const from = position.floored();
  const range = (entity) => entity.position.distanceTo(position);
  const candidates = Object.values(bot.entities || {}).filter((entity) => mobs.includes(entity.name) && entity.position
    && range(entity) > NEAR_HUNT && range(entity) <= FAR_HUNT && accept(entity))
    .sort((a, b) => range(a) - range(b)).slice(0, CANDIDATE_LIMIT);
  const home = new goals.GoalBlock(from.x, from.y, from.z);

  for (const entity of candidates) {
    if (!clearSight(bot, entity)) continue;
    const observed = entity.position.clone();
    const stillSafe = () => mayContinue() && bot.entity.onGround && bot.entity.position.floored().equals(from)
      && bot.entities[entity.id] === entity && accept(entity) && entity.position.distanceTo(observed) < 1.5;
    const path = await shorterPath(bot, ctx, position, new MeleeFollowGoal(bot, entity, 3), stillSafe);
    if (!path?.length) continue;
    const endpoint = path.at(-1);
    const to = path[Math.min(path.length, maxLegSteps) - 1];
    if (!to || !stillSafe() || to.offset(.5, 0, .5).distanceTo(entity.position) >= NEAR_HUNT) continue;
    const back = await shorterPath(bot, ctx, endpoint.offset(.5, 0, .5), home, stillSafe);
    if (!back?.length) continue;
    const backFromLeg = to.equals(endpoint) ? back : await shorterPath(bot, ctx, to.offset(.5, 0, .5), home, stillSafe);
    if (!backFromLeg?.length || !clearSight(bot, entity)) continue;
    return { entity, from, to: new Vec3(to.x, to.y, to.z), approachSteps: path.length, returnSteps: back.length };
  }
  return null;
}

module.exports = { NEAR_HUNT, planScoutFoodApproach };
