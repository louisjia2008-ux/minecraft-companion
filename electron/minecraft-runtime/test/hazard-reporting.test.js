/* global require */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { createDiamondExpedition, getMiningLevels } = require('../vendor/server/minecraft/diamondExpedition');
const key = (point) => `${Math.floor(point.x)},${Math.floor(point.y)},${Math.floor(point.z)}`;

// Offline reporting contract only. Actual expedition and checked voxel navigator
// encounter registry blocks; the adjacent-cell movement dependency is explicit
// and does not claim a physics or natural-server acceptance result.
function fixture(lava) {
  const cells = new Map();
  const reports = [];
  const moves = [];
  const bot = Object.assign(new EventEmitter(), { version: '1.21.8', registry, health: 20, food: 20,
    game: { dimension: 'overworld', minY: -64, height: 384 },
    entity: { position: new Vec3(0.5, 12, 0.5) },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1, metadata: 0, type: registry.itemsByName.iron_pickaxe.id }] },
    blockAt: (point) => Object.assign(Block.fromStateId(registry.blocksByName[cells.get(key(point))
      ?? (point.y < 12 ? 'stone' : 'air')].defaultState), { position: point.floored() }),
    canDigBlock: () => true,
  });
  for (const [x, z] of [[1, 0], [0, 1], [0, -1], [-1, 0]]) cells.set(`${x},10,${z}`, 'air');
  if (lava) cells.set('1,10,0', 'lava'); // The preferred down-step really sees lava first.
  const levels = getMiningLevels(bot, { targetY: 11 });
  let checkpoint = { schema: 1, targetCount: 1, levels, targetY: 11, phase: 'starting',
    heading: 0, searchSteps: 0, avoidedHazards: 0, ignoredOres: [], base: { x: 0, y: 12, z: 0 },
    prepared: true, stonePrepared: true, foodPrepared: true, ironPrepared: true };
  const expedition = createDiamondExpedition({ getBot: () => bot,
    getCheckpoint: () => checkpoint, saveCheckpoint: (state) => { checkpoint = state; },
    report: (message, state) => reports.push({ message, state }),
    equipItem: async (item) => { bot.heldItem = item; },
    digBlock: async (block) => {
      assert.ok(block.position.distanceTo(bot.entity.position) <= 4.5);
      assert.equal(block.name, 'stone');
      cells.set(key(block.position), 'air');
    }, collectDrops: async () => {},
    navigationOptions: { moveTo: async (target) => {
      const from = bot.entity.position.floored();
      assert.equal(Math.abs(target.x - from.x) + Math.abs(target.z - from.z), 1);
      assert.ok(Math.abs(target.y - from.y) <= 1);
      assert.equal(bot.blockAt(target).boundingBox, 'empty');
      assert.equal(bot.blockAt(target.offset(0, 1, 0)).boundingBox, 'empty');
      assert.equal(bot.blockAt(target.offset(0, -1, 0)).boundingBox, 'block');
      moves.push({ from, target });
      bot.entity.position = target.offset(0.5, 0, 0.5);
    } },
  });
  return { bot, cells, reports, moves,
    run: () => expedition.run({ args: { count: 1, targetY: 11, maxSearchSteps: 8 } }) };
}

test('level detour report retains the first actual lava rejection when later directions reject ordinary missing support', async () => {
  const f = fixture(true);
  await assert.rejects(f.run(), (error) => error.code === 'mining_search_exhausted');
  const detourIndex = f.reports.findIndex((report) => report.message.includes('沿安全同层通道绕行'));
  assert.ok(detourIndex >= 2);
  const detour = f.reports[detourIndex];
  const rejections = f.reports.slice(0, detourIndex).filter((report) => report.message.startsWith('前方存在危险'));
  assert.equal(detour.state.avoidedHazards, 4, 'All four actual direction attempts rejected before planning the level detour');
  assert.ok(rejections.length >= 2, 'Identical consecutive reports may be deduplicated by production publish');
  assert.match(rejections[0].message, /lava/);
  assert.doesNotMatch(rejections[rejections.length - 1].message, /lava/);
  assert.match(detour.message, /lava/);
  assert.match(detour.message, /洞穴|搭桥|地板|支撑/);
  assert.equal((detour.message.match(/前方是洞穴/g) || []).length, 1, 'Repeated actual rejection messages are deduplicated');
  assert.equal(f.cells.get('1,10,0'), 'lava');
  assert.ok(f.moves.some((move) => move.target.y === move.from.y), 'Checked level detour really executes');
  assert.ok(f.reports.slice(detourIndex + 1).some((report) => report.state.searchSteps > detour.state.searchSteps));
});

test('ordinary missing-support rejections cannot manufacture a lava reason in the detour report', async () => {
  const f = fixture(false);
  await assert.rejects(f.run(), (error) => error.code === 'mining_search_exhausted');
  const detour = f.reports.find((report) => report.message.includes('沿安全同层通道绕行'));
  assert.ok(detour);
  assert.match(detour.message, /洞穴|搭桥|地板|支撑/);
  assert.equal(f.reports.some((report) => /lava/.test(report.message)), false);
  assert.ok(f.moves.some((move) => move.target.y === move.from.y));
});
