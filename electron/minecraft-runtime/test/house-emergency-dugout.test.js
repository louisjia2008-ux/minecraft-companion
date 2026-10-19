'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {planEmergencyDugout,emergencyDugoutConfirmed}=require('../vendor/server/minecraft/houseEmergencyDugout');
function fixture(){const cells=new Map(),key=p=>`${p.x},${p.y},${p.z}`,at=p=>{const name=cells.has(key(p))?cells.get(key(p)):(p.y<68?'dirt':'air');return name===null?null:{name,diggable:true,boundingBox:name==='air'?'empty':'block',shapes:name==='air'?[]:[[0,0,0,1,1,1]],getProperties:()=>({})};};return {cells,key,at,args:{position:{x:.5,y:68,z:.5},blockAt:at}};}
test('finite three-soil dugout grants no protection until actual seal and position are confirmed',()=>{
 const f=fixture(),plan=planEmergencyDugout(f.args);assert.ok(plan);assert.equal(plan.digs.length,3);assert.equal(plan.actualProtectionConfirmed,false);
 assert.equal(emergencyDugoutConfirmed({...f.args,plan}),false);
 for(const p of plan.digs)f.cells.set(f.key(p),'air');f.cells.set(f.key(plan.cap),'cobblestone');
 const args={plan,position:{x:.5,y:65,z:.5},blockAt:f.at};assert.equal(emergencyDugoutConfirmed(args),true);
 assert.equal(emergencyDugoutConfirmed({...args,entities:[{position:{x:.5,y:65,z:.5},height:1.8}]}),false);
 assert.equal(emergencyDugoutConfirmed({...args,entities:[{position:{x:.5,y:68,z:.5},height:1.8}]}),true);
 f.cells.set('1,66,0','air');assert.equal(emergencyDugoutConfirmed(args),false);
});
for(const mode of ['unknown','water','gravel','cave','protected','boundary'])test(`dugout refuses ${mode}`,()=>{
 const f=fixture();if(mode==='boundary')f.args.position.x=.1;
 else if(mode==='protected')f.args.excluded=()=>true;
 else f.cells.set(mode==='cave'?'0,64,0':'1,66,0',mode==='unknown'?null:mode==='cave'?'air':mode);
 assert.equal(planEmergencyDugout(f.args),null);
});
