'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createHuntPearlsGoal } = require('../core/goals/huntPearls');
const { skyOpen } = require('../core/caveRetreat');

const AIR = { name: 'air', boundingBox: 'empty', shapes: [], skyLight: 15 };
const STONE = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
const nightState = (position) => ({ isDay: false, position, health: 20, food: 20, inventory: { iron_sword: 1 } });
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

test('a pearl hunter resumed under a low roof keeps climbing past cave detection height', async () => {
  const stairs = [new Vec3(0, 57, 0), new Vec3(1, 58, 0), new Vec3(2, 59, 0),
    new Vec3(3, 60, 0), new Vec3(4, 61, 0), new Vec3(5, 62, 0), new Vec3(6, 63, 0)];
  const bot = { ...terrain, entity: { position: stairs[0], onGround: true },
    companionHomeAt: () => new Vec3(0, 64, 0),
    pathfinder: { movements: { getNeighbors: () => [] } },
    blockAt(p) {
      const step = stairs.find((at) => at.x === p.x && at.z === p.z);
      if (!step || p.y < step.y || (step.x < 6 && p.y >= step.y + 3)) return STONE;
      return step.x === 6 ? AIR : { ...AIR, skyLight: 0 };
    } };
  const actions = { goTo: async (_bot, _ctx, goal) => {
    const next = stairs[stairs.indexOf(bot.entity.position) + 1];
    assert.ok(goal.isEnd(next));
    bot.entity.position = next;
    return { ok: true };
  } };
  const records = [];
  const goal = createHuntPearlsGoal({ bot, actions });
  const ctx = { signal: new AbortController().signal, record: (type) => records.push(type),
    perceive: () => ({ ...nightState(bot.entity.position), isDay: true }) };
  goal.memory.sawNight = true;
  for (let i = 1; i < stairs.length; i += 1) {
    assert.equal(goal.isDone(ctx.perceive()), false);
    assert.equal((await goal.run(ctx)).ok, true);
    assert.equal(bot.entity.position, stairs[i]);
  }
  assert.equal(records.filter((type) => type === 'pearl_cave_ascent').length, stairs.length - 1);
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
    perceive: () => nightState(position) };
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
    perceive: () => nightState(position) };
  await goal.run(ctx);
  assert.deepEqual(views, ['eyes', 'eyes', 'ground', 'ground', 'ground']);
  const result = records.find((r) => r.t === 'enderman_stare_result');
  assert.equal(result.came, true);
  assert.equal(result.angry, true);
});

test('a visible Enderman below dry leaves can be stared at without opening that cell to scouts', async () => {
  const position = new Vec3(0, 64, 0);
  const target = new Vec3(12, 64, 0);
  const man = { id: 7, name: 'enderman', position: target };
  const records = [];
  const bot = { ...terrain, entity: { position }, entities: { 7: man },
    blockAt(p) {
      if (p.equals(target.offset(0, 1, 0))) return { ...AIR, skyLight: 0 };
      if (p.equals(target.offset(0, 3, 0))) return { ...STONE, name: 'oak_leaves' };
      return terrain.blockAt(p);
    },
    lookAt: async () => { man.position = new Vec3(4, 64, 0); },
  };
  assert.equal(skyOpen(bot, target), false);
  const goal = createHuntPearlsGoal({ bot, actions: { haltBody() {} } });
  await goal.run({ signal: new AbortController().signal, record: (type, data) => records.push({ type, ...data }),
    perceive: () => nightState(position) });
  assert.ok(records.some((r) => r.type === 'enderman_stare_result' && r.came));
});

