'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutfitGoal } = require('../core/goals/outfit');
const { createGatherMaterialsGoal } = require('../core/goals/gatherMaterials');
const { perceive } = require('../core/perception');
const { createStarterHouse } = require('../core/blueprints/starterHouse');
const { sleep } = require('../core/confirm');
const { takeItems } = require('../core/skills');
const { Vec3 } = require('vec3');

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

test('home recovery leaves normal gather idle until it physically returns and reads the supply chest', async () => {
  const bot = Object.assign(fakeBot(), { health: 20, food: 20, game: { dimension: 'overworld' },
    entity: { position: new Vec3(20, 64, 0) }, entities: {} });
  const operations = [];
  const guardedHome = { ...home, anchor: { x: 0, y: 64, z: 0 } };
  const items = [{ key: 'stone_tier_pickaxe', count: 1 }];
  const goal = createOutfitGoal({ bot, home: guardedHome, items, recoverAtHome: true,
    actions: {
      goNear: async (_bot, _ctx, p) => { operations.push('walk'); bot.entity.position = p; return { ok: true }; },
    },
    skills: {
      takeItems: async (_bot, _ctx, { itemMatch }) => {
        operations.push('read-chest');
        assert.ok(itemMatch('stone_pickaxe'));
        assert.ok(itemMatch('oak_log'));
        assert.equal(itemMatch('arrow'), false);
        assert.equal(itemMatch('water_bucket'), false);
        return { ok: false, reason: 'chest_empty' };
      },
    },
    createGather: (options) => {
      assert.equal(options.surfaceOnly, true);
      operations.push('gather');
      return { isDone: () => false, progress: () => 0, run: async () => ({ ok: true }) };
    } });
  const ctx = { perceive: () => perceive(bot), record: (type) => operations.push(type) };
  assert.equal(goal.isDone(perceive(bot)), false);
  await goal.run(ctx);
  await goal.run(ctx);
  await goal.run(ctx);
  assert.deepEqual(operations, ['walk', 'resupply_home_arrived', 'read-chest', 'resupply_chest_read', 'device_materials', 'gather']);
});

test('a healthy recovery with a missing food reserve can withdraw existing water for dry known wheat', async () => {
  const farm = new Vec3(8, 63, 2);
  const bot = Object.assign(fakeBot([{ name: 'stone_sword', count: 1 }, { name: 'bread', count: 1 }]),
    { health: 20, food: 18, game: { dimension: 'overworld' }, entity: { position: new Vec3(2.5, 64, 2.5), onGround: true },
      entities: {}, time: { timeOfDay: 5000 } });
  bot.blockAt = (p) => p.equals(farm) ? { name: 'farmland', getProperties: () => ({ moisture: 0 }) }
    : p.equals(farm.offset(0, 1, 0)) ? { name: 'wheat', getProperties: () => ({ age: 4 }) } : { name: 'air' };
  let read = false;
  const goal = createOutfitGoal({ bot, home, items: [{ key: 'food', count: 3 }], recoverAtHome: true,
    farmPlots: [farm], skills: {
      takeItems: async (_b, _c, { itemMatch }) => {
        read = true;
        assert.equal(itemMatch('water_bucket'), true);
        assert.equal(itemMatch('lava_bucket'), false);
        return { ok: true, taken: 1 };
      },
    } });
  await goal.run({ perceive: () => perceive(bot), record() {} });
  assert.equal(read, true);
});

test('home recovery takes a bounded dry ascent after a failed open-sky ravine return', async () => {
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  const door = house.furniture.door.position;
  const start = new Vec3(8, 57, 3);
  const air = { name: 'air', boundingBox: 'empty', shapes: [], skyLight: 15 };
  const stone = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], diggable: true };
  const cleared = new Set();
  const bot = Object.assign(fakeBot([{ name: 'stone_pickaxe', count: 1 }]), {
    game: { dimension: 'overworld', minY: 50, height: 30 }, health: 20, food: 17, time: { timeOfDay: 5000 }, entities: {},
    canDigBlock: () => true,
    entity: { position: start.offset(.5, 0, .5), onGround: true },
    blockAt(p) {
      if (p.x === door.x && p.z === door.z && [door.y, door.y + 1].includes(p.y)) return {
        name: 'oak_door', getProperties: () => ({ half: p.y === door.y ? 'lower' : 'upper', open: false, facing: 'north', hinge: 'left' }),
      };
      if (!cleared.has(p.toString()) && (p.equals(start.offset(0, -1, 0)) || p.x >= 9 && p.y <= 61)) return { ...stone, position: p };
      return air;
    },
  });
  const movements = { getNeighbors(homeward) {
    return [...[-1, 0, 1].flatMap((dy) => [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => homeward.offset(dx, dy, dz))),
      homeward.offset(1, -3, 0)];
  } };
  bot.pathfinder = { movements };
  const events = [];
  const ctx = { perceive: () => perceive(bot), record: (type, details) => events.push({ type, ...details }) };
  let attempts = 0;
  let digs = 0;
  let chest = 0;
  const goal = createOutfitGoal({ bot, items: [{ key: 'food', count: 3 }], recoverAtHome: true,
    home: { chest: house.furniture.chest.position, centre: house.interiorCenter, anchor: house.anchor, door },
    actions: {
      withinReach: () => false,
      goNear: async () => {
        attempts += 1;
        if (bot.entity.position.y < 62) return { ok: false, reason: 'NoPath' };
        const { x, y, z } = house.interiorCenter;
        bot.entity.position = new Vec3(x + .5, y, z + .5);
        return { ok: true };
      },
      digBlock: async (_bot, _ctx, block) => {
        assert.ok(block.position.x >= 9);
        assert.ok(block.position.y > bot.entity.position.y);
        cleared.add(block.position.toString());
        digs += 1;
        return { ok: true };
      },
      goTo: async (_bot, _ctx, { x, y, z }) => {
        const from = bot.entity.position.floored();
        const to = new Vec3(x, y, z);
        assert.deepEqual(movements.getNeighbors(from), [to]);
        assert.ok(to.y >= from.y - 1 && to.y <= from.y + 1);
        bot.entity.position = to.offset(.5, 0, .5);
        return { ok: true };
      },
    },
    skills: { takeItems: async () => { chest += 1; return { ok: false, reason: 'chest_empty' }; } },
  });
  assert.equal(goal.ownsRouteRecovery(), false);
  await goal.run(ctx);
  assert.equal(goal.ownsRouteRecovery(), true);
  assert.deepEqual(events[0], { type: 'resupply_ravine_ascent', from: start, floor: 62 });
  bot.entities[1] = { id: 1, name: 'skeleton', position: start.offset(0, 5, 0) };
  assert.equal((await goal.run(ctx)).reason, 'resupply_ravine_unsafe');
  assert.equal(digs, 0);
  delete bot.entities[1];
  for (let i = 0; i < 32 && !chest; i += 1) await goal.run(ctx);
  assert.equal(chest, 1);
  assert.equal(attempts, 2);
  assert.ok(digs > 0);
  assert.equal(goal.ownsRouteRecovery(), false);
});

test('home recovery walks beneath intact foundations before digging outside the house', async () => {
  const house = createStarterHouse({ x: 30, y: 72, z: -34 });
  const door = house.furniture.door.position;
  const start = new Vec3(33, 68, -32);
  const approach = [[33, 69, -33], [33, 68, -34], [32, 68, -34], [32, 69, -35]].map((p) => new Vec3(...p));
  const air = { name: 'air', boundingBox: 'empty', shapes: [], skyLight: 15 };
  const dirt = { name: 'dirt', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], diggable: true };
  const cleared = new Set();
  const initial = new Set([start, ...approach].flatMap((p) => [p.toString(), p.offset(0, 1, 0).toString()]));
  for (const p of [start, approach[1], approach[2]]) initial.add(p.offset(0, 2, 0).toString());
  const bot = Object.assign(fakeBot(), {
    health: 20, food: 20, time: { timeOfDay: 5000 }, game: { dimension: 'overworld', minY: 60, height: 24 },
    entity: { position: start.offset(.5, 0, .5), onGround: true }, entities: {}, canDigBlock: () => true,
    blockAt(p) {
      if (p.x === door.x && p.z === door.z && [door.y, door.y + 1].includes(p.y)) return {
        name: 'birch_door', getProperties: () => ({ half: p.y === door.y ? 'lower' : 'upper', open: false, facing: 'south', hinge: 'left' }),
      };
      return p.y >= 72 || initial.has(p.toString()) || cleared.has(p.toString()) ? air : { ...dirt, position: p };
    },
    companionProtectBlock: (block) => block.position?.z >= house.anchor.z
      && block.position.x >= house.anchor.x && block.position.x < house.anchor.x + 7,
  });
  const movements = { getNeighbors(at) {
    return [-1, 0, 1].flatMap(dy => [[0, -1], [-1, 0], [1, 0], [0, 1]].map(([dx, dz]) => at.offset(dx, dy, dz)));
  } };
  bot.pathfinder = { movements };
  const moves = [];
  const ctx = { perceive: () => perceive(bot), record: () => {} };
  const goal = createOutfitGoal({ bot, items: [{ key: 'stone_sword', count: 1 }], recoverAtHome: true,
    home: { chest: house.furniture.chest.position, centre: house.interiorCenter, anchor: house.anchor, door },
    actions: {
      goNear: async () => assert.fail('ordinary approach attempted from below the house'),
      goTo: async (_bot, _ctx, { x, y, z }) => {
        const from = bot.entity.position.floored();
        const next = new Vec3(x, y, z);
        assert.deepEqual(movements.getNeighbors(from), [next]);
        moves.push(next);
        bot.entity.position = next.offset(.5, 0, .5);
        return { ok: true };
      },
      digBlock: async (_bot, _ctx, block) => {
        assert.equal(moves.length, approach.length);
        assert.ok(block.position.z < house.anchor.z);
        assert.equal(bot.companionProtectBlock(block), false);
        cleared.add(block.position.toString());
        return { ok: true };
      },
    },
  });
  for (let i = 0; i < approach.length; i += 1) assert.equal((await goal.run(ctx)).ok, true);
  assert.deepEqual(moves, approach);
  assert.equal(cleared.size, 0);
  assert.equal(goal.ownsRouteRecovery(), true);
  assert.equal((await goal.run(ctx)).ok, true);
  assert.equal(cleared.size, 1);
});

test('unarmed home rearm climbs a shallow roofed rim outside the house before walking home', async () => {
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  const start = new Vec3(3, 60, 8);
  const door = house.furniture.door.position;
  const air = { name: 'air', boundingBox: 'empty', shapes: [], skyLight: 15 };
  const stone = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], diggable: true };
  const bot = Object.assign(fakeBot(), {
    health: 20, food: 20, time: { timeOfDay: 3000 }, game: { dimension: 'overworld', minY: 54, height: 28 },
    entity: { position: start.offset(.5, 0, .5), onGround: true }, entities: {}, canDigBlock: () => true,
    blockAt(p) {
      if (p.x === door.x && p.z === door.z && [door.y, door.y + 1].includes(p.y)) return {
        name: 'birch_door', getProperties: () => ({ half: p.y === door.y ? 'lower' : 'upper', open: false, facing: 'south', hinge: 'left' }),
      };
      return p.y >= 64 || p.equals(start) || p.equals(start.offset(0, 1, 0)) ? air : { ...stone, position: p };
    },
  });
  const events = [];
  const goal = createOutfitGoal({ bot, items: [{ key: 'stone_sword', count: 1 }], recoverAtHome: true,
    home: { chest: house.furniture.chest.position, centre: house.interiorCenter, anchor: house.anchor, door },
    actions: {
      goNear: async () => assert.fail('ordinary approach attempted through the roofed rim'),
      goTo: async () => assert.fail('retreat should clear its next foothold first'),
      digBlock: async () => ({ ok: false, reason: 'observed_cut' }),
    },
  });
  const result = await goal.run({ perceive: () => perceive(bot), record: (type) => events.push(type) });
  assert.equal(result.reason, 'observed_cut');
  assert.deepEqual(events, ['resupply_ravine_ascent', 'resupply_ravine_step']);
  assert.equal(goal.ownsRouteRecovery(), true);
});

test('healthy daytime rearm lets the active quarry work from its dry low entrance', async () => {
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  const door = house.furniture.door.position;
  const entrance = new Vec3(-2, 60, 4);
  const air = { name: 'air', boundingBox: 'empty', shapes: [], skyLight: 15 };
  const stone = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], diggable: true };
  const bot = Object.assign(fakeBot(), {
    health: 20, food: 20, time: { timeOfDay: 3000 }, game: { dimension: 'overworld', minY: 54, height: 28 },
    entity: { position: new Vec3(3.5, 64, 4.5), onGround: true }, entities: {},
    blockAt(p) {
      if (p.x === door.x && p.z === door.z && [door.y, door.y + 1].includes(p.y)) return {
        name: 'birch_door', getProperties: () => ({ half: p.y === door.y ? 'lower' : 'upper', open: true, facing: 'north' }),
      };
      return p.y >= 64 || p.x === entrance.x && p.z === entrance.z && p.y >= entrance.y
        ? air : { ...stone, position: p };
    },
  });
  const events = [];
  const goal = createOutfitGoal({ bot, items: [{ key: 'stone_sword', count: 1 }], recoverAtHome: true,
    home: { chest: house.furniture.chest.position, centre: house.interiorCenter, anchor: house.anchor, door },
    skills: { takeItems: async () => ({ ok: false, reason: 'chest_empty' }) },
    actions: {
      goNear: async () => assert.fail('left the known quarry by the ordinary route'),
      goTo: async () => assert.fail('left the known quarry by a ravine route'),
      digBlock: async () => assert.fail('dug to escape the known quarry'),
    },
    createGather: () => ({
      atSurfaceQuarry: () => bot.entity.position.floored().equals(entrance),
      isDone: () => false,
      progress: () => 0,
      async run() {
        events.push('quarry');
        bot.entity.position = entrance.offset(.5, 0, .5);
        return { ok: true };
      },
    }),
  });
  const ctx = { perceive: () => perceive(bot), record: (type) => events.push(type) };
  for (let tick = 0; tick < 3; tick += 1) assert.equal((await goal.run(ctx)).ok, true);
  assert.deepEqual(events, ['resupply_home_arrived', 'resupply_chest_read', 'device_materials', 'quarry', 'quarry']);
});

