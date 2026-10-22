'use strict';
// The life goal's scheduling: home first and every evening at home, then the
// project the world needs most (food first when the bag is empty).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createLifeGoal } = require('../core/goals/life');

function world({ homeDone, timeOfDay = 1000, inventory = {} }) {
  const calls = [];
  const bot = {
    entity: { position: new Vec3(0.5, 1, 0.5) },
    entities: {},
    inventory: { items: () => Object.entries(inventory).map(([name, count]) => ({ name, count })) },
    blockAt: (p) => ({ name: p.y <= 0 ? 'grass_block' : 'air', boundingBox: p.y <= 0 ? 'block' : 'empty', position: new Vec3(p.x, p.y, p.z) }),
    findBlocks: () => [],
    registry: { blocksByName: {} },
  };
  const home = {
    memory: { house: { anchor: { x: 0, y: 1, z: 0 }, blocks: [{}], furniture: { chest: { position: { x: 4, y: 1, z: 5 } } } },
      houseBuilt: homeDone ? 1 : 0, houseBed: homeDone },
    isDone: () => homeDone,
    run: async () => { calls.push('home'); return homeDone ? { ok: true, idle: true } : { ok: true }; },
  };
  const skills = {
    gatherOne: async () => { calls.push('gather'); return { ok: true }; },
    explore: async () => ({ ok: true, moved: 32 }),
  };
  const events = [];
  const ctx = { signal: new AbortController().signal, record: (type, data) => events.push({ type, ...data }),
    perceive: () => ({ timeOfDay, inventory: { ...inventory }, position: bot.entity.position, hostiles: [] }) };
  return { goal: createLifeGoal({ bot, skills, homestead: home }), ctx, calls, events };
}

test('until the home is done, the home goal runs', async () => {
  const { goal, ctx, calls, events } = world({ homeDone: false });
  await goal.run(ctx);
  assert.deepEqual(calls, ['home']);
  assert.ok(!events.some((e) => e.type === 'life_project'));
});

test('in the evening the home goal runs even when the home is done', async () => {
  const { goal, ctx, calls } = world({ homeDone: true, timeOfDay: 12000 });
  await goal.run(ctx);
  assert.equal(calls[0], 'home');
});

test('a finished home by day starts the most needed project: food first with an empty bag', async () => {
  const { goal, ctx, events } = world({ homeDone: true });
  await goal.run(ctx);
  const chosen = events.find((e) => e.type === 'life_project');
  assert.equal(chosen?.project, 'farm');
});