test('dim sky alone, a roof over leaves and wet foliage do not qualify an Enderman', () => {
  const feet = new Vec3(0, 64, 0);
  const leaves = { ...STONE, name: 'oak_leaves' };
  for (const [canopy, higher] of [[AIR, AIR], [leaves, STONE],
    [{ ...leaves, getProperties: () => ({ waterlogged: true }) }, AIR], [leaves, null]]) {
    const bot = { ...terrain, blockAt(p) {
      if (p.y === 65) return { ...AIR, skyLight: 0 };
      if (p.y === 67) return canopy;
      if (p.y === 68) return higher;
      return terrain.blockAt(p);
    } };
    assert.equal(skyOpen(bot, feet, { allowLeafCanopy: true }), false);
  }
});

test('an injured or unarmed hunter does not aggro a visible Enderman', async () => {
  const position = new Vec3(0, 64, 0);
  const man = { id: 7, name: 'enderman', position: new Vec3(14, 64, 0) };
  const bot = { ...terrain, entity: { position }, entities: { 7: man },
    lookAt: async () => assert.fail('provoked Enderman while unfit') };
  const goal = createHuntPearlsGoal({ bot, skills: { huntOne: async () => assert.fail('started melee while unfit') } });
  const state = { ...nightState(position), health: 8.833 };
  const ctx = { signal: new AbortController().signal, record() {}, perceive: () => state };
  assert.equal((await goal.run(ctx)).reason, 'pearl_wait_for_combat_readiness');
  state.health = 20;
  state.inventory = {};
  man.position = new Vec3(3, 64, 0);
  assert.equal((await goal.run(ctx)).reason, 'pearl_wait_for_combat_readiness');
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
  await goal.run({ signal: new AbortController().signal, record() {}, perceive: () => nightState(position) });
  assert.equal(stared, 0);
});

test('a hunter steps back from a drop to a dry fight position before staring', async () => {
  const start = new Vec3(0, 64, 0);
  const openCamp = new Vec3(0, 64, -5);
  const man = { id: 9, name: 'enderman', position: new Vec3(14, 64, 0) };
  const path = { getNeighbors: (p) => p.z > openCamp.z ? [p.offset(0, 0, -1)] : [] };
  let looks = 0;
  const bot = { ...terrain, entity: { position: start, onGround: true }, entities: { 9: man }, pathfinder: { movements: path },
    blockAt(p) {
      if (p.y >= 55 && p.y < 64 && p.z > 0 && Math.abs(p.x) <= 3) return AIR;
      return terrain.blockAt(p);
    },
    lookAt: async () => { looks += 1; man.position = new Vec3(3, 64, -5); },
  };
  const actions = { haltBody() {}, goTo: async (_bot, _ctx, goal) => {
    assert.ok(goal.z <= -3);
    bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
    return { ok: true };
  } };
  const goal = createHuntPearlsGoal({ bot, actions });
  const ctx = { signal: new AbortController().signal, record() {}, perceive: () => nightState(bot.entity.position) };
  await goal.run(ctx);
  assert.equal(looks, 0);
  await goal.run(ctx);
  assert.equal(looks, 1);
});

test('after an angry Enderman approaches, the hunter lets it close instead of scouting away', async () => {
  const position = new Vec3(0, 64, 0);
  const player = { position, onGround: true };
  const man = { id: 9, name: 'enderman', position: new Vec3(12, 64, 0), metadata: {} };
  const bot = { ...terrain, entity: player, entities: { 9: man },
    registry: { entitiesByName: { enderman: { metadataKeys: ['creepy'] } } },
    lookAt: async () => { man.metadata[0] = true; },
    look: async () => { man.position = new Vec3(4, 60, 0); },
  };
  const goal = createHuntPearlsGoal({ bot, actions: { haltBody() {}, goTo: () => assert.fail('left the lure site') } });
  const ctx = { signal: new AbortController().signal, record() {}, perceive: () => nightState(position) };
  await goal.run(ctx);
  assert.equal((await goal.run(ctx)).reason, 'pearl_wait_for_lured_enderman');
  goal.memory.lured.until = Date.now() - 1;
  assert.equal((await goal.run(ctx)).reason, 'pearl_scout_no_dry_route');
});

