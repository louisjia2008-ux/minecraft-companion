/* global require */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planEstateMaterialBatch, createEstateMaterialSupply } = require('../vendor/server/minecraft/estateMaterials');

function fixture({ full = false, amount = 64, existing = 0 } = {}) {
  let cancelled = false;
  let stock = amount;
  let opened = 0;
  let closed = 0;
  let withdrawals = 0;
  const slots = Array(46).fill(null);
  if (full) for (let index = 9; index < 45; index += 1) slots[index] = { name: 'stone', count: 64 };
  else if (existing) slots[9] = { name: 'oak_planks', count: existing };
  const bot = { registry: { itemsByName: { oak_planks: { id: 1, stackSize: 64 } } },
    inventory: { slots, inventoryStart: 9, inventoryEnd: 45, items: () => slots.slice(9, 45).filter(Boolean) } };
  let pending = 0;
  const deps = { getBot: () => bot, assertActive: () => { if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); },
    isDepotAllowed: () => true, reachDepot: async () => {}, report: () => {},
    openDepot: async () => { opened += 1; return {
      containerItems: () => stock ? [{ name: 'oak_planks', count: stock, slot: 0 }] : [],
      withdraw: async (id, metadata, count) => { assert.equal(id, 1); stock -= count; pending += count; withdrawals += 1; },
      close: () => { closed += 1; if (pending) { slots[9] = { name: 'oak_planks', count: (slots[9]?.count || 0) + pending }; pending = 0; } },
    }; },
  };
  return { deps, bot, cancel: () => { cancelled = true; }, counts: () => ({ stock, opened, closed, withdrawals }),
    supply: () => createEstateMaterialSupply(deps) };
}

test('large manifests are divided into bounded real-stack batches and derived cells consume no extra items', () => {
  const specs = Array.from({ length: 400 }, (_, index) => ({ id: index, item: 'white_bed' }));
  specs.unshift({ item: 'white_bed', derived: true });
  const batch = planEstateMaterialBatch(specs, { stackSize: () => 1 });
  assert.equal(batch.blocks.length, 12);
  assert.deepEqual(batch.requirements, { white_bed: 12 });
  assert.equal(planEstateMaterialBatch(Array.from({ length: 400 }, () => ({ item: 'oak_planks' }))).blocks.length, 96);
});

test('depot withdrawals confirm the closed-window inventory instead of using old player slot numbers', async () => {
  const f = fixture();
  const result = await f.supply().ensure({ oak_planks: 24 }, [{ x: 0, y: 64, z: 0 }]);
  assert.equal(result.confirmed, true);
  assert.equal(f.bot.inventory.items()[0].count, 24);
  assert.deepEqual(f.counts(), { stock: 40, opened: 1, closed: 1, withdrawals: 1 });
});

test('missing stock reports the actual deficit and never searches unrelated containers', async () => {
  const f = fixture({ amount: 8 });
  await assert.rejects(f.supply().ensure({ oak_planks: 24 }, [{ x: 0, y: 64, z: 0 }]), (error) => {
    assert.equal(error.code, 'house_materials_missing');
    assert.deepEqual(error.missingMaterials, [{ item: 'oak_planks', required: 24, available: 8, missing: 16 }]);
    return true;
  });
  assert.equal(f.counts().withdrawals, 1);
});

test('resupply reconciles existing partial stacks and a resumed satisfied batch performs no IO', async () => {
  const f = fixture({ existing: 17 });
  const supply = f.supply();
  await supply.ensure({ oak_planks: 24 }, [{ x: 0, y: 64, z: 0 }]);
  assert.equal(supply.count('oak_planks'), 24);
  assert.equal(f.counts().stock, 57);
  await supply.ensure({ oak_planks: 24 }, [{ x: 0, y: 64, z: 0 }]);
  assert.equal(f.counts().withdrawals, 1);
});

test('full inventory preserves all player items and performs no withdrawal', async () => {
  const f = fixture({ full: true });
  await assert.rejects(f.supply().ensure({ oak_planks: 24 }, [{ x: 0, y: 64, z: 0 }]), { code: 'estate_inventory_full' });
  assert.equal(f.counts().withdrawals, 0);
  assert.equal(f.bot.inventory.items().length, 36);
});

test('cancellation after opening closes its window without a late withdrawal', async () => {
  const f = fixture();
  const open = f.deps.openDepot;
  f.deps.openDepot = async (position) => { const window = await open(position); f.cancel(); return window; };
  await assert.rejects(f.supply().ensure({ oak_planks: 24 }, [{ x: 0, y: 64, z: 0 }]), { code: 'cancelled' });
  assert.equal(f.counts().withdrawals, 0);
  assert.equal(f.counts().closed, 1);
});

test('unauthorized or overlapping depot locations fail before native container access', async () => {
  const f = fixture(); f.deps.isDepotAllowed = () => false;
  await assert.rejects(f.supply().ensure({ oak_planks: 24 }, [{ x: 0, y: 64, z: 0 }]), { code: 'estate_invalid_depot' });
  assert.equal(f.counts().opened, 0);
});
