'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const registry=require('prismarine-registry')('1.21.8'),Item=require('prismarine-item')(registry),windows=require('prismarine-windows')('1.21.8');
const {getHouseShield}=require('../vendor/server/minecraft/houseShieldState');
test('a real player Window excludes the equipped shield from items but defense must reuse it',()=>{
 const inventory=windows.createWindow(0,'minecraft:inventory','Player'),shield=new Item(registry.itemsByName.shield.id,1);
 inventory.updateSlot(45,shield);assert.equal(inventory.items().some(i=>i.name==='shield'),false);
 const result=getHouseShield({inventory});assert.equal(result.equipped,true);assert.equal(result.item,inventory.slots[45]);
 inventory.updateSlot(36,new Item(registry.itemsByName.shield.id,1));assert.equal(getHouseShield({inventory}).item,inventory.slots[45]);
 inventory.updateSlot(45,null);assert.equal(getHouseShield({inventory}).equipped,false);
 inventory.updateSlot(36,null);assert.equal(getHouseShield({inventory}),null);
});
