'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { installPlacedMemory } = require('../core/placed');

test('blocks the bot placed itself are remembered for a while, then forgotten', async () => {
  let clock = 0;
  const calls = [];
  const bot = { placeBlock: async (ref, face) => { calls.push([ref.position, face]); } };
  const remove = installPlacedMemory(bot, { keepMs: 1000, now: () => clock });
  await bot.placeBlock({ position: new Vec3(4, 70, -2) }, new Vec3(0, 1, 0));
  assert.equal(calls.length, 1, 'still places');
  assert.equal(bot.companionPlacedRecently(new Vec3(4, 71, -2)), true);
  assert.equal(bot.companionPlacedRecently(new Vec3(4, 70, -2)), false);
  clock = 2000;
  assert.equal(bot.companionPlacedRecently(new Vec3(4, 71, -2)), false);
  remove();
  assert.equal(bot.companionPlacedRecently, undefined);
});

test('gathering leaves the pillar the bot just climbed on', async () => {
  const { gatherOne } = require('../core/skills');
  const position = new Vec3(1, 1, 1);
  const bot = { entity: { position: new Vec3(0, 1, 0) }, registry: { blocksByName: { cobblestone: { name: 'cobblestone', id: 1 } } },
    findBlocks: () => [position], blockAt: () => ({ name: 'cobblestone', position }),
    companionPlacedRecently: (p) => p.equals(position) };
  const result = await gatherOne(bot, {}, { blocks: (n) => n === 'cobblestone', dropMatch: () => true,
    blacklist: { has: () => false } });
  assert.deepEqual(result, { ok: false, reason: 'no_target_in_range' });
});