test('scouting owns short dry surface legs and skips underground targets', async () => {
  const player = new Vec3(0, 64, 0);
  const safe = new Vec3(8, 64, 0);
  const water = new Vec3(0, 64, 1);
  const roof = new Vec3(-1, 64, 0);
  const man = { id: 12, name: 'enderman', position: roof };
  const next = new Vec3(1, 64, 0);
  const neighbors = (from) => from.x === 0 ? [next, water, roof, new Vec3(49, 64, 0), new Vec3(14, 64, 0), safe.offset(0, -2, 0)]
    : from.x < safe.x ? [next.offset(from.x, 0, 0)] : [];
  const movements = { getNeighbors: neighbors, canDig: true };
  const bot = { ...terrain, entity: { position: player, onGround: true }, entities: { 12: man }, pathfinder: { movements },
    blockAt(p) {
      if (p.floored().equals(water)) return { ...AIR, name: 'water' };
      if (p.floored().equals(roof.offset(0, 3, 0))) return STONE;
      return terrain.blockAt(p);
    } };
  const goal = createHuntPearlsGoal({ bot, actions: {
    goTo: async (_b, _c, next) => {
      assert.equal(next.isEnd(safe), true);
      assert.deepEqual(movements.getNeighbors(player), [new Vec3(1, 64, 0)]);
      assert.equal(movements.canDig, false);
      bot.entity.position = safe;
      return { ok: true };
    },
  }, skills: { huntOne: async () => assert.fail('underground Enderman selected') } });
  const records = [];
  await goal.run({ signal: new AbortController().signal, record: (type) => records.push(type),
    perceive: () => nightState(player) });
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
  const result = await goal.run({ signal: new AbortController().signal, record: (type) => records.push(type),
    perceive: () => nightState(player) });
  assert.deepEqual(records, []);
  assert.equal(result.reason, 'pearl_scout_no_dry_route');
});

test('scouting takes the connected dry bend when a straight lookout would end in the river', async () => {
  const start = new Vec3(0, 64, 0);
  const shore = [start];
  for (let z = 1; z <= 5; z += 1) shore.push(new Vec3(0, 64, z));
  for (let x = 1; x <= 7; x += 1) shore.push(new Vec3(x, 64, 5));
  const neighbors = (at) => {
    assert.ok(at.offset(0, -1, 0), 'native companion movement guards need a Vec3');
    return shore.filter((p) => p.y === at.y && Math.abs(at.x - p.x) + Math.abs(at.z - p.z) === 1);
  };
  const bot = { ...terrain, entity: { position: start, onGround: true }, pathfinder: { movements: { getNeighbors: neighbors } },
    blockAt(p) {
      if (p.y === 63 && !shore.some((at) => at.x === p.x && at.z === p.z)) return { ...AIR, name: 'water' };
      return terrain.blockAt(p);
    } };
  const steps = [];
  const goal = createHuntPearlsGoal({ bot, actions: { goTo: async (_bot, _ctx, goal) => {
    const target = shore.find((p) => goal.isEnd(p));
    assert.ok(target, 'the destination has real dry support');
    steps.push(target);
    bot.entity.position = target;
    return { ok: true };
  } } });
  const ctx = { signal: new AbortController().signal, record() {}, perceive: () => nightState(bot.entity.position) };
  await goal.run(ctx);
  await goal.run(ctx);
  assert.deepEqual(steps, [new Vec3(5, 64, 5), shore.at(-1)]);
});

