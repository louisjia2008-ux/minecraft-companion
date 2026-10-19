/* global require, setTimeout */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('minecraft-data')('1.21.8');
const { Recipe } = require('prismarine-recipe')(registry);
const { createHouseMaterialRecipes, planHouseMaterialBatch, DEFAULT_RAW } = require('../vendor/server/minecraft/houseMaterialRecipes');
const { createFurnishedHouseBlueprint, getFurnishedHouseMaterialBudget } = require('../vendor/server/minecraft/furnishedHouseBlueprints');
const { createEstateBlueprint, getEstateMaterialBudget } = require('../vendor/server/minecraft/estateBlueprints');
const { CancellationToken } = require('../vendor/server/minecraft/agentControl');

// This is an inventory transaction unit fixture, not Minecraft live evidence.
// All recipe shapes, counts and requiresTable flags are the installed originals.
function fixture(initial = {}, overrides = {}) {
  const stock = { ...initial }; const calls = []; let controller;
  const deps = {
    registry, recipesAll: (id, metadata) => Recipe.find(id, metadata),
    getItemCount: name => stock[name] || 0, assertActive: () => {},
    readbackMs: 40, pollMs: 5,
    acquireRaw: async (name, amount, context) => {
      calls.push({ kind: 'raw', name, amount, target: context.targetCount });
      stock[name] = (stock[name] || 0) + amount;
    },
    craftRecipe: async (recipe, repetitions, context) => {
      calls.push({ kind: 'craft', recipe, repetitions, context });
      for (const [name, needed] of Object.entries(controller.inputsFor(recipe, repetitions))) assert.ok((stock[name] || 0) >= needed, `Missing actual fixture ingredient ${name}`);
      for (const delta of recipe.delta) {
        const name = registry.items[delta.id].name;
        stock[name] = (stock[name] || 0) + delta.count * repetitions;
      }
    },
    smeltBatch: async ({ input, output, count }) => {
      calls.push({ kind: 'smelt', input, output, count });
      assert.ok((stock[input] || 0) >= count);
      stock[input] -= count; stock[output] = (stock[output] || 0) + count;
    },
    ...overrides,
  };
  controller = createHouseMaterialRecipes(deps);
  return { controller, stock, calls };
}

test('three original logs cover table, wooden sword and pick without a reserve harvest',async()=>{
 const f=fixture({oak_log:3});
 await f.controller.ensure({crafting_table:1,wooden_sword:1,wooden_pickaxe:1});
 assert.equal(f.calls.some(c=>c.kind==='raw'),false);
 for(const name of ['crafting_table','wooden_sword','wooden_pickaxe'])assert.equal(f.stock[name],1);
});

test('the installed chestplate recipe reuses the raw-iron smelt chain and never crafts a second completed plate',async()=>{
 const f=fixture();await f.controller.ensure({iron_chestplate:1});
 assert.equal(f.stock.iron_chestplate,1);
 assert.equal(f.calls.filter(c=>c.kind==='raw'&&c.name==='raw_iron').reduce((n,c)=>n+c.amount,0),8);
 assert.equal(f.calls.filter(c=>c.kind==='smelt'&&c.output==='iron_ingot').reduce((n,c)=>n+c.count,0),8);
 const before=f.calls.length;await f.controller.ensure({iron_chestplate:1});assert.equal(f.calls.length,before);
});

test('basic tools prefetch one stone batch and wood before quarry stick consumption', async () => {
  const f=fixture({wooden_pickaxe:1,oak_planks:3});
  const basic={stone_sword:1,stone_pickaxe:1,stone_axe:1,oak_planks:6};
  await f.controller.prefetchRaw(basic);
  const raw=f.calls.filter(c=>c.kind==='raw');
  assert.deepEqual(raw.map(c=>[c.name,c.amount]),[['oak_log',2],['cobblestone',8]]);
  await f.controller.ensure({stick:2}); // Native quarry preparation consumes real recipe inputs.
  await f.controller.ensure(basic);
  assert.equal(f.calls.filter(c=>c.kind==='raw').length,2);
  for(const [name,n] of Object.entries(basic))assert.ok(f.stock[name]>=n);
});

