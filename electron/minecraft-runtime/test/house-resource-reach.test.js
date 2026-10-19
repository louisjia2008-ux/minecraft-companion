'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const {createHouseResourceReach}=require('../vendor/server/minecraft/houseResourceReach');
function fixture({name='Timeout',code=null,after={}}={}) {
 let ready=false,owner=true,stands=true,visible=true,support=true,calls=0,recovered=0;
 const block={name:'oak_log',stateId:137,position:new Vec3(0,6,0)};
 const bot={_client:{},game:{dimension:'overworld'},entity:{position:new Vec3(.5,1,.5)},blockAt:()=>block,
  canDigBlock:()=>ready,canSeeBlock:()=>visible};
 const error=Object.assign(new Error('native planning failed'),{name,...(code?{code}:{})});
 const reach=createHouseResourceReach({getBot:()=>bot,captureActive:()=>()=>{if(!owner)throw Object.assign(new Error('paused'),{code:'paused'});},
  avoidsSupport:()=>support,standingSafely:()=>stands,onRecovered:()=>{recovered++;},moveToBlock:async()=>{
   calls++;ready=true;owner=after.owner??true;stands=after.stands??true;visible=after.visible??true;support=after.support??true;
   if(after.state)block.stateId++;if(after.client)bot._client={};if(after.dimension)bot.game.dimension='nether';throw error;
  }});
 return {reach,block,error,calls:()=>calls,recovered:()=>recovered,setReady:()=>{ready=true;}};
}
for(const name of ['NoPath','Timeout'])test(`actual unchanged reachable block can continue after native ${name}`,async()=>{
 const f=fixture({name});await f.reach(f.block);assert.equal(f.calls(),1);assert.equal(f.recovered(),1);
});
test('already reachable target requires no native movement or recovery',async()=>{
 const f=fixture();f.setReady();await f.reach(f.block);assert.equal(f.calls(),0);assert.equal(f.recovered(),0);
});
for(const after of [{owner:false},{stands:false},{visible:false},{support:false},{state:true},{client:true},{dimension:true}])
 test(`native failure cannot recover changed actual condition ${JSON.stringify(after)}`,async()=>{
  const f=fixture({after});await assert.rejects(f.reach(f.block));assert.equal(f.recovered(),0);
 });
for(const [name,code] of [['GoalChanged',null],['Timeout','step_timeout'],['NoPath','house_surface_dry_graph_hazard'],['Error',null]])
 test(`only native planning failures can be reconsidered ${name}/${code}`,async()=>{
  const f=fixture({name,code});await assert.rejects(f.reach(f.block));assert.equal(f.recovered(),0);
 });

for(const name of ['NoPath','Timeout'])test(`a far approach may clear its now-reachable leaf sight after native ${name} without resource credit`,async()=>{
 let near=false,visible=false,cleared=0,recovered=0;const budgets=[];
 const block={name:'oak_log',stateId:137,position:new Vec3(3,2,0)},bot={_client:{},game:{dimension:'overworld'},entity:{position:new Vec3(.5,1,.5)},
  blockAt:()=>block,canDigBlock:()=>near,canSeeBlock:()=>visible};
 const reach=createHouseResourceReach({getBot:()=>bot,captureActive:()=>()=>{},avoidsSupport:()=>true,standingSafely:()=>true,
  clearSight:async(b,{maximumLeaves})=>{budgets.push(maximumLeaves);if(!near)return 0;cleared+=2;visible=true;return 2;},
  moveToBlock:async()=>{near=true;throw Object.assign(Error('modeled native planning failure after approach'),{name});},onRecovered:()=>recovered++});
 await reach(block);assert.equal(cleared,2);assert.equal(recovered,1);assert.deepEqual(budgets,[2,2]);assert.equal(block.stateId,137);
});
test('pre-approach and post-approach sight clearing share one two-leaf total budget',async()=>{
 let leaves=2,cleared=0;const budgets=[],block={name:'oak_log',stateId:137,position:new Vec3(3,2,0)};
 const bot={_client:{},game:{dimension:'overworld'},entity:{position:new Vec3(.5,1,.5)},blockAt:()=>block,canDigBlock:()=>true,canSeeBlock:()=>leaves===0};
 await createHouseResourceReach({getBot:()=>bot,captureActive:()=>()=>{},avoidsSupport:()=>true,standingSafely:()=>true,
  clearSight:async(b,{maximumLeaves})=>{budgets.push(maximumLeaves);leaves--;cleared++;return 1;},
  moveToBlock:async()=>{throw Object.assign(Error('native partial approach'),{name:'Timeout'});}})(block);
 assert.equal(cleared,2);assert.deepEqual(budgets,[2,1]);assert.equal(block.stateId,137);
});

test('a blocked natural approach may use bounded local navigation before fresh native sight succeeds',async()=>{
 let near=false,recoveries=0,moves=0;const block={name:'oak_log',stateId:137,position:new Vec3(3,2,0)};
 const bot={_client:{},game:{dimension:'overworld'},entity:{position:new Vec3(.5,1,.5)},blockAt:()=>block,canDigBlock:()=>near,canSeeBlock:()=>near};
 const start=Date.now();await createHouseResourceReach({getBot:()=>bot,captureActive:()=>()=>{},avoidsSupport:()=>true,standingSafely:()=>true,
  moveToBlock:async(b,{deadline})=>{moves++;assert.ok(deadline<=start+30010);throw Object.assign(Error('native cannot clear leaves'),{name:'NoPath'});},
  recoverApproach:async(b,{deadline})=>{recoveries++;assert.ok(deadline<=Date.now()+10000);near=true;return true;}})(block);
 assert.equal(recoveries,1);assert.equal(moves,1);assert.equal(block.stateId,137);
});
test('an expired original resource budget permits neither native planning nor local opening',async()=>{
 const block={name:'oak_log',stateId:137,position:new Vec3(3,2,0)},bot={_client:{},game:{dimension:'overworld'}};let calls=0;
 await assert.rejects(createHouseResourceReach({getBot:()=>bot,captureActive:()=>()=>{},getDeadline:()=>Date.now()-1,
  avoidsSupport:()=>true,standingSafely:()=>true,moveToBlock:async()=>{calls++;},recoverApproach:async()=>{calls++;}})(block),{code:'house_resource_reach_timeout'});assert.equal(calls,0);
});

for(const name of ['NoPath','Timeout'])test(`structured native ${name} rechecks actual reach instead of losing the safe handoff`,async()=>{
 const f=fixture({name,code:name});await f.reach(f.block);assert.equal(f.calls(),1);assert.equal(f.recovered(),1);
});

for(const after of [{},{owner:false},{stands:false},{visible:false},{support:false}])test(`owned bounded approach timeout rechecks actual reach while changed conditions refuse: ${JSON.stringify(after)}`,async()=>{
 const f=fixture({name:'Error',code:'house_resource_native_approach_timeout',after});
 if(Object.keys(after).length){await assert.rejects(f.reach(f.block));assert.equal(f.recovered(),0);}
 else{await f.reach(f.block);assert.equal(f.recovered(),1);assert.equal(f.calls(),1);}
});
