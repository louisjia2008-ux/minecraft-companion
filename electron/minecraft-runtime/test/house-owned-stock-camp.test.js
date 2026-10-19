'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ownsNeededGlass}=require('../vendor/server/minecraft/houseOwnedStockCamp');
function receipt(){return {ownedStations:{crafting_table:{},furnace:{}},storage:{chests:[{confirmedPlaced:true,emptyAuthorized:true,stock:{glass:15}}]}};}
test('enough recorded owned glass motivates a visit without inventing carried stock',()=>{
 let carried=0;assert.equal(ownsNeededGlass(receipt(),{glass:15},()=>carried),true);assert.equal(carried,0);
 carried=15;assert.equal(ownsNeededGlass(receipt(),{glass:15},()=>carried),false);
});
for(const change of [r=>r.storage.chests[0].pendingTransfer={},r=>r.storage.chests[0].pendingClosedInventory={},r=>r.storage.chests[0].emptyAuthorized=false,
 r=>r.storage.chests[0].confirmedPlaced=false,r=>r.storage.chests[0].stock.glass=14,r=>delete r.ownedStations.furnace])
 test('unverified, unsettled or insufficient archived stock cannot justify a workshop trip',()=>{
  const r=receipt();change(r);assert.equal(ownsNeededGlass(r,{glass:15},()=>0),false);
 });

test('archived wool or dye inputs justify a visit only from settled ownership and real carried wool',()=>{
 const {ownsUsefulWoolStock}=require('../vendor/server/minecraft/houseOwnedStockCamp');
 const prior={storage:{chests:[{confirmedPlaced:true,emptyAuthorized:true,stock:{white_wool:1,bone:2}}]}};
 assert.equal(ownsUsefulWoolStock(prior,()=>0),true);
 prior.storage.chests[0].stock={bone:2};assert.equal(ownsUsefulWoolStock(prior,()=>0),false);
 assert.equal(ownsUsefulWoolStock(prior,n=>n==='black_wool'?1:0),true);
 prior.storage.chests[0].pendingTransfer={};assert.equal(ownsUsefulWoolStock(prior,()=>1),false);
});

test('latest settled empty stock supersedes older glass receipts for the same owned chest',()=>{
 const {latestOwnedCampArchives,ownsNeededGlass}=require('../vendor/server/minecraft/houseOwnedStockCamp');
 const older={storage:{storageId:'owned',chests:[{confirmedPlaced:true,emptyAuthorized:true,stock:{glass:15}}]},ownedStations:{crafting_table:{},furnace:{}}};
 const latest={...older,storage:{...older.storage,chests:[{confirmedPlaced:true,emptyAuthorized:true,stock:{glass:0}}]}};
 const selected=latestOwnedCampArchives({retiredCamps:[older,latest]});assert.deepEqual(selected,[latest]);
 assert.equal(ownsNeededGlass(selected[0],{glass:4},()=>0),false);
 assert.deepEqual(latestOwnedCampArchives({storage:{storageId:'owned'},retiredCamps:[older,latest]}),[]);
});
test('owned sand and actual fuel can justify nearby native smelting without crediting finished glass',()=>{
 const {ownsGlassInputs}=require('../vendor/server/minecraft/houseOwnedStockCamp');
 const p={storage:{chests:[{confirmedPlaced:true,emptyAuthorized:true,stock:{sand:5,coal:16}}]}};
 assert.equal(ownsGlassInputs(p,{glass:4},()=>0),true);assert.equal(ownsGlassInputs(p,{glass:6},()=>0),false);
 p.storage.chests[0].pendingTransfer={};assert.equal(ownsGlassInputs(p,{glass:4},()=>0),false);
});

test('loaded own workshop and reconciled wood stock are only a bootstrap visit hint',()=>{
 const {hasOwnedBootstrapWoodHint}=require('../vendor/server/minecraft/houseOwnedStockCamp');
 const table={x:0,y:1,z:0},box={x:2,y:1,z:0};const state={materialSource:'self_gathered',ownedStations:{crafting_table:{position:table,confirmedPlaced:true}},storage:{chests:[{position:box,confirmedPlaced:true,emptyAuthorized:true,usableStock:{spruce_log:3}}]}};
 const at=p=>({name:p.x===0?'crafting_table':'chest'});
 assert.equal(hasOwnedBootstrapWoodHint(state,at),true);assert.deepEqual(state.storage.chests[0].usableStock,{spruce_log:3});
 state.storage.chests[0].pendingTransfer={};assert.equal(hasOwnedBootstrapWoodHint(state,at),false);delete state.storage.chests[0].pendingTransfer;
 state.storage.chests[0].usableStock={spruce_log:2};assert.equal(hasOwnedBootstrapWoodHint(state,at),false);
 state.storage.chests[0].usableStock={spruce_planks:12};assert.equal(hasOwnedBootstrapWoodHint(state,at),true);
 // Unloaded identity remains a visit hint; loaded replacement is negative evidence.
 assert.equal(hasOwnedBootstrapWoodHint(state,()=>null),true);
 assert.equal(hasOwnedBootstrapWoodHint(state,()=>({name:'stone'})),false);
});