test('raw prefetch retains carried stock and does not gather for already owned tools', async () => {
  const f=fixture({stone_sword:1,stone_pickaxe:1,cobblestone:2,stick:2,oak_log:1});
  await f.controller.prefetchRaw({stone_sword:1,stone_pickaxe:1,stone_axe:1});
  assert.deepEqual(f.calls.filter(c=>c.kind==='raw').map(c=>[c.name,c.amount]),[['cobblestone',1]]);
  assert.equal(f.stock.cobblestone,3);
  await f.controller.ensure({stone_axe:1});
  assert.equal(f.stock.stone_axe,1);
});

test('generic shield wood prefetch follows acquired birch instead of forcing the old oak camp species',async()=>{
 const f=fixture({birch_log:4,wooden_pickaxe:1},{rawItems:[...DEFAULT_RAW,'birch_log']});
 const recipe=f.controller.selectRecipe('shield',1);
 const wood=Object.fromEntries(Object.entries(f.controller.inputsFor(recipe)).filter(([name])=>name.endsWith('_planks')));
 assert.deepEqual(wood,{birch_planks:6});
 await f.controller.prefetchRaw({stone_sword:1,stone_pickaxe:1,stone_axe:1,...wood});
 assert.ok(f.calls.filter(c=>c.kind==='raw').every(c=>!c.name.endsWith('_log')));
 await f.controller.ensure({...wood,stone_sword:1,stone_pickaxe:1,stone_axe:1});
 assert.equal(f.stock.birch_planks>=6,true);assert.equal(f.stock.oak_log||0,0);
 const partial=fixture({birch_log:1,birch_planks:1},{rawItems:[...DEFAULT_RAW,'birch_log'],rawCost:name=>name.endsWith('_log')?name==='oak_log'?1:1.01:undefined});
 const selected=partial.controller.selectRecipe('shield',1);
 assert.equal(partial.controller.inputsFor(selected).birch_planks,6,'one additional birch log must beat two oak logs despite the old camp preference');
});

test('owned camp generic recipes use a genuinely acquired tree species while fixed oak building requirements stay oak', async () => {
  const f = fixture({ spruce_log: 1 }, { rawItems: [...DEFAULT_RAW, 'spruce_log'], rawCost: name => name === 'spruce_log' ? 0.1 : undefined });
  await f.controller.ensure({ crafting_table: 1, chest: 1 });
  assert.equal(f.stock.crafting_table, 1); assert.equal(f.stock.chest, 1);
  assert.ok(f.calls.filter(call => call.kind === 'raw').every(call => call.name === 'spruce_log'));
  await f.controller.ensure({ oak_planks: 4 });
  assert.equal(f.stock.oak_planks, 4); assert.ok(f.calls.some(call => call.kind === 'raw' && call.name === 'oak_log'));
});

for (const [profile, logs, cobble, wool] of [
  ['cottage', 75, 59, 3], ['enchanting_library', 130, 75, 3],
  ['medieval_castle', 217, 1005, 3], ['riverside_villa', 317, 149, 6],
]) test(`${profile}: original 1.21.8 recipes expand the complete construction budget`, () => {
  const simple = ['cottage', 'enchanting_library'].includes(profile);
  const b = simple ? createFurnishedHouseBlueprint({ x: 0, y: 64, z: 0 }, { profile })
    : createEstateBlueprint({ x: 0, y: 64, z: 0 }, { profile });
  const budget = simple ? getFurnishedHouseMaterialBudget(b) : getEstateMaterialBudget(b);
  const { controller } = fixture(); const plan = controller.plan(budget);
  assert.equal(plan.rawRequirements.oak_log, logs);
  assert.equal(plan.rawRequirements.cobblestone, cobble);
  assert.equal(plan.rawRequirements.white_wool, wool);
  assert.ok(!Object.keys(plan.rawRequirements).some(name => /stripped|cherry|pale_oak|bamboo/.test(name)));
  if (profile !== 'cottage') {
    assert.equal(plan.rawRequirements.leather, 46); assert.equal(plan.rawRequirements.sugar_cane, 138);
    assert.equal(plan.rawRequirements.obsidian, 4); assert.equal(plan.rawRequirements.diamond, 2);
    const withPickaxe = controller.plan({ ...budget, diamond_pickaxe: 1 });
    assert.equal(withPickaxe.rawRequirements.diamond, 5, 'Three tool diamonds remain additional to two table diamonds');
  }
  assert.equal(plan.surplus.oak_door, profile === 'riverside_villa' ? 1 : 2, 'Native door recipe surplus is retained in the shared planning ledger');
  assert.ok(plan.crafts.every(c => c.outputCount <= 96 && Object.values(c.inputs).every(n => n <= 64)), 'Planned recipe calls remain bounded too');
});

