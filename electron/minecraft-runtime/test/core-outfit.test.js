'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutfitGoal } = require('../core/goals/outfit');
const { createGatherMaterialsGoal } = require('../core/goals/gatherMaterials');
const { perceive } = require('../core/perception');
const { createStarterHouse } = require('../core/blueprints/starterHouse');
const { sleep } = require('../core/confirm');
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
  bot.canDigBlock = (block) => block.diggable;
  bot.companionProtectBlock = (block) => protect && block.position.equals(route[1]);
  bot.blockAt = (p) => {
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

test('critical bread return can leave the observed 15/16-height farmland for a dry cardinal step', async () => {
  const house = createStarterHouse({ x: -68, y: 72, z: -35 });
  const door = new Vec3(-65, 72, -35);
  const plot = new Vec3(-81, 70, -34);
  const ground = new Vec3(-81, 71, -33);
  const route = [ground, ...Array.from({ length: 11 }, (_, i) => ground.offset(i + 1, 0, 0)),
    new Vec3(-69, 72, -33), new Vec3(-69, 72, -34), new Vec3(-69, 72, -35), new Vec3(-69, 72, -36),
    ...Array.from({ length: 4 }, (_, i) => new Vec3(-68 + i, 72, -36))];
  const base = new Set(route.map((p) => p.offset(0, -1, 0).toString()));
  const bot = Object.assign(fakeBot([{ name: 'wheat', count: 3 }]), { health: 2.67, food: 5, game: { dimension: 'overworld' },
    entity: { position: plot.offset(.5, 15 / 16, .5), onGround: true }, entities: {}, time: { timeOfDay: 5000 } });
  let material = 'farmland';
  let wet = false;
  bot.blockAt = (p) => {
    if (p.equals(door) || p.equals(door.offset(0, 1, 0))) {
      return { name: 'oak_door', boundingBox: 'block', getProperties: () => ({ half: p.y === door.y ? 'lower' : 'upper',
        open: false, facing: 'south', hinge: 'left' }) };
    }
    if (p.equals(plot)) return { name: material, boundingBox: 'block', shapes: [[0, 0, 0, 1, 15 / 16, 1]] };
    if (wet && p.equals(ground)) return { name: 'water', boundingBox: 'empty', shapes: [] };
    const solid = base.has(p.toString());
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
  assert.equal((await goal.run(ctx)).ok, true);
  assert.equal(steps, 1);
  assert.deepEqual(events.at(-1), ['resupply_home_step', { from: plot, to: ground, partialFloor: 'farmland' }]);
  assert.equal(bot.pathfinder.movements.getNeighbors, nativeNeighbors);
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
