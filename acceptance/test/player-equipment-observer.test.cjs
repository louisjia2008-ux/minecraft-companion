'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {equipmentFromEntitySNBT,savedEquipment,mergeEquipment}=require('../vanilla-player-equipment-v1.cjs');
test('actual modern separate offhand and iron armor equipment are read from server fields',()=>{
 const slots=equipmentFromEntitySNBT('DeskPet has the following entity data: {Pos: [1.0d,2.0d,3.0d], equipment: {offhand: {count: 1, id: "minecraft:shield"}, head: {components: {"minecraft:custom_data": {id: "minecraft:decoy", count: 99}}, count: 1, id: "minecraft:iron_helmet"}}, Inventory: [{Slot: 0b, count: 1, id: "minecraft:stone_sword"}]}');
 assert.deepEqual(slots,[{name:'iron_helmet',count:1,slot:5},{name:'shield',count:1,slot:45}]);
});
test('empty player equipment stays empty and nested decoys cannot supply equipment',()=>{
 assert.deepEqual(equipmentFromEntitySNBT('Player has the following entity data: {Inventory: [], nested: {equipment: {offhand: {id: "minecraft:shield", count: 1}}}}'),[]);
 assert.deepEqual(equipmentFromEntitySNBT('Player has the following entity data: {equipment: {}}'),[]);
});
test('saved equipment uses the same real slots and does not permit duplicate inventory credit',()=>{
 assert.deepEqual(savedEquipment({offhand:{id:'minecraft:shield',count:1}}),[{name:'shield',count:1,slot:45,components:null}]);
 assert.throws(()=>mergeEquipment([{name:'shield',slot:45,count:1}],[{name:'shield',slot:45,count:1}]),/same slot/);
 assert.throws(()=>equipmentFromEntitySNBT('Player has the following entity data: {equipment: {offhand: {id: "minecraft:shield", count: 0}}}'),/Invalid/);
 assert.throws(()=>equipmentFromEntitySNBT('Player has the following entity data: {equipment: {head: {id: "minecraft:iron_helmet", count: 1}}'),/Unbalanced/);
});
