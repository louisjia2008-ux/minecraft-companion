'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const { configureMovements } = require('../core/companion');

test('the bot sprints only on a full stomach, and a saved setting survives hunger', () => {
  const bot = Object.assign(new EventEmitter(), { registry, blockAt: () => null, entities: {}, food: 20,
    entity: { effects: {}, position: new Vec3(0, 64, 0), onGround: true }, inventory: { items: () => [] },
    game: { minY: -64 }, clearControlStates() {} });
  require('mineflayer-pathfinder').pathfinder(bot);
  const m = configureMovements(bot);
  assert.equal(m.allowSprinting, true);
  bot.food = 15;
  assert.equal(m.allowSprinting, false);
  // The nether saves the setting, turns sprinting off, and restores it: hungry
  // meanwhile, the restore must not turn sprinting off for good.
  const saved = m.sprintSetting ?? m.allowSprinting;
  m.allowSprinting = false;
  m.allowSprinting = saved;
  bot.food = 20;
  assert.equal(m.allowSprinting, true);
});