test('home recovery repairs the missing inner doorstep support from the intact outer doorstep', async () => {
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  const { x, y, z } = house.furniture.door.position;
  const door = new Vec3(x, y, z);
  const inside = door.offset(0, 0, 1);
  const outside = door.offset(0, 0, -1);
  const gap = inside.offset(0, -1, 0);
  const ref = gap.offset(-1, 0, 0);
  const item = { name: 'dirt', count: 2 };
  let floor = 'air';
  let visible = false;
  const events = [];
  const bot = Object.assign(fakeBot([item]), { game: { dimension: 'overworld' }, time: { timeOfDay: 5000 },
    health: 20, food: 17, entity: { position: outside.offset(.5, 0, .5), onGround: true } });
  bot.blockAt = (p) => {
    if (p.equals(door) || p.equals(door.offset(0, 1, 0))) return { name: 'oak_door',
      getProperties: () => ({ half: p.y === door.y ? 'lower' : 'upper', open: true, facing: 'south', hinge: 'left' }) };
    const solid = p.equals(gap) ? floor === 'dirt' : p.y === 63 || p.equals(inside.offset(0, 2, 0));
    return { position: p.floored(), name: p.equals(gap) ? floor : solid ? 'grass_block' : 'air',
      boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] };
  };
  bot.world = { getBlock: bot.blockAt, raycast: () => visible ? { position: ref, face: 5 } : null };
  const path = [];
  let placed = 0;
  const goal = createOutfitGoal({ bot, items: [{ key: 'food', count: 3 }], recoverAtHome: true,
    home: { chest: house.furniture.chest.position, centre: house.interiorCenter, anchor: house.anchor, door },
    actions: {
      goTo: async (_b, _c, { x, y, z }) => {
        const next = new Vec3(x, y, z);
        assert.equal(floor, 'dirt');
        path.push(next);
        bot.entity.position = next.offset(.5, 0, .5);
        return { ok: true };
      },
      goNear: async () => assert.fail('the damaged entry requires dry cardinal steps'),
      digBlock: async () => assert.fail('do not dig any existing door or floor'),
    },
    skills: {
      placeAt: async (_b, _c, target, match, options) => {
        assert.ok(bot.entity.position.floored().equals(outside));
        assert.deepEqual(target, gap);
        assert.deepEqual(options.faces, [new Vec3(-1, 0, 0)]);
        assert.ok(match(item.name));
        assert.equal(match('gravel'), false);
        item.count -= 1;
        floor = item.name;
        placed += 1;
        return { ok: true };
      },
      takeItems: async () => ({ ok: false, reason: 'chest_empty' }),
    },
  });
  const ctx = { perceive: () => perceive(bot), record: (type, data) => events.push({ type, ...data }) };
  assert.equal((await goal.run(ctx)).reason, 'resupply_home_floor_no_face');
  assert.equal(placed, 0);
  visible = true;
  assert.equal((await goal.run(ctx)).ok, true);
  assert.equal(placed, 1);
  assert.equal(item.count, 1);
  assert.deepEqual(events.at(-1), { type: 'resupply_home_floor', position: gap, confirmed: true, reason: undefined });
  await goal.run(ctx);
  await goal.run(ctx);
  await goal.run(ctx);
  assert.deepEqual(path, [door, inside]);
  assert.equal(placed, 1);
  assert.ok(events.some(({ type }) => type === 'resupply_home_arrived'));
});

test('critically hurt home recovery closes the real door before nighttime provisioning', async () => {
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  const door = house.furniture.door.position;
  const roof = new Vec3(3, 66, 3);
  const bot = Object.assign(fakeBot(), { health: 2.67, food: 0, game: { dimension: 'overworld' },
    entity: { position: new Vec3(3.5, 64, 3.5) }, entities: {}, time: { timeOfDay: 15000 } });
  const operations = [];
  let open = true;
  let breached = false;
  bot.blockAt = (p) => {
    if (p.x === door.x && p.z === door.z && (p.y === door.y || p.y === door.y + 1)) {
      return { name: 'oak_door', getProperties: () => ({ half: p.y === door.y ? 'lower' : 'upper',
        open, facing: 'north', hinge: 'left' }) };
    }
    return p.equals(roof) && breached ? { name: 'air', shapes: [] } : { name: 'cobblestone', shapes: [[0, 0, 0, 1, 1, 1]] };
  };
  bot.activateBlock = async () => { open = !open; operations.push(open ? 'open' : 'close'); };
  const goal = createOutfitGoal({ bot, items: [{ key: 'food', count: 3 }], recoverAtHome: true,
    home: { chest: house.furniture.chest.position, centre: house.interiorCenter, anchor: house.anchor, door },
    actions: { withinReach: () => true },
    skills: { takeItems: async (_bot, _ctx, { itemMatch }) => {
      assert.equal(itemMatch('water_bucket'), true);
      operations.push('chest');
      return { ok: false, reason: 'chest_empty' };
    },
      huntOne: async () => { operations.push('hunt'); return { ok: true }; } } });
  const controller = new AbortController();
  const ctx = { perceive: () => perceive(bot), signal: controller.signal, record: (type) => {
    if (type === 'resupply_shelter_wait') controller.abort();
  } };
  await goal.run(ctx);
  await goal.run(ctx);
  assert.deepEqual(operations, ['close', 'chest']);
  assert.equal(perceive(bot).sheltered, true);
  breached = true;
  assert.equal(perceive(bot).sheltered, false, 'live roof breach invalidates cover');
  breached = false;
  bot.entities[1] = { id: 1, name: 'zombie', position: new Vec3(5.5, 64, 3.5) };
  assert.equal(perceive(bot).sheltered, false, 'an interior hostile invalidates cover');
  bot.entities = {};
  await assert.rejects(goal.run(ctx), { code: 'aborted' });
  assert.deepEqual(operations, ['close', 'chest'], 'nighttime hunger must not send the bot outside');
  bot.time.timeOfDay = 3000;
  delete ctx.signal;
  bot.health = 10;
  await goal.run(ctx);
  assert.deepEqual(operations, ['close', 'chest', 'open']);
  await goal.run(ctx);
  assert.deepEqual(operations, ['close', 'chest', 'open', 'hunt']);
  await goal.dispose();
  assert.equal(bot.companionResupplySheltered, undefined);
});

test('a full-health unarmed respawn seals home and reads supplies before gathering after daylight', async () => {
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  const door = house.furniture.door.position;
  const bot = Object.assign(fakeBot(), { health: 20, food: 20, game: { dimension: 'overworld' },
    entity: { position: new Vec3(3.5, 64, 3.5), onGround: true }, entities: {}, time: { timeOfDay: 15000 } });
  let open = true;
  bot.blockAt = (p) => p.x === door.x && p.z === door.z && (p.y === door.y || p.y === door.y + 1)
    ? { name: 'oak_door', getProperties: () => ({ half: p.y === door.y ? 'lower' : 'upper', open, facing: 'north', hinge: 'left' }) }
    : { name: 'cobblestone', shapes: [[0, 0, 0, 1, 1, 1]] };
  const events = [];
  bot.activateBlock = async () => { open = !open; events.push(open ? 'open' : 'close'); };
  const goal = createOutfitGoal({ bot, items: [{ key: 'stone_sword', count: 1 }], recoverAtHome: true,
    home: { chest: house.furniture.chest.position, centre: house.interiorCenter, anchor: house.anchor, door },
    actions: { withinReach: () => true },
    skills: { takeItems: async () => { events.push('chest'); return { ok: false, reason: 'chest_empty' }; } },
    createGather: () => {
      events.push('gather');
      return { isDone: () => false, progress: () => 0, run: async () => ({ ok: true }) };
    } });
  const ctx = { perceive: () => perceive(bot), record() {} };
  await goal.run(ctx);
  await goal.run(ctx);
  assert.deepEqual(events, ['close', 'chest']);
  assert.equal(perceive(bot).sheltered, true);
  const controller = new AbortController();
  await assert.rejects(goal.run({ ...ctx, signal: controller.signal, record(type) {
    if (type === 'resupply_shelter_wait') controller.abort();
  } }), { code: 'aborted' });
  assert.deepEqual(events, ['close', 'chest']);
  bot.time.timeOfDay = 4000;
  await goal.run(ctx);
  await goal.run(ctx);
  assert.deepEqual(events, ['close', 'chest', 'open', 'gather']);
  assert.equal(perceive(bot).sheltered, false);
  await goal.dispose();
});

test('an unarmed respawn reads a reachable chest from a screened part of a damaged house', async (t) => {
  const house = createStarterHouse({ x: 5, y: 64, z: -13 });
  const door = house.furniture.door.position;
  const chest = house.furniture.chest.position;
  const origin = new Vec3(9.5, 64, -11.5);
  const westGap = new Vec3(5, 64, -9);
  const shell = new Set([...house.blocks.map(({ position }) => position), ...house.foundation]
    .map(({ x, y, z }) => new Vec3(x, y, z).toString()));
  for (const p of [westGap, westGap.offset(0, 1, 0)]) shell.delete(p.toString());
  const cases = [
    { name: 'rock screens the underground skeleton', mob: 'skeleton', at: new Vec3(7.3, 55, -2.58), open: true },
    { name: 'an exposed skeleton has sight through the opening', mob: 'skeleton', at: new Vec3(4.5, 64, -7.8), open: false },
    { name: 'a close creeper still blocks the action', mob: 'creeper', at: new Vec3(9.5, 64, -14.5), open: false },
  ];
  for (const sample of cases) await t.test(sample.name, async () => {
    const underRock = sample.at.y < 64;
    const bot = Object.assign(fakeBot(), { health: 20, food: 20, game: { dimension: 'overworld' },
      entity: { position: origin.clone(), onGround: true }, time: { timeOfDay: 16000 },
      entities: { 4: { id: 4, name: sample.mob, position: sample.at } }, canSeeBlock: () => true });
    bot.blockAt = (p) => {
      if (p.x === door.x && p.z === door.z && (p.y === door.y || p.y === door.y + 1)) {
        return { name: 'birch_door', getProperties: () => ({ half: p.y === door.y ? 'lower' : 'upper',
          open: false, facing: 'north', hinge: 'left' }) };
      }
      if (p.x === chest.x && p.y === chest.y && p.z === chest.z) return { name: 'chest' };
      const solid = shell.has(p.toString()) || underRock && p.y === 62;
      return { name: solid ? 'cobblestone' : 'air', boundingBox: solid ? 'block' : 'empty',
        shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] };
    };
    let opened = 0;
    bot.openContainer = async () => { opened += 1; return { containerItems: () => [], close() {} }; };
    const goal = createOutfitGoal({ bot, recoverAtHome: true, items: [{ key: 'stone_sword', count: 1 }],
      home: { chest, centre: house.interiorCenter, anchor: house.anchor, door }, skills: { takeItems } });
    const events = [];
    await goal.run({ perceive: () => perceive(bot), record: (type, detail) => events.push([type, detail]) });
    assert.equal(opened, Number(sample.open));
    assert.equal(events.find(([type]) => type === 'resupply_chest_read')[1].reason,
      sample.open ? 'chest_empty' : 'unsafe_resupply_food_route');
    assert.ok(bot.entity.position.equals(origin));
    assert.equal(perceive(bot).sheltered, false, 'a successful interaction does not seal a breached house');
    await goal.dispose();
  });
});

test('daylight rearm can cross the north door above a screened archer under live checks', async () => {
  const house = createStarterHouse({ x: 5, y: 64, z: -13 });
  const { door, chest } = house.furniture;
  const doorway = new Vec3(8, 64, -13);
  const threshold = doorway.offset(0, 0, 1);
  const outside = doorway.offset(0, 0, -1);
  const hole = new Vec3(5, 64, -9);
  const shell = new Set([...house.blocks.map(({ position }) => position), ...house.foundation]
    .map(({ x, y, z }) => new Vec3(x, y, z).toString()));
  for (const p of [hole, hole.offset(0, 1, 0)]) shell.delete(p.toString());
  const skeleton = { id: 7, name: 'skeleton', position: new Vec3(7.3, 55, -2.58), width: .6, height: 1.99 };
  const neighbors = (p) => [p.offset(0, 0, -1), p.offset(1, 0, 0), p.offset(-1, 0, 0)];
  const movements = { getNeighbors: neighbors };
  let open = false;
  const bot = Object.assign(fakeBot(), { health: 20, food: 20, game: { dimension: 'overworld' },
    entity: { position: new Vec3(9.5, 64, -11.5), onGround: true }, time: { timeOfDay: 5000 },
    entities: { 7: skeleton }, pathfinder: { movements } });
  bot.blockAt = (p) => {
    if (p.x === doorway.x && p.z === doorway.z && (p.y === doorway.y || p.y === doorway.y + 1)) {
      return { name: 'birch_door', getProperties: () => ({ half: p.y === doorway.y ? 'lower' : 'upper',
        open, facing: 'north', hinge: 'left' }) };
    }
    const solid = shell.has(p.toString()) || p.y === 62 || p.equals(outside.offset(0, -1, 0));
    return { name: solid ? 'cobblestone' : 'air', boundingBox: solid ? 'block' : 'empty',
      shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] };
  };
  bot.activateBlock = async () => { open = !open; };
  const operations = [];
  let replaced = false;
  const goal = createOutfitGoal({ bot, recoverAtHome: true, items: [{ key: 'stone_sword', count: 1 }],
    home: { chest: chest.position, centre: house.interiorCenter, anchor: house.anchor, door: door.position },
    skills: { takeItems: async () => ({ ok: false, reason: 'chest_empty' }) },
    createGather: () => ({ isDone: () => false, progress: () => 0,
      async run(ctx) {
        operations.push('gather');
        if (replaced) {
          skeleton.position = new Vec3(8.5, 64, -17.5);
          await sleep(400, ctx.signal);
          assert.fail('a newly exposed shooter must interrupt the rearm');
        }
        const permitted = (from, to) => movements.getNeighbors(from).some((cell) => cell.equals(to));
        assert.equal(permitted(hole, hole.offset(-1, 0, 0)), false);
        assert.equal(permitted(threshold, doorway), true);
        assert.equal(permitted(doorway, outside), true);
        bot.entity.position = doorway.offset(.5, 0, .5);
        await sleep(120, ctx.signal);
        bot.entity.position = outside.offset(.5, 0, .5);
        await sleep(120, ctx.signal);
        return { ok: true };
      } }),
  });
  const ctx = { perceive: () => perceive(bot), record() {} };
  await goal.run(ctx);
  await goal.run(ctx);
  assert.equal(open, true);
  assert.equal((await goal.run(ctx)).ok, true);
  assert.ok(bot.entity.position.equals(outside.offset(.5, 0, .5)));
  replaced = true;
  assert.equal((await goal.run(ctx)).reason, 'unsafe_resupply_food_route');
  assert.deepEqual(operations, ['gather', 'gather']);
  assert.equal(movements.getNeighbors, neighbors);
  await goal.dispose();
});

