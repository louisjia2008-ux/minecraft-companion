'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {rememberCombatCover,combatCover,transitionCombat,cleanupCombatCover}=require('../vendor/server/minecraft/houseCombatMode');
function fixture(){
 const material={},cells=new Map(),key=p=>`${p.x},${p.y},${p.z}`;
 const block=name=>({name,boundingBox:name==='air'?'empty':'block',shapes:name==='air'?[]:[[0,0,0,1,1,1]],getProperties:()=>({})});
 let threat=false,cancel=false;const removed=[];
 const at=p=>cells.get(key(p))||block(p.y<0?'stone':'air');
 const deps={material,assertActive(){if(cancel)throw Object.assign(Error('cancel'),{code:'cancelled'});},
  hasThreat:()=>threat,grounded:()=>true,dry:()=>true,position:()=>({x:.5,y:0,z:.5}),blockAt:at,canSee:()=>true,protectedFloor:()=>false,
  remove:async(s,guard)=>{guard();removed.push(s);cells.set(key(s.position),block('air'));}};
 function add(x,y,z,item='dirt'){const s={position:{x,y,z},item};cells.set(key(s.position),block(item));rememberCombatCover(material,s);return s;}
 return {material,deps,add,cells,block,key,removed,threat:v=>{threat=v;},cancel:()=>{cancel=true;}};
}
test('combat records exact resumable task and retains old cover after shelter replacement',()=>{
 const f=fixture();f.material.defensiveCover={placed:[{position:{x:1,y:0,z:0},item:'dirt'}]};
 f.add(2,0,0);f.material.defensiveCover={placed:[]};f.add(3,0,0);
 assert.equal(combatCover(f.material).length,3);
 transitionCombat(f.material,'fighting',{resumeTaskId:'task1',resumeStep:9,resumeGeneration:5},1);
 transitionCombat(f.material,'cleanup',{},2);transitionCombat(f.material,'resumed',{},3);
 assert.equal(f.material.combatMode.resumeGeneration,5);assert.equal(f.material.combatMode.resumeStep,9);
});
test('cleanup consumes no new materials and removes actual reachable owned cover only once',async()=>{
 const f=fixture();f.add(1,0,0);const done=await cleanupCombatCover(f.deps);
 assert.equal(done.removed,1);assert.equal(done.pending,0);await cleanupCombatCover(f.deps);assert.equal(f.removed.length,1);
});
test('fresh nearby threat defers cleanup and new threat on write boundary preempts it',async()=>{
 const f=fixture();f.add(1,0,0);f.threat(true);assert.equal((await cleanupCombatCover(f.deps)).removed,0);
 f.threat(false);f.deps.remove=async(_s,guard)=>{f.threat(true);guard();};
 await assert.rejects(cleanupCombatCover(f.deps),{code:'house_combat_cleanup_preempted'});assert.equal(combatCover(f.material).length,1);
});
test('foreign replacements, unknown chunks, route floors and distant cover stay untouched',async()=>{
 const f=fixture();const a=f.add(1,0,0),b=f.add(2,0,0);f.add(1,-1,0);f.add(30,0,0);
 f.cells.set(f.key(a.position),f.block('chest'));f.deps.blockAt=p=>f.key(p)===f.key(b.position)?null:f.cells.get(f.key(p))||f.block(p.y<0?'stone':'air');
 f.deps.protectedFloor=p=>p.y===-1;
 assert.equal((await cleanupCombatCover(f.deps)).removed,0);assert.equal(combatCover(f.material).length,4);
});
test('fluid and gravity boundaries prevent unsafe cover demolition',async()=>{
 for(const name of ['water','gravel']){
  const f=fixture();f.add(1,0,0);f.cells.set('1,1,0',f.block(name));assert.equal((await cleanupCombatCover(f.deps)).removed,0);
 }
});
test('a disconnected actor cannot clean up and unconfirmed native removal never clears its ledger',async()=>{
 const f=fixture();f.add(1,0,0);f.cancel();await assert.rejects(cleanupCombatCover(f.deps),{code:'cancelled'});
 const g=fixture();g.add(1,0,0);g.deps.remove=async()=>{};
 await assert.rejects(cleanupCombatCover(g.deps),{code:'house_combat_cleanup_unconfirmed'});assert.equal(combatCover(g.material).length,1);
});

