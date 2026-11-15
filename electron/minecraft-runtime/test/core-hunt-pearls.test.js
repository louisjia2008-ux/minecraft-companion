'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createHuntPearlsGoal, pearlTetherRecoveryNeeded, pearlHomeReturnNeeded, scoutSectorOf } = require('../core/goals/huntPearls');
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

test('a surfaced hunter launched in daylight swims only to the adjacent dry bank before releasing', async () => {
  const start = new Vec3(-87, 62, -188);
  const bank = new Vec3(-87, 63, -187);
  const home = new Vec3(-102, 64, -179);
  const bot = { ...terrain, entity: { position: start.offset(.5, 0, .5), onGround: true, isInWater: true },
    companionHomeAt: () => home, blockAt(p) {
      if (p.equals(start)) return { ...AIR, name: 'seagrass' };
      if (p.equals(bank.offset(0, -1, 0))) return STONE;
      return AIR;
    } };
  const calls = [];
  const goal = createHuntPearlsGoal({ bot, actions: { swimAshore: async (_b, _c, options) => {
    assert.deepEqual(options.bank, bank);
    assert.equal(options.acceptBank(bank), true);
    assert.equal(options.acceptBank(bank.offset(48, 0, 0)), false);
    assert.equal(options.maxTicks, 45);
    bot.entity.position = bank.offset(.5, 0, .5);
    bot.entity.isInWater = false;
    return true;
  } } });
  const ctx = { signal: new AbortController().signal, record: (type) => calls.push(type),
    perceive: () => ({ ...nightState(bot.entity.position), isDay: true, inWater: bot.entity.isInWater }) };
  assert.equal(goal.isDone(ctx.perceive()), false);
  await goal.run(ctx);
  assert.equal(goal.isDone(ctx.perceive()), true);
  assert.deepEqual(calls, ['pearl_swim_dry_bank']);
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

test('a loaded occluded Enderman guides the hunter to a dry visible stance before any stare', async () => {
  const position = new Vec3(0, 64, 0);
  const viewpoint = new Vec3(0, 64, -2);
  const flooded = new Vec3(0, 64, 2);
  const man = { id: 62, name: 'enderman', position: new Vec3(10, 64, 0) };
  const dry = [position, new Vec3(0, 64, -1), viewpoint];
  const movements = { getNeighbors: (p) => dry.filter((q) => p.distanceTo(q) === 1)
    .concat(p.equals(position) ? [flooded.offset(0, 0, -1)] : p.equals(flooded.offset(0, 0, -1)) ? [flooded] : []) };
  const records = [];
  let stares = 0;
  const bot = { ...terrain, entity: { position: position.offset(.5, 0, .5), onGround: true },
    entities: { 62: man }, companionHomeAt: () => position, pathfinder: { movements },
    blockAt(p) {
      if (p.floored().equals(flooded.offset(0, -1, 0))) return { ...AIR, name: 'seagrass' };
      return terrain.blockAt(p);
    },
    world: { raycast: (eye) => eye.z <= -1 ? null : STONE },
    lookAt: async () => {
      stares += 1;
      assert.deepEqual(bot.entity.position.floored(), viewpoint);
      man.position = new Vec3(4, 64, -2);
    } };
  const actions = { haltBody() {}, goTo: async (_bot, _ctx, target) => {
    assert.equal(stares, 0);
    assert.ok(target.isEnd(viewpoint));
    assert.ok(!movements.getNeighbors(flooded.offset(0, 0, -1)).some((p) => p.equals(flooded)));
    bot.entity.position = viewpoint.offset(.5, 0, .5);
    return { ok: true };
  } };
  const goal = createHuntPearlsGoal({ bot, actions });
  const ctx = { signal: new AbortController().signal, record: (type, data) => records.push({ type, ...data }),
    perceive: () => nightState(bot.entity.position) };
  await goal.run(ctx);
  assert.equal(stares, 0);
  assert.equal(records[0].occludedEnderman, man.id);
  await goal.run(ctx);
  assert.equal(stares, 1);
  assert.ok(records.some((e) => e.type === 'enderman_stare_result' && e.came));
});

test('canopy sky proof requires dry leaves below a loaded, unobstructed column', () => {
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

test('a low light bare column admits an Enderman only with loaded, dry body clearance', async () => {
  const position = new Vec3(0, 64, 0);
  const open = { id: 1, name: 'enderman', position: new Vec3(4, 64, 0) };
  const roofed = { id: 2, name: 'enderman', position: new Vec3(5, 64, 0) };
  const clipped = { id: 3, name: 'enderman', position: new Vec3(-4, 64, 0) };
  const unloaded = { id: 4, name: 'enderman', position: new Vec3(-5, 64, 0) };
  const candidates = [open, roofed, clipped, unloaded];
  const bot = { ...terrain, entity: { position }, entities: Object.fromEntries(candidates.map((e) => [e.id, e])),
    blockAt(p) {
      if (candidates.some((e) => e.position.offset(0, 1, 0).equals(p))) return { ...AIR, skyLight: 7 };
      if (p.equals(roofed.position.offset(0, 3, 0))) return STONE;
      if (p.equals(clipped.position.offset(0, 2, 0))) return { ...STONE, name: 'oak_leaves' };
      if (p.equals(unloaded.position.offset(0, 3, 0))) return null;
      return terrain.blockAt(p);
    } };
  const goal = createHuntPearlsGoal({ bot, skills: { huntOne: async (_bot, _ctx, { accept }) => {
    assert.deepEqual(candidates.filter(accept), [open]);
    return { ok: true, melee: true };
  } } });
  const result = await goal.run({ signal: new AbortController().signal, record() {}, perceive: () => nightState(position) });
  assert.deepEqual(result, { ok: true, melee: true });
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

test('an angry Enderman that stays eight blocks away does not monopolize repeated stares', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const position = new Vec3(0, 64, 0);
  const man = { id: 9, name: 'enderman', position: new Vec3(8, 64, 0), metadata: [true] };
  const bot = { ...terrain, entity: { position, onGround: true }, entities: { 9: man },
    registry: { entitiesByName: { enderman: { metadataKeys: ['creepy'] } } }, look: async () => {} };
  const goal = createHuntPearlsGoal({ bot });
  const events = [];
  const ctx = { signal: new AbortController().signal, record: (type, data) => events.push({ type, ...data }),
    perceive: () => nightState(position) };
  const original = goal.run(ctx);
  for (let i = 0; i < 120; i += 1) {
    await Promise.resolve();
    t.mock.timers.tick(100);
    await Promise.resolve();
  }
  await original;
  const next = goal.run(ctx);
  await Promise.resolve();
  t.mock.timers.tick(750);
  await next;
  assert.equal(events.filter(({ type }) => type === 'enderman_stare').length, 1);
  assert.equal(goal.memory.lured, null);
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

test('a hunter pushed under leaves can step down onto nearby open grass even after dawn', async () => {
  const home = new Vec3(-102, 64, -179);
  const start = new Vec3(-140, 64, -210);
  const bank = new Vec3(-140, 63, -209);
  const water = start.offset(0, 0, -1);
  const roof = new Vec3(start.x, 67, start.z);
  const leaves = { ...STONE, name: 'oak_leaves' };
  let cover = STONE;
  const native = (p) => p.equals(start) ? [bank, water] : [];
  const movements = { getNeighbors: native, canDig: true };
  const bot = { ...terrain, entity: { position: start.offset(.5, 0, .5), onGround: true }, companionHomeAt: () => home,
    pathfinder: { movements }, blockAt(p) {
      if (p.equals(roof)) return cover;
      if (p.equals(start.offset(0, -1, 0)) || p.equals(bank.offset(0, -1, 0))) return { ...STONE, name: 'grass_block' };
      if (p.equals(water.offset(0, -1, 0))) return { ...AIR, name: 'water' };
      if (p.equals(start)) return { ...AIR, name: 'leaf_litter' };
      return AIR;
    } };
  const actions = { goTo: async (_bot, _ctx, target, options) => {
    assert.equal(target.isEnd(bank), true);
    assert.deepEqual(movements.getNeighbors(start), [bank]);
    assert.equal(movements.canDig, false);
    bot.entity.position = bank.offset(.5, 0, .5);
    assert.equal(options.arrived(bot.entity.position), true);
    return { ok: true };
  } };
  const goal = createHuntPearlsGoal({ bot, actions });
  const records = [];
  const ctx = { signal: new AbortController().signal, record(type, payload) { records.push({type, ...payload}); },
    perceive: () => ({ ...nightState(bot.entity.position), isDay: true }) };
  assert.equal(pearlHomeReturnNeeded(home, bot.entity.position, bot), false, 'never use the same move under a solid roof');
  cover = leaves;
  assert.equal(pearlHomeReturnNeeded(home, bot.entity.position, bot), true);
  assert.equal((await goal.run(ctx)).ok, true);
  assert.deepEqual(records, [{ type: 'pearl_scout_ground_bank', from: start, to: bank }]);
  assert.equal(movements.getNeighbors, native);
});

test('a hunter beyond the tether follows inward dry canopy cells to open ground', async () => {
  const home = new Vec3(-102, 64, -179);
  const start = new Vec3(-97, 63, -129);
  const exit = start.offset(0, 0, -5);
  const native = (p) => [p.offset(0, 0, 1), p.offset(0, 0, -1)];
  const bot = { ...terrain, entity: { position: start.offset(.5, 0, .5), onGround: true },
    companionHomeAt: () => home, pathfinder: { movements: { getNeighbors: native } },
    blockAt(p) {
      if (p.y === 62) return { ...STONE, name: 'grass_block' };
      if (p.y === 66 && p.z > exit.z && p.z <= start.z) return { ...STONE, name: 'oak_leaves' };
      return AIR;
    },
  };
  const moved = [];
  const goal = createHuntPearlsGoal({ bot, actions: { goTo: async (_bot, _ctx, target, { arrived }) => {
    const p = new Vec3(target.x, target.y, target.z);
    assert.deepEqual(bot.pathfinder.movements.getNeighbors(bot.entity.position.floored()), [p]);
    moved.push(p);
    bot.entity.position = p.offset(.5, 0, .5);
    assert.equal(arrived(bot.entity.position), true);
    return { ok: true };
  } } });
  const ctx = { signal: new AbortController().signal, record() {}, perceive: () => nightState(bot.entity.position) };
  for (let leg = 0; leg < 5; leg += 1) await goal.run(ctx);
  assert.deepEqual(moved, Array.from({ length: 5 }, (_, i) => start.offset(0, 0, -i - 1)));
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

test('the requested sector follows supported legs around a river even when its first leg moves east', async () => {
  const start = new Vec3(0, 64, 4);
  const shore = [start];
  for (let x = 1; x <= 5; x += 1) shore.push(new Vec3(x, 64, 4));
  for (let z = 3; z >= -15; z -= 1) shore.push(new Vec3(5, 64, z));
  const native = (at) => shore.filter((p) => p.y === at.y && Math.abs(at.x - p.x) + Math.abs(at.z - p.z) === 1);
  const bot = { ...terrain, entity: { position: start, onGround: true }, companionHomeAt: () => new Vec3(0, 64, 0),
    pathfinder: { movements: { getNeighbors: native } }, blockAt(p) {
      if (p.y === 63 && !shore.some((at) => at.x === p.x && at.z === p.z)) return { ...AIR, name: 'water' };
      return terrain.blockAt(p);
    } };
  const records = [];
  const goal = createHuntPearlsGoal({ bot, scoutSector: 'north', actions: { goTo: async (_bot, _ctx, hop) => {
    const target = shore.find((p) => hop.isEnd(p));
    assert.ok(target);
    assert.ok(target.distanceTo(bot.entity.position) <= 7);
    bot.entity.position = target;
    return { ok: true };
  } } });
  const ctx = { signal: new AbortController().signal, record: (type, data) => records.push({ type, ...data }),
    perceive: () => nightState(bot.entity.position) };
  for (let i = 0; i < 4; i += 1) await goal.run(ctx);
  assert.deepEqual(records.filter((e) => e.scoutSector).map((e) => [e.target.x, e.target.z]), [[5, 2], [5, -5], [5, -12], [5, -14]]);
  assert.equal(goal.memory.scoutCoverage.north, 2);
});

test('dawn keeps an outlying hunter on the dry route back inside the known home tether', async () => {
  const home = new Vec3(-102, 64, -179);
  const start = new Vec3(-122, 63, -229);
  const entry = new Vec3(-122, 63, -222);
  const wet = start.offset(1, 0, 0);
  const bank = Array.from({ length: 9 }, (_, i) => start.offset(0, 0, i));
  const native = (p) => bank.filter((q) => p.distanceTo(q) === 1).concat(p.equals(start) ? [wet] : []);
  const movements = { getNeighbors: native, canDig: true, allowParkour: true };
  const bot = { ...terrain, entity: { position: start.offset(.5, 0, .5), onGround: true }, companionHomeAt: () => home,
    pathfinder: { movements }, blockAt(p) {
      if (p.y !== 62) return AIR;
      return bank.some((q) => q.x === p.x && q.z === p.z) ? STONE : { ...AIR, name: 'water' };
    } };
  const records = [];
  const goal = createHuntPearlsGoal({ bot, actions: { goTo: async (_bot, _ctx, target, options) => {
    assert.equal(target.isEnd(entry), true);
    assert.deepEqual(movements.getNeighbors(start), [bank[1]]);
    assert.equal(movements.canDig, false);
    assert.equal(movements.allowParkour, false);
    assert.equal(options.arrived(bot.entity.position), false);
    bot.entity.position = entry.offset(.5, 0, .5);
    assert.equal(options.arrived(bot.entity.position), true);
    return { ok: true };
  } } });
  const ctx = { signal: new AbortController().signal, record: (type, data) => records.push({ type, ...data }),
    perceive: () => ({ ...nightState(bot.entity.position), isDay: true }) };
  goal.memory.sawNight = true;
  assert.equal(pearlTetherRecoveryNeeded(home, start), true);
  assert.equal(pearlTetherRecoveryNeeded(home, home.offset(0, 0, 59)), false);
  assert.equal(scoutSectorOf(start, home), 'north');
  assert.equal(goal.isDone(ctx.perceive()), false);
  await goal.run(ctx);
  assert.deepEqual(goal.memory.centre, home);
  assert.equal(goal.isDone(ctx.perceive()), false, 'the dawn return continues toward the house');
  assert.deepEqual(records, [{ type: 'pearl_scout_tether_return', from: start, to: entry, centre: home }]);
  assert.equal(movements.getNeighbors, native);
});

test('an edge cell that triggers tether recovery is excluded from the next scout leg', async () => {
  const home = new Vec3(-102, 64, -179);
  const outside = new Vec3(-59, 65, -158);
  const entry = new Vec3(-60, 65, -159);
  const lookout = new Vec3(-61, 65, -159);
  const cells = [outside, entry, lookout];
  const center = (p) => p.offset(.5, 0, .5);
  const movements = { getNeighbors: (p) => cells.filter((next) => p.distanceTo(next) > 0 && p.distanceTo(next) <= Math.SQRT2) };
  const bot = { ...terrain, entity: { position: center(outside), onGround: true }, companionHomeAt: () => home,
    pathfinder: { movements }, blockAt: (p) => p.y < 65 ? STONE : AIR };
  const records = [];
  const goal = createHuntPearlsGoal({ bot, actions: { goTo: async (_bot, _ctx, target) => {
    const next = cells.find((p) => target.isEnd(p));
    bot.entity.position = center(next);
    return { ok: true };
  } } });
  const ctx = { signal: new AbortController().signal, record: (type, data) => records.push({ type, ...data }),
    perceive: () => nightState(bot.entity.position) };
  assert.equal(pearlTetherRecoveryNeeded(home, outside), false);
  assert.equal(pearlTetherRecoveryNeeded(home, center(outside)), true);
  await goal.run(ctx);
  await goal.run(ctx);
  assert.deepEqual(records.map(({ type, target, to }) => [type, target || to]), [
    ['pearl_scout_tether_return', entry], ['pearl_surface_scout', lookout],
  ]);
  assert.deepEqual(bot.entity.position, center(lookout));
});

test('a hunter resumed on grounded sand can recover onto the grass inside the tether after dawn', async () => {
  const home = new Vec3(-102, 64, -179);
  const player = new Vec3(-58.7, 65, -158.35925622748834);
  const start = player.floored();
  const bank = start.offset(-1, 0, 0);
  const outside = start.offset(0, 0, 1);
  let roof = STONE;
  const native = (p) => p.equals(start) ? [outside, bank] : [];
  const movements = { getNeighbors: native, canDig: true };
  const bot = { ...terrain, entity: { position: player, onGround: true }, companionHomeAt: () => home,
    pathfinder: { movements }, blockAt(p) {
      if (p.equals(start.offset(0, -1, 0))) return { ...STONE, name: 'sand' };
      if (p.equals(start.offset(0, 3, 0))) return roof;
      return p.y < 65 ? STONE : AIR;
    } };
  const goal = createHuntPearlsGoal({ bot, actions: { goTo: async (_bot, _ctx, target, options) => {
    assert.equal(target.isEnd(bank), true);
    assert.deepEqual(movements.getNeighbors(start), [bank]);
    assert.equal(movements.canDig, false);
    bot.entity.position = bank.offset(.5, 0, .5);
    assert.equal(options.arrived(bot.entity.position), true);
    return { ok: true };
  } } });
  const records = [];
  const ctx = { signal: new AbortController().signal, record: (type, data) => records.push({ type, ...data }),
    perceive: () => ({ ...nightState(bot.entity.position), isDay: true }) };
  assert.equal(pearlHomeReturnNeeded(home, player, bot), false);
  roof = AIR;
  assert.equal(pearlHomeReturnNeeded(home, player, bot), true);
  assert.equal((await goal.run(ctx)).ok, true);
  assert.deepEqual(records, [{ type: 'pearl_scout_ground_bank', from: start, to: bank }]);
  assert.equal(movements.getNeighbors, native);
});

test('a grounded hunter can cross backed sand and take one step up to grass', async () => {
  const home = new Vec3(-102, 64, -179);
  const start = new Vec3(-92, 64, -195);
  const route = [start, start.offset(-1, 0, 0), start.offset(-1, 0, -1), start.offset(-1, 1, -2)];
  const bot = { ...terrain, entity: { position: start.offset(.5, 0, .5), onGround: true },
    companionHomeAt: () => home, pathfinder: { movements: {
      getNeighbors: (p) => route.filter((q) => Math.abs(p.x - q.x) + Math.abs(p.z - q.z) === 1),
    } }, blockAt(p) {
      if (p.equals(route.at(-1).offset(0, -1, 0))) return { ...STONE, name: 'grass_block' };
      if (route.slice(0, 3).some((q) => q.x === p.x && q.z === p.z) && p.y >= 61 && p.y <= 63) return { ...STONE, name: 'sand' };
      return p.y === 60 ? STONE : AIR;
    },
  };
  const destinations = [];
  const goal = createHuntPearlsGoal({ bot, actions: { goTo: async (_bot, _ctx, target, { arrived }) => {
    const next = new Vec3(target.x, target.y, target.z);
    assert.deepEqual(bot.pathfinder.movements.getNeighbors(bot.entity.position.floored()), [next]);
    destinations.push(next);
    bot.entity.position = next.offset(.5, 0, .5);
    assert.equal(arrived(bot.entity.position), true);
    return { ok: true };
  } } });
  const ctx = { signal: new AbortController().signal, record() {}, perceive: () => nightState(bot.entity.position) };
  for (let i = 1; i < route.length; i += 1) await goal.run(ctx);
  assert.deepEqual(destinations, route.slice(1));
});

test('an outlying hunter launched at dawn stops attempting recovery after two guarded route failures', async () => {
  const home = new Vec3(0, 64, 0);
  const start = home.offset(0, 0, -56);
  const bot = { ...terrain, entity: { position: start, onGround: true }, companionHomeAt: () => home,
    pathfinder: { movements: { getNeighbors: () => [] } } };
  const goal = createHuntPearlsGoal({ bot, actions: {} });
  const ctx = { signal: new AbortController().signal, record() {},
    perceive: () => ({ ...nightState(bot.entity.position), isDay: true }) };
  assert.equal(goal.isDone(ctx.perceive()), false);
  assert.equal((await goal.run(ctx)).reason, 'pearl_scout_tether_blocked');
  assert.equal(goal.ownsRouteRecovery(), true);
  assert.equal(goal.isDone(ctx.perceive()), false);
  assert.equal((await goal.run(ctx)).reason, 'pearl_scout_tether_blocked');
  assert.equal(goal.isDone(ctx.perceive()), true);
  assert.deepEqual(goal.memory.centre, home);
});


test('a long quiet hunt revisits a near camp it actually landed at, then still hunts a visible target', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const home = new Vec3(0, 64, 0);
  const start = home.offset(0, 0, -10);
  const previous = home.offset(0, 0, -22);
  const target = { id: 29, name: 'enderman', position: start.offset(4, 0, 0) };
  const entities = {};
  const movements = { getNeighbors: (p) => [p.offset(0, 0, -1), p.offset(0, 0, 1)] };
  const bot = { ...terrain, entity: { position: start.offset(.5, 0, .5), onGround: true }, entities,
    companionHomeAt: () => home, pathfinder: { movements, *getPathFromTo(dry, at, goal) {
      assert.equal(dry.canDig, false);
      assert.ok(goal.isEnd(start));
      assert.ok(at.floored().equals(previous));
      const path = Array.from({ length: 12 }, (_, i) => previous.offset(0, 0, i + 1));
      yield { result: { status: 'success', path } };
    } } };
  const records = [];
  let hunted = 0;
  const actions = { goTo: async (_bot, _ctx, goal) => {
    bot.entity.position = new Vec3(goal.x + .5, goal.y, goal.z + .5);
    return { ok: true };
  } };
  const goal = createHuntPearlsGoal({ bot, actions, skills: { huntOne: async (_b, _c, options) => {
    assert.equal(options.accept(target), true);
    hunted += 1;
    return { ok: true };
  } } });
  const ctx = { signal: new AbortController().signal, record: (type, data) => records.push({ type, ...data }),
    perceive: () => nightState(bot.entity.position) };
  await goal.run(ctx);
  bot.entity.position = previous.offset(.5, 0, .5);
  t.mock.timers.tick(71000);
  await goal.run(ctx);
  assert.equal(records.at(-1).remaining, 5);
  await goal.run(ctx);
  assert.equal(records.at(-1).remaining, 0);
  const watch = goal.run(ctx);
  await Promise.resolve();
  t.mock.timers.tick(750);
  assert.equal((await watch).reason, 'pearl_near_scout_watch');
  entities[target.id] = target;
  await goal.run(ctx);
  assert.equal(hunted, 1);
  assert.deepEqual(records.filter(({ type }) => type === 'pearl_near_scout_watch').map(({ at }) => at), [start]);
});

test('the wider dusk scout proves a dry return and records a completed dry watch', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100 });
  const home = new Vec3(0, 64, 0);
  const camp = home.offset(0, 0, 64);
  const simplePath = (start, end) => Array.from({ length: Math.abs(start.z - end.z) }, (_, i) =>
    start.offset(0, 0, (i + 1) * Math.sign(end.z - start.z)));
  let day = false, foodPieces = 2;
  const ledges = [];
  const bot = { ...terrain, time: { day: 8, timeOfDay: 13000 }, entity: { position: home.offset(.5, 0, .5), onGround: true },
    companionHomeAt: () => home, pathfinder: { movements: { getNeighbors: (p) => [p.offset(0, 0, 1), p.offset(0, 0, -1)] },
      *getPathFromTo(dry, position, end) {
        assert.equal(dry.canDig, false);
        const start = position.floored();
        const target = start.equals(camp) ? home : camp;
        assert.ok(end.isEnd(target));
        if (start.equals(camp)) assert.equal(end.isEnd(home.offset(0, -1, 0)), false);
        yield { result: { status: 'success', path: simplePath(start, target) } };
      } } };
  const goal = createHuntPearlsGoal({ bot, scoutRadius: 80, scoutSector: 'south', actions: {
    goTo: async (_bot, _ctx, target) => {
      const next = new Vec3(target.x, target.y, target.z);
      assert.ok(bot.entity.position.floored().distanceTo(next) <= 10);
      ledges.push(next);
      bot.entity.position = next.offset(.5, 0, .5);
      return { ok: true };
    },
  } });
  const records = [];
  const ctx = { signal: new AbortController().signal, record: (type, data) => records.push({ type, ...data }),
    perceive: () => ({ ...nightState(bot.entity.position), isDay: day, inventory: { iron_sword: 1, bread: foodPieces } }) };
  await goal.run(ctx);
  assert.equal(records.some(({ type }) => type === 'pearl_wide_scout_plan'), false);
  bot.entity.position = home.offset(.5, 0, .5);
  foodPieces = 3;
  for (let i = 0; i < 10; i += 1) await goal.run(ctx);
  assert.deepEqual(records.find(({ type }) => type === 'pearl_wide_scout_plan'), {
    type: 'pearl_wide_scout_plan', from: home, camp, sector: 'south', steps: 64, returnSteps: 64 });
  assert.deepEqual(bot.entity.position.floored(), camp);
  const watch = goal.run(ctx);
  await Promise.resolve();
  t.mock.timers.tick(21000);
  await watch;
  assert.ok(records.some(({ type }) => type === 'pearl_wide_scout_watch'));
  assert.equal(records.some(({ type }) => type === 'pearl_wide_scout_dry_sortie'), false);
  day = true;
  for (let i = 0; i < 11; i += 1) {
    assert.equal(goal.isDone(ctx.perceive()), false);
    await goal.run(ctx);
  }
  assert.equal(goal.isDone(ctx.perceive()), true);
  assert.ok(records.some(({ type }) => type === 'pearl_wide_scout_home'));
  assert.deepEqual(ledges.at(-1), home);
  assert.deepEqual(records.find(({ type }) => type === 'pearl_wide_scout_dry_sortie'), {
    type: 'pearl_wide_scout_dry_sortie', radius: 80, nightDay: 8, from: home, camp, at: home, home,
    before: 0, after: 0, watchedMs: 21000 });
});

test('the distant scout starts before dusk and keeps its dry return when dawn beats the first watch', async () => {
  const home = new Vec3(0, 64, 0), camp = home.offset(60, 0, -60);
  const bot = { ...terrain, time: { day: 8, timeOfDay: 10500 }, entity: { position: home.offset(.5, 0, .5), onGround: true },
    companionHomeAt: () => home, pathfinder: { movements: { getNeighbors: (p) => [p.offset(1, 0, -1), p.offset(-1, 0, 1)] },
      *getPathFromTo(_dry, position, target) {
        const start = position.floored();
        const end = target.isEnd(camp) ? camp : home;
        assert.ok(target.isEnd(end));
        const step = Math.sign(end.x - start.x);
        const path = Array.from({ length: Math.abs(end.x - start.x) }, (_, i) => start.offset(step * (i + 1), 0, -step * (i + 1)));
        yield { result: { status: 'success', path } };
      } } };
  const goal = createHuntPearlsGoal({ bot, scoutRadius: 96, actions: { goTo: async (_b, _ctx, target) => {
    bot.entity.position = new Vec3(target.x + .5, target.y, target.z + .5);
    return { ok: true };
  } } });
  const events = [];
  const ctx = { signal: new AbortController().signal, record: (type, data) => events.push({ type, ...data }),
    perceive: () => ({ ...nightState(bot.entity.position), isDay: true, inventory: { iron_sword: 1, bread: 2 } }) };
  await goal.run(ctx);
  assert.equal(goal.memory.distantScoutActive, true);
  assert.equal(events[0].radius, 96);
  assert.equal(events[0].sector, 'northeast');
  assert.equal(events.at(-1).type, 'pearl_wide_scout_out_leg');
  bot.time.day += 1;
  bot.time.timeOfDay = 600;
  await goal.run(ctx);
  assert.equal(events.at(-1).type, 'pearl_wide_scout_return_leg');
  await goal.run(ctx);
  assert.equal(events.at(-1).type, 'pearl_wide_scout_home');
  assert.equal(goal.memory.distantScoutActive, false);
});

test('dawn returns to the house in short confirmed dry legs and can begin with a detour', async () => {
  const house = new Vec3(0, 64, 0);
  const start = house.offset(0, 0, -26);
  const route = [start.offset(0, 0, -1), start.offset(1, 0, -1), start.offset(2, 0, -1)];
  for (let z = -26; z <= -5; z += 1) route.push(house.offset(2, 0, z));
  const bank = [start, ...route];
  const native = (p) => bank.filter((at) => p.distanceTo(at) === 1);
  const bot = { ...terrain, entity: { position: start.offset(.5, 0, .5), onGround: true },
    companionHomeAt: () => house, pathfinder: { movements: { getNeighbors: native },
      *getPathFromTo(movements, position, end) {
        assert.deepEqual(movements.getNeighbors(position.floored()), [route[0]]);
        assert.ok(end.isEnd(route.at(-1)));
        yield { result: { status: 'success', path: route } };
      } },
    blockAt(p) {
      if (p.y === 63 && !bank.some((at) => at.x === p.x && at.z === p.z)) return { ...AIR, name: 'water' };
      return terrain.blockAt(p);
    } };
  const records = [];
  let reached = 0;
  const goal = createHuntPearlsGoal({ bot, actions: { goTo: async (_bot, _ctx, target, options) => {
    const leg = route.slice(reached, reached += 7);
    const next = leg.at(-1);
    assert.ok(target.isEnd(next));
    assert.equal(bot.pathfinder.movements.canDig, false);
    assert.ok(bot.pathfinder.movements.getNeighbors(bot.entity.position.floored()).every((p) => leg.includes(p)));
    bot.entity.position = next.offset(.5, 0, .5);
    assert.equal(options.arrived(bot.entity.position), true);
    return { ok: true };
  } } });
  const ctx = { signal: new AbortController().signal, record: (type, data) => records.push({ type, ...data }),
    perceive: () => ({ ...nightState(bot.entity.position), isDay: true }) };
  assert.equal(pearlHomeReturnNeeded(house, bot.entity.position, bot), true);
  for (let i = 0; i < 4; ++i) {
    assert.equal(goal.isDone(ctx.perceive()), false);
    assert.equal((await goal.run(ctx)).ok, true);
  }
  assert.equal(goal.isDone(ctx.perceive()), true);
  assert.equal(records.length, 4);
  assert.ok(records.every(({ type }) => type === 'pearl_daylight_home_leg'));
  assert.equal(records.at(-1).remaining, 0);
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
