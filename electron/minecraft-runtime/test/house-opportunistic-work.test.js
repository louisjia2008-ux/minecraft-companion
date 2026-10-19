'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const {runHouseOpportunisticWork}=require('../vendor/server/minecraft/houseOpportunisticWork');
function fixture(){let active=true,quantity=12,dug=0,urgent=false;const cells=new Map();
 const block=(name,x,y,z)=>{const b={name,position:new Vec3(x,y,z),stateId:name==='air'?0:1};cells.set(`${x},${y},${z}`,b);return b;};
 const root=block('oak_log',1,64,0);block('oak_log',1,65,0);block('oak_log',1,66,0);
 const bot={_client:{},entity:{position:new Vec3(.5,64,.5)},canDigBlock:()=>true,canSeeBlock:()=>true,
  blockAt:p=>cells.get(`${p.x},${p.y},${p.z}`)||{name:'air',position:p,stateId:0}};
 const deps={getBot:()=>bot,assertActive:()=>{if(!active)throw Object.assign(Error('paused'),{code:'paused'});},urgent:()=>urgent,
  freeSlots:()=>4,logCount:()=>quantity,counts:()=>({oak_log:quantity}),scan:k=>k==='wood'?[root]:[],excluded:()=>false,canDigSafely:()=>true,wantsOre:()=>true,
  equip:async()=>{},dig:async b=>{dug++;block('air',b.position.x,b.position.y,b.position.z);},collect:async()=>{quantity+=dug;}};
 return{bot,deps,block,root,dug:()=>dug,cancel:()=>{active=false;},urgent:()=>{urgent=true;}};
}
test('a whole adjacent reachable trunk provides actual extra logs without navigation',async()=>{
 const f=fixture(),origin=f.bot.entity.position.clone();const r=await runHouseOpportunisticWork(f.deps);
 assert.equal(r.dug,3);assert.equal(r.acquired.oak_log,3);assert.equal(r.treeComplete,true);assert.equal(r.extraNavigation,0);assert.deepEqual(f.bot.entity.position,origin);
});
test('an unreachable crown prevents opportunistic stump-only chopping',async()=>{
 const f=fixture();for(let y=67;y<=70;y++)f.block('oak_log',1,y,0);
 assert.equal((await runHouseOpportunisticWork(f.deps)).acted,false);assert.equal(f.dug(),0);
});
for(const option of ['urgent','full_inventory','enough_logs','protected'])test(`${option} leaves main-task resources and priority alone`,async()=>{
 const f=fixture();if(option==='urgent')f.urgent();if(option==='full_inventory')f.deps.freeSlots=()=>2;
 if(option==='enough_logs')f.deps.logCount=()=>24;if(option==='protected')f.deps.excluded=()=>true;
 assert.equal((await runHouseOpportunisticWork(f.deps)).acted,false);assert.equal(f.dug(),0);
});
test('cancellation during tool preparation cannot dig',async()=>{
 const f=fixture();f.deps.equip=async()=>f.cancel();await assert.rejects(runHouseOpportunisticWork(f.deps),{code:'paused'});assert.equal(f.dug(),0);
});
test('digging without actual pickup does not create inventory credit',async()=>{
 const f=fixture();f.deps.collect=async()=>{};const r=await runHouseOpportunisticWork(f.deps);assert.equal(r.dug,3);assert.deepEqual(r.acquired,{});
});