test('a grounded unarmed return can descend a screened two-level ridge to the original door', async () => {
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  const { door, chest } = house.furniture;
  const westBreach = new Vec3(0, 64, 1);
  const houseCells = new Set([...house.blocks.map(({ position }) => position), ...house.foundation]
    .map(({ x, y, z }) => new Vec3(x, y, z).toString()));
  for (const cell of [westBreach, westBreach.offset(0, 1, 0)]) houseCells.delete(cell.toString());
  const route = [new Vec3(-1, 66, 1), new Vec3(-1, 66, 0), new Vec3(-1, 66, -1), new Vec3(0, 65, -1),
    new Vec3(1, 65, -1), new Vec3(2, 65, -1), new Vec3(3, 64, -1), new Vec3(3, 64, 0), new Vec3(3, 64, 1)];
  for (const cell of route.slice(0, 7)) houseCells.add(cell.offset(0, -1, 0).toString());
  const archer = { id: 4, name: 'skeleton', position: new Vec3(3.5, 55, 4.5), width: .6, height: 1.99 };
  const bot = Object.assign(fakeBot(), { health: 20, food: 20, game: { dimension: 'overworld' },
    entity: { position: route[0].offset(.5, 0, .5), onGround: true }, time: { timeOfDay: 3000 }, entities: { 4: archer } });
  bot.blockAt = (p) => {
    if (p.x === door.position.x && p.z === door.position.z && [64, 65].includes(p.y)) {
      return { name: 'birch_door', getProperties: () => ({ half: p.y === 64 ? 'lower' : 'upper',
        open: true, facing: 'north', hinge: 'left' }) };
    }
    const solid = houseCells.has(p.toString()) || p.y === 62;
    return { name: solid ? 'cobblestone' : 'air', boundingBox: solid ? 'block' : 'empty',
      shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] };
  };
  const visited = [];
  const goal = createOutfitGoal({ bot, recoverAtHome: true, items: [{ key: 'stone_sword', count: 1 }],
    home: { chest: chest.position, centre: house.interiorCenter, anchor: house.anchor, door: door.position },
    actions: { async goTo(_bot, _ctx, target) {
      const pos = new Vec3(target.x, target.y, target.z);
      visited.push(pos);
      bot.entity.position = pos.offset(.5, 0, .5);
      return { ok: true };
    } },
  });
  const ctx = { perceive: () => perceive(bot), record() {} };
  for (const _step of route.slice(1)) assert.equal((await goal.run(ctx)).ok, true);
  assert.deepEqual(visited, route.slice(1));
  await goal.dispose();
});

test('an armed daylight home return takes a longer dry route when the short search cannot reach the door', async () => {
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  const { door, chest } = house.furniture;
  const shell = new Set([...house.blocks.map(({ position }) => position), ...house.foundation]
    .map(({ x, y, z }) => new Vec3(x, y, z).toString()));
  const route = [new Vec3(16, 64, 3)];
  for (let z = 2; z >= -14; z -= 1) route.push(new Vec3(16, 64, z));
  for (let x = 15; x >= 3; x -= 1) route.push(new Vec3(x, 64, -14));
  for (let z = -13; z <= -1; z += 1) route.push(new Vec3(3, 64, z));
  for (const p of route) shell.add(p.offset(0, -1, 0).toString());
  const bot = Object.assign(fakeBot([{ name: 'stone_sword', count: 1 }]), { health: 20, food: 19,
    game: { dimension: 'overworld' }, time: { timeOfDay: 18000 }, entities: {},
    entity: { position: route[0].offset(.5, 0, .5), onGround: true } });
  bot.blockAt = (p) => {
    if (p.x === door.position.x && p.z === door.position.z && [64, 65].includes(p.y)) {
      return { name: 'oak_door', getProperties: () => ({ half: p.y === 64 ? 'lower' : 'upper',
        open: true, facing: 'south', hinge: 'left' }) };
    }
    if (p.equals(new Vec3(15, 64, 3))) return { name: 'nether_portal', boundingBox: 'empty', shapes: [] };
    const solid = shell.has(p.toString());
    return { name: solid ? 'cobblestone' : 'air', boundingBox: solid ? 'block' : 'empty',
      shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] };
  };
  const visits = [], detours = [];
  const goal = createOutfitGoal({ bot, recoverAtHome: true, items: [{ key: 'food', count: 3 }],
    home: { chest: chest.position, centre: house.interiorCenter, anchor: house.anchor, door: door.position },
    actions: { async goTo(_bot, _ctx, target) {
      const next = new Vec3(target.x, target.y, target.z);
      visits.push(next);
      bot.entity.position = next.offset(.5, 0, .5);
      return { ok: true };
    } } });
  const ctx = { perceive: () => perceive(bot), record(type, data) {
    if (type === 'resupply_home_detour') detours.push(data);
  } };
  assert.equal((await goal.run(ctx)).reason, 'resupply_no_dry_home_route');
  bot.time.timeOfDay = 5000;
  bot.entities[2] = { id: 2, name: 'pillager', position: new Vec3(16.5, 64, -21.5) };
  assert.equal((await goal.run(ctx)).reason, 'resupply_no_dry_home_route');
  delete bot.entities[2];
  for (const _step of route.slice(1)) assert.equal((await goal.run(ctx)).ok, true);
  assert.deepEqual(visits, route.slice(1));
  assert.equal(detours.length, 1);
  assert.equal(detours[0].steps, route.length + 1);
  await goal.dispose();
});

test('home resupply can see a known ripe plot beyond the native section scan', async () => {
  const { OctahedronIterator } = require('prismarine-world').iterators;
  const house = createStarterHouse({ x: -69, y: 65, z: -104 });
  const plot = new Vec3(-81, 62, -94);
  const ripe = plot.offset(0, 1, 0);
  const farther = new Vec3(-90, 62, -94);
  const sectionOf = (p) => new Vec3(Math.floor(p.x / 16), Math.floor(p.y / 16), Math.floor(p.z / 16));
  const bot = Object.assign(fakeBot([{ name: 'stone_sword', count: 1 }]), { health: 7.3, food: 7,
    entity: { position: new Vec3(-64.5, 65, -102.5), onGround: true }, game: { dimension: 'overworld' },
    registry: { blocksByName: { wheat: { id: 1 } } }, time: { timeOfDay: 6149 }, entities: {} });
  const targets = [];
  bot.findBlocks = ({ point, maxDistance }) => {
    const start = sectionOf(point);
    const iter = new OctahedronIterator(start, Math.ceil((maxDistance + 8) / 16));
    for (let cell = start; cell; cell = iter.next()) if (cell.equals(sectionOf(ripe))) return [ripe];
    return [];
  };
  bot.blockAt = (position) => {
    if (position.equals(ripe) || position.equals(farther.offset(0, 1, 0))) return { name: 'wheat', getProperties: () => ({ age: 7 }) };
    if (position.equals(plot) || position.equals(farther)) return { name: 'farmland' };
    return { name: 'air', boundingBox: 'empty', shapes: [] };
  };
  const { chest } = house.furniture;
  const goal = createOutfitGoal({ bot, recoverAtHome: true, items: [{ key: 'food', count: 3 }],
    farmPlots: [farther, plot], home: { chest: chest.position, centre: house.interiorCenter, anchor: house.anchor },
    skills: { takeItems: async () => ({ ok: false, reason: 'chest_empty' }) } });
  const controller = new AbortController();
  const ctx = { signal: controller.signal, perceive: () => perceive(bot), record(type, fields) {
    if (type === 'resupply_food_target') { targets.push(fields.position); controller.abort('test_proved_target'); }
  } };
  await goal.run(ctx);
  await assert.rejects(goal.run(ctx), { code: 'aborted' });
  assert.deepEqual(targets, [ripe]);
  await goal.dispose();
});

test('a destroyed doorstep uses supported covered interior and refuses missing floor or visible shooter', async () => {
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  const door = new Vec3(3, 64, 0);
  const start = new Vec3(1, 64, -1);
  const wallBreach = new Vec3(1, 64, 0);
  const inside = new Vec3(1, 64, 1);
  const chamber = [...house.blocks.map(({ position }) => position), ...house.foundation];
  const world = new Set(chamber.map(({ x, y, z }) => new Vec3(x, y, z).toString()));
  for (const breach of [door.offset(0, -1, 0), door.offset(0, -1, -1), wallBreach, wallBreach.offset(0, 1, 0)]) {
    world.delete(breach.toString());
  }
  world.add(start.offset(0, -1, 0).toString());
  const items = [];
  const bot = Object.assign(fakeBot(items), { health: 2.67, food: 20, game: { dimension: 'overworld' },
    entity: { position: start.offset(.5, 0, .5), onGround: true }, entities: {}, time: { timeOfDay: 15000 } });
  bot.blockAt = (p) => {
    const solid = world.has(p.floored().toString());
    return { name: solid ? 'cobblestone' : 'air', boundingBox: solid ? 'block' : 'empty',
      shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] };
  };
  const path = [];
  let genericReturns = 0;
  let spawnShooter = false;
  const goal = createOutfitGoal({ bot, items: [{ key: 'stone_sword', count: 1 }], recoverAtHome: true,
    home: { chest: house.furniture.chest.position, centre: house.interiorCenter, anchor: house.anchor, door },
    actions: {
      goNear: async (_bot, ctx, destination) => {
        assert.equal(bot.health, 20);
        assert.equal(bot.time.timeOfDay, 5000);
        genericReturns += 1;
        if (spawnShooter) {
          bot.entities[7] = { id: 7, name: 'skeleton', position: start.offset(.5, 0, -4.5) };
          await sleep(250, ctx.signal);
          assert.fail('must stop when a hostile enters the return route');
        }
        bot.entity.position = destination;
        return { ok: true };
      },
      digBlock: async () => assert.fail('must not excavate the damaged foundation'),
      goTo: async (_bot, _ctx, destination) => {
        const next = new Vec3(destination.x, destination.y, destination.z);
        path.push(next);
        bot.entity.position = next.offset(.5, 0, .5);
        return { ok: true };
      },
    }, skills: { takeItems: async () => ({ ok: false, reason: 'chest_empty' }) } });
  const events = [];
  const ctx = { perceive: () => perceive(bot), record(type, detail) { events.push([type, detail]); } };
  const abortOn = async (type) => {
    const controller = new AbortController();
    await assert.rejects(goal.run({ ...ctx, signal: controller.signal, record(name, detail) {
      ctx.record(name, detail);
      if (name === type) controller.abort();
    } }), { code: 'aborted' });
  };
  world.delete(wallBreach.offset(0, -1, 0).toString());
  await abortOn('resupply_home_approach_wait');
  assert.equal(events.at(-1)[1].reason, 'resupply_damaged_shelter_no_safe_route');
  world.add(wallBreach.offset(0, -1, 0).toString());
  assert.equal((await goal.run(ctx)).ok, true);
  assert.equal((await goal.run(ctx)).ok, true);
  assert.deepEqual(path, [wallBreach, inside]);
  await goal.run(ctx);
  await abortOn('resupply_shelter_wait');
  assert.equal(events.at(-1)[1].reason, 'covered_room_until_safe');
  assert.equal(perceive(bot).sheltered, true);
  bot.entities[7] = { id: 7, name: 'skeleton', position: start.offset(.5, 0, -4.5) };
  await sleep(110);
  assert.equal(perceive(bot).sheltered, false, 'an exposed line through the breach invalidates cover');
  bot.entities[7].position = new Vec3(-4.5, 64, 2.5);
  await sleep(110);
  assert.equal(perceive(bot).sheltered, true, 'the intact side wall occludes the shooter');
  bot.entity.position = wallBreach.offset(.5, 0, .5);
  assert.equal(perceive(bot).sheltered, false, 'roof over a wall opening is insufficient');
  bot.entity.position = start.offset(.5, 0, .5);
  world.delete(wallBreach.offset(0, -1, 0).toString());
  delete bot.entities[7];
  items.push({ name: 'stone_sword', count: 1 });
  bot.health = 20;
  bot.time.timeOfDay = 5000;
  spawnShooter = true;
  assert.equal((await goal.run(ctx)).reason, 'unsafe_resupply_food_route');
  assert.ok(bot.entity.position.floored().equals(start));
  delete bot.entities[7];
  spawnShooter = false;
  assert.equal((await goal.run(ctx)).ok, true);
  assert.equal(genericReturns, 2);
  assert.equal(goal.isDone(perceive(bot)), true);
  await goal.dispose();
});

