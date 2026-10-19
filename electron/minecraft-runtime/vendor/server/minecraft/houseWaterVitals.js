'use strict';

// Only the host's recorded-route return operation supplies this capability.
// A route object cannot lower the ordinary exploration thresholds.
function createWaterVitalsGuard(bot, recoveryReturn = false) {
  let peakHealth = Number.isFinite(bot.health) ? bot.health : Infinity;
  return () => {
    if (!Number.isFinite(bot.health) || !Number.isFinite(bot.food)) return false;
    if (!recoveryReturn && (bot.health < 6 || bot.food < 6)) return false;
    if (bot.health <= 0 || bot.food < 0 || bot.health < peakHealth - .01) return false;
    peakHealth = Math.max(peakHealth, bot.health);
    return true;
  };
}

module.exports = { createWaterVitalsGuard };
