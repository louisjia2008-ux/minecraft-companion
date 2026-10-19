'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {planHouseCampAccess,repairHouseCampAccess}=require('../vendor/server/minecraft/houseCampAccess');
const air={name:'air',boundingBox:'empty',shapes:[]};
const stone={name:'stone',boundingBox:'block',shapes:[[0,0,0,1,1,1]]};
const from={x:-86,y:64,z:-16},goal={x:-87,y:68,z:-13};
const key=p=>`${p.x},${p.y},${p.z}`;
test('destroyed camp root receives a bounded physical staircase from the live crater floor',()=>{
 const world=new Map(),at=p=>world.get(key(p))||(p.y<=63?stone:air);
 const plan=planHouseCampAccess({from,goal,blockAt:at});assert.ok(plan);assert.ok(plan.blocks.length>0&&plan.blocks.length<=16);
 for(const step of plan.steps){
  assert.equal(Math.abs(step.to.x-step.from.x)+Math.abs(step.to.z-step.from.z),1);
  assert.ok([0,1].includes(step.to.y-step.from.y));
  for(const p of step.place){assert.equal(at(p).name,'air');
   assert.ok([[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([x,y,z])=>at({x:p.x+x,y:p.y+y,z:p.z+z})===stone));world.set(key(p),stone);}
  assert.equal(at({...step.to,y:step.to.y-1}),stone);assert.equal(at(step.to),air);assert.equal(at({...step.to,y:step.to.y+1}),air);
 }assert.deepEqual(plan.steps.at(-1).to,goal);
});
test('unloaded, fluid, protected, unsupported or over-budget access is refused',()=>{
 for(const blockAt of [()=>null,()=>({...air,name:'water'}),p=>p.y<=63?{...stone,name:'sand'}:air])assert.equal(planHouseCampAccess({from,goal,blockAt}),null);
 const blockAt=p=>p.y<=63?stone:air;
 assert.equal(planHouseCampAccess({from,goal,blockAt,protectedBody:()=>true}),null);
 assert.equal(planHouseCampAccess({from,goal,blockAt,maxBlocks:1}),null);
 assert.equal(planHouseCampAccess({from,goal,blockAt,maxSteps:1}),null);
});
function fixture(){let position={...from};const world=new Map(),blockAt=p=>world.get(key(p))||(p.y<=63?stone:air);
 return {deps:{assertActive(){},plan:()=>planHouseCampAccess({from:position,goal,blockAt}),blockAt,at:p=>key(p)===key(position),acquire:async()=>{},place:async p=>world.set(key(p),stone),move:async(a,b)=>{position={...b};}},world};}
test('executor requires actual placement and arrival confirmations',async()=>{
 const f=fixture();assert.equal((await repairHouseCampAccess(f.deps)).repaired,true);assert.ok(f.world.size>0);
 const unconfirmed=fixture();unconfirmed.deps.place=async()=>{};
 await assert.rejects(repairHouseCampAccess(unconfirmed.deps),{code:'house_camp_access_unconfirmed'});
 const stuck=fixture();stuck.deps.move=async()=>{};
 await assert.rejects(repairHouseCampAccess(stuck.deps),{code:'house_camp_access_arrival_unconfirmed'});
});
test('cancellation prevents all subsequent placements',async()=>{
 const f=fixture();let cancelled=false,placements=0;f.deps.assertActive=()=>{if(cancelled)throw Error('cancelled');};
 f.deps.acquire=async()=>{cancelled=true;};f.deps.place=async()=>{placements++;};
 await assert.rejects(repairHouseCampAccess(f.deps),/cancelled/);assert.equal(placements,0);
});