test('final cleanup visits deferred owned obstacles and requires actual AIR before retiring receipts',async()=>{
 const f=fixture();f.add(12,0,0);let visits=0;
 f.deps.approach=async()=>{visits++;f.deps.position=()=>({x:11.5,y:0,z:.5});return true;};
 const result=await require('../vendor/server/minecraft/houseCombatMode').sweepCombatCover(f.deps);
 assert.equal(result.pendingWork,0);assert.equal(result.removed,1);assert.equal(visits,1);assert.equal(combatCover(f.material).length,0);
});
test('an unreachable cleanup target is attempted once and remains an explicit failure, not completion',async()=>{
 const f=fixture();f.add(12,0,0);let visits=0;f.deps.approach=async()=>{visits++;return false;};
 const result=await require('../vendor/server/minecraft/houseCombatMode').sweepCombatCover(f.deps);
 assert.equal(visits,1);assert.equal(result.pendingWork,1);assert.equal(combatCover(f.material).length,1);
});
test('final cleanup reports protected return supports separately and never claims they were removed',async()=>{
 const f=fixture();f.add(1,0,0);f.deps.protectedFloor=()=>true;f.deps.approach=async()=>{throw Error('Protected supports cannot authorize travel');};
 const result=await require('../vendor/server/minecraft/houseCombatMode').sweepCombatCover(f.deps);
 assert.equal(result.pendingWork,0);assert.equal(result.pending,1);assert.equal(result.retainedProtected.length,1);assert.equal(result.removed,0);assert.equal(combatCover(f.material).length,1);
});
test('new threats preempt a deferred cleanup visit without removing its obstacle',async()=>{
 const f=fixture();f.add(12,0,0);f.deps.approach=async()=>{f.threat(true);return false;};
 const result=await require('../vendor/server/minecraft/houseCombatMode').sweepCombatCover(f.deps);
 assert.equal(result.interrupted,true);assert.equal(result.pendingWork,1);assert.equal(f.removed.length,0);
});
test('an owned dirt cover grown to grass remains removable, but foreign replacements remain explicit',async()=>{
 const f=fixture();const a=f.add(1,0,0);f.cells.set(f.key(a.position),f.block('grass_block'));
 assert.equal((await cleanupCombatCover(f.deps)).removed,1);
 const g=fixture();const s=g.add(1,0,0);g.cells.set(g.key(s.position),g.block('chest'));g.deps.approach=async()=>{throw Error('Foreign block cannot authorize travel');};
 assert.equal((await require('../vendor/server/minecraft/houseCombatMode').sweepCombatCover(g.deps)).pendingWork,1);assert.equal(g.removed.length,0);
});

test('a distant unloaded owned receipt can request bounded approach, then requires loaded identity and AIR readback',async()=>{
 const f=fixture(),s=f.add(12,0,0),native=f.deps.blockAt;let loaded=false,visits=0;
 f.deps.blockAt=p=>f.key(p)===f.key(s.position)&&!loaded?null:native(p);
 f.deps.approach=async spec=>{assert.deepEqual(spec,s);visits++;assert.equal(f.removed.length,0);loaded=true;f.deps.position=()=>({x:11.5,y:0,z:.5});return true;};
 const result=await require('../vendor/server/minecraft/houseCombatMode').sweepCombatCover(f.deps);
 assert.equal(visits,1);assert.equal(result.removed,1);assert.equal(result.pendingWork,0);
});
test('failed unloaded approach and a newly observed foreign replacement preserve the receipt and never dig',async()=>{
 for(const foreign of [false,true]){
  const f=fixture(),s=f.add(12,0,0),native=f.deps.blockAt;let loaded=false,visits=0;
  f.deps.blockAt=p=>f.key(p)===f.key(s.position)&&!loaded?null:native(p);
  f.deps.approach=async()=>{visits++;if(foreign){loaded=true;f.cells.set(f.key(s.position),f.block('chest'));}return false;};
  const result=await require('../vendor/server/minecraft/houseCombatMode').sweepCombatCover(f.deps);
  assert.equal(visits,1);assert.equal(result.pendingWork,1);assert.equal(f.removed.length,0);
 }
});

test('recorded self-built wooden screens clean up only their exact owned block identities and leave natural wood alone',async()=>{
 const f=fixture();f.add(1,0,0,'spruce_log');f.add(1,1,0,'spruce_planks');
 f.cells.set('2,0,0',f.block('spruce_log'));
 const result=await cleanupCombatCover(f.deps);assert.equal(result.removed,2);assert.equal(result.pending,0);
 assert.equal(f.cells.get('2,0,0').name,'spruce_log');
 const g=fixture(),spec=g.add(1,0,0,'spruce_log');g.cells.set(g.key(spec.position),g.block('oak_log'));
 assert.equal((await cleanupCombatCover(g.deps)).removed,0);assert.equal(combatCover(g.material).length,1);
});
test('confirmed new passage progress permits another visit to the same pending cover under one unchanged deadline',async()=>{
 const f=fixture();f.add(12,0,0);let revision=0,visits=0;const deadlines=[];
 f.deps.approachProgress=()=>revision;
 f.deps.approach=async(_spec,deadline)=>{deadlines.push(deadline);visits++;if(visits===1){revision++;return false;}f.deps.position=()=>({x:11.5,y:0,z:.5});return true;};
 const result=await require('../vendor/server/minecraft/houseCombatMode').sweepCombatCover(f.deps);
 assert.equal(visits,2);assert.equal(new Set(deadlines).size,1);assert.equal(result.removed,1);assert.equal(result.pendingWork,0);
});
test('new opening progress cannot reset the original cleanup visit budget or retire an unremoved cover',async()=>{
 const f=fixture();f.add(12,0,0);let revision=0;f.deps.approachProgress=()=>revision;f.deps.approach=async()=>{revision++;return false;};
 const result=await require('../vendor/server/minecraft/houseCombatMode').sweepCombatCover(f.deps,{maxVisits:3});
 assert.equal(result.visits,3);assert.equal(result.pendingWork,1);assert.equal(result.removed,0);assert.equal(combatCover(f.material).length,1);
});
