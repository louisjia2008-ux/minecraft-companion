'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const nether = require('../core/nether');

// A voxel world: everything below y=64 is netherrack unless set otherwise.
function makeWorld(overrides = {}, dimension = 'the_nether') {
  const blocks = new Map(Object.entries(overrides));
  const blockAt = (p) => {
    const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
    const name = blocks.get(key) || (Math.floor(p.y) < 64 ? 'netherrack' : 'air');
    return { name, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
      boundingBox: /^(air|lava|fire|nether_portal)$/.test(name) ? 'empty' : 'block' };
  };
  return { blockAt, game: { dimension }, entity: { position: new Vec3(0.5, 64, 0.5) } };
}

test('dimension names are normalized', () => {
  assert.equal(nether.dimension({ game: { dimension: 'minecraft:the_nether' } }), 'the_nether');
  assert.equal(nether.inNether({ game: { dimension: 'the_nether' } }), true);
  assert.equal(nether.inNether({ game: { dimension: 'overworld' } }), false);
});

test('portal frame has 10 obsidian cells, 4 corners and a 2x3 interior', () => {
  const frame = nether.portalFrame(new Vec3(0, 64, 0), 'x');
  assert.equal(frame.cells.filter((c) => !c.corner).length, 10);
  assert.equal(frame.cells.filter((c) => c.corner).length, 4);
  assert.equal(frame.interior.length, 6);
  // Every cell rests on, or hangs from, a cell placed before it.
  const placed = new Set();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  for (const cell of frame.cells) {
    const supported = cell.pos.y === 64 || placed.has(key(cell.pos.offset(0, -1, 0)))
      || (cell.against && placed.has(key(cell.against)));
    assert.ok(supported, `unsupported ${key(cell.pos)}`);
    placed.add(key(cell.pos));
  }
  assert.deepEqual(frame.front, new Vec3(0, 0, 1));
  assert.ok(nether.portalFrame(new Vec3(0, 64, 0), 'z').interior.every((p) => p.x === 0));
});

test('a flat open site is accepted, lava in front or blocks in the frame are not', () => {
  const base = new Vec3(0, 64, 0);
  assert.ok(nether.portalSiteOk(makeWorld(), base, 'x'));
  assert.ok(!nether.portalSiteOk(makeWorld({ '1,63,1': 'lava' }), base, 'x'));
  assert.ok(!nether.portalSiteOk(makeWorld({ '2,66,0': 'netherrack' }), base, 'x'));
});

test('cells by lava cost more, standing in or over lava is effectively banned', () => {
  const bot = makeWorld({ '3,64,0': 'lava', '0,63,5': 'lava' });
  assert.equal(nether.lavaRisk(bot, new Vec3(0, 64, 0)), 0);
  assert.ok(nether.lavaRisk(bot, new Vec3(2, 64, 0)) >= 60);
  assert.ok(nether.lavaRisk(bot, new Vec3(1, 64, 5)) >= 30);
  assert.equal(nether.lavaRisk(bot, new Vec3(0, 64, 5)), 1000);
});

test('nether movements are applied once and fully restored', () => {
  const movements = { maxDropDown: 4, digCost: 1, blocksCantBreak: new Set([1]), exclusionAreasStep: [() => 0], scafoldingBlocks: [20, 21],
    allowSprinting: true };
  const bot = { ...makeWorld(), pathfinder: { movements },
    registry: { blocksByName: { nether_gold_ore: { id: 7 }, obsidian: { id: 8 } }, itemsByName: { netherrack: { id: 21 }, cobblestone: { id: 20 } } } };
  const restore = nether.applyNetherMovements(bot);
  assert.equal(movements.maxDropDown, 3);
  assert.ok(movements.digCost > 1, 'digging costs more than walking around');
  assert.ok(movements.blocksCantBreak.has(7) && movements.blocksCantBreak.has(8));
  assert.equal(movements.exclusionAreasStep.length, 2);
  assert.deepEqual(movements.scafoldingBlocks, [21], 'cobblestone is kept for lava steps');
  assert.equal(movements.allowSprinting, false, 'no sprinting along fortress bridges');
  nether.applyNetherMovements(bot)();
  assert.equal(movements.exclusionAreasStep.length, 2, 'a second apply is a no-op');
  restore();
  assert.equal(movements.maxDropDown, 4);
  assert.equal(movements.digCost, 1);
  assert.equal(movements.allowSprinting, true);
  assert.deepEqual(movements.scafoldingBlocks, [20, 21]);
  assert.deepEqual([...movements.blocksCantBreak], [1]);
  assert.equal(movements.exclusionAreasStep.length, 1);
});

