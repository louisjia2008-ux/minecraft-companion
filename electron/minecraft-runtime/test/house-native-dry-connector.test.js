'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,Vec3,Movements,goals}=require('../test-support/bank-alignment-native-fixture.cjs');
const {runSurfaceGraphNativeProbe,runGroundedDryConnectorProbe,naturalWalkingFoot,hasGroundedBodySupport,inspectSurfaceBody}=require('../vendor/server/minecraft/houseSurfaceGraph');
const {followNativeDryConnector,restrictNativeDryConnectorProfile}=require('../vendor/server/minecraft/houseNativeDryConnector');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function setup(t){
 const f=fixture(t,4,{bank:'stone',initialLateral:0}),b=f.bot,p=new Movements(b);
 Object.assign(p,{canDig:false,scafoldingBlocks:[],allowParkour:false,allow1by1towers:false,allowSprinting:false,allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false});
 restrictNativeDryConnectorProfile(p);b.pathfinder.setMovements(p);let active=true;const records=[],moves=[];
 const deps={assertActive:()=>{if(!active)throw Object.assign(Error('paused'),{code:'paused'});},position:()=>({...b.entity.position}),
  safeFoot:v=>naturalWalkingFoot(b,new Vec3(v.x,v.y,v.z)),grounded:()=>hasGroundedBodySupport(b),dry:()=>inspectSurfaceBody(b).dry,wait,
  probe:v=>runSurfaceGraphNativeProbe(b,p,new goals.GoalBlock(v.x,v.y,v.z),{assertActive:deps.assertActive,isOwnerCurrent:()=>active}),
  move:async v=>{moves.push(v);await b.pathfinder.goto(new goals.GoalBlock(v.x,v.y,v.z));},record:r=>records.push(r)};
 return {f,b,deps,records,moves,pause:()=>{active=false;}};
}
test('UNKNOWN long path only guides separately proven short legs with original pathfinder and Physics',{timeout:15000},async t=>{
 const f=setup(t),target={x:-7,y:2,z:-12},native=f.deps.probe;
 f.deps.probe=p=>{const proof=native(p);if(p.x===target.x&&Math.abs(f.b.entity.position.x-p.x)>7)return {...proof,facts:{...proof.facts,status:'timeout',conclusive:false},result:{...proof.result,path:proof.result.path.filter(q=>q.x>=f.b.entity.position.x-6)}};return proof;};
 assert.equal(await followNativeDryConnector(f.deps,target,{deadline:Date.now()+14000}),true);
 assert.ok(f.moves.length>=2);assert.ok(f.records.some(r=>r.conclusive===false));
 assert.ok(f.records.filter(r=>r.actualMovementPerformed).every(r=>r.arrivalConfirmed));
 assert.equal(f.b.entity.onGround,true);assert.equal(f.b.entity.isInWater,false);
 assert.ok(f.f.points.every(p=>!p.wet));
});
test('UNKNOWN short probes grant no motion or successful connector',async t=>{
 const f=setup(t),before=f.b.entity.position.clone();
 f.deps.probe=()=>({facts:{status:'timeout',conclusive:false},result:{path:[{x:7,y:2,z:-12}]}});
 assert.equal(await followNativeDryConnector(f.deps,{x:0,y:2,z:-12},{deadline:Date.now()+1000}),false);
 assert.equal(f.moves.length,0);assert.ok(f.b.entity.position.equals(before));
});
test('a conclusive path requiring excavation cannot authorize the dry connector',async t=>{
 const f=setup(t);f.deps.probe=()=>({facts:{status:'success',conclusive:true},result:{path:[{x:8,y:2,z:-12,toBreak:[{}]}]}});
 assert.equal(await followNativeDryConnector(f.deps,{x:8,y:2,z:-12},{deadline:Date.now()+1000}),false);assert.equal(f.moves.length,0);
});
test('pause at the proof boundary prevents all late movement',async t=>{
 const f=setup(t),native=f.deps.probe;f.deps.probe=p=>{const proof=native(p);f.pause();return proof;};
 await assert.rejects(followNativeDryConnector(f.deps,{x:7,y:2,z:-12},{deadline:Date.now()+1000}),{code:'paused'});assert.equal(f.moves.length,0);
});
test('connector observation has its own bounded grounded scope; ordinary exploration retains100ms cap',t=>{
 const f=setup(t),goal=new goals.GoalBlock(7,2,-12),options={observedOrigin:{x:9,y:2,z:-12},assertActive:f.deps.assertActive,isOwnerCurrent:()=>true};
 const proof=runGroundedDryConnectorProbe(f.b,f.b.pathfinder.movements,goal,options);
 assert.equal(proof.facts.conclusive,true);assert.equal(proof.facts.status,'success');assert.equal(f.moves.length,0);
 assert.throws(()=>runSurfaceGraphNativeProbe(f.b,f.b.pathfinder.movements,goal,{...options,timeoutMs:500}),{code:'dry_graph_invalid_probe'});
 assert.throws(()=>runGroundedDryConnectorProbe(f.b,f.b.pathfinder.movements,goal,{...options,observedOrigin:{x:8,y:2,z:-12}}),{code:'dry_graph_invalid_probe'});
 assert.throws(()=>runGroundedDryConnectorProbe(f.b,f.b.pathfinder.movements,goal,{...options,isOwnerCurrent:()=>false}),{code:'dry_graph_movement_preempted'});
});

test('a conclusive long route is split into independently proven legs instead of one short-budget goto',{timeout:20000},async t=>{
 const f=setup(t),target={x:-26,y:2,z:-12};
 assert.equal(await followNativeDryConnector(f.deps,target,{deadline:Date.now()+18000}),true);
 assert.ok(f.records.some(r=>r.conclusive&&r.pathLength>24));
 assert.ok(f.moves.length>=2);assert.notDeepEqual(f.moves[0],target);
 assert.ok(f.f.points.every(p=>!p.wet));
});

test('a dry connection inherited from a sprint-enabled construction caller uses cardinal native walking without sprint packets',{timeout:10000},async t=>{
 const f=setup(t),p=new Movements(f.b);Object.assign(p,{canDig:false,scafoldingBlocks:[],allowParkour:false,allow1by1towers:false,maxDropDown:2,infiniteLiquidDropdownDistance:false});
 assert.equal(p.allowSprinting,true);restrictNativeDryConnectorProfile(p);f.b.pathfinder.setMovements(p);
 const goal={x:6,y:2,z:-15},proof=runGroundedDryConnectorProbe(f.b,p,new goals.GoalBlock(goal.x,goal.y,goal.z),
  {observedOrigin:{x:9,y:2,z:-12},assertActive:f.deps.assertActive,isOwnerCurrent:()=>true});
 assert.equal(proof.facts.conclusive,true);let from={x:9,y:2,z:-12};
 for(const node of proof.result.path){const delta=Math.abs(node.x-from.x)+Math.abs(node.z-from.z);assert.ok(delta<=1);from=node;}
 await f.b.pathfinder.goto(new goals.GoalBlock(goal.x,goal.y,goal.z));
 assert.ok(f.b.entity.position.floored().equals(new Vec3(goal.x,goal.y,goal.z)));
 assert.equal(f.f.controls.some(c=>c.name==='sprint'&&c.value===true),false);assert.ok(f.f.points.every(p=>!p.wet));
});