test('critical resupply returns from spent wheat to closed shelter and leaves only for bounded, covered food', async () => {
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  const door = house.furniture.door.position;
  const crop = new Vec3(-12, 63, 4);
  const distantCrop = new Vec3(-24, 63, 4);
  const inside = new Vec3(3.5, 64, 3.5);
  const bot = Object.assign(fakeBot(), { health: 2.67, food: 10, game: { dimension: 'overworld' },
    entity: { position: inside }, entities: {}, time: { timeOfDay: 3000 }, registry: { blocksByName: { wheat: { id: 1 } } } });
  const operations = [];
  const records = [];
  let open = true;
  let age = 1;
  let blocked = false;
  bot.world = { raycast: () => blocked ? { name: 'stone' } : null };
  bot.findBlocks = () => [distantCrop, crop];
  bot.blockAt = (p) => {
    if (p.x === door.x && p.z === door.z && (p.y === door.y || p.y === door.y + 1)) {
      return { name: 'oak_door', getProperties: () => ({ half: p.y === door.y ? 'lower' : 'upper',
        open, facing: 'north', hinge: 'left' }) };
    }
    if (p.equals(crop) || p.equals(distantCrop)) return { name: 'wheat', getProperties: () => ({ age: p.equals(crop) ? age : 7 }) };
    if (p.equals(crop.offset(0, -1, 0)) || p.equals(distantCrop.offset(0, -1, 0))) return { name: 'farmland' };
    return { name: 'cobblestone', shapes: [[0, 0, 0, 1, 1, 1]] };
  };
  bot.activateBlock = async () => { open = !open; operations.push(open ? 'open' : 'close'); };
  const goal = createOutfitGoal({ bot, items: [{ key: 'food', count: 3 }], recoverAtHome: true,
    home: { chest: house.furniture.chest.position, centre: house.interiorCenter, anchor: house.anchor, door },
    actions: { withinReach: () => true, goNear: async (_bot, _ctx, p) => {
      bot.entity.position = p;
      operations.push('walk-home');
      return { ok: true };
    } },
    skills: { takeItems: async () => ({ ok: false, reason: 'chest_empty' }),
      huntOne: async () => assert.fail('a distant animal must not trigger a hunt'),
      explore: async () => assert.fail('a critical bot must not explore for food') } });
  let controller = new AbortController();
  const ctx = { perceive: () => perceive(bot), get signal() { return controller.signal; }, record: (type, detail) => {
    records.push([type, detail]);
    if (type === 'resupply_shelter_wait' || type === 'resupply_food_target') controller.abort();
  } };
  await goal.run(ctx);
  bot.entity.position = crop;
  bot.entities[1] = { id: 1, name: 'pig', position: distantCrop };
  await goal.run(ctx);
  await goal.run(ctx);
  await assert.rejects(goal.run(ctx), { code: 'aborted' });
  assert.deepEqual(operations, ['walk-home', 'close']);
  assert.deepEqual(records.find(([type]) => type === 'resupply_food_wait')[1], { reason: 'awaiting_crop_regrowth', growing: 1 });
  assert.equal(perceive(bot).sheltered, true);

  controller = new AbortController();
  age = 7;
  // It can see the doorway from 12 blocks, beyond the original 8-block check.
  bot.entities[2] = { id: 2, name: 'skeleton', position: new Vec3(3.5, 64, -13.5) };
  await assert.rejects(goal.run(ctx), { code: 'aborted' });
  assert.deepEqual(operations, ['walk-home', 'close']);
  assert.equal(records.at(-1)[1].reason, 'nearby_hostile');

  controller = new AbortController();
  blocked = true;
  // A nominal ray obstruction is not enough to leave shelter this close to a shooter.
  const nearbyWait = { ...ctx, signal: controller.signal };
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(goal.run(nearbyWait), { code: 'aborted' });
  assert.equal(operations.at(-1), 'close');
  delete bot.entities[2];
  controller = new AbortController();
  await goal.run(ctx);
  await assert.rejects(goal.run(ctx), { code: 'aborted' });
  assert.equal(operations.at(-1), 'open');
  assert.deepEqual(records.at(-1), ['resupply_food_target', { kind: 'wheat', position: crop }]);
  await goal.dispose();
});

test('critical bread return rejects a known shooter in planning and cancels for a newly observed one', async () => {
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  const inside = new Vec3(3.5, 64, 3.5);
  const farm = new Vec3(-10.5, 64, 3.5);
  const risk = { x: -5, y: 64, z: 3 };
  const bypass = { x: -9, y: 64, z: 9 };
  const shooter = { id: 42, name: 'skeleton', position: new Vec3(-4.5, 64, -11.5) };
  const items = [];
  const bot = Object.assign(fakeBot(items), { health: 2.67, food: 10, game: { dimension: 'overworld' },
    entity: { position: inside }, entities: {}, time: { timeOfDay: 3000 },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }), world: { raycast: () => ({ name: 'stone' }) } });
  const neighbors = () => [risk, bypass];
  bot.pathfinder = { movements: { getNeighbors: neighbors } };
  let walk = 0;
  const goal = createOutfitGoal({ bot, items: [{ key: 'food', count: 3 }], recoverAtHome: true,
    home: { chest: house.furniture.chest.position, centre: house.interiorCenter, anchor: house.anchor,
      stations: { crafting_table: house.furniture.crafting_table.position } },
    actions: { goNear: async (_bot, ctx) => {
      walk += 1;
      const from = walk === 1 ? { x: -6, y: 64, z: 3 } : { x: -10, y: 64, z: 3 };
      if (walk === 1) {
        assert.deepEqual(bot.pathfinder.movements.getNeighbors(from), [bypass]);
        return { ok: false, reason: 'NoPath' };
      }
      assert.deepEqual(bot.pathfinder.movements.getNeighbors(from), [risk, bypass]);
      bot.entity.position = new Vec3(-4.5, 64, 3.5);
      bot.entities[42] = shooter;
      await sleep(1000, ctx.signal);
      assert.fail('the unguarded inbound action should not finish');
    } }, skills: { takeItems: async () => ({ ok: false, reason: 'chest_empty' }) } });
  const records = [];
  const ctx = { perceive: () => perceive(bot), record: (type, detail) => records.push([type, detail]) };
  await goal.run(ctx);
  items.push({ name: 'wheat', count: 3 });
  bot.entity.position = farm;
  bot.entities[42] = shooter;
  assert.deepEqual(await goal.run(ctx), { ok: true, waited: true, reason: 'unsafe_resupply_food_route' });
  bot.entities = {};
  assert.deepEqual(await goal.run(ctx), { ok: true, waited: true, reason: 'unsafe_resupply_food_route' });
  assert.deepEqual(records.at(-1), ['resupply_route_interrupted', { leg: 'return_for_bread', position: new Vec3(-5, 64, 3) }]);
  assert.equal(bot.pathfinder.movements.getNeighbors, neighbors);
  await goal.dispose();
});

for (const { key, slot, existing, target, ingredients } of [
  { key: 'iron_helmet', slot: 5, existing: 0, target: 1, ingredients: { iron_ingot: 5 } },
  { key: 'iron_helmet', slot: 5, existing: 1, target: 2, ingredients: { iron_ingot: 5 } },
  { key: 'shield', slot: 45, existing: 1, target: 2, ingredients: { iron_ingot: 1, oak_planks: 6 } },
]) {
  test(`outfit real child gathers ${target} ${key} with ${existing} already worn without double-counting or depositing equipment`, async () => {
    const bag = { ...ingredients };
    const slots = [];
    if (existing) slots[slot] = { name: key, count: existing };
    const bot = { health: 20, food: 20, game: { dimension: 'overworld' }, entities: {},
      entity: { position: new Vec3(0.5, 64, 2.5) }, on() {}, removeListener() {},
      inventory: { slots, items: () => Object.entries(bag).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })), emptySlotCount: () => 30 },
      blockAt: (p) => ({ name: p.x === 0 && p.y === 64 && p.z === 0 ? 'chest'
        : p.x === 1 && p.y === 64 && p.z === 0 ? 'crafting_table' : 'air' }) };
    const equippedHome = { ...home, stations: { crafting_table: { x: 1, y: 64, z: 0 } } };
    let crafted = 0;
    let gatherOptions;
    const skills = {
      storeInChest: async (_bot, _ctx, { wants }) => {
        assert.equal(wants.length, 0, 'body equipment is never offered for chest storage');
        return { ok: true, contents: {} };
      },
      craft: async (_bot, _ctx, { item }) => {
        assert.equal(item, key);
        crafted += 1;
        for (const [name, count] of Object.entries(ingredients)) bag[name] -= count;
        // The permanent wear_armor behavior may equip the first piece
        // immediately; a same-tier spare stays in the main inventory.
        if (!slots[slot]) slots[slot] = { name: key, count: 1 };
        else bag[key] = (bag[key] || 0) + 1;
        return { ok: true };
      },
      takeItems: async () => { assert.fail('the same reserved equipment cannot complete the child and trigger an empty take'); },
    };
    const goal = createOutfitGoal({ bot, home: equippedHome, items: [{ key, count: target }], skills,
      createGather: (options) => { gatherOptions = options; return createGatherMaterialsGoal({ ...options, skills }); } });
    const ctx = { perceive: () => perceive(bot), record() {}, signal: new AbortController().signal };
    await goal.run(ctx); // inspect the empty chest
    assert.equal(gatherOptions.countWorn, true);
    assert.equal(goal.memory.gather.isDone(perceive(bot)), false, 'pre-existing worn items were reserved by the parent');
    await goal.run(ctx); // craft one new item
    if (!existing) assert.equal(goal.memory.gather.isDone(perceive(bot)), true, 'new auto-equipped armour is delivered for outfit');
    await goal.run(ctx); // release child and finish the kit
    assert.equal(crafted, 1);
    assert.equal(goal.isDone(perceive(bot)), true);
    assert.equal(perceive(bot).inventory[key], target);
    assert.equal(slots[slot].count, 1);
  });
}

test('critical home arrival walks the saved ledge and crosses the door from the supported step', async () => {
  const house = createStarterHouse({ x: -68, y: 72, z: -35 });
  const door = new Vec3(-65, 72, -35);
  const ledge = new Vec3(-70, 70, -33);
  const route = [ledge, new Vec3(-70, 71, -34), new Vec3(-69, 72, -34), new Vec3(-69, 72, -35),
    new Vec3(-69, 72, -36), new Vec3(-68, 72, -36), new Vec3(-67, 72, -36), new Vec3(-66, 72, -36),
    new Vec3(-65, 72, -36), door, new Vec3(-65, 72, -34)];
  const floors = route.map((p) => p.offset(0, -1, 0));
  const bot = Object.assign(fakeBot(), { health: 2.67, food: 0, game: { dimension: 'overworld' },
    entity: { position: ledge.offset(.5, 0, .5), onGround: true }, entities: {}, time: { timeOfDay: 15000 } });
  let open = false;
  let obstruction = null;
  let flood = false;
  let protect = false;
  let portal = null;
  bot.canDigBlock = (block) => block.diggable;
  bot.companionProtectBlock = (block) => protect && block.position.equals(route[1]);
  bot.blockAt = (p) => {
    if (portal && p.equals(portal)) return { name: 'nether_portal', boundingBox: 'empty', shapes: [] };
    if (p.equals(door) || p.equals(door.offset(0, 1, 0))) {
      return { name: 'oak_door', boundingBox: 'block', getProperties: () => ({ half: p.y === door.y ? 'lower' : 'upper',
        open, facing: 'south', hinge: 'left' }) };
    }
    if (flood && p.equals(route[1].offset(-1, 0, 0))) return { name: 'water', boundingBox: 'empty', shapes: [] };
    const needsCut = obstruction?.equals(p);
    const solid = needsCut || floors.some((floor) => p.equals(floor))
      || house.blocks.some(({ position }) => p.x === position.x && p.y === position.y && p.z === position.z)
      || house.foundation.some((position) => p.x === position.x && p.y === position.y && p.z === position.z);
    return { name: solid ? 'grass_block' : 'air', boundingBox: solid ? 'block' : 'empty', position: p, diggable: solid,
      shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] };
  };
  const operations = [];
  const nativeNeighbors = () => [...route.map(({ x, y, z }) => ({ x, y, z })), { x: -57, y: 61, z: -38 }];
  bot.pathfinder = { movements: { getNeighbors: nativeNeighbors } };
  bot.activateBlock = async () => { open = !open; operations.push(open ? 'open' : 'close'); };
  let moves = 0;
  const goal = createOutfitGoal({ bot, items: [{ key: 'food', count: 3 }], recoverAtHome: true,
    home: { chest: house.furniture.chest.position, centre: house.interiorCenter, anchor: house.anchor, door },
    actions: { withinReach: () => true, goNear: async () => assert.fail('unconstrained native arrival is not allowed'),
      digBlock: async (_bot, _ctx, block) => {
        assert.ok(block.position.equals(route[1]));
        assert.ok(obstruction.equals(block.position));
        operations.push('cut');
        obstruction = null;
        return { ok: true };
      },
      goTo: async (_bot, _ctx, destination, options) => {
        const next = route[moves + 1];
        assert.equal(options.retryNoProgress, false);
        assert.ok(destination.isEnd(next));
        assert.deepEqual(bot.pathfinder.movements.getNeighbors(route[moves]).map((move) => new Vec3(move.x, move.y, move.z)), [next]);
        bot.entity.position = next.offset(.5, 0, .5);
        moves += 1;
        return { ok: true };
      } }, skills: { takeItems: async () => { operations.push('chest'); return { ok: false, reason: 'chest_empty' }; } } });
  const events = [];
  const ctx = { perceive: () => perceive(bot), record: (type, detail) => events.push([type, detail]) };
  assert.equal(goal.ownsRouteRecovery(), true);
  const expectBlocked = async (reason, name, position) => {
    if (name) bot.entities[22] = { id: 22, name, position };
    else delete bot.entities[22];
    const controller = new AbortController();
    await assert.rejects(goal.run({ ...ctx, signal: controller.signal, record: (type, detail) => {
      ctx.record(type, detail);
      if (type === 'resupply_home_approach_wait') controller.abort();
    } }), { code: 'aborted' });
    assert.equal(events.at(-1)[1].reason, reason);
    assert.equal(moves, 0);
    assert.deepEqual(operations, []);
  };
  await expectBlocked('resupply_home_route_unsafe', 'zombie', new Vec3(-68.5, 71, -34.5));
  await expectBlocked('resupply_home_route_unsafe', 'creeper', new Vec3(-61.2256, 67, -37.502));
  await expectBlocked('resupply_home_route_unsafe', 'skeleton', new Vec3(-57.5, 72, -36.5));
  for (const dy of [0, 1, 2]) {
    portal = route[1].offset(0, dy, 0);
    await expectBlocked('resupply_no_dry_home_route');
  }
  portal = null;
  // Both unmodified R7/R8 worlds had grass on the first foothold. Its
  // removal alone must restore the complete physical route to the door.
  obstruction = route[1];
  flood = true;
  await expectBlocked('resupply_no_dry_home_route');
  flood = false;
  protect = true;
  await expectBlocked('resupply_no_dry_home_route');
  protect = false;
  await expectBlocked('resupply_home_cut_unsafe', 'skeleton', new Vec3(-54.503, 73, -30.258));
  // The preserved zombie started east/downhill. A six-block separation at
  // the critical first leg must not preclude a physically separated route.
  bot.entities[22] = { id: 22, name: 'zombie', position: new Vec3(-65.6271, 67, -35.9979) };
  for (let n = 0; n < 14; n += 1) assert.equal((await goal.run(ctx)).ok, true);
  assert.equal(moves, 10);
  assert.deepEqual(operations, ['cut', 'open', 'close', 'chest']);
  assert.deepEqual(events.filter(([type]) => type === 'resupply_home_cut').map(([, d]) => [d.position, d.confirmed]), [[route[1], true]]);
  assert.deepEqual(events.filter(([type]) => type === 'resupply_home_step').map(([, d]) => d.to), route.slice(1));
  assert.equal(bot.pathfinder.movements.getNeighbors, nativeNeighbors);
  bot.health = 20;
  assert.equal(goal.ownsRouteRecovery(), false);
  await goal.dispose();
});

