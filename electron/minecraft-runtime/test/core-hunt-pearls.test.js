'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createHuntPearlsGoal } = require('../core/goals/huntPearls');

function setup({ position, inWater = false }) {
  const walks = [];
  const bot = { entity: { position }, companionHomeAt: () => ({ x: 0, y: 64, z: 0 }) };
  const actions = {
    goNear: async (_b, _c, p) => { walks.push(p); return { ok: true }; },
    unstick: async () => ({ ok: true, unstuck: true }),
  };
  const goal = createHuntPearlsGoal({ bot, count: 12, actions, skills: {} });
  const ctx = { signal: new AbortController().signal, record() {},
    perceive: () => ({ isDay: true, inWater, position, inventory: {} }) };
  return { goal, ctx, walks };
}

test('set during the day far from home, the hunt waits for dusk at home', async () => {
  const s = setup({ position: new Vec3(-53, -5, 9), inWater: true });
  const result = await s.goal.run(s.ctx);
  assert.equal(result.ok, true);
  assert.equal(s.walks.length, 1);
  assert.deepEqual([s.walks[0].x, s.walks[0].z], [0, 0]);
});

test('already at home, it simply waits', async () => {
  const s = setup({ position: new Vec3(3, 64, 2) });
  const goal = s.goal;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  await goal.run({ ...s.ctx, signal: ac.signal }).catch(() => {});
  assert.equal(s.walks.length, 0);
});
