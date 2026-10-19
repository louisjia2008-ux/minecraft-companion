'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {canWorkAtOwnedCamp}=require('../vendor/server/minecraft/houseCampWorkStance');
function fixture(){return {position:{x:-85.1,y:66,z:-141.5},anchor:{x:-85,y:66,z:-141},grounded:true,dry:true,
 stations:{crafting_table:{confirmedPlaced:true,position:{x:-87,y:66,z:-141}},furnace:{confirmedPlaced:true,position:{x:-85,y:66,z:-143}}},
 blockAt:p=>({name:p.x===-87?'crafting_table':'furnace'})};}
test('real reachable owned workstation stance does not require a synthetic graph-root arrival',()=>{const f=fixture(),before=JSON.stringify(f);assert.equal(canWorkAtOwnedCamp(f),true);assert.equal(JSON.stringify(f),before);});
for(const kind of ['airborne','wet','distant','wrong_level','unowned','unloaded'])test(`work stance refuses ${kind}`,()=>{
 const f=fixture();if(kind==='airborne')f.grounded=false;if(kind==='wet')f.dry=false;if(kind==='distant')f.position.x-=4;if(kind==='wrong_level')f.position.y--;
 if(kind==='unowned')f.stations.furnace.confirmedPlaced=false;if(kind==='unloaded')f.blockAt=()=>null;
 assert.equal(canWorkAtOwnedCamp(f),false);
});