test('a cell beside a long drop costs more, a step down does not', () => {
  // A bridge at y 64: floor at 63 for x <= 0, a drop to below 59 at x = 1.
  const drop = {};
  for (let y = 58; y <= 63; y += 1) drop[`1,${y},0`] = 'air';
  const bridge = makeWorld(drop);
  assert.equal(nether.edgeRisk(bridge, new Vec3(0, 64, 0)), 15);
  assert.equal(nether.edgeRisk(bridge, new Vec3(-1, 64, 0)), 0);
  assert.equal(nether.edgeRisk(makeWorld({ '1,63,0': 'air' }), new Vec3(0, 64, 0)), 0, 'a one-block step is no edge');
});

test('lifting the lava margins keeps lava cells shut and restores the nether costs', async () => {
  const movements = { maxDropDown: 4, digCost: 1, blocksCantBreak: new Set(), exclusionAreasStep: [], scafoldingBlocks: [] };
  const bot = { ...makeWorld({ '3,64,0': 'lava', '0,63,5': 'magma_block' }), pathfinder: { movements },
    registry: { blocksByName: {}, itemsByName: { netherrack: { id: 21 } } } };
  const restore = nether.applyNetherMovements(bot);
  const cost = (x, y, z) => movements.exclusionAreasStep.reduce((sum, f) => sum + f({ position: new Vec3(x, y, z) }), 0);
  assert.ok(cost(2, 64, 0) >= 60, 'beside lava costs extra');
  const inside = await nether.withLavaMarginsLifted(bot, () => ({ beside: cost(2, 64, 0), over: cost(0, 64, 5), into: cost(3, 64, 0), dig: movements.digCost }));
  assert.deepEqual(inside, { beside: 0, over: 1000, into: 1000, dig: 1 });
  assert.ok(cost(2, 64, 0) >= 60, 'margins back afterwards');
  assert.equal(movements.digCost, 6);
  restore();
  assert.equal(movements.exclusionAreasStep.length, 0);
});

const { EventEmitter } = require('node:events');
const { createSurvivalBehaviors } = require('../core/behaviors/survival');

function piglinBot() {
  const bot = new EventEmitter();
  bot.entity = { position: new Vec3(0, 64, 0) };
  bot.game = { dimension: 'the_nether' };
  bot.inventory = { slots: [], items: () => [] };
  bot.registry = { foodsByName: {} };
  bot.entities = { 7: { id: 7, name: 'zombified_piglin', position: new Vec3(2, 64, 0) } };
  return bot;
}
const nearPiglin = (bot) => ({ alive: true, health: 20, food: 20, position: bot.entity.position, inventory: {},
  hostiles: [{ id: 7, name: 'zombified_piglin', distance: 2, position: bot.entities[7].position }] });

test('a calm zombified piglin beside the bot is not attacked after unrelated damage', () => {
  const bot = piglinBot();
  const defend = createSurvivalBehaviors({ bot }).find((b) => b.name === 'defend');
  bot.emit('entityHurt', bot.entity); // an arrow or a fall: the piglin did not swing
  assert.equal(defend.want(nearPiglin(bot)), 0);
});

test('a zombified piglin that swung just before the hit is fought back', () => {
  const bot = piglinBot();
  const defend = createSurvivalBehaviors({ bot }).find((b) => b.name === 'defend');
  bot.emit('entitySwingArm', bot.entities[7]);
  bot.emit('entityHurt', bot.entity);
  assert.equal(defend.want(nearPiglin(bot)), 1);
});

const { createNetherQuartzGoal } = require('../core/goals/netherQuartz');

test('returning to the overworld restores the overworld movement settings', async () => {
  const movements = { maxDropDown: 4, blocksCantBreak: new Set(), exclusionAreasStep: [] };
  const bot = { ...makeWorld({ '0,64,0': 'nether_portal' }), pathfinder: { movements },
    registry: { blocksByName: { nether_portal: { id: 1 } } },
    inventory: { slots: [], items: () => [{ name: 'iron_pickaxe' }] },
    findBlocks: () => [new Vec3(0, 64, 0)] };
  bot.entity.position = new Vec3(0.5, 64, 0.5);
  // Stands in the portal already: travel only waits for the dimension to change.
  bot.waitForChunksToLoad = async () => {};
  setTimeout(() => { bot.game.dimension = 'overworld'; }, 50);
  const goal = createNetherQuartzGoal({ bot, count: 1 });
  const ctx = { signal: new AbortController().signal, record: () => {}, perceive: () => ({ inventory: { quartz: 1 } }) };
  bot.clearControlStates = () => {};
  const result = await goal.run(ctx);
  assert.equal(result.ok, true);
  assert.equal(bot.game.dimension, 'overworld');
  assert.equal(movements.maxDropDown, 4);
  assert.equal(movements.exclusionAreasStep.length, 0);
});