async function checkFarmlandExit(rise) {
  const house = createStarterHouse({ x: -68, y: 72, z: -35 });
  const door = new Vec3(-65, 72, -35);
  const plot = new Vec3(-81, 70, -34);
  const ground = new Vec3(-81, 71 + rise, -33);
  const route = [ground, ...Array.from({ length: 11 }, (_, i) => ground.offset(i + 1, 0, 0)),
    new Vec3(-69, 72, -33), new Vec3(-69, 72, -34), new Vec3(-69, 72, -35), new Vec3(-69, 72, -36),
    ...Array.from({ length: 4 }, (_, i) => new Vec3(-68 + i, 72, -36))];
  const base = new Set(route.map((p) => p.offset(0, -1, 0).toString()));
  const bot = Object.assign(fakeBot([{ name: 'wheat', count: 3 }]), { health: 2.67, food: 5, game: { dimension: 'overworld' },
    entity: { position: plot.offset(.5, 15 / 16, .5), onGround: true }, entities: {}, time: { timeOfDay: 5000 } });
  let material = 'farmland';
  let wet = false;
  let lowCeiling = false;
  bot.blockAt = (p) => {
    if (p.equals(door) || p.equals(door.offset(0, 1, 0))) {
      return { name: 'oak_door', boundingBox: 'block', getProperties: () => ({ half: p.y === door.y ? 'lower' : 'upper',
        open: false, facing: 'south', hinge: 'left' }) };
    }
    if (p.equals(plot)) return { name: material, boundingBox: 'block', shapes: [[0, 0, 0, 1, 15 / 16, 1]] };
    if (wet && p.equals(ground)) return { name: 'water', boundingBox: 'empty', shapes: [] };
    const solid = base.has(p.toString()) || lowCeiling && p.equals(plot.offset(0, 3, 0));
    return { name: solid ? 'grass_block' : 'air', boundingBox: solid ? 'block' : 'empty',
      shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] };
  };
  const logicalOrigin = plot.offset(0, 1, 0);
  const nativeNeighbors = () => [ground, ground.offset(1, 0, 1), ground.offset(-1, -1, 0)];
  bot.pathfinder = { movements: { getNeighbors: nativeNeighbors } };
  let steps = 0;
  const goal = createOutfitGoal({ bot, items: [{ key: 'food', count: 3 }], recoverAtHome: true,
    home: { chest: house.furniture.chest.position, centre: house.interiorCenter, anchor: house.anchor, door },
    actions: {
      goTo: async (_bot, _ctx, destination, options) => {
        assert.equal(options.retryNoProgress, false);
        assert.ok(destination.isEnd(ground));
        assert.deepEqual(bot.pathfinder.movements.getNeighbors(logicalOrigin), [ground]);
        bot.entity.position = ground.offset(.5, 0, .5);
        steps++;
        return { ok: true };
      },
      goNear: async () => assert.fail('unexpected generic movement'),
      digBlock: async () => assert.fail('must preserve farmland'),
    } });
  const events = [];
  const ctx = { perceive: () => perceive(bot), record: (type, detail) => events.push([type, detail]) };
  const expectWait = async () => {
    const controller = new AbortController();
    await assert.rejects(goal.run({ ...ctx, signal: controller.signal, record: (type, detail) => {
      ctx.record(type, detail);
      if (type === 'resupply_home_approach_wait') controller.abort();
    } }), { code: 'aborted' });
    assert.equal(steps, 0);
  };
  material = 'dirt_path';
  await expectWait();
  material = 'farmland';
  wet = true;
  await expectWait();
  wet = false;
  if (rise) {
    lowCeiling = true;
    await expectWait();
    lowCeiling = false;
  }
  assert.equal((await goal.run(ctx)).ok, true);
  assert.equal(steps, 1);
  assert.deepEqual(events.at(-1), ['resupply_home_step', { from: plot, to: ground, partialFloor: 'farmland' }]);
  assert.equal(bot.pathfinder.movements.getNeighbors, nativeNeighbors);
  await goal.dispose();
}

test('critical bread return can leave observed 15/16-height farmland for a dry cardinal step', () => checkFarmlandExit(0));

test('critical bread return can jump from observed farmland onto a full bank with overhead clearance', () => checkFarmlandExit(1));

test('guarded bread return follows level farmland to a dry bank without jumping on crops', async () => {
  const plot = new Vec3(-113, 62, -180);
  const otherPlot = plot.offset(1, 0, 0);
  const logicalOther = otherPlot.offset(0, 1, 0);
  const bank = logicalOther.offset(1, 0, 0);
  const house = createStarterHouse({ x: -105, y: 64, z: -182 });
  const door = new Vec3(-102, 64, -182);
  const path = [bank, ...Array.from({ length: 5 }, (_, i) => bank.offset(i + 1, 0, 0)),
    new Vec3(-106, 64, -181), new Vec3(-106, 64, -182), new Vec3(-106, 64, -183),
    ...Array.from({ length: 4 }, (_, i) => new Vec3(-105 + i, 64, -183))];
  const support = new Set(path.map((p) => p.offset(0, -1, 0).toString()));
  const farmland = { name: 'farmland', boundingBox: 'block', shapes: [[0, 0, 0, 1, 15 / 16, 1]] };
  const air = { name: 'air', boundingBox: 'empty', shapes: [] };
  const stone = { name: 'grass_block', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
  const bot = Object.assign(fakeBot([{ name: 'wheat', count: 3 }]), { health: 2.67, food: 5, game: { dimension: 'overworld' },
    entity: { position: plot.offset(.5, 15 / 16, .5), onGround: true }, entities: {}, time: { timeOfDay: 5000 } });
  let flood = true;
  bot.blockAt = (p) => {
    if (p.equals(plot) || p.equals(otherPlot)) return farmland;
    if (p.equals(logicalOther)) return { ...air, name: flood ? 'water' : 'wheat' };
    if (p.equals(door) || p.equals(door.offset(0, 1, 0))) {
      return { name: 'oak_door', boundingBox: 'block', getProperties: () => ({ half: p.y === door.y ? 'lower' : 'upper',
        open: false, facing: 'south', hinge: 'left' }) };
    }
    return support.has(p.toString()) ? stone : air;
  };
  const logicalPlot = plot.offset(0, 1, 0);
  const nativeNeighbors = (p) => p.equals(logicalPlot)
    ? [logicalOther, logicalOther.offset(0, 1, 0), bank] : [bank, logicalPlot];
  const movement = { getNeighbors: nativeNeighbors, allowSprinting: true };
  bot.pathfinder = { movements: movement };
  const moves = [];
  const goal = createOutfitGoal({ bot, items: [{ key: 'food', count: 3 }], recoverAtHome: true,
    home: { chest: house.furniture.chest.position, centre: house.interiorCenter, anchor: house.anchor, door },
    actions: {
      goTo: async (_bot, _ctx, target, { arrived }) => {
        if (!moves.length) {
          assert.ok(target.isEnd(logicalOther));
          assert.deepEqual(movement.getNeighbors(logicalPlot), [logicalOther]);
          assert.equal(movement.allowSprinting, false);
          assert.equal(arrived(), false);
          bot.entity.position = otherPlot.offset(.5, 15 / 16, .5);
          assert.equal(arrived(), true);
          moves.push(logicalOther);
        } else {
          assert.ok(target.isEnd(bank));
          assert.equal(movement.allowSprinting, true);
          bot.entity.position = bank.offset(.5, 0, .5);
          moves.push(bank);
        }
        return { ok: true };
      },
      goNear: async () => assert.fail('unexpected generic movement'),
      digBlock: async () => assert.fail('must preserve farmland'),
    } });
  const abort = new AbortController();
  const ctx = { perceive: () => perceive(bot), record() {} };
  await assert.rejects(goal.run({ ...ctx, signal: abort.signal, record(type, { reason }) {
    if (type === 'resupply_home_approach_wait') {
      assert.equal(reason, 'resupply_no_dry_home_route');
      abort.abort();
    }
  } }), { code: 'aborted' });
  assert.deepEqual(moves, []);
  flood = false;
  assert.equal((await goal.run(ctx)).ok, true);
  assert.equal((await goal.run(ctx)).ok, true);
  assert.deepEqual(moves, [logicalOther, bank]);
  assert.equal(movement.allowSprinting, true);
  assert.equal(movement.getNeighbors, nativeNeighbors);
  await goal.dispose();
});

test('critical resupply steps inward only while a continuous roof separates the doorway from a phantom', async () => {
  const house = createStarterHouse({ x: -68, y: 72, z: -35 });
  const door = new Vec3(-65, 72, -35);
  const interior = door.offset(0, 0, 1);
  const phantomRoof = new Vec3(-66, 74, -34);
  const start = new Vec3(-64.49999780768488, 72, -34.240824418395114);
  const phantom = { id: 638, name: 'phantom', position: new Vec3(-65.82064211533519, 75, -33.60018374945365), width: .9, height: .5 };
  const bot = Object.assign(fakeBot(), { health: 2.67, food: 0, game: { dimension: 'overworld' },
    entity: { position: start, onGround: true, width: .6 }, entities: { [phantom.id]: phantom }, time: { timeOfDay: 16900 } });
  const building = new Set([...house.blocks.map((block) => block.position), ...house.foundation]
    .map(({ x, y, z }) => new Vec3(x, y, z).toString()));
  let open = true;
  let roofBreach = false;
  let movePhantomWhileWalking = false;
  bot.blockAt = (p) => {
    if (p.equals(door) || p.equals(door.offset(0, 1, 0))) {
      return { name: 'oak_door', boundingBox: 'block', getProperties: () => ({ half: p.y === door.y ? 'lower' : 'upper',
        open, facing: 'south', hinge: 'left' }) };
    }
    const solid = building.has(p.toString()) && !(roofBreach && p.equals(phantomRoof));
    return { name: solid ? 'oak_planks' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] };
  };
  bot.activateBlock = async () => { open = !open; };
  let attempts = 0;
  const goal = createOutfitGoal({ bot, items: [{ key: 'food', count: 3 }], recoverAtHome: true,
    home: { chest: house.furniture.chest.position, centre: house.interiorCenter, anchor: house.anchor, door },
    actions: { withinReach: () => true,
      goTo: async (_bot, ctx, destination) => {
        attempts++;
        assert.ok(destination.isEnd(interior));
        if (movePhantomWhileWalking) {
          phantom.position = phantom.position.offset(0, -.1, 0);
          await sleep(300, ctx.signal);
          assert.fail('inward route continued after the roof no longer separated the phantom');
        }
        bot.entity.position = interior.offset(.5, 0, .5);
        return { ok: true };
      }, goNear: async () => assert.fail('unexpected generic movement') } });
  const events = [];
  const ctx = { perceive: () => perceive(bot), record: (type, detail) => events.push([type, detail]) };
  const expectWait = async () => {
    const controller = new AbortController();
    await assert.rejects(goal.run({ ...ctx, signal: controller.signal, record: (type, detail) => {
      ctx.record(type, detail);
      if (type === 'resupply_home_approach_wait') controller.abort();
    } }), { code: 'aborted' });
    assert.equal(attempts, 0);
  };
  roofBreach = true;
  await expectWait();
  roofBreach = false;
  await sleep(110);
  const observed = phantom.position;
  phantom.position = new Vec3(-65.82, 74.9, -33.60);
  await expectWait();
  phantom.position = new Vec3(-67.8, 75, -33.5);
  await expectWait();
  phantom.position = observed;
  bot.entities[686] = { id: 686, name: 'skeleton', position: new Vec3(-64.5, 72, -28) };
  await expectWait();
  delete bot.entities[686];
  movePhantomWhileWalking = true;
  assert.equal((await goal.run(ctx)).reason, 'unsafe_resupply_food_route');
  assert.ok(bot.entity.position.equals(start));
  movePhantomWhileWalking = false;
  phantom.position = observed;
  assert.equal((await goal.run(ctx)).ok, true);
  assert.equal(attempts, 2);
  assert.ok(bot.entity.position.floored().equals(interior));
  assert.equal((await goal.run(ctx)).ok, true);
  assert.equal(open, false);
  await goal.dispose();
});

