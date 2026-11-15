'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('minecraft-data')('1.21.8');
const Item = require('prismarine-item')('1.21.8');
const { remainingDurability, quartzToolReserve } = require('../core/quartzTools');
const { createGatherMaterialsGoal } = require('../core/goals/gatherMaterials');

function tool(name = 'stone_pickaxe', used = 0) {
  const item = new Item(registry.itemsByName[name].id, 1);
  item.durabilityUsed = used;
  return item;
}

test('quartz reserve reads the native 1.21.8 durability getter at the exact remaining threshold', () => {
  const items = [tool('stone_pickaxe', 35), tool('stone_pickaxe', 36), tool(), tool('diamond_pickaxe')];
  const bot = { registry, inventory: { items: () => items } };
  assert.equal(remainingDurability(bot, items[0]), 96);
  assert.equal(remainingDurability(bot, items[1]), 95);
  assert.deepEqual(quartzToolReserve(bot), { carried: 3, ready: 2, required: 3, minimumRemaining: 96, short: 1, targetCount: 4 });
});

test('unknown, negative or over-maximum wear cannot discharge the carried tool reserve', () => {
  for (const used of [undefined, null, NaN, -1, 0.5, 132]) {
    const item = { name: 'stone_pickaxe', count: 1, durabilityUsed: used };
    const bot = { registry, inventory: { items: () => [item] } };
    assert.equal(remainingDurability(bot, item), null);
    assert.equal(quartzToolReserve(bot).ready, 0);
    assert.equal(quartzToolReserve(bot).targetCount, 4);
  }
});

test('an unreadable native wear component is unknown reserve instead of crashing tool preparation', () => {
  const item = { name: 'stone_pickaxe', count: 1, get durabilityUsed() { throw new Error('invalid component'); } };
  const bot = { registry, inventory: { items: () => [item] } };
  assert.equal(remainingDurability(bot, item), null);
  assert.equal(quartzToolReserve(bot).ready, 0);
});

test('a remembered or chest pickaxe is not carried reserve and diamond does not become a cheap pick', () => {
  const bot = { registry, inventory: { items: () => [tool('diamond_pickaxe')] }, companionChest: { stone_pickaxe: 64 } };
  assert.deepEqual(quartzToolReserve(bot), { carried: 0, ready: 0, required: 3, minimumRemaining: 96, short: 3, targetCount: 3 });
});

function parentFixture({ picks = [], ledgeSeen = true } = {}) {
  const items = [tool('diamond_pickaxe'), ...picks,
    new Item(registry.itemsByName.iron_sword.id, 1), new Item(registry.itemsByName.cooked_beef.id, 4),
    new Item(registry.itemsByName.cobblestone.id, 450), new Item(registry.itemsByName.stick.id, 6)];
  const chest = new Vec3(0, 64, 3); const table = new Vec3(1, 64, 3); const portal = new Vec3(0, 64, 0);
  const bot = Object.assign(new EventEmitter(), { registry, health: 20, food: 20, game: { dimension: 'overworld' },
    entity: { position: new Vec3(0.5, 64, 2.5), onGround: true },
    inventory: { items: () => items, slots: [], emptySlotCount: () => 20 },
    blockAt(p) { const f = p.floored(); const name = f.equals(chest) ? 'chest' : f.equals(table) ? 'crafting_table'
      : f.equals(portal) ? 'nether_portal' : f.y < 64 ? 'stone' : 'air';
      return { name, position: f, boundingBox: ['air', 'nether_portal'].includes(name) ? 'empty' : 'block' }; },
    findBlocks: () => [portal] });
  const crafts = []; let entries = 0;
  const goal = createGatherMaterialsGoal({ bot, chest, requirements: [{ key: 'quartz', count: 8 }],
    stations: { crafting_table: table }, actions: { surface: async () => null },
    skills: { craft: async (_bot, _ctx, request) => { crafts.push(request); return { ok: true }; } } });
  goal.memory.chest = {};
  goal.memory.trip = { target: 8, memory: { ledgeSeen, overworldPortal: portal },
    run: async () => { entries += 1; return { ok: false, reason: 'MODELED_before_portal' }; } };
  const records = [];
  const ctx = { signal: new AbortController().signal, record: (type, data) => records.push({ type, ...data }),
    perceive: () => ({ inventory: items.reduce((o, i) => { o[i.name] = (o[i.name] || 0) + i.count; return o; }, {}),
      position: bot.entity.position.clone(), health: 20, food: 20 }) };
  return { bot, goal, ctx, crafts, records, entries: () => entries };
}

test('after the 450-block stock the material parent naturally plans fresh stone tools before Nether entry', async () => {
  const f = parentFixture();
  await f.goal.run(f.ctx);
  assert.equal(f.entries(), 0);
  assert.equal(f.crafts.length, 1);
  assert.equal(f.crafts[0].item, 'stone_pickaxe');
  assert.equal(f.crafts[0].times, 3);
  assert.ok(f.records.some((r) => r.type === 'plan_step' && r.item === 'stone_pickaxe'));
});

test('three worn stones do not suppress replacement crafting after bridge preparation', async () => {
  const f = parentFixture({ picks: [tool('stone_pickaxe', 120), tool('stone_pickaxe', 120), tool('stone_pickaxe', 120)] });
  await f.goal.run(f.ctx);
  assert.equal(f.entries(), 0);
  assert.equal(f.crafts[0]?.item, 'stone_pickaxe');
  assert.equal(f.crafts[0]?.times, 3);
});

test('three actually ready stone tools allow the material parent to continue its original Nether trip', async () => {
  const f = parentFixture({ picks: [tool(), tool(), tool()] });
  assert.equal((await f.goal.run(f.ctx)).reason, 'MODELED_before_portal');
  assert.equal(f.entries(), 1);
  assert.equal(f.crafts.length, 0);
});

test('first portal discovery keeps its original kit instead of demanding the later quarry reserve', async () => {
  const f = parentFixture({ ledgeSeen: false });
  assert.equal((await f.goal.run(f.ctx)).reason, 'MODELED_before_portal');
  assert.equal(f.entries(), 1);
  assert.equal(f.crafts.length, 0);
});
