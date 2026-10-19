'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const {clearHouseResourceSight}=require('../vendor/server/minecraft/houseResourceSight');
function fixture(options={}){
 const target={name:'oak_log',stateId:137,shapes:[[0,0,0,1,1,1]],position:new Vec3(3,2,0)},digs=[];
 const leaves=Array.from({length:options.leaves??2},(_,i)=>({name:options.wall?'stone':'oak_leaves',stateId:200+i,shapes:[[0,0,0,1,1,1]],position:new Vec3(i+1,2,0)}));
 let owner=true;
 const bot={_client:{},game:{dimension:'overworld'},entity:{position:new Vec3(.5,1,.5),eyeHeight:1.62},
  blockAt:raw=>{const p=raw.floored();return p.equals(target.position)?target:leaves.find(l=>l.position.equals(p))||{name:'air',stateId:0,shapes:[],position:p};},canDigBlock:()=>true,
  canSeeBlock:()=>leaves.every(l=>l.name==='air'),world:{raycast:()=>leaves.find(l=>l.name!=='air')}};
 const deps={getBot:()=>bot,assertActive:()=>{if(!owner)throw Object.assign(Error('paused'),{code:'paused'});},
  standingSafely:()=>!options.airborne,canClear:()=>!options.protected,
  dig:async leaf=>{digs.push(leaf.position.clone());leaf.name='air';leaf.stateId=0;leaf.shapes=[];if(options.revoke)owner=false;}};
 return{target,bot,digs,run:()=>clearHouseResourceSight(deps,target)};
}
test('two blocking leaves are cleared, then the unchanged target is re-observed without wood credit',async()=>{
 const f=fixture();assert.equal(await f.run(),2);assert.equal(f.digs.length,2);assert.equal(f.target.stateId,137);
 assert.equal(f.bot.canSeeBlock(f.target),true);
});
for(const options of [{wall:true},{protected:true},{airborne:true}])test(`sight clearing refuses non-leaf, protected or unsupported facts ${JSON.stringify(options)}`,async()=>{
 const f=fixture(options);assert.equal(await f.run(),0);assert.equal(f.digs.length,0);
});
test('more than two occluding leaves retain obstruction after the finite budget',async()=>{
 const f=fixture({leaves:3});assert.equal(await f.run(),2);assert.equal(f.bot.canSeeBlock(f.target),false);
});
test('owner revocation after one actual leaf dig prohibits a second operation',async()=>{
 const f=fixture({revoke:true});await assert.rejects(f.run(),{code:'paused'});assert.equal(f.digs.length,1);
});
