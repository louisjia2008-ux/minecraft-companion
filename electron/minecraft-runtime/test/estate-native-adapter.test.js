/* global require */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { estateFarmActionTarget, createEstateNativeAdapter } = require('../vendor/server/minecraft/estateNativeAdapter');
const WorldSync = require('prismarine-world/src/worldsync');

test('native crop interactions prove sight against actual lowered farmland collision rather than shapeless wheat', () => {
  const soil = new Vec3(0, 64, 0);
  const at = p => Object.assign(Block.fromProperties(registry.blocksByName[p.equals(soil) ? 'farmland' : p.equals(soil.offset(0, 1, 0)) ? 'wheat' : 'air'].id,
    p.equals(soil) ? { moisture: 7 } : p.equals(soil.offset(0, 1, 0)) ? { age: 7 } : {}, 0), { position: p });
  const world = { getBlock: at, raycast: WorldSync.prototype.raycast };
  const bot = { blockAt: at };
  assert.equal(at(soil.offset(0, 1, 0)).shapes.length, 0);
  for (const action of ['bone_meal', 'harvest_crop']) {
    const target = estateFarmActionTarget(bot, soil.offset(0, 1, 0), action);
    assert.ok(target.cell.equals(soil));
    assert.equal(target.point.y, 64.9365);
    const eye = new Vec3(2.5, 66.62, 0.5);
    assert.ok(world.raycast(eye, target.point.minus(eye).normalize(), 4.5).position.equals(soil));
  }
});

test('window opened just as cancellation arrives is always closed and never reported usable', async () => {
  let cancelled = false, closed = 0, calls = 0;
  const position = { x: 0, y: 64, z: 0 };
  const door = { lower: position, upper: { ...position, y: 65 } };
  const openBlock = { getProperties: () => ({ open: true }) };
  const adapter = createEstateNativeAdapter({
    getBot: () => ({ blockAt: () => openBlock }),
    assertActive: () => { if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); },
    moveTo: async () => {}, wait: async () => {},
    openCraftingTable: async () => { calls += 1; cancelled = true; return { close: () => { closed += 1; } }; },
  });
  await assert.rejects(adapter.verifyFurniture({ furniture: { door, doors: [door], craftingTable: position } }), { code: 'cancelled' });
  assert.equal(calls, 1); assert.equal(closed, 1);
});

test('construction explicitly opens only confirmed blueprint door pairs before later component travel', async () => {
  let opened = false, uses = 0, moves = 0;
  const lower = { x: 0, y: 64, z: 0 }, upper = { ...lower, y: 65 };
  const block = p => ({ name: 'oak_door', position: p, getProperties: () => ({ half: p.y === 64 ? 'lower' : 'upper',
    facing: 'north', hinge: 'left', open: opened }) });
  const adapter = createEstateNativeAdapter({ getBot: () => ({ blockAt: block }), assertActive: () => {},
    moveTo: async () => { moves += 1; }, activateBlock: async () => { uses += 1; opened = true; }, wait: async () => {} });
  const b = { furniture: { doors: [{ lower, upper, facing: 'north' }] } };
  await adapter.openConstructionDoors(b); await adapter.openConstructionDoors(b);
  assert.equal(uses, 1); assert.equal(moves, 1);
  const mismatched = createEstateNativeAdapter({ getBot: () => ({ blockAt: p => ({ ...block(p),
    getProperties: () => ({ ...block(p).getProperties(), facing: p.y === 64 ? 'north' : 'south' }) }) }), assertActive: () => {},
    activateBlock: async () => { throw new Error('Do not touch a changed pair'); } });
  await assert.rejects(mismatched.openConstructionDoors(b), { code: 'estate_door_unconfirmed' });
});
