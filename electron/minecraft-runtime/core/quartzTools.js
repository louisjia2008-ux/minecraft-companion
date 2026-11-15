'use strict';

// A protected bridge can consume the tools that were present on the first
// portal visit. Inspect carried tools again, rather than crediting a full
// hunger bar, a stored tool or a merely remembered pickaxe.
const QUARTZ_STONE_PICKS = 3;
const QUARTZ_STONE_PICK_REMAINING = 96;

function remainingDurability(bot, item) {
  if (!item) return null;
  let maximum; let used;
  try {
    maximum = item.maxDurability ?? bot.registry?.itemsByName?.[item.name]?.maxDurability
      ?? bot.registry?.items?.[item.type]?.maxDurability;
    used = item.durabilityUsed;
  } catch { return null; }
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || !Number.isSafeInteger(used) || used < 0 || used > maximum) return null;
  return maximum - used;
}

function quartzToolReserve(bot) {
  let carried = 0;
  let ready = 0;
  for (const item of bot.inventory.items()) {
    if (item.name !== 'stone_pickaxe' || !Number.isSafeInteger(item.count) || item.count <= 0) continue;
    carried += item.count;
    if ((remainingDurability(bot, item) ?? -1) >= QUARTZ_STONE_PICK_REMAINING) ready += item.count;
  }
  const short = Math.max(0, QUARTZ_STONE_PICKS - ready);
  return { carried, ready, required: QUARTZ_STONE_PICKS, minimumRemaining: QUARTZ_STONE_PICK_REMAINING,
    short, targetCount: carried + short };
}

module.exports = { remainingDurability, quartzToolReserve, QUARTZ_STONE_PICKS, QUARTZ_STONE_PICK_REMAINING };
