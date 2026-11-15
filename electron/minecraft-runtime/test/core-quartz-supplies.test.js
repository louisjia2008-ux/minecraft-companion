'use strict';
// Deterministic model of candidate01's observed post-death inventory. No
// server, world mutation or network travel occurs in these tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const nether = require('../core/nether');
const { perceive } = require('../core/perception');
const { createNetherQuartzGoal, QUARTZ_MIN_FOOD, quartzFoodCount } = require('../core/goals/netherQuartz');
const { createGatherMaterialsGoal } = require('../core/goals/gatherMaterials');

const chest = { x: 0, y: 64, z: 3 };
const stations = { crafting_table: { x: 1, y: 64, z: 3 } };
function fixture(t, inventory = {}, { dimension = 'overworld' } = {}) {
  const bag = { stone_pickaxe: 1, wooden_pickaxe: 1, stone_sword: 1, dirt: 36, cobblestone: 21, ...inventory };
  const portal = new Vec3(0, 64, 0);
  const bot = Object.assign(new EventEmitter(), { health: 20, food: 20, entities: {}, game: { dimension },
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true },
    registry: { blocksByName: { nether_portal: { id: 1 }, nether_bricks: { id: 2 } }, itemsByName: {},
      foodsByName: { cooked_beef: { foodPoints: 8 }, beef: { foodPoints: 3 }, chicken: { foodPoints: 2 },
        rotten_flesh: { foodPoints: 4 }, sweet_berries: { foodPoints: 2 } } },
    pathfinder: { movements: { maxDropDown: 4, blocksCantBreak: new Set(), exclusionAreasStep: [], scafoldingBlocks: [] } },
    inventory: { slots: [], items: () => Object.entries(bag).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })), emptySlotCount: () => 30 },
    blockAt(p) {
      const f = p.floored();
      const name = f.equals(portal) ? 'nether_portal' : f.x === chest.x && f.y === chest.y && f.z === chest.z ? 'chest'
        : f.x === stations.crafting_table.x && f.y === stations.crafting_table.y && f.z === stations.crafting_table.z ? 'crafting_table'
          : f.y < 64 ? (dimension === 'the_nether' ? 'netherrack' : 'stone') : 'air';
      return { name, position: f, boundingBox: ['air', 'nether_portal'].includes(name) ? 'empty' : 'block' };
    },
    findBlocks: ({ matching }) => [].concat(matching).includes(1) ? [portal] : [],
  });
  const events = [];
  let travelCalls = 0;
  t.mock.method(nether, 'travel', async () => { travelCalls += 1; return { ok: false, reason: 'MODELED_stop_before_travel' }; });
  const ctx = { signal: new AbortController().signal, perceive: () => perceive(bot),
    record: (type, data) => events.push({ type, ...data }) };
  return { bot, bag, portal, ctx, events, entries: () => travelCalls };
}

test('observed post-death hp20/hunger20 with tools but zero food stops before entering the remembered portal', async (t) => {
  const f = fixture(t);
  const goal = createNetherQuartzGoal({ bot: f.bot, count: 8 });
  goal.memory.overworldPortal = f.portal;
  const result = await goal.run(f.ctx);
  assert.equal(result.reason, 'needs_supplies');
  assert.deepEqual(result.missing, ['food']);
  assert.equal(result.food, 0);
  assert.equal(result.requiredFood, QUARTZ_MIN_FOOD);
  assert.equal(result.armorPieces, 0);
  assert.deepEqual(result.protectionMissing, ['gold_armor']);
  assert.equal(f.entries(), 0);
  assert.equal(f.events.some((e) => e.type === 'portal_enter'), false);
});

test('no_pickaxe remains the first low-level precondition, even when food is also missing', async (t) => {
  const f = fixture(t);
  delete f.bag.stone_pickaxe;
  delete f.bag.wooden_pickaxe;
  const result = await createNetherQuartzGoal({ bot: f.bot }).run(f.ctx);
  assert.equal(result.reason, 'no_pickaxe');
  assert.equal(f.entries(), 0);
});

test('raw chicken and other foods the normal eat policy refuses do not discharge the carried reserve', async (t) => {
  const f = fixture(t, { chicken: 8, rotten_flesh: 8 });
  assert.equal(quartzFoodCount(f.bot), 0);
  const goal = createNetherQuartzGoal({ bot: f.bot });
  goal.memory.overworldPortal = f.portal;
  assert.equal((await goal.run(f.ctx)).reason, 'needs_supplies');
  assert.equal(f.entries(), 0);
});

test('four safe food items permit departure, while unavailable gold protection remains an explicit unresolved gap', async (t) => {
  const f = fixture(t, { cooked_beef: 4 });
  const goal = createNetherQuartzGoal({ bot: f.bot });
  goal.memory.overworldPortal = f.portal;
  assert.equal((await goal.run(f.ctx)).reason, 'MODELED_stop_before_travel');
  assert.equal(f.entries(), 1);
  const supplies = f.events.find((e) => e.type === 'quartz_supplies');
  assert.equal(supplies.food, 4);
  assert.equal(supplies.goldArmor, false);
  assert.deepEqual(supplies.protectionMissing, ['gold_armor']);
});

