'use strict';
// Goal: hold at least N items obtained by breaking matching blocks (e.g. logs).
//
// Each run() handles exactly one block: reach it, break it, pick up the drop.
// Nothing is remembered between runs except a short blacklist of failed
// targets, so an interruption at any point needs no special recovery.

const defaultActions = require('../actions');
const { countMatching } = require('../perception');
const { createBlacklist, posKey } = require('../blacklist');

const isLog = (name) => name.endsWith('_log') && !name.startsWith('stripped_');

function createGatherBlocksGoal({
  bot,
  name = 'gather_blocks',
  count,
  itemMatch,
  blockMatch = itemMatch,
  baseline,
  searchRadius = 48,
  maxCandidates = 32,
  actions = defaultActions,
  blacklist = createBlacklist({ ttlMs: 120000 }),
  findTargets,
} = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  if (typeof itemMatch !== 'function') throw new TypeError('itemMatch is required');
  const startCount = Number.isFinite(baseline)
    ? baseline
    : countMatching(Object.fromEntries(bot.inventory.items().map((i) => [i.name, i.count])), itemMatch);
  const target = startCount + count;

  const locate = findTargets || (() => defaultFindTargets(bot, blockMatch, searchRadius, maxCandidates));

  return {
    name,
    target,
    isDone: (state) => countMatching(state.inventory, itemMatch) >= target,
    progress: (state) => countMatching(state.inventory, itemMatch),
    async run(ctx) {
      const here = ctx.perceive().position;
      const candidates = locate()
        .filter((block) => !blacklist.has(posKey(block.position)))
        .sort((a, b) => targetCost(here, a.position) - targetCost(here, b.position));
      if (candidates.length === 0) return { ok: false, reason: 'no_target_in_range' };
      const block = candidates[0];
      const key = posKey(block.position);
      ctx.record('target_selected', { block: block.name, position: key, options: candidates.length });

      const reach = await actions.goToDig(bot, ctx, block);
      if (!reach.ok) {
        blacklist.add(key, reach.reason);
        return reach;
      }
      const dig = await actions.digBlock(bot, ctx, block);
      if (!dig.ok) {
        blacklist.add(key, dig.reason);
        return dig;
      }
      const pickup = await actions.collectDrops(bot, ctx, block.position.offset(0.5, 0.5, 0.5), itemMatch);
      return pickup.ok ? { ok: true } : pickup;
    },
  };
}

// Prefer near and low blocks: a trunk is cleared bottom-up from the ground.
function targetCost(from, to) {
  const dx = to.x + 0.5 - from.x;
  const dz = to.z + 0.5 - from.z;
  const dy = to.y - from.y;
  return Math.hypot(dx, dz) + Math.max(0, dy) * 3 + Math.max(0, -dy) * 1.5;
}

function defaultFindTargets(bot, blockMatch, maxDistance, count) {
  const ids = Object.values(bot.registry.blocksByName)
    .filter((block) => blockMatch(block.name))
    .map((block) => block.id);
  if (ids.length === 0) return [];
  return bot.findBlocks({ matching: ids, maxDistance, count })
    .map((position) => bot.blockAt(position))
    .filter(Boolean);
}

function createGatherLogsGoal({ bot, count, ...rest }) {
  return createGatherBlocksGoal({ bot, count, name: 'gather_logs', itemMatch: isLog, ...rest });
}

module.exports = { createGatherBlocksGoal, createGatherLogsGoal, isLog, targetCost };
