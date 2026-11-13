'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutfitGoal } = require('../core/goals/outfit');
const { createGatherMaterialsGoal } = require('../core/goals/gatherMaterials');
const { perceive } = require('../core/perception');
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
