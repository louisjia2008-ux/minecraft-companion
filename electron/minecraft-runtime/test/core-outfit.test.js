'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutfitGoal } = require('../core/goals/outfit');

function fakeBot(items = []) {
  return { inventory: { items: () => items, slots: [] }, on() {}, removeListener() {} };
}
const home = { chest: { x: 0, y: 64, z: 0 }, centre: { x: 2, y: 64, z: 2 }, stations: {} };

test('outfit gathers everything but food into the chest, and hunts the food itself', async () => {
  const asked = [];
  const goal = createOutfitGoal({ bot: fakeBot(), home, items: [{ key: 'iron_helmet', count: 1 }, { key: 'food', count: 8 }],
    createGather: ({ requirements }) => { asked.push(requirements); return { isDone: () => false, progress: () => 0, run: async () => ({ ok: true }) }; } });
  await goal.run({ perceive: () => ({ inventory: {} }), record() {} });
  assert.deepEqual(asked, [[{ key: 'iron_helmet', count: 1 }]]);
  assert.equal(goal.isDone({ inventory: { iron_helmet: 1 } }), false, 'food still to hunt');
});

test('outfit rejects unknown items', () => {
  assert.throws(() => createOutfitGoal({ bot: fakeBot(), home, items: [{ key: 'nope', count: 1 }] }), /bad item/);
});