test('recipe cost selects naturally obtainable logs over stripped logs or crafted wood', () => {
  const { controller } = fixture();
  const recipe = controller.selectRecipe('oak_planks', 4);
  assert.deepEqual(controller.inputsFor(recipe), { oak_log: 1 });
  assert.equal(controller.recipeCost(recipe, 1), 1);
  assert.equal(controller.recipeCost(recipe, 1, { inventoryCounts: { oak_log: 1 } }), 0);
  assert.equal(controller.selectRecipe('stripped_oak_log'), null, 'The installed original registry has no craft recipe for stripped logs');
  assert.deepEqual(controller.inputsFor(controller.selectRecipe('stick', 4)), { oak_planks: 2 });
  assert.equal(controller.recipeCost(Recipe.find(registry.itemsByName.oak_wood.id)[0]), 4);
});

test('a shared planning ledger consumes stock once and preserves native recipe surplus', () => {
  const { controller, stock, calls } = fixture({ oak_log: 1 });
  const before = { ...stock };
  const plan = controller.plan({ oak_planks: 3, stick: 4 });
  assert.equal(plan.rawRequirements.oak_log, 1);
  assert.equal(plan.surplus.oak_planks, 3);
  assert.deepEqual(stock, before); assert.equal(calls.length, 0, 'Planning cannot acquire or award inventory');
});

test('96-block and 12-stack blueprint batches exclude derived bed and door cells', () => {
  const specs = Array.from({ length: 200 }, (_, i) => ({ id: `stone:${i}`, item: 'cobblestone' }));
  assert.equal(planHouseMaterialBatch(specs).blocks.length, 96);
  const unstackable = Array.from({ length: 20 }, (_, i) => ({ id: `bucket:${i}`, item: 'water_bucket' }));
  assert.equal(planHouseMaterialBatch(unstackable, { stackSize: name => registry.itemsByName[name].stackSize }).blocks.length, 12);
  assert.deepEqual(planHouseMaterialBatch([{ item: 'white_bed' }, { item: 'white_bed', derived: true }]).requirements, { white_bed: 1 });
});

test('existing 32 glass to target 40 invokes exactly eight additional native smelts', async () => {
  const f = fixture({ glass: 32, sand: 8 });
  const result = await f.controller.ensure({ glass: 40 });
  assert.equal(result.confirmed, true); assert.equal(f.stock.glass, 40); assert.equal(f.stock.sand, 0);
  assert.deepEqual(f.calls, [{ kind: 'smelt', input: 'sand', output: 'glass', count: 8 }]);
});

test('iron and glass smelting use additional <=32 batches with actual source consumption', async () => {
  const f = fixture({ iron_ingot: 32, raw_iron: 8, sand: 75 });
  await f.controller.ensure({ iron_ingot: 40, glass: 75 });
  assert.deepEqual(f.calls.filter(c => c.kind === 'smelt').map(c => [c.output, c.count]), [
    ['iron_ingot', 8], ['glass', 32], ['glass', 32], ['glass', 11],
  ]);
  assert.equal(f.stock.iron_ingot, 40); assert.equal(f.stock.raw_iron, 0); assert.equal(f.stock.glass, 75);
});

