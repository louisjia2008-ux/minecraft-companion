'use strict';
// Blocks the bot itself placed lately: pillars and bridges the pathfinder
// builds, steps out of a hole. Gathering leaves them be. A world gathering
// cobblestone kept digging back the pillars it had just climbed on, fell,
// climbed again on new cobblestone, and never had more than a handful.

const { posKey } = require('./blacklist');

const KEEP_MS = 20 * 60 * 1000;

/** Wraps bot.placeBlock once; adds bot.companionPlacedRecently(position). */
function installPlacedMemory(bot, { keepMs = KEEP_MS, now = Date.now } = {}) {
  if (!bot || typeof bot.placeBlock !== 'function' || bot.placeBlock.companionPlaced) return () => {};
  const placed = new Map();
  const original = bot.placeBlock;
  const wrapped = function placeBlock(reference, face, ...rest) {
    try {
      if (reference?.position && face) placed.set(posKey(reference.position.plus(face)), now());
    } catch { /* never in the way of placing */ }
    return original.call(this, reference, face, ...rest);
  };
  wrapped.companionPlaced = true;
  bot.placeBlock = wrapped;
  bot.companionPlacedRecently = (position) => {
    const key = posKey(position);
    const at = placed.get(key);
    if (at === undefined) return false;
    if (now() - at > keepMs) { placed.delete(key); return false; }
    return true;
  };
  return () => {
    if (bot.placeBlock === wrapped) bot.placeBlock = original;
    delete bot.companionPlacedRecently;
  };
}

module.exports = { installPlacedMemory };