test('the original first trip keeps its supplied 24 beef; a supplied gold helmet is observed, not fabricated', async (t) => {
  const f = fixture(t, { cooked_beef: 24 });
  f.bot.inventory.slots[5] = { name: 'golden_helmet', count: 1 };
  const goal = createNetherQuartzGoal({ bot: f.bot });
  goal.memory.overworldPortal = f.portal;
  await goal.run(f.ctx);
  assert.equal(f.bag.cooked_beef, 24);
  assert.equal(f.entries(), 1);
  assert.equal(f.events.find((e) => e.type === 'quartz_supplies').goldArmor, true);
});

test('low health without regeneration hunger stays outside even with a carried reserve', async (t) => {
  const f = fixture(t, { cooked_beef: 4 });
  f.bot.health = 10;
  f.bot.food = 16;
  const goal = createNetherQuartzGoal({ bot: f.bot });
  goal.memory.overworldPortal = f.portal;
  const result = await goal.run(f.ctx);
  assert.equal(result.reason, 'needs_supplies');
  assert.deepEqual(result.missing, ['health']);
  assert.equal(f.entries(), 0);
});

test('one remaining food item sends the quartz trip home before it starts another mining leg', async (t) => {
  const f = fixture(t, { cooked_beef: 1 }, { dimension: 'the_nether' });
  let mined = 0;
  const goal = createNetherQuartzGoal({ bot: f.bot, skills: { gatherOne: async () => { mined += 1; return { ok: true }; } } });
  goal.memory.netherPortal = f.portal;
  await goal.run(f.ctx);
  assert.equal(mined, 0);
  assert.equal(f.entries(), 1);
  assert.ok(f.events.some((e) => e.type === 'retreat' && e.food === 1 && e.missing.includes('food')));
});

test('after death the material parent hunts naturally to four, keeps the food out of the chest, then attempts entry', async (t) => {
  const f = fixture(t);
  let hunts = 0;
  let storedFood = 0;
  const skills = {
    huntOne: async (_bot, _ctx, { mobs, dropMatch }) => {
      assert.equal(mobs.includes('chicken'), false);
      assert.equal(dropMatch('chicken'), false);
      assert.equal(dropMatch('beef'), true);
      f.bag.beef = (f.bag.beef || 0) + 2;
      hunts += 1;
      return { ok: true, gained: 2 };
    },
    storeInChest: async (_bot, _ctx, { wants }) => {
      storedFood += wants.filter((w) => w.match('beef')).length;
      return { ok: true, contents: {} };
    },
  };
  const goal = createGatherMaterialsGoal({ bot: f.bot, chest, stations, requirements: [{ key: 'quartz', count: 8 }], skills, actions: {} });
  goal.memory.chest = {};
  await goal.run(f.ctx);
  assert.equal(hunts, 1);
  assert.equal(f.entries(), 0);
  await goal.run(f.ctx);
  assert.equal(hunts, 2);
  assert.equal(quartzFoodCount(f.bot), 4);
  assert.equal(f.entries(), 0);
  await goal.run(f.ctx);
  assert.equal(f.entries(), 1);
  assert.equal(storedFood, 0);
  assert.equal(f.bag.beef, 4);
});

test('the material parent cannot count a bag of raw chicken as restored food', async (t) => {
  const f = fixture(t, { chicken: 4 });
  let hunts = 0;
  const goal = createGatherMaterialsGoal({ bot: f.bot, chest, stations, requirements: [{ key: 'quartz', count: 8 }],
    skills: { huntOne: async (_bot, _ctx, { dropMatch }) => { assert.equal(dropMatch('chicken'), false); hunts += 1; return { ok: false, reason: 'no_mob_in_range' }; },
      explore: async () => ({ ok: true, moved: 24 }) }, actions: {} });
  goal.memory.chest = {};
  await goal.run(f.ctx);
  assert.equal(hunts, 1);
  assert.equal(f.entries(), 0);
  assert.ok(f.events.some((e) => e.type === 'needs_supplies' && e.food === 0));
});

test('unavailable natural food is reported as needs_supplies after bounded searching, not bypassed with a portal retry', async (t) => {
  const f = fixture(t);
  const goal = createGatherMaterialsGoal({ bot: f.bot, chest, stations, requirements: [{ key: 'quartz', count: 8 }], maxExploreStreak: 1,
    skills: { huntOne: async () => ({ ok: false, reason: 'no_mob_in_range' }), pickBerries: async () => ({ ok: false, reason: 'no_berries' }),
      explore: async () => ({ ok: true, moved: 24 }) }, actions: {} });
  goal.memory.chest = {};
  await goal.run(f.ctx);
  const result = await goal.run(f.ctx);
  assert.equal(result.reason, 'needs_supplies');
  assert.equal(result.cause, 'exhausted:food');
  assert.deepEqual(result.missing, ['food']);
  assert.equal(f.entries(), 0);
});
