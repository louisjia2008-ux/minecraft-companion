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

test('at night an enderman far off is stared at until it comes, not chased', async () => {
  const position = new Vec3(0, 64, 0);
  const man = { id: 7, name: 'enderman', position: new Vec3(30, 64, 0) };
  let looks = 0;
  const bot = { entity: { position }, entities: { 7: man },
    look: async () => {}, lookAt: async (p) => { looks += 1; assert.ok(p.y > 66, 'at its head'); if (looks === 3) man.position = new Vec3(2, 64, 0); } };
  let chased = 0;
  const skills = { huntOne: async () => { chased += 1; return { ok: false, reason: 'no_mob_in_range' } }, explore: async () => ({ ok: true }) };
  const records = [];
  const goal = createHuntPearlsGoal({ bot, count: 12, skills, actions: { haltBody() {} } });
  const ctx = { signal: new AbortController().signal, record: (t, d) => records.push({ t, ...d }),
    perceive: () => ({ isDay: false, position, inventory: {} }) };
  const result = await goal.run(ctx);
  assert.equal(result.ok, true);
  assert.equal(chased, 0);
  assert.ok(records.some((r) => r.t === 'enderman_stare_result' && r.came));
  // The same one is not stared at again straight away: the hunt goes on.
  man.position = new Vec3(30, 64, 0);
  await goal.run(ctx);
  assert.equal(chased, 1);
});

test('once the stared enderman turns, the bot looks at the ground so it does not freeze', async () => {
  const position = new Vec3(0, 64, 0);
  const man = { id: 9, name: 'enderman', position: new Vec3(14, 64, 0), metadata: {} };
  const views = [];
  const bot = { entity: { position, yaw: 0 }, entities: { 9: man },
    registry: { entitiesByName: { enderman: { metadataKeys: ['a', 'creepy'] } } },
    lookAt: async () => { views.push('eyes'); if (views.length === 2) man.metadata[1] = true; },
    look: async (_y, pitch) => { views.push(pitch < -1 ? 'ground' : 'other'); if (views.length === 5) man.position = new Vec3(3, 64, 0); } };
  const records = [];
  const goal = createHuntPearlsGoal({ bot, count: 12, skills: {}, actions: { haltBody() {} } });
  const ctx = { signal: new AbortController().signal, record: (t, d) => records.push({ t, ...d }),
    perceive: () => ({ isDay: false, position, inventory: {} }) };
  await goal.run(ctx);
  assert.deepEqual(views, ['eyes', 'eyes', 'ground', 'ground', 'ground']);
  const result = records.find((r) => r.t === 'enderman_stare_result');
  assert.equal(result.came, true);
  assert.equal(result.angry, true);
});

test('with an angry enderman already at hand, no other one is stared at', async () => {
  const position = new Vec3(0, 64, 0);
  const near = { id: 1, name: 'enderman', position: new Vec3(3, 64, 0), metadata: { 1: true } };
  const far = { id: 2, name: 'enderman', position: new Vec3(25, 64, 0), metadata: {} };
  let stared = 0;
  const bot = { entity: { position, yaw: 0 }, entities: { 1: near, 2: far },
    registry: { entitiesByName: { enderman: { metadataKeys: ['a', 'creepy'] } } },
    lookAt: async () => { stared += 1; }, look: async () => {} };
  const skills = { huntOne: async () => ({ ok: true }) };
  const goal = createHuntPearlsGoal({ bot, count: 12, skills, actions: { haltBody() {} } });
  await goal.run({ signal: new AbortController().signal, record() {}, perceive: () => ({ isDay: false, position, inventory: {} }) });
  assert.equal(stared, 0);
});