test('crafting preserves final floor planks while preparing stairs and other final outputs', async () => {
  const f = fixture();
  const result = await f.controller.ensure({ oak_log: 12, oak_planks: 100, oak_stairs: 96, chest: 1, crafting_table: 1 });
  assert.equal(result.confirmed, true);
  assert.equal(f.stock.oak_log, 12); assert.ok(f.stock.oak_planks >= 100); assert.equal(f.stock.oak_stairs, 96);
  assert.equal(f.stock.chest, 1); assert.equal(f.stock.crafting_table, 1);
  for (const call of f.calls.filter(c => c.kind === 'craft')) {
    assert.ok(call.context.outputCount <= 96);
    assert.ok(Object.values(call.context.inputs).every(n => n <= 64));
    assert.equal(call.context.requiresTable, call.recipe.requiresTable === true);
  }
});

test('317 natural logs and 1005 stone are acquired through bounded additional raw batches', async () => {
  const f = fixture();
  await f.controller.ensure({ oak_log: 317, cobblestone: 1005 });
  assert.equal(f.stock.oak_log, 317); assert.equal(f.stock.cobblestone, 1005);
  assert.ok(f.calls.every(c => c.kind === 'raw' && c.amount > 0 && c.amount <= 64));
  assert.equal(f.calls.filter(c => c.name === 'cobblestone').length, 16);
});

test('scarce providers receive exact raw hooks and buckets use real iron recipe dependencies', async () => {
  const f = fixture();
  await f.controller.ensure({ white_wool: 3, leather: 46, sugar_cane: 138, obsidian: 4, diamond: 5, wheat_seeds: 56, water_bucket: 2, bucket: 2 });
  assert.equal(f.stock.bucket, 2); assert.equal(f.stock.iron_ingot, 0);
  assert.equal(f.calls.filter(c => c.kind === 'raw' && c.name === 'raw_iron').reduce((n, c) => n + c.amount, 0), 6);
  assert.ok(f.calls.some(c => c.kind === 'smelt' && c.output === 'iron_ingot'));
});

test('no inventory change fails once rather than logically awarding a smelt or repeating it', async () => {
  let uses = 0;
  const f = fixture({ glass: 32, sand: 8 }, { smeltBatch: async () => { uses += 1; return { confirmed: true }; } });
  await assert.rejects(f.controller.ensure({ glass: 40 }), e => e.code === 'house_materials_no_progress');
  assert.equal(uses, 1); assert.equal(f.stock.glass, 32); assert.equal(f.stock.sand, 8);
});

test('a fabricated output without actual ingredient debit cannot pass the transaction check', async () => {
  const stock = { glass: 32, sand: 8 };
  const f = fixture(stock, { getItemCount: name => stock[name] || 0,
    smeltBatch: async () => { stock.glass += 8; } });
  await assert.rejects(f.controller.ensure({ glass: 40 }), e => e.code === 'house_materials_no_progress');
});

test('delayed authoritative output and ingredient readback settle without duplicate native use', async () => {
  const stock = { glass: 32, sand: 8 }; let uses = 0;
  const f = fixture({}, { getItemCount: name => stock[name] || 0,
    smeltBatch: async () => { uses += 1; setTimeout(() => { stock.glass = 40; stock.sand = 0; }, 15); } });
  await f.controller.ensure({ glass: 40 }); assert.equal(uses, 1);
});

test('pause/cancel signals after a native callback prevent any subsequent material action', async () => {
  for (const code of ['paused', 'cancelled']) {
    let stopped = false; let uses = 0;
    const f = fixture({}, { assertActive: () => { if (stopped) throw Object.assign(new Error(code), { code }); },
      acquireRaw: async () => { uses += 1; stopped = true; } });
    await assert.rejects(f.controller.ensure({ oak_log: 130, leather: 46 }), e => e.code === code);
    assert.equal(uses, 1);
  }
});

