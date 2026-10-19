'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),registry=require('prismarine-registry')('1.21.8');
const {canFinishShelterBeforeIronUpgrade:ready}=require('../vendor/server/minecraft/houseDefenseReadiness');
function fixture(){const item=name=>({name,type:registry.itemsByName[name].id,count:1,durabilityUsed:0});const slots=Array(46).fill(null);slots[6]=item('iron_chestplate');slots[7]=item('iron_leggings');slots[45]=item('shield');return {registry,health:20,food:20,inventory:{slots,items:()=>[item('stone_sword')]}};}
test('existing roof and actual core defense permit furniture without accepting a complete iron kit',()=>{const b=fixture();assert.equal(ready(b,{phase:'furniture',roofComplete:true}),true);assert.equal(b.inventory.slots[5],null);});
test('final verification, missing roof, low health and exhausted equipment cannot defer the iron goal',()=>{
 const b=fixture();assert.equal(ready(b,{phase:'verify',roofComplete:true}),false);assert.equal(ready(b,{phase:'furniture',roofComplete:false}),false);
 b.health=6;assert.equal(ready(b,{phase:'furniture',roofComplete:true}),false);b.health=20;b.inventory.slots[6].durabilityUsed=239;
 assert.equal(ready(b,{phase:'furniture',roofComplete:true}),false);
});
