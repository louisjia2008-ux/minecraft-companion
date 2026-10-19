'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const {shearHouseSheep}=require('../vendor/server/minecraft/houseSheepShearing');
function fixture(){let count=0,active=true,activations=0;
 const keys=Array(18).fill('');keys[2]='custom_name';keys[9]='health';keys[16]='baby';keys[17]='wool';
 const metadata=[];metadata[9]=8;metadata[16]=false;metadata[17]=0;
 const sheep={id:1,name:'sheep',position:new Vec3(2,64,0),isValid:true,metadata};
 const bot={_client:{},entity:{position:new Vec3(0,64,0)},entities:{1:sheep},registry:{entitiesByName:{sheep:{metadataKeys:keys}}}};
 const deps={getBot:()=>bot,assertActive:()=>{if(!active)throw Object.assign(Error('paused'),{code:'paused'});},safeFoot:()=>true,
  count:()=>count,approach:async()=>{},equip:async()=>{bot.heldItem={name:'shears'};},activate:async()=>{activations++;metadata[17]=16;},
  collect:async()=>{count+=3;},sleep:async()=>{throw Error('unexpected wait');}};
 return{bot,sheep,deps,metadata,cancel:()=>{active=false;},activations:()=>activations};
}
test('actual sheared state and picked-up wool are both required for material credit',async()=>{
 const f=fixture(),result=await shearHouseSheep(f.deps,f.sheep);assert.equal(result.acquired,3);assert.equal(result.sheared,true);assert.equal(f.activations(),1);
});
for(const change of [f=>f.metadata[16]=true,f=>f.metadata[17]=1,f=>f.metadata[17]=16,f=>f.metadata[2]='named',f=>f.metadata[9]=0])
 test('baby, colored, already sheared, named or dead sheep cannot be harvested',async()=>{
  const f=fixture();change(f);await assert.rejects(shearHouseSheep(f.deps,f.sheep),{code:'house_shearing_target_changed'});assert.equal(f.activations(),0);
 });
test('cancellation during approach cannot send an interaction',async()=>{
 const f=fixture();f.deps.approach=async()=>f.cancel();await assert.rejects(shearHouseSheep(f.deps,f.sheep),{code:'paused'});assert.equal(f.activations(),0);
});
test('equipping an unrelated item cannot send shearing interaction',async()=>{
 const f=fixture();f.deps.equip=async()=>{f.bot.heldItem={name:'iron_sword'};};await assert.rejects(shearHouseSheep(f.deps,f.sheep),{code:'house_shearing_tool_missing'});assert.equal(f.activations(),0);
});
test('sheared metadata alone cannot invent a wool pickup',async()=>{
 const f=fixture();f.deps.collect=async()=>{};await assert.rejects(shearHouseSheep(f.deps,f.sheep),{code:'house_shearing_no_pickup'});assert.equal(f.activations(),1);
});
