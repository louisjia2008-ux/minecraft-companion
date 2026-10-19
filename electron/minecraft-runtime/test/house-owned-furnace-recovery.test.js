/* global require */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recoverOwnedFurnace } = require('../vendor/server/minecraft/houseOwnedFurnaceRecovery');

// Explicit window/inventory transaction fixture; not live server evidence.
function fixture(options = {}) {
  const stock = {}, received = {}, calls = [];
  let input = options.outputOnly ? null : { name: 'raw_iron', count: 7 }, output = { name: 'iron_ingot', count: options.outputOnly ? 8 : 1 }, paused = false;
  const bot = { _client: {}, inventory: { items: () => Object.entries(stock).map(([name,count]) => ({ name,count })) } };
  const furnace = {
    inputItem: () => input, outputItem: () => output,
    takeInput: async () => {
      calls.push('input');
      if (options.finalCookingTick) { input.count--; output.count++; }
      received.raw_iron = input.count; input = null;
      if (options.pauseAfterInput) paused = true;
    },
    takeOutput: async () => { calls.push('output'); received.iron_ingot = output.count; output = null; },
    close: () => { calls.push('close'); if (!options.missingReceipt) Object.assign(stock, received); },
  };
  const deps = { getBot: () => bot, assertActive: () => { if (paused) throw Object.assign(Error('paused'),{code:'paused'}); },
    isOwnerCurrent: () => !options.foreignOwner, blockAt: () => ({ name: options.destroyed ? 'air' : 'furnace' }),
    reach: async () => {}, openFurnace: async () => { calls.push('open'); return furnace; }, transfer: action => action() };
  return { deps, stock, calls, request: {position:{x:0,y:64,z:0},input:'raw_iron',output:'iron_ingot'} };
}

test('interrupted eight-iron batch reclaims actual seven inputs and one output before replanning',async()=>{
  const f=fixture();assert.equal(await recoverOwnedFurnace(f.deps,f.request),true);
  assert.deepEqual(f.stock,{raw_iron:7,iron_ingot:1});assert.deepEqual(f.calls,['open','input','output','close']);
});
test('one final cooking tick conserves the actual input plus output receipt',async()=>{
  const f=fixture({finalCookingTick:true});await recoverOwnedFurnace(f.deps,f.request);
  assert.deepEqual(f.stock,{raw_iron:6,iron_ingot:2});
});
test('finished output-only batch is reclaimed without requesting more raw inputs',async()=>{
  const f=fixture({outputOnly:true});await recoverOwnedFurnace(f.deps,f.request);
  assert.deepEqual(f.stock,{iron_ingot:8});assert.deepEqual(f.calls,['open','output','close']);
});
test('unrelated input and output remain untouched',async()=>{
  const f=fixture();f.request.input='sand';f.request.output='glass';
  assert.equal(await recoverOwnedFurnace(f.deps,f.request),false);
  assert.deepEqual(f.stock,{});assert.deepEqual(f.calls,['open','close']);
});
test('foreign or destroyed furnace cannot transfer materials',async()=>{
  const foreign=fixture({foreignOwner:true});await assert.rejects(recoverOwnedFurnace(foreign.deps,foreign.request),{code:'house_furnace_owner_changed'});
  assert.deepEqual(foreign.calls,[]);
  const gone=fixture({destroyed:true});assert.equal(await recoverOwnedFurnace(gone.deps,gone.request),false);assert.deepEqual(gone.calls,[]);
});
test('pause after input receipt closes its window and cannot take output',async()=>{
  const f=fixture({pauseAfterInput:true});await assert.rejects(recoverOwnedFurnace(f.deps,f.request),{code:'paused'});
  assert.deepEqual(f.calls,['open','input','close']);assert.deepEqual(f.stock,{raw_iron:7});
});
test('transfer callback without actual inventory receipt cannot claim recovery',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000});
  const f=fixture({missingReceipt:true});f.deps.wait=async()=>t.mock.timers.tick(500);
  await assert.rejects(recoverOwnedFurnace(f.deps,f.request),{code:'house_furnace_recovery_unconfirmed'});
});
