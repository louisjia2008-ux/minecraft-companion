'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {getHouseShield,shieldCraftTarget}=require('../vendor/server/minecraft/houseShieldState');
const shield=damage=>({name:'shield',count:1,type:1,durabilityUsed:damage});
function bot(offhand,carried=[]){return {registry:{items:{1:{maxDurability:336}}},inventory:{slots:{45:offhand},items:()=>carried}};}
test('one-durability worn shield is not working expedition equipment',()=>{const b=bot(shield(335));assert.equal(getHouseShield(b),null);assert.equal(shieldCraftTarget(b),1);});
test('fresh backpack shield supersedes exhausted offhand and worn item does not double recipe target',()=>{const fresh=shield(0),b=bot(shield(335),[fresh]);assert.equal(getHouseShield(b).item,fresh);assert.equal(getHouseShield(b).equipped,false);});
test('near-broken carried shield cannot satisfy a new shield recipe target',()=>{const b=bot(null,[shield(335)]);assert.equal(getHouseShield(b),null);assert.equal(shieldCraftTarget(b),2);});
test('an actually usable offhand shield remains recognized outside backpack slots',()=>{const s=shield(100),b=bot(s);assert.equal(getHouseShield(b).item,s);assert.equal(getHouseShield(b).equipped,true);});

test('fourteen remaining shield durability can block immediate damage but is replaced before another expedition',()=>{
 const worn=shield(322),b=bot(worn);assert.equal(getHouseShield(b).item,worn);assert.equal(getHouseShield(b,32),null);
 const fresh=shield(0);b.inventory.items=()=>[shield(335),fresh];assert.equal(getHouseShield(b,32).item,fresh);
 assert.equal(shieldCraftTarget(b),3);
});