test('recipe cycles, unreachable variants, invalid quantities and operation limits fail closed', async () => {
  const f = fixture({}, { rawItems: [], recipesAll: id => [
    { result: { id, count: 1 }, delta: [{ id, count: -1 }], requiresTable: false },
  ] });
  assert.throws(() => f.controller.plan({ oak_planks: 1 }), e => e.code === 'house_materials_unsupported');
  await assert.rejects(f.controller.ensure({ oak_planks: 1 }), e => e.code === 'house_materials_unsupported');
  const bounded = fixture({}, { limits: { maxOperations: 1 } });
  await assert.rejects(bounded.controller.ensure({ oak_log: 130 }), e => e.code === 'house_materials_operation_limit');
  assert.equal(bounded.calls.length, 1);
  assert.throws(() => fixture().controller.plan({ oak_log: 4097 }), e => e.code === 'house_materials_invalid_budget');
  assert.throws(() => planHouseMaterialBatch([null]), e => e.code === 'house_materials_invalid_batch');
});

test('charcoal is a real log smelt dependency and execution requires ingredient and output reads', async () => {
  const f = fixture();
  const plan = f.controller.plan({ charcoal: 3 }); assert.equal(plan.rawRequirements.oak_log, 3);
  await f.controller.ensure({ charcoal: 3 });
  assert.equal(f.stock.charcoal, 3); assert.equal(f.stock.oak_log, 0);
  assert.deepEqual(f.calls.at(-1), { kind: 'smelt', input: 'oak_log', output: 'charcoal', count: 3 });
});

test('native station preparation precedes ingredient reservations and recipe debit snapshots', async () => {
  let stationMade = false; let f;
  f = fixture({ oak_planks: 8 }, { beforeRecipe: async (_recipe, context) => {
    context.assertActive();
    if (!context.requiresTable || stationMade) return;
    assert.ok(f.stock.oak_planks >= 4);
    f.stock.oak_planks -= 4; stationMade = true;
  } });
  const result = await f.controller.ensure({ oak_planks: 8, oak_stairs: 4 });
  assert.equal(stationMade, true); assert.equal(result.confirmed, true);
  assert.ok(f.stock.oak_planks >= 8); assert.equal(f.stock.oak_stairs, 4);
});

test('raw provider confirmation cannot substitute for actual gathered inventory', async () => {
  let uses = 0;
  const f = fixture({}, { acquireRaw: async () => { uses += 1; return { confirmed: true, quantity: 64 }; } });
  await assert.rejects(f.controller.ensure({ oak_log: 64, leather: 1 }), e => e.code === 'house_materials_no_progress');
  assert.equal(uses, 1); assert.equal(f.stock.oak_log, undefined);
});

test('operation deadline aborts the captured real token before rejection and blocks late native writes', async () => {
  const token = new CancellationToken(); const events = []; let writes = 0;
  const f = fixture({}, {
    limits: { operationTimeoutMs: 5 }, assertActive: () => token.throwIfRequested(),
    onOperationTimeout: () => { token.pause(); events.push('owner_paused'); },
    acquireRaw: async (_name, _amount, context) => {
      await new Promise(resolve => setTimeout(resolve, 25));
      context.assertActive(); writes += 1;
    },
  });
  await assert.rejects(f.controller.ensure({ oak_log: 1 }), e => e.code === 'house_materials_operation_timeout');
  events.push('deadline_rejected');
  assert.deepEqual(events, ['owner_paused', 'deadline_rejected']);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(writes, 0); assert.equal(token.pauseRequested, true);
});

test('without a synchronous owner abort dependency no callback timeout is installed', async () => {
  const stock = {}; let writes = 0;
  const f = fixture({}, {
    limits: { operationTimeoutMs: 5 }, getItemCount: name => stock[name] || 0,
    acquireRaw: async (name, amount, context) => {
      await new Promise(resolve => setTimeout(resolve, 25)); context.assertActive();
      stock[name] = amount; writes += 1;
    },
  });
  const result = await f.controller.ensure({ oak_log: 1 });
  assert.equal(result.confirmed, true); assert.equal(writes, 1); assert.equal(stock.oak_log, 1);
});