test('scouting avoids leaf floors and can leave one via a directly reachable grass bank', async () => {
  const start = new Vec3(0, 64, 0);
  const treetop = new Vec3(1, 64, 0);
  const grass = new Vec3(0, 64, -1);
  const movements = { getNeighbors: (p) => p.x === 0 ? [treetop, grass] : [start] };
  const bot = { ...terrain, entity: { position: start, onGround: true }, pathfinder: { movements },
    blockAt(p) {
      if (p.equals(treetop.offset(0, -1, 0))) return { ...STONE, name: 'oak_leaves' };
      return terrain.blockAt(p);
    } };
  let target;
  const goal = createHuntPearlsGoal({ bot, actions: { goTo: async (_bot, _ctx, goal) => {
    target = new Vec3(goal.x, goal.y, goal.z);
    const current = bot.entity.position;
    assert.ok(movements.getNeighbors(current).some((p) => p.equals(target)));
    assert.ok(movements.getNeighbors(current).every((p) => !p.equals(treetop)));
    bot.entity.position = target;
    return { ok: true };
  } } });
  const records = [];
  const ctx = { signal: new AbortController().signal, record: (type) => records.push(type),
    perceive: () => nightState(bot.entity.position) };
  await goal.run(ctx);
  assert.ok(target.equals(grass));
  bot.entity.position = treetop;
  await goal.run(ctx);
  assert.ok(target.equals(start));
  assert.equal(records.at(-1), 'pearl_scout_ground_bank');
});

test('an unobstructed dry column admits scouting with low live sky light, but a roof or unloaded column does not', async () => {
  const start = new Vec3(0, 64, 0);
  const candidate = new Vec3(-1, 64, 0);
  const above = candidate.offset(0, 3, 0);
  const shaded = { ...AIR, skyLight: 7 };
  let overhead = STONE;
  const movements = { getNeighbors: (p) => p.equals(start) ? [candidate] : [] };
  const bot = { ...terrain, entity: { position: start, onGround: true }, pathfinder: { movements }, blockAt(p) {
    if (p.equals(above)) return overhead;
    return p.y >= 64 ? shaded : STONE;
  } };
  const visits = [];
  const goal = createHuntPearlsGoal({ bot, actions: { goTo: async (_bot, _ctx, hop) => {
    assert.equal(hop.isEnd(candidate), true);
    visits.push(candidate);
    bot.entity.position = candidate;
    return { ok: true };
  } } });
  const ctx = { signal: new AbortController().signal, record() {}, perceive: () => nightState(bot.entity.position) };
  assert.equal(skyOpen(bot, start), false);
  assert.equal((await goal.run(ctx)).reason, 'pearl_scout_no_dry_route');
  overhead = null;
  assert.equal((await goal.run(ctx)).reason, 'pearl_scout_no_dry_route');
  overhead = shaded;
  await goal.run(ctx);
  assert.deepEqual(visits, [candidate]);
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
    perceive: () => nightState(player) });
  assert.deepEqual(records, ['pearl_house_exit']);
});

test('a grounded body straddling leaf litter and a supported lip regains just that footing', async () => {
  const player = new Vec3(-30.9, 70, -24.5);
  const foot = player.floored();
  const support = new Vec3(-32, 70, -25);
  const neighbors = () => [support, new Vec3(-30, 70, -25)];
  const movements = { getNeighbors: neighbors, canDig: true };
  const bot = { ...terrain, entity: { position: player, onGround: true }, pathfinder: { movements },
    blockAt(p) {
      if (p.equals(foot.offset(0, -1, 0))) return { ...AIR, name: 'leaf_litter' };
      return p.y < 70 ? STONE : AIR;
    } };
  const actions = { goTo: async (_b, _c, target, options) => {
    assert.equal(target.isEnd(support), true);
    assert.deepEqual(movements.getNeighbors(foot), [support]);
    assert.equal(movements.canDig, false);
    assert.equal(options.arrived(player), false);
    bot.entity.position = support.offset(.5, 0, .5);
    assert.equal(options.arrived(bot.entity.position), true);
    return { ok: true };
  } };
  const goal = createHuntPearlsGoal({ bot, actions });
  const records = [];
  await goal.run({ signal: new AbortController().signal, record: (type) => records.push(type),
    perceive: () => nightState(player) });
  assert.deepEqual(records, ['pearl_scout_regained_footing']);
  assert.equal(movements.getNeighbors, neighbors);
  assert.equal(movements.canDig, true);
});
