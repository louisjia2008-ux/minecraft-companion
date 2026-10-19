'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {reuseOwnedWool}=require('../vendor/server/minecraft/houseWoolReuse');
function fixture(noGain=false){
 const inventory={},stock={black_wool:1,light_gray_wool:1,bone:1,string:1},calls=[];
 const count=k=>inventory[k]||0;
 const recipes={bone_meal:{bone:1},white_dye:{bone_meal:1},white_wool:{white_dye:1}};
 const d={active(){},count,stock:()=>stock,coloredCount:()=>count('black_wool')+count('light_gray_wool'),
  withdraw:async targets=>{for(const [k,n]of Object.entries(targets)){const taken=Math.min(stock[k]||0,n-count(k));inventory[k]=count(k)+taken;stock[k]-=taken;}},
  recipe:k=>Object.entries(recipes[k]).every(([i,n])=>count(i)>=n)&&(k!=='white_wool'||d.coloredCount())?{requiresTable:false}:null,
  craft:async k=>{calls.push(k);if(noGain)return;for(const[i,n]of Object.entries(recipes[k]))inventory[i]-=n;if(k==='white_wool')inventory[count('black_wool')?'black_wool':'light_gray_wool']--;inventory[k]=count(k)+(k==='bone_meal'?3:1);}};
 return {d,inventory,calls};
}
test('owned colored wool and bone conversion reduces the actual remaining natural wool requirement',async()=>{
 const f=fixture();await reuseOwnedWool(3,f.d);assert.equal(f.inventory.white_wool,2);assert.equal(f.calls.filter(i=>i==='white_wool').length,2);
 assert.equal(f.inventory.string,undefined);
});
test('recipe completion without actual output cannot credit wool',async()=>{
 const f=fixture(true);await assert.rejects(reuseOwnedWool(3,f.d),{code:'house_materials_no_progress'});assert.equal(f.inventory.white_wool,undefined);
});
