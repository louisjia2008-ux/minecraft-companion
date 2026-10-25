'use strict';
// Tiered blocks (ores, obsidian) are timed with the pickaxe's speed, as the server does.
const test = require('node:test');
const assert = require('node:assert/strict');
const mcData = require('minecraft-data')('1.21.8');
const Block = require('prismarine-block')('1.21.8');
const { installDigTimeFix } = require('../core/digTime');

function botHolding(item) {
  const bot = { heldItem: { type: mcData.itemsByName[item].id } };
  bot.digTime = (block) => block.digTime(bot.heldItem.type, false, false, false, [], {});
  installDigTimeFix(bot);
  return bot;
}
const block = (name) => Block.fromStateId(mcData.blocksByName[name].defaultState, 0);

test('obsidian takes 9.4 s with a diamond pickaxe, not 75 s', () => {
  assert.equal(botHolding('diamond_pickaxe').digTime(block('obsidian')), 9400);
});

test('ore is timed with the pickaxe; other blocks are left as they were', () => {
  const bot = botHolding('iron_pickaxe');
  assert.ok(bot.digTime(block('deepslate_redstone_ore')) < 2000);
  assert.equal(bot.digTime(block('stone')), Block.fromStateId(mcData.blocksByName.stone.defaultState, 0)
    .digTime(mcData.itemsByName.iron_pickaxe.id, false, false, false, [], {}));
  // Installing twice does not wrap twice.
  const before = bot.digTime;
  installDigTimeFix(bot);
  assert.equal(bot.digTime, before);
});