test('expedition stock uses the home furnace and only counts food that can be eaten safely', async () => {
  const furnace = { x: 3, y: 64, z: 3 };
  const bag = { chicken: 3 };
  const bot = Object.assign(fakeBot(), { health: 20, food: 20, game: { dimension: 'overworld' },
    entity: { position: new Vec3(2.5, 64, 2.5), onGround: true }, blockAt: () => null });
  const goal = createOutfitGoal({ bot, home: { ...home, stations: { furnace } }, items: [{ key: 'food', count: 3 }],
    expeditionFood: true, skills: {
      smelt: async (_bot, _ctx, options) => {
        assert.equal(options.input, 'chicken');
        assert.equal(options.count, 3);
        assert.equal(options.furnacePosition, furnace);
        delete bag.chicken;
        bag.cooked_chicken = 3;
        return { ok: true, taken: 3 };
      },
    } });
  const state = () => ({ position: bot.entity.position, inventory: { ...bag }, health: bot.health, food: bot.food });
  assert.equal(goal.isDone(state()), false);
  assert.equal(goal.expeditionStocking(state()), true);
  const events = [];
  assert.deepEqual(await goal.run({ perceive: state, record: (type, data) => events.push({ type, ...data }) }), { ok: true, taken: 3 });
  assert.deepEqual(events, [{ type: 'expedition_food_cook', input: 'chicken', ok: true, taken: 3 }]);
  assert.equal(goal.isDone(state()), true);
});

