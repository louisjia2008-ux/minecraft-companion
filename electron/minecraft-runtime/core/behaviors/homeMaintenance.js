'use strict';
// Reuse the established home's planner without replacing the current player
// or device goal. Survival and night rest stay above this maintenance work.
const { BAND } = require('../brain');

function createHomeMaintenance({ bot, home, activeGoal = () => null, now = Date.now,
  missingGearDelayMs = 5000, noChangeLimit = 3, retryMs = 60000 } = {}) {
  if (!bot || typeof home !== 'function') throw new TypeError('bot and home are required');
  let gearMissingSince = null;
  let noChange = 0;
  let retryAt = 0;
  let lastHome = null;

  function current() {
    const goal = home();
    if (goal !== lastHome) {
      lastHome = goal;
      gearMissingSince = null;
      noChange = 0;
      retryAt = 0;
    }
    return goal;
  }

  function observed(goal, state) {
    const status = goal.maintenance(state);
    // steps is an action counter, not evidence of changed inventory or world.
    return JSON.stringify({ ...status,
      inventory: Object.entries(state.inventory).filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b)),
      position: state.position && [state.position.x, state.position.y, state.position.z].map((n) => Math.floor(n)),
      furnace: goal.memory.furnace });
  }

  function accountAttempt(ctx, goal, before, result) {
    // Waiting and survival preemption neither spend nor refill this budget.
    if (ctx.signal?.aborted || result?.waited || result?.reason === 'aborted') return;
    const after = observed(goal, ctx.perceive());
    // A failed path can monopolize maintenance just as a no-op success can.
    // Only observed inventory/world/body progress resets the streak.
    if (before === after) noChange += 1;
    else noChange = 0;
    if (noChange >= noChangeLimit) {
      noChange = 0;
      retryAt = now() + retryMs;
      ctx.record('home_maintenance_paused', { reason: 'no_observed_change', retryAt });
    }
  }

  return {
    name: 'home_maintenance',
    // A smaller want cannot preempt work in the same band. Keep house work
    // below survival maintenance so eating/rest can cancel even a long hunt.
    band: BAND.MAINTENANCE - 1,
    want(state) {
      const goal = current();
      if (!goal?.memory.established || typeof goal.maintenance !== 'function' || activeGoal() === 'homestead') return 0;
      const status = goal.maintenance(state);
      if (status.gear.length) gearMissingSince ??= now();
      else gearMissingSince = null;
      if (now() < retryAt || state.alive === false || state.health < 10 || state.food <= 12
        || state.isDay === false || state.sheltered
        || state.hostiles?.some((h) => h.distance <= 8)
        || String(bot.game?.dimension || 'overworld').replace(/^minecraft:/, '') !== 'overworld') return 0;
      const gearReady = gearMissingSince !== null && now() - gearMissingSince >= missingGearDelayMs;
      return status.missing.length || status.unverified.length || gearReady ? 0.2 : 0;
    },
    async run(ctx) {
      const goal = current();
      if (!goal?.memory.established) return { ok: true };
      const before = observed(goal, ctx.perceive());
      let result;
      try {
        result = await goal.run(ctx);
      } catch (error) {
        if (error?.code !== 'aborted' && error?.code !== 'ABORT_ERR' && error?.name !== 'AbortError') {
          try { accountAttempt(ctx, goal, before); } catch { /* Preserve the original repair exception. */ }
        }
        throw error;
      }
      accountAttempt(ctx, goal, before, result);
      return result;
    },
  };
}

module.exports = { createHomeMaintenance };
