'use strict';
// Dig times for tiered blocks. minecraft-data 1.21 gives blocks that need a
// pickaxe of some tier (ores, obsidian) the material `incorrect_for_wooden_tool`
// and so on, which has no tool speeds: the client then times every pickaxe as
// a bare hand that can harvest. Obsidian takes 75 s instead of 9.4 s with a
// diamond pickaxe, and a dig cut short by a timeout is never finished.
// The server times them as `mineable/pickaxe`, so the client does too.

const TIERED = /^incorrect_for_/;

function installDigTimeFix(bot) {
  const original = bot.digTime;
  if (typeof original !== 'function' || original.tieredFix) return;
  const digTime = (block) => {
    if (!block || !TIERED.test(block.material || '')) return original(block);
    const asPickaxe = Object.create(block);
    asPickaxe.material = 'mineable/pickaxe';
    return original(asPickaxe);
  };
  digTime.tieredFix = true;
  bot.digTime = digTime;
}

module.exports = { installDigTimeFix };
