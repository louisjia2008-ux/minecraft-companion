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
  const movements = { maxDropDown: 4, blocksCantBreak: new Set([1]), exclusionAreasStep: [() => 0] };
  const bot = { ...makeWorld(), pathfinder: { movements },
    registry: { blocksByName: { nether_gold_ore: { id: 7 }, obsidian: { id: 8 } } } };
  const restore = nether.applyNetherMovements(bot);
  assert.equal(movements.maxDropDown, 3);
  assert.ok(movements.blocksCantBreak.has(7) && movements.blocksCantBreak.has(8));
  assert.equal(movements.exclusionAreasStep.length, 2);
  nether.applyNetherMovements(bot)();
  assert.equal(movements.exclusionAreasStep.length, 2, 'a second apply is a no-op');
  restore();
  assert.equal(movements.maxDropDown, 4);
  assert.deepEqual([...movements.blocksCantBreak], [1]);
  assert.equal(movements.exclusionAreasStep.length, 1);
});