test('expedition stock rejects deep and distant animals and leaves native movement restored', async () => {
  const { createStockFoodGoal } = require('../core/goals/stockFood');
  const dry = { name: 'grass_block', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
  const air = { name: 'air', boundingBox: 'empty', shapes: [] };
  const originalNeighbors = () => [new Vec3(3, 64, 2), new Vec3(55, 64, 2), new Vec3(3, 40, 2), new Vec3(4, 63, 2)];
  const movements = { canDig: true, allowParkour: true, scafoldingBlocks: [1], getNeighbors: originalNeighbors };
  const pig = (x, y, z) => ({ name: 'pig', position: new Vec3(x, y, z), isValid: true });
  const bot = Object.assign(fakeBot(), { game: { dimension: 'overworld' }, pathfinder: { movements },
    entity: { position: new Vec3(2.5, 64, 2.5), onGround: true }, blockAt: (p) => {
      if (p.x === 4 && p.y === 63) return { ...air, name: 'water' };
      return p.y === 63 ? dry : air;
    } });
  const goal = createStockFoodGoal({ bot, target: 12, expeditionHome: home,
    actions: { underground: () => false }, skills: {
      takeItems: async () => ({ ok: false, reason: 'chest_empty' }),
      huntOne: async (_bot, _ctx, { accept, radius, dropMatch }) => {
        assert.equal(radius, 48);
        assert.equal(accept(pig(13, 64, 6)), true);
        assert.equal(accept(pig(13, 40, 6)), false);
        assert.equal(accept(pig(55, 64, 6)), false);
        assert.equal(dropMatch('chicken'), true, 'take raw chicken to the furnace');
        assert.equal(dropMatch('rotten_flesh'), false);
        assert.equal(movements.canDig, false);
        assert.equal(movements.allowParkour, false);
        assert.deepEqual(movements.scafoldingBlocks, []);
        assert.deepEqual(movements.getNeighbors(new Vec3(2, 64, 2)), [new Vec3(3, 64, 2)]);
        return { ok: true, gained: 2 };
      },
    } });
  const ctx = { perceive: () => ({ inventory: {}, health: 20, food: 20, isDay: true }), record() {} };
  assert.deepEqual(await goal.run(ctx), { ok: true });
  assert.deepEqual(await goal.run(ctx), { ok: true, gained: 2 });
  assert.equal(movements.canDig, true);
  assert.equal(movements.getNeighbors, originalNeighbors);
});

test('expedition reserve uses real ripe plots and replants before seeking new ground', async (t) => {
  const { createStockFoodGoal } = require('../core/goals/stockFood');
  const farm = require('../core/farming');
  const plot = { x: 13, y: 63, z: 2 };
  const field = new Vec3(plot.x, plot.y, plot.z);
  const bank = field.offset(1, 1, 0);
  const water = field.offset(-1, 1, 0);
  const otherFarm = field.offset(0, 1, 1);
  const air = { name: 'air', boundingBox: 'empty', shapes: [] };
  const grass = { name: 'grass_block', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
  const farmland = { name: 'farmland', boundingBox: 'block', shapes: [[0, 0, 0, 1, 15 / 16, 1]] };
  const neighbors = () => [field.offset(0, 1, 0), otherFarm];
  let crop = 'ripe';
  const bag = {};
  const bot = Object.assign(fakeBot(), { game: { dimension: 'overworld' },
    pathfinder: { movements: { getNeighbors: neighbors } },
    entity: { position: new Vec3(2.5, 64, 2.5), onGround: true }, blockAt: (p) => {
      if (p.equals(field) || p.equals(otherFarm.offset(0, -1, 0))) return farmland;
      if (p.equals(water.offset(0, -1, 0))) return { ...air, name: 'water' };
      return p.y === 63 ? grass : air;
    } });
  const calls = [];
  t.mock.method(farm, 'plotState', (_bot, p) => {
    assert.ok(p.equals(new Vec3(plot.x, plot.y, plot.z)));
    return crop;
  });
  t.mock.method(farm, 'harvest', async (_bot, ctx, _plot, { collect }) => {
    calls.push('harvest');
    crop = 'empty';
    await collect(bot, ctx);
    bag.wheat = 3;
    bag.wheat_seeds = 1;
    return { ok: true, gained: 3 };
  });
  t.mock.method(farm, 'plant', async () => {
    calls.push('plant');
    crop = 'growing';
    bag.wheat_seeds = 0;
    return { ok: true };
  });
  const table = { x: 1, y: 64, z: 1 };
  const goal = createStockFoodGoal({ bot, target: 12, expeditionHome: { ...home, stations: { crafting_table: table } },
    farmPlots: [plot], actions: {
      goTo: async (_bot, _ctx, target, { arrived }) => {
        const moves = bot.pathfinder.movements.getNeighbors;
        assert.deepEqual(moves(water), [], 'cannot enter farmland from water');
        assert.deepEqual(moves(bank.offset(0, 1, 0)), [], 'cannot drop onto farmland and trample it');
        assert.deepEqual(moves(bank.offset(1, 0, 0)), [], 'cannot enter farmland across a gap');
        assert.deepEqual(moves(bank), [field.offset(0, 1, 0)], 'only the wheat pickup target is allowed');
        assert.ok(target.isEnd(field.offset(0, 1, 0)));
        bot.entity.position = field.offset(.5, 15 / 16, .5);
        assert.ok(arrived());
        bot.entity.position = new Vec3(2.5, 64, 2.5);
        return { ok: true };
      },
    }, skills: {
      takeItems: async () => ({ ok: false, reason: 'chest_empty' }),
      huntOne: async () => ({ ok: false, reason: 'no_mob_in_range' }),
      craft: async (_bot, _ctx, { item, times, tablePosition }) => {
        assert.equal(item, 'bread');
        assert.equal(times, 1);
        assert.equal(tablePosition, table);
        calls.push('bake');
        bag.wheat = 0;
        bag.bread = 1;
        return { ok: true, gained: 1 };
      },
    } });
  const ctx = { perceive: () => ({ inventory: { ...bag }, health: 20, food: 20, isDay: true }), record() {} };
  for (let i = 0; i < 4; i += 1) assert.equal((await goal.run(ctx)).ok, true);
  assert.equal(bot.pathfinder.movements.getNeighbors, neighbors);
  assert.deepEqual(calls, ['harvest', 'bake', 'plant']);
  assert.equal(goal.progress(ctx.perceive()), 1);
  assert.equal(goal.isDone(ctx.perceive()), false);
});

test('expedition reserve extends the growing field on nearby hydrated soil and preserves a dry bank', async (t) => {
  const { createStockFoodGoal } = require('../core/goals/stockFood');
  const farm = require('../core/farming');
  const original = new Vec3(13, 63, 2);
  const newPlot = original.offset(1, 0, 0);
  const bank = newPlot.offset(1, 0, 0);
  const distant = original.offset(6, 0, 0);
  const source = newPlot.offset(0, 0, -1);
  const field = new Map([[original.toString(), 'growing']]);
  const air = { name: 'air', boundingBox: 'empty', shapes: [] };
  const grass = { name: 'grass_block', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
  const bag = { cooked_chicken: 3, wheat_seeds: 1, stone_hoe: 1 };
  const bot = Object.assign(fakeBot(), { game: { dimension: 'overworld' },
    entity: { position: new Vec3(2.5, 64, 2.5), onGround: true },
    registry: { blocksByName: { water: { id: 7 } } }, findBlocks: () => [source],
    blockAt(p) {
      if (p.equals(source)) return { ...air, name: 'water', position: source, metadata: 0 };
      if (p.y === 63 && ![newPlot, bank, distant].some((ground) => p.equals(ground))) return { ...grass, name: 'stone' };
      return p.y === 63 ? grass : air;
    } });
  const edits = [];
  t.mock.method(farm, 'plotState', (_bot, p) => field.get(p.toString()) || 'untilled');
  t.mock.method(farm, 'till', async (_bot, _ctx, p) => {
    edits.push(p);
    field.set(p.toString(), 'empty');
    return { ok: true };
  });
  t.mock.method(farm, 'plant', async (_bot, _ctx, p) => {
    assert.ok(p.equals(newPlot));
    field.set(p.toString(), 'growing');
    delete bag.wheat_seeds;
    return { ok: true };
  });
  const goal = createStockFoodGoal({ bot, target: 12,
    expeditionHome: { ...home, stations: { crafting_table: home.centre } }, farmPlots: [original], skills: {
      takeItems: async () => ({ ok: false, reason: 'chest_empty' }),
      huntOne: async () => ({ ok: false, reason: 'no_mob_in_range' }),
    } });
  const ctx = { perceive: () => ({ inventory: bag, health: 20, food: 20, isDay: true }), record() {} };
  for (let i = 0; i < 3; i += 1) assert.ok((await goal.run(ctx)).ok);
  assert.deepEqual(edits, [newPlot]);
  bag.wheat_seeds = 1;
  const result = await goal.run(ctx);
  assert.equal(result.reason, 'expedition_food_waiting_for_wheat');
  assert.equal(result.waited, true);
  assert.deepEqual(edits, [newPlot], 'keep the harvest bank and avoid expanding beyond the original field');
});

test('expedition wheat uses a bounded level farm path and preserves its way back after a threat', async (t) => {
  const { createStockFoodGoal } = require('../core/goals/stockFood');
  const farm = require('../core/farming');
  const bank = new Vec3(10, 64, 2);
  const plots = [1, 2, 3].map((x) => bank.offset(x, -1, 0));
  const cells = [bank, ...plots.map((p) => p.offset(0, 1, 0))];
  const air = { name: 'air', boundingBox: 'empty', shapes: [] };
  const support = { name: 'grass_block', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
  const soil = { ...support, name: 'farmland', shapes: [[0, 0, 0, 1, 15 / 16, 1]] };
  const nativeNeighbors = () => [...cells, bank.offset(0, 0, 1)];
  const movement = { getNeighbors: nativeNeighbors, allowSprinting: true };
  const bot = Object.assign(fakeBot(), { game: { dimension: 'overworld' }, pathfinder: { movements: movement },
    entity: { position: new Vec3(2.5, 64, 2.5), onGround: true }, blockAt(p) {
      if (plots.some((plot) => p.equals(plot))) return soil;
      if (cells.slice(1).some((cell) => p.equals(cell))) return { ...air, name: 'wheat' };
      if (p.y === 63) return p.equals(bank.offset(0, -1, 0)) ? support : { ...air, name: 'water' };
      return air;
    } });
  let hostiles = [];
  let abortNext = true;
  let harvested = 0;
  const traveled = [];
  t.mock.method(farm, 'plotState', (_bot, p) => p.equals(plots[2]) ? 'ripe' : 'growing');
  t.mock.method(farm, 'harvest', async (_bot, _ctx, p) => {
    assert.ok(bot.entity.position.floored().equals(p));
    harvested += 1;
    return { ok: true, gained: 1 };
  });
  const ctx = { perceive: () => ({ inventory: {}, health: 20, food: 20, isDay: true, hostiles }), record() {} };
  const goal = createStockFoodGoal({ bot, target: 12, expeditionHome: { ...home, stations: { crafting_table: home.centre } },
    farmPlots: plots, actions: { goTo: async (_bot, _ctx, target, { arrived }) => {
      const pos = new Vec3(target.x, target.y, target.z);
      const at = bot.entity.position.floored();
      if (pos.x !== bank.x || at.x > bank.x) {
        const logical = at.x > bank.x ? at.offset(0, 1, 0) : at;
        assert.deepEqual(movement.getNeighbors(logical), [pos]);
        assert.equal(movement.allowSprinting, false);
      }
      bot.entity.position = pos.offset(.5, pos.x > bank.x ? -1 / 16 : 0, .5);
      assert.ok(arrived());
      traveled.push(pos.x);
      if (abortNext && pos.x === bank.x + 2) {
        abortNext = false;
        hostiles = [{ name: 'zombie', distance: 4 }];
      }
      return { ok: true };
    } }, skills: { takeItems: async () => ({ ok: false, reason: 'chest_empty' }),
      huntOne: async () => ({ ok: false, reason: 'no_mob_in_range' }) } });
  assert.equal((await goal.run(ctx)).ok, true);
  assert.equal((await goal.run(ctx)).reason, 'expedition_food_field_unreachable');
  assert.equal(harvested, 0);
  assert.deepEqual(traveled, [10, 11, 12]);
  hostiles = [];
  assert.equal((await goal.run(ctx)).ok, true);
  assert.deepEqual(traveled, [10, 11, 12, 11, 10]);
  assert.equal(movement.allowSprinting, true);
  assert.equal(movement.getNeighbors, nativeNeighbors);
});

test('expedition reserve re-enters the home range by dry local legs from beyond a loaded route', async () => {
  const { createStockFoodGoal } = require('../core/goals/stockFood');
  const floor = { name: 'grass_block', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
  const air = { name: 'air', boundingBox: 'empty', shapes: [] };
  const bot = Object.assign(fakeBot(), { game: { dimension: 'overworld' }, blockAt: (p) => p.y === 63 ? floor : air,
    entity: { position: new Vec3(108.5, 64, 2.5), onGround: true } });
  const targets = [];
  let blocked = true;
  const goal = createStockFoodGoal({ bot, target: 12, expeditionHome: home, actions: {
    underground: () => false,
    goTo: async (_bot, _ctx, destination) => {
      assert.ok(destination.constructor.name === 'GoalNearXZ', 'a bounded leg rather than a goal outside loaded terrain');
      const p = new Vec3(destination.x, 64, destination.z);
      targets.push(p);
      assert.ok(destination.isEnd(p));
      if (blocked) { blocked = false; return { ok: false, reason: 'NoPath' }; }
      bot.entity.position = p.offset(.5, 0, .5);
      return { ok: true };
    },
  } });
  const ctx = { perceive: () => ({ inventory: {}, health: 20, food: 20, isDay: true }), record() {} };
  assert.equal((await goal.run(ctx)).reason, 'NoPath');
  assert.equal((await goal.run(ctx)).ok, true);
  assert.equal((await goal.run(ctx)).ok, true);
  assert.notEqual(targets[0].z, targets[1].z, 'retry uses a different safe heading');
  assert.ok(bot.entity.position.x < 90);
});

test('expedition reserve scouts loaded dry legs while crops grow and retraces on low food', async (t) => {
  const { createStockFoodGoal } = require('../core/goals/stockFood');
  const farm = require('../core/farming');
  const plot = new Vec3(10, 63, 4);
  const start = new Vec3(10, 64, 2);
  const air = { name: 'air', boundingBox: 'empty', shapes: [] };
  const grass = { name: 'grass_block', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
  const water = { name: 'water', boundingBox: 'empty', shapes: [] };
  const seagrass = { ...water, name: 'seagrass' };
  let food = 18;
  const native = (p) => [p.offset(1, 0, 0), p.offset(0, 0, -1), p.offset(1, 0, -1), p.offset(0, -2, 1)];
  const movements = { canDig: true, allowSprinting: false, sprintSetting: true, getNeighbors: native };
  const planned = [];
  const walked = [];
  const huntRadii = [];
  let directBlocked = true;
  const bot = Object.assign(fakeBot(), { game: { dimension: 'overworld' },
    entity: { position: new Vec3(2.5, 64, 2.5), onGround: true },
    blockAt: (p) => p.x === 11 && p.z === 2 && p.y === 64 ? seagrass : p.y === 63 ? grass : air,
    pathfinder: { movements, *getPathFromTo(profile, here, goal, options) {
      const feet = here.floored();
      planned.push(new Vec3(goal.x, 64, goal.z));
      assert.equal(profile.allowSprinting, false);
      assert.deepEqual(options, { timeout: 80, tickTimeout: 35, optimizePath: false, searchRadius: 48 });
      assert.deepEqual(profile.getNeighbors(start), [start.offset(0, 0, -1)], 'reject seagrass, diagonals and large drops');
      yield { result: { status: 'partial', path: planned.length === 1 ? []
        : Array.from({ length: 22 }, (_, index) => feet.offset(0, 0, -index - 1)) } };
    } } });
  t.mock.method(farm, 'plotState', () => 'growing');
  const goal = createStockFoodGoal({ bot, target: 12, expeditionHome: { ...home, stations: { crafting_table: home.centre } },
    farmPlots: [plot], actions: { goTo: async (_bot, _ctx, destination, options) => {
      assert.ok(options.timeoutMs <= 15000 && !options.retryNoProgress);
      assert.equal(movements.allowSprinting, false);
      const at = new Vec3(destination.x, destination.y, destination.z);
      walked.push(at);
      if (at.equals(new Vec3(2, 64, 2)) && directBlocked) {
        directBlocked = false;
        assert.equal(options.timeoutMs, 6500);
        return { ok: false, reason: 'NoPath' };
      }
      bot.entity.position = at.offset(.5, 0, .5);
      if (options.arrived) assert.ok(options.arrived());
      if (options.arrived && walked.length === 1) {
        bot.entity.isInWater = true;
        assert.equal(options.arrived(), false, 'native wet flag vetoes a dry-looking endpoint');
        bot.entity.isInWater = false;
      }
      return { ok: true };
    } }, skills: {
      takeItems: async () => ({ ok: false, reason: 'chest_empty' }),
      huntOne: async (_bot, _ctx, { radius }) => {
        huntRadii.push(radius);
        return { ok: false, reason: 'no_mob_in_range' };
      },
    } });
  const events = [];
  const ctx = { perceive: () => ({ inventory: { cooked_chicken: 3 }, health: 20, food, isDay: true, timeOfDay: 2000 }),
    record: (type, data) => events.push({ type, ...data }) };
  await goal.run(ctx);
  bot.entity.position = start.offset(.5, 0, .5);
  await goal.run(ctx); // no local source, reserve can wait and scout
  await goal.run(ctx); // east blocked by water
  await goal.run(ctx); // rotate to another sector and follow a dry prefix
  assert.equal(planned.length, 2);
  assert.ok(planned[1].z < planned[0].z);
  assert.deepEqual(walked, [start.offset(0, 0, -12)], 'ignore the rest of the proposed path');
  assert.equal(movements.allowSprinting, true, 'restore actual sprint setting, not the hunger-gated getter');
  food = 13;
  await goal.run(ctx);
  await goal.run(ctx);
  assert.deepEqual(walked.slice(1), [new Vec3(2, 64, 2), start, new Vec3(2, 64, 2)]);
  assert.deepEqual(huntRadii, [48, 12, 12]);
  assert.deepEqual(events.map((e) => e.type), [
    'expedition_food_scout', 'expedition_food_scout_home', 'expedition_food_scout_return', 'expedition_food_scout_home',
  ]);
  assert.deepEqual(events.filter((e) => e.type === 'expedition_food_scout_home').map((e) => e.ok), [false, true]);
  assert.equal(movements.getNeighbors, native);
});

test('expedition stock gets ashore after a wet restart and follows the supported home route', async () => {
  const { createStockFoodGoal } = require('../core/goals/stockFood');
  const air = { name: 'air', boundingBox: 'empty', shapes: [] };
  const grass = { name: 'grass_block', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
  const feet = new Vec3(12.9, 63, 2.5);
  const controls = [];
  const bot = Object.assign(fakeBot(), { game: { dimension: 'overworld' },
    entity: { position: feet, onGround: true, isInWater: true },
    blockAt(p) {
      if (p.x === 13 && p.y === 63) return { ...air, name: 'seagrass' };
      return p.y === 62 ? grass : air;
    },
    async lookAt(at) { assert.deepEqual(at, new Vec3(12.5, 64.65, 2.5)); },
    setControlState(control, value) {
      controls.push([control, value]);
      if (control === 'forward' && value) {
        bot.entity.position = new Vec3(12.5, 63, 2.5);
        bot.entity.isInWater = false;
      }
    },
  });
  const visits = [];
  const events = [];
  const goal = createStockFoodGoal({ bot, target: 12, expeditionHome: home, actions: {
    goTo: async (_bot, _ctx, target) => { visits.push([target.x, target.y, target.z]); return { ok: true }; },
  } });
  const ctx = { perceive: () => ({ inventory: { cooked_chicken: 3 }, health: 20, food: 18,
    isDay: true, inWater: bot.entity.isInWater }), record: (type, data) => events.push({ type, ...data }) };
  assert.equal((await goal.run(ctx)).ok, true);
  assert.deepEqual(events.map(({ type, arrived }) => ({ type, arrived })), [{ type: 'expedition_food_scout_ashore', arrived: true }]);
  assert.deepEqual(controls.slice(-2), [['forward', false], ['jump', false]]);
  assert.equal((await goal.run(ctx)).ok, true);
  assert.deepEqual(visits, [[2, 64, 2]]);
});

test('expedition scout can withdraw from a distant spider while close, ranged and attacking mobs still stop the trip', async (t) => {
  const { createStockFoodGoal } = require('../core/goals/stockFood');
  const farm = require('../core/farming');
  const at = new Vec3(10, 64, 2);
  const out = at.offset(0, 0, 10);
  const air = { name: 'air', boundingBox: 'empty', shapes: [] };
  const grass = { name: 'grass_block', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
  const walked = [];
  const events = [];
  let hostiles = [];
  let hunts = 0;
  const native = (p) => [p.offset(0, 0, 1), p.offset(0, 0, -1)];
  const movements = { getNeighbors: native };
  const bot = Object.assign(fakeBot(), { game: { dimension: 'overworld' },
    registry: { entitiesByName: { spider: { metadataKeys: ['mob_flags'] } } },
    entities: { 1: { name: 'spider', metadata: [0] } },
    entity: { position: new Vec3(2.5, 64, 2.5), onGround: true },
    blockAt: (p) => p.y === 63 ? grass : air,
    pathfinder: { movements, *getPathFromTo() { yield { result: { path: [out] } }; } },
  });
  t.mock.method(farm, 'plotState', () => 'growing');
  const goal = createStockFoodGoal({ bot, target: 12, expeditionHome: { ...home, stations: { crafting_table: home.centre } },
    farmPlots: [at.offset(1, -1, 0)], actions: {
      async goTo(_bot, _ctx, destination) {
        const to = new Vec3(destination.x, destination.y, destination.z);
        walked.push(to);
        if (to.equals(at)) {
          assert.deepEqual(movements.getNeighbors(out), [out.offset(0, 0, -1)],
            'the swept route can retreat, but cannot take an edge toward the spider');
        }
        bot.entity.position = to.offset(.5, 0, .5);
        return { ok: true };
      },
    }, skills: {
      takeItems: async () => ({ ok: false, reason: 'chest_empty' }),
      huntOne: async () => { hunts++; return { ok: false, reason: 'no_mob_in_range' }; },
    } });
  const ctx = { perceive: () => ({ inventory: { cooked_chicken: 3 }, health: 20, food: 18,
    isDay: true, timeOfDay: 2000, hostiles }), record: (type, data) => events.push({ type, ...data }) };
  await goal.run(ctx);
  bot.entity.position = at.offset(.5, 0, .5);
  const spider = { id: 1, name: 'spider', position: out.offset(.5, 0, 12.5), distance: 12 };
  hostiles = [spider];
  assert.equal((await goal.run(ctx)).reason, 'expedition_food_unsafe', 'an idle scout will not set out with a nearby mob');
  assert.equal(hunts, 0);
  hostiles = [];
  await goal.run(ctx);
  await goal.run(ctx);
  assert.deepEqual(walked, [out]);
  for (const hostile of [{ ...spider, distance: 7 }, { ...spider, name: 'skeleton' }, { ...spider, selfAggressor: true }]) {
    hostiles = [hostile];
    assert.equal((await goal.run(ctx)).reason, 'expedition_food_unsafe');
  }
  hostiles = [spider];
  const entity = bot.entities[1];
  delete bot.entities[1];
  assert.equal((await goal.run(ctx)).reason, 'expedition_food_unsafe');
  bot.entities[1] = entity;
  const keys = bot.registry.entitiesByName.spider.metadataKeys;
  bot.registry.entitiesByName.spider.metadataKeys = [];
  assert.equal((await goal.run(ctx)).reason, 'expedition_food_unsafe');
  bot.registry.entitiesByName.spider.metadataKeys = keys;
  bot.entities[1].name = 'drowned';
  hostiles = [{ ...spider, name: 'drowned' }];
  assert.equal((await goal.run(ctx)).reason, 'expedition_food_unsafe');
  bot.entities[1].name = 'spider';
  hostiles = [spider];
  bot.entities[1].metadata[0] = 4;
  assert.equal((await goal.run(ctx)).reason, 'expedition_food_unsafe');
  bot.entities[1].metadata[0] = 0;
  assert.equal((await goal.run(ctx)).ok, true);
  assert.deepEqual(walked, [out, at]);
  assert.equal(hunts, 2, 'no hunts launched while any threat was present');
  assert.deepEqual(events.map((e) => e.type), ['expedition_food_scout', 'expedition_food_scout_withdraw']);
  assert.equal(movements.getNeighbors, native);
});

test('an armed expedition stock restart can leave a calm spider by one bounded dry route', async () => {
  const { createStockFoodGoal } = require('../core/goals/stockFood');
  const start = new Vec3(62.5, 64, 2.5);
  const spider = { id: 1, name: 'spider', position: new Vec3(73, 64, 2.5) };
  const air = { name: 'air', boundingBox: 'empty', shapes: [] };
  const grass = { name: 'grass_block', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
  const neighbors = (p) => [p.offset(1, 0, 0), p.offset(-1, 0, 0), p.offset(0, 0, 1)];
  const movements = { getNeighbors: neighbors, allowSprinting: true };
  const bot = Object.assign(fakeBot(), { game: { dimension: 'overworld' },
    registry: { entitiesByName: { spider: { metadataKeys: ['mob_flags'] } } },
    entities: { 1: { name: 'spider', metadata: [0] } },
    entity: { position: start, onGround: true },
    blockAt: (p) => p.y === 63 ? grass : air,
    pathfinder: { movements },
  });
  const visits = [];
  const goal = createStockFoodGoal({ bot, target: 12, expeditionHome: home, actions: {
    underground: () => false,
    async goTo(_bot, _ctx, destination) {
      visits.push(destination.constructor.name);
      if (destination.constructor.name === 'GoalBlock') {
        assert.equal(movements.allowSprinting, false);
        const initial = start.floored();
        assert.deepEqual(movements.getNeighbors(initial), [initial.offset(-1, 0, 0)]);
        assert.equal(destination.x, 55);
        assert.equal(destination.z, 2);
      }
      bot.entity.position = new Vec3(destination.x + .5, destination.y ?? 64, destination.z + .5);
      return { ok: true };
    },
  } });
  const inventory = { cooked_chicken: 3, iron_sword: 1 };
  const events = [];
  let isDay = true;
  const ctx = { perceive() {
    const distance = bot.entity.position.distanceTo(spider.position);
    return { inventory, health: 20, food: 18, isDay, hostiles: distance <= 16 ? [{ ...spider, distance }] : [] };
  }, record: (type, data) => events.push({ type, ...data }) };
  isDay = false;
  assert.equal((await goal.run(ctx)).reason, 'expedition_food_unsafe');
  isDay = true;
  bot.entities[1].metadata = [];
  assert.equal((await goal.run(ctx)).reason, 'expedition_food_unsafe');
  bot.entities[1].metadata = [0];
  assert.equal((await goal.run(ctx)).ok, true);
  assert.ok(bot.entity.position.distanceTo(spider.position) > 17);
  assert.deepEqual(events.map(({ type, arrived }) => ({ type, arrived })), [{ type: 'expedition_food_return_withdraw', arrived: true }]);
  assert.equal((await goal.run(ctx)).ok, true);
  assert.deepEqual(visits, ['GoalBlock', 'GoalNearXZ']);
  assert.equal(movements.getNeighbors, neighbors);
  assert.equal(movements.allowSprinting, true);
});

test('expedition stock steps directly away from a distant native zombie and refuses close or mixed threats', async (t) => {
  const { createStockFoodGoal } = require('../core/goals/stockFood');
  const start = new Vec3(-199.5, 92, -190.497020021202);
  const zombie = { id: 1, name: 'zombie', position: new Vec3(-208.50937430715018, 97, -195.2618923313049) };
  const air = { name: 'air', boundingBox: 'empty', shapes: [] };
  const grass = { name: 'grass_block', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
  const route = [[-200, 92], [-199, 91], [-198, 90], [-197, 90], [-196, 90], [-195, 89], [-194, 89]]
    .map(([x, y]) => new Vec3(x, y, -191));
  const movements = { allowSprinting: true, getNeighbors: (p) => [route.find((q) => q.x === p.x + 1), p.offset(-1, 0, 0)]
    .filter(Boolean) };
  const bot = Object.assign(fakeBot(), { game: { dimension: 'overworld' }, entities: { 1: zombie },
    entity: { position: start, onGround: true }, pathfinder: { movements, enablePathShortcut: true },
    blockAt: (p) => route.some((q) => p.equals(q.offset(0, -1, 0))) ? grass : air });
  const events = [];
  const goal = createStockFoodGoal({ bot, target: 24, expeditionHome: { ...home, centre: { x: -102, y: 64, z: -179 } },
    actions: { underground: () => false, goTo: async (_b, _ctx, target, { arrived }) => {
      const last = route.at(-1);
      assert.deepEqual([target.x, target.y, target.z], last.toArray());
      assert.equal(movements.allowSprinting, false);
      assert.equal(bot.pathfinder.enablePathShortcut, false);
      for (let index = 0; index < route.length - 1; index += 1) {
        assert.deepEqual(movements.getNeighbors(route[index]), [route[index + 1]]);
      }
      bot.entity.position = last.offset(.5, 0, .5);
      assert.ok(arrived());
      return { ok: true };
    } } });
  const near = { id: 1, name: 'zombie', position: start.offset(-6, 0, 0) };
  const skeleton = { id: 2, name: 'skeleton', position: start.offset(-12, 0, 0) };
  let hostiles = [];
  let isDay = true;
  const ctx = { perceive: () => ({ health: 20, food: 19, isDay, timeOfDay: 3000, inventory: { bread: 3, iron_sword: 1 },
    hostiles: hostiles.map((h) => ({ ...h, distance: bot.entity.position.distanceTo(h.position) })).filter(({ distance }) => distance <= 16) }),
  record: (type, data) => events.push({ type, ...data }) };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const threats of [[near], [zombie, skeleton], [zombie]]) {
    hostiles = threats;
    isDay = threats[0] !== zombie || threats.length > 1;
    const denied = goal.run(ctx);
    t.mock.timers.tick(1001);
    assert.equal((await denied).reason, 'expedition_food_unsafe');
  }
  assert.deepEqual(bot.entity.position, start);
  isDay = true;
  assert.ok((await goal.run(ctx)).ok);
  assert.equal(events.at(-1).type, 'expedition_food_return_withdraw');
  assert.ok(bot.entity.position.distanceTo(zombie.position) > 17);
  assert.equal(movements.allowSprinting, true);
  assert.equal(bot.pathfinder.enablePathShortcut, true);
});

test('expedition stock counts angry and unsynced Endermen as threats, while confirmed calm ones allow supplies', async () => {
  const { createStockFoodGoal } = require('../core/goals/stockFood');
  const at = new Vec3(2.5, 64, 2.5);
  const mob = { id: 7, name: 'enderman', type: 'hostile', position: at.offset(12, -2, 0), metadata: [] };
  const bot = Object.assign(fakeBot(), { game: { dimension: 'overworld' }, entities: { 7: mob },
    registry: { entitiesByName: { enderman: { type: 'hostile', metadataKeys: ['creepy', 'stared_at'] } } },
    entity: { position: at, onGround: true },
  });
  const controller = new AbortController();
  let seenHits = false;
  let chestReads = 0;
  const ctx = { signal: controller.signal, record() {}, perceive: () => ({ inventory: { bread: 3, iron_sword: 1 },
    health: 20, food: 15, isDay: true, hostiles: [{ id: 7, name: 'enderman', distance: 12.2, selfAggressor: seenHits }] }) };
  const goal = createStockFoodGoal({ bot, target: 12, expeditionHome: home, skills: {
    takeItems: async () => { chestReads += 1; return { ok: true, gained: 1 }; },
  } });
  const cases = [[], [true, false], [false, true], [2, false]];
  for (const metadata of cases) {
    mob.metadata = metadata;
    assert.equal((await goal.run(ctx)).reason, 'expedition_food_unsafe');
  }
  mob.attributes = { movement_speed: { value: .3, modifiers: [] } };
  mob.metadata = [];
  seenHits = true;
  assert.equal((await goal.run(ctx)).reason, 'expedition_food_unsafe');
  seenHits = false;
  assert.equal((await goal.run(ctx)).ok, true);
  assert.equal(chestReads, 1);
});

test('healthy home recovery waits for its growing food reserve instead of exploring and harvests when ripe', async () => {
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  const crop = new Vec3(-10, 64, 3);
  const { door } = house.furniture;
  let open = true;
  let age = 1;
  const items = [{ name: 'stone_sword', count: 1 }, { name: 'stone_pickaxe', count: 1 }, { name: 'bread', count: 1 }];
  const bot = Object.assign(fakeBot(items), { health: 20, food: 17, time: { timeOfDay: 3000 }, entities: {},
    entity: { position: new Vec3(3.5, 64, 3.5), onGround: true }, game: { dimension: 'overworld' },
    registry: { blocksByName: { wheat: { id: 1 } } }, findBlocks: () => [crop] });
  bot.blockAt = (p) => {
    if (p.x === door.position.x && p.z === door.position.z && (p.y === door.position.y || p.y === door.upper.y)) {
      return { name: 'oak_door', getProperties: () => ({ half: p.y === door.position.y ? 'lower' : 'upper',
        open, facing: 'north', hinge: 'left' }) };
    }
    if (p.equals(crop)) return { name: 'wheat', getProperties: () => ({ age }) };
    if (p.equals(crop.offset(0, -1, 0))) return { name: 'farmland', getProperties: () => ({ moisture: 7 }) };
    return { name: 'cobblestone', shapes: [[0, 0, 0, 1, 1, 1]] };
  };
  bot.activateBlock = async () => { open = !open; };
  const goal = createOutfitGoal({ bot, recoverAtHome: true,
    items: [{ key: 'stone_sword', count: 1 }, { key: 'stone_tier_pickaxe', count: 1 }, { key: 'food', count: 3 }],
    home: { chest: house.furniture.chest.position, centre: house.interiorCenter, anchor: house.anchor, door: door.position,
      stations: { crafting_table: house.furniture.crafting_table.position } },
    actions: { withinReach: () => true }, skills: { takeItems: async () => ({ ok: false, reason: 'chest_empty' }),
      huntOne: async () => assert.fail('healthy recovery should not hunt without a nearby verified target'),
      explore: async () => assert.fail('healthy recovery should not leave a growing local farm') } });
  const records = [];
  let controller = new AbortController();
  const ctx = { perceive: () => perceive(bot), get signal() { return controller.signal; }, record: (type, detail) => {
    records.push({ type, ...detail });
    if (type === 'resupply_shelter_wait' || type === 'resupply_food_target') controller.abort();
  } };
  await goal.run(ctx);
  await goal.run(ctx);
  assert.equal(open, false);
  await assert.rejects(goal.run(ctx), { code: 'aborted' });
  assert.equal(goal.ownsRouteRecovery(), true);
  assert.deepEqual(records.find(({ type }) => type === 'resupply_food_wait'), {
    type: 'resupply_food_wait', reason: 'awaiting_crop_regrowth', growing: 1 });
  assert.equal(goal.isDone(perceive(bot)), false);
  age = 7;
  controller = new AbortController();
  await goal.run(ctx);
  assert.equal(open, true);
  await assert.rejects(goal.run(ctx), { code: 'aborted' });
  assert.equal(records.find(({ type }) => type === 'resupply_food_target')?.kind, 'wheat');
});

test('expedition harvest crosses a same-level sand bank only over dry full backing', async (t) => {
  const { createStockFoodGoal } = require('../core/goals/stockFood');
  const farm = require('../core/farming');
  const bank = new Vec3(10, 64, 2);
  const target = bank.offset(1, 0, 0);
  const plot = target.offset(0, -1, 0);
  const air = { name: 'air', boundingBox: 'empty', shapes: [] };
  const support = { name: 'clay', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
  const water = { ...air, name: 'water' };
  const sand = { ...support, name: 'sand' };
  const soil = { ...support, name: 'farmland', shapes: [[0, 0, 0, 1, 15 / 16, 1]] };
  const from = bank.offset(0, 0, 1);
  const start = new Vec3(2.5, 64, 2.5);
  const state = { inventory: { wheat_seeds: 1 }, health: 20, food: 20, isDay: true, hostiles: [] };
  let backing = water;
  let ripe = true;
  let crops = 0, replanted = 0;
  const traveled = [];
  const movement = { getNeighbors: () => [bank, target], allowSprinting: true };
  const bot = Object.assign(fakeBot(), { game: { dimension: 'overworld' }, pathfinder: { movements: movement },
    entity: { position: start, onGround: true }, blockAt(p) {
      if (p.equals(plot)) return soil;
      if (p.equals(target) && ripe) return { ...air, name: 'wheat' };
      if (p.equals(bank.offset(0, -1, 0))) return sand;
      if (p.equals(bank.offset(0, -2, 0))) return backing;
      if (p.equals(from.offset(0, -1, 0))) return support;
      if (p.y === 63) return water;
      return air;
    } });
  t.mock.method(farm, 'plotState', () => ripe ? 'ripe' : 'empty');
  t.mock.method(farm, 'harvest', async () => {
    assert.ok(bot.entity.position.floored().equals(plot));
    ripe = false;
    crops += 1;
    return { ok: true, gained: 1 };
  });
  t.mock.method(farm, 'plant', async () => { replanted += 1; return { ok: true }; });
  const ctx = { perceive: () => state, record() {} };
  const createGoal = () => createStockFoodGoal({ bot, target: 12,
    expeditionHome: { ...home, stations: { crafting_table: home.centre } }, farmPlots: [plot], actions: {
      goTo: async (_bot, _ctx, goal, { arrived }) => {
        const to = new Vec3(goal.x, goal.y, goal.z);
        const at = bot.entity.position.floored();
        const nativeFrom = at.equals(start.floored()) ? from : at.equals(plot) ? target : at;
        assert.ok(movement.getNeighbors(nativeFrom).some((p) => p.equals(to)));
        bot.entity.position = to.offset(.5, to.equals(target) ? -1 / 16 : 0, .5);
        assert.ok(arrived());
        traveled.push(to);
        return { ok: true };
      },
    }, skills: { takeItems: async () => ({ ok: false, reason: 'chest_empty' }),
      huntOne: async () => ({ ok: false, reason: 'no_mob_in_range' }) } });

  const refused = createGoal();
  await refused.run(ctx);
  await refused.run(ctx);
  assert.equal(crops, 0);
  assert.deepEqual(traveled, []);

  backing = support;
  const reachable = createGoal();
  await reachable.run(ctx);
  assert.equal((await reachable.run(ctx)).gained, 1);
  assert.equal(crops, 1);
  assert.equal(replanted, 1);
  assert.deepEqual(traveled, [bank, target, bank]);
});
