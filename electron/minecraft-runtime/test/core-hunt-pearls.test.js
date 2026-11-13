'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createHuntPearlsGoal } = require('../core/goals/huntPearls');

const AIR = { name: 'air', boundingBox: 'empty', shapes: [], skyLight: 15 };
const STONE = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
const terrain = {
  blockAt: (p) => Math.floor(p.y) < 64 ? STONE : AIR,
  world: { raycast: () => null },
  game: { minY: 0, height: 80 },
};

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
  const bot = { ...terrain, entity: { position }, entities: { 7: man },
    look: async () => {}, lookAt: async (p) => { looks += 1; assert.ok(p.y > 66, 'at its head'); if (looks === 3) man.position = new Vec3(2, 64, 0); } };
  let chased = 0;
  const skills = { huntOne: async () => { chased += 1; return { ok: false, reason: 'no_mob_in_range' } } };
  const records = [];
  const goal = createHuntPearlsGoal({ bot, count: 12, skills, actions: { haltBody() {} } });
  const ctx = { signal: new AbortController().signal, record: (t, d) => records.push({ t, ...d }),
    perceive: () => ({ isDay: false, position, inventory: {} }) };
  const result = await goal.run(ctx);
  assert.equal(result.ok, true);
  assert.equal(chased, 0);
  assert.ok(records.some((r) => r.t === 'enderman_stare_result' && r.came));
  // The same one is not stared at or chased across terrain again straight away.
  man.position = new Vec3(30, 64, 0);
  await goal.run(ctx);
  assert.equal(chased, 0);
  man.position = new Vec3(3, 64, 0);
  await goal.run(ctx);
  assert.equal(chased, 1);
});

test('once the stared enderman turns, the bot looks at the ground so it does not freeze', async () => {
  const position = new Vec3(0, 64, 0);
  const man = { id: 9, name: 'enderman', position: new Vec3(14, 64, 0), metadata: {} };
  const views = [];
  const bot = { ...terrain, entity: { position, yaw: 0 }, entities: { 9: man },
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
  const bot = { ...terrain, entity: { position, yaw: 0 }, entities: { 1: near, 2: far },
    registry: { entitiesByName: { enderman: { metadataKeys: ['a', 'creepy'] } } },
    lookAt: async () => { stared += 1; }, look: async () => {} };
  const skills = { huntOne: async () => ({ ok: true }) };
  const goal = createHuntPearlsGoal({ bot, count: 12, skills, actions: { haltBody() {} } });
  await goal.run({ signal: new AbortController().signal, record() {}, perceive: () => ({ isDay: false, position, inventory: {} }) });
  assert.equal(stared, 0);
});

test('scouting owns short dry surface legs and skips underground targets', async () => {
  const player = new Vec3(0, 64, 0);
  const safe = new Vec3(8, 64, 0);
  const water = new Vec3(0, 64, 4);
  const roof = new Vec3(-2, 64, 4);
  const man = { id: 12, name: 'enderman', position: roof };
  const neighbors = () => [safe, water, roof, new Vec3(49, 64, 0), new Vec3(14, 64, 0), safe.offset(0, -2, 0)];
  const movements = { getNeighbors: neighbors, canDig: true };
  const bot = { ...terrain, entity: { position: player, onGround: true }, entities: { 12: man }, pathfinder: { movements },
    blockAt(p) {
      if (p.floored().equals(water)) return { ...AIR, name: 'water' };
      if (p.floored().equals(roof.offset(0, 3, 0))) return STONE;
      return terrain.blockAt(p);
    } };
  const goal = createHuntPearlsGoal({ bot, actions: {
    goTo: async (_b, _c, next) => {
      assert.equal(next.x, 10);
      assert.deepEqual(movements.getNeighbors(player), [safe]);
      assert.equal(movements.canDig, false);
      bot.entity.position = safe;
      return { ok: true };
    },
  }, skills: { huntOne: async () => assert.fail('underground Enderman selected') } });
  const records = [];
  await goal.run({ signal: new AbortController().signal, record: (type) => records.push(type),
    perceive: () => ({ isDay: false, position: player, inventory: {} }) });
  assert.deepEqual(records, ['pearl_surface_scout']);
  assert.equal(goal.ownsRouteRecovery(), true);
  assert.equal(movements.getNeighbors, neighbors);
  assert.equal(movements.canDig, true);
});

test('an obstructed outdoor Enderman does not consume a stare or start a chase', async () => {
  const player = new Vec3(0, 64, 0);
  const man = { id: 12, name: 'enderman', position: new Vec3(4, 64, 0) };
  const bot = { ...terrain, entity: { position: player }, entities: { 12: man }, world: { raycast: () => STONE },
    lookAt: async () => assert.fail('stared through a wall') };
  const goal = createHuntPearlsGoal({ bot, skills: { huntOne: async () => assert.fail('chased through a wall') } });
  const records = [];
  await goal.run({ signal: new AbortController().signal, record: (type) => records.push(type),
    perceive: () => ({ isDay: false, position: player, inventory: {} }) });
  assert.deepEqual(records, ['pearl_surface_scout']);
});

test('a hunter starting inside the known house walks out through an observed door', async () => {
  const player = new Vec3(0, 64, 0);
  const position = new Vec3(0, 64, -2);
  const exit = new Vec3(0, 64, -3);
  let open = false;
  const door = { name: 'oak_door', position, getProperties: () => ({ half: 'lower', facing: 'north', open }) };
  const bot = { ...terrain, entity: { position: player, onGround: true }, companionHomeAt: () => player,
    findBlock: ({ matching, useExtraInfo }) => matching(door) && useExtraInfo(door) ? door : null,
    activateBlock: async (block) => { assert.equal(block, door); open = true; },
    blockAt(p) {
      if (p.floored().equals(position)) return door;
      if (p.y === 67 && p.z >= -2) return STONE;
      return terrain.blockAt(p);
    } };
  const actions = { withinReach: () => true, goTo: async (_b, _c, target) => {
    assert.equal(open, true);
    assert.equal(target.isEnd(exit), true);
    bot.entity.position = exit;
    return { ok: true };
  } };
  const goal = createHuntPearlsGoal({ bot, actions });
  const records = [];
  await goal.run({ signal: new AbortController().signal, record: (type) => records.push(type),
    perceive: () => ({ isDay: false, position: player, inventory: {} }) });
  assert.deepEqual(records, ['pearl_house_exit']);
});
