'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{prepareHouseDefense}=require('../vendor/server/minecraft/houseDefensePreparation');
test('equipped shield is reused without repeated crafting even if absent from inventory.items',async()=>{const r=await prepareHouseDefense({assertActive:()=>{},getOffhand:()=>({name:'shield'}),ensure:()=>{throw Error('Repeated craft');}});assert.equal(r.reused,true);});
test('missing shield is crafted and actually equipped before defense readiness',async()=>{let offhand=null,crafted=false;const shield={name:'shield'};const r=await prepareHouseDefense({assertActive:()=>{},getOffhand:()=>offhand,ensure:async req=>{assert.deepEqual(req,{shield:1});crafted=true;},findShield:()=>crafted?shield:null,equip:async(item,slot)=>{assert.equal(slot,'off-hand');offhand=item;}});assert.equal(r.shieldEquipped,true);});
test('equip promise without actual offhand change grants no readiness',async()=>{await assert.rejects(prepareHouseDefense({assertActive:()=>{},getOffhand:()=>null,ensure:async()=>{},findShield:()=>({name:'shield'}),equip:async()=>{}}),{code:'house_defense_shield_not_equipped'});});
test('existing shield does not skip missing survival armor; actual torso slot is checked',async()=>{
 let torso=null,requirements=[];const armor={name:'iron_chestplate'};
 const result=await prepareHouseDefense({assertActive:()=>{},getOffhand:()=>({name:'shield'}),getTorso:()=>torso,
  ensure:async r=>requirements.push(r),findTorso:()=>armor,equip:async(item,slot)=>{assert.equal(slot,'torso');torso=item;}});
 assert.deepEqual(requirements,[{iron_chestplate:1}]);assert.equal(result.armorEquipped,true);assert.equal(result.reused,true);
});
test('armor equip resolution cannot substitute for actual torso state',async()=>{
 await assert.rejects(prepareHouseDefense({assertActive:()=>{},getOffhand:()=>({name:'shield'}),getTorso:()=>null,
 ensure:async()=>{},findTorso:()=>({name:'iron_chestplate'}),equip:async()=>{}}),{code:'house_defense_armor_not_equipped'});
});