test('a swing next to a hit is not blamed while a wither skeleton could have dealt it', () => {
  const bot = piglinBot();
  bot.entities[9] = { id: 9, name: 'wither_skeleton', position: new Vec3(-2, 64, 0) };
  const defend = createSurvivalBehaviors({ bot }).find((b) => b.name === 'defend');
  bot.emit('entitySwingArm', bot.entities[7]);
  bot.emit('entityHurt', bot.entity);
  bot.emit('entitySwingArm', bot.entities[7]);
  bot.emit('entityHurt', bot.entity);
  assert.equal(defend.want(nearPiglin(bot)), 0);
  // Once the skeleton is gone, a swing before a hit is the pack's own.
  delete bot.entities[9];
  bot.emit('entitySwingArm', bot.entities[7]);
  bot.emit('entityHurt', bot.entity);
  assert.equal(defend.want(nearPiglin(bot)), 1);
});

test('quartz next to a fortress is left alone: blazes spawn there', async () => {
  const bricks = Array.from({ length: 30 }, (_, i) => new Vec3(10 + i, 64, 0));
  const bot = { ...makeWorld(), pathfinder: { movements: { maxDropDown: 4, blocksCantBreak: new Set(), exclusionAreasStep: [] } },
    registry: { blocksByName: { nether_portal: { id: 1 }, nether_bricks: { id: 2 } } },
    inventory: { slots: [], items: () => [{ name: 'iron_pickaxe' }] },
    findBlocks: ({ matching }) => ([].concat(matching).includes(2) ? bricks : []) };
  let exclude = null;
  const skills = { gatherOne: async (_b, _c, options) => { exclude = options.exclude; return { ok: true }; } };
  const goal = createNetherQuartzGoal({ bot, count: 1, skills });
  goal.memory.netherPortal = new Vec3(0, 64, 0);
  const ctx = { signal: new AbortController().signal, record: () => {}, perceive: () => ({ inventory: {} }) };
  await goal.run(ctx);
  assert.equal(exclude(new Vec3(20, 40, 0)), true, 'ore in the fortress');
  assert.equal(exclude(new Vec3(-50, 40, 0)), false, 'ore on the far side of the portal');
});

test('a Nether portal blown out is lit again from its frame before going home', async () => {
  // Frame along x from base 0,63,0: obsidian at u=0..3, y=63..67, interior air.
  const blocks = {};
  for (const c of nether.portalFrame(new Vec3(0, 63, 0), 'x').cells) if (!c.corner) blocks[`${c.pos.x},${c.pos.y},${c.pos.z}`] = 'obsidian';
  const bot = { ...makeWorld(blocks), pathfinder: { movements: { maxDropDown: 4, blocksCantBreak: new Set(), exclusionAreasStep: [] } },
    registry: { blocksByName: { nether_portal: { id: 1 } } },
    inventory: { slots: [], items: () => [{ name: 'iron_pickaxe' }] }, findBlocks: () => [] };
  const goal = createNetherQuartzGoal({ bot, count: 1 });
  goal.memory.netherPortal = new Vec3(2, 64, 0);
  const records = [];
  const ctx = { signal: new AbortController().signal, record: (type) => records.push(type), perceive: () => ({ inventory: { quartz: 1 } }) };
  const result = await goal.run(ctx);
  assert.ok(records.includes('portal_relight'));
  // No flint and steel in this bag: the relight is tried and says why it failed.
  assert.equal(result.reason, 'no_igniter');
});

test('a worn-out pickaxe in the Nether sends the bot home, not round in circles', async () => {
  const bot = { ...makeWorld({}), pathfinder: { movements: { maxDropDown: 4, blocksCantBreak: new Set(), exclusionAreasStep: [] } },
    registry: { blocksByName: { nether_portal: { id: 1 } } },
    inventory: { slots: [], items: () => [{ name: 'iron_sword' }] }, findBlocks: () => [] };
  const goal = createNetherQuartzGoal({ bot, count: 8 });
  const records = [];
  const ctx = { signal: new AbortController().signal, record: (type, data) => records.push({ type, ...data }), perceive: () => ({ inventory: {} }) };
  const result = await goal.run(ctx);
  assert.ok(records.some((r) => r.type === 'retreat' && r.pickaxe === false));
  assert.equal(result.reason, 'nether_portal_lost');
});