test('inventory polling honors a real pause before starting the next material action', async () => {
  const token = new CancellationToken(); let uses = 0;
  const f = fixture({}, { assertActive: () => token.throwIfRequested(),
    acquireRaw: async () => { uses += 1; }, wait: async () => { token.pause(); } });
  await assert.rejects(f.controller.ensure({ oak_log: 1, leather: 1 }), e => e.code === 'paused');
  assert.equal(uses, 1);
});

test('shield reuses native recipe dependency chain with one smelted iron and six planks',async()=>{
 const f=fixture({oak_planks:6,raw_iron:1});await f.controller.ensure({shield:1});
 assert.equal(f.stock.shield,1);assert.equal(f.stock.oak_planks,0);assert.equal(f.stock.raw_iron,0);assert.equal(f.stock.iron_ingot,0);
 assert.equal(f.calls.find(c=>c.kind==='smelt').count,1);assert.ok(f.calls.find(c=>c.kind==='craft'&&c.context.item==='shield').recipe.requiresTable);
});

test('craft output is measured after dependency preparation legitimately consumes prior planks as fuel',async()=>{
 let prepared=false,usedFuel=0,f;
 f=fixture({oak_planks:4,oak_log:2},{beforeRecipe:async(_recipe,context)=>{
  if(context.item==='oak_planks'&&!prepared){prepared=true;usedFuel=f.stock.oak_planks;f.stock.oak_planks=0;}
 }});
 await f.controller.ensure({oak_planks:8});
 assert.equal(usedFuel,4);assert.equal(f.stock.oak_planks,8);assert.equal(f.stock.oak_log,0);
 assert.equal(f.calls.filter(c=>c.kind==='craft').length,2);
});

test('interrupted owned smelt receipts avoid reacquiring the same eight ores',async()=>{
 let f,restored=false;
 f=fixture({}, {restoreOwnedItem:async(name,_target,context)=>{
   context.assertActive();if(name==='iron_ingot'&&!restored){restored=true;f.stock.iron_ingot=1;f.stock.raw_iron=7;}
 }});
 await f.controller.ensure({iron_chestplate:1});
 assert.equal(f.stock.iron_chestplate,1);assert.equal(f.calls.some(c=>c.kind==='raw'),false);
 assert.equal(f.calls.filter(c=>c.kind==='smelt').reduce((n,c)=>n+c.count,0),7);
});

test('finished owned ingots are read back before expanding ore and smelting dependencies',async()=>{
 let f;const restored=[];
 f=fixture({oak_planks:6},{restoreOwnedItem:async(name,target,context)=>{context.assertActive();restored.push({name,target});if(name==='iron_ingot')f.stock.iron_ingot=target;}});
 await f.controller.ensure({shield:1});assert.equal(f.stock.shield,1);
 assert.ok(restored.some(v=>v.name==='iron_ingot'&&v.target===1));
 assert.equal(f.calls.filter(c=>c.kind==='raw'||c.kind==='smelt').length,0);
});

test('owned-item recovery claims without actual inventory still require the ordinary native chain',async()=>{
 const f=fixture({oak_planks:6},{restoreOwnedItem:async()=>({confirmed:true,actual:999})});
 await f.controller.ensure({shield:1});assert.equal(f.stock.shield,1);
 assert.equal(f.calls.filter(c=>c.kind==='raw'&&c.name==='raw_iron').length,1);
 assert.equal(f.calls.filter(c=>c.kind==='smelt'&&c.output==='iron_ingot').length,1);
});

test('owned-item recovery respects the original operation limit and cancellation before crafting',async()=>{
 let active=true,restores=0;
 const f=fixture({oak_planks:6},{assertActive:()=>{if(!active)throw Object.assign(Error('paused'),{code:'paused'});},restoreOwnedItem:async()=>{restores++;active=false;}});
 await assert.rejects(f.controller.ensure({shield:1}),{code:'paused'});assert.equal(restores,1);assert.equal(f.calls.length,0);
 const g=fixture({oak_planks:6},{limits:{maxOperations:1},restoreOwnedItem:async()=>{}});
 await assert.rejects(g.controller.ensure({shield:1}),{code:'house_materials_operation_limit'});assert.equal(g.calls.length,0);
});
