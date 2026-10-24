'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Vec3}=require('vec3');
const registry=require('minecraft-data')('1.21.8');
const skills=require('../core/skills');
const actions=require('../core/actions');
// Measured live bats from formal full-01 stopped-world chunk(-1,0).
const saved={errors:[],overlap:[
 {name:'bat',type:'ambient',width:.5,height:.9,health:6,deathTime:0,pos:[-5.454164529814669,24.404434394097887,4.624815921407757]},
 {name:'bat',type:'ambient',width:.5,height:.9,health:6,deathTime:0,pos:[-5.684814724753429,24,4.609796393050761]},
]};
const target=new Vec3(-6,24,4);
function entity(name,position=target.offset(.5,0,.5)){
 const r=registry.entitiesByName[name];
 return {name,type:r?.type||'other',width:r?.width||.6,height:r?.height||1.8,position};
}
function inside(skill,e,t=target){return skill.entityInside({entities:{1:e}},t);}
test('native 1.21.8 experience_orb type other must not block placement',()=>{
 const xp=entity('experience_orb');
 assert.equal(xp.type,'other');
 
 assert.equal(inside(skills,xp),false);
});
for(const name of ['item','experience_orb'])test(`${name} does not block the target cell`,()=>assert.equal(inside(skills,entity(name)),false));
test('legacy type orb remains excluded',()=>assert.equal(inside(skills,{...entity('experience_orb'),name:'legacy_xp',type:'orb'}),false));
for(const name of ['bat','zombie','skeleton','player'])test(`live ${name} still blocks the target cell`,()=>assert.equal(inside(skills,entity(name)),true));
test('unrecognised other type is protected rather than broadly ignored',()=>assert.equal(inside(skills,entity('unknown_entity')),true));
test('saved live bats remain blockers: XP compatibility alone does not fix mobfarm failure',()=>{
 assert.equal(saved.errors.length,0);assert.equal(saved.overlap.length,2);
 for(const e of saved.overlap){
  assert.equal(e.name,'bat');assert.equal(e.health,6);assert.equal(e.deathTime,0);
  const b={name:e.name,type:e.type,width:e.width,height:e.height,position:new Vec3(...e.pos)};
 assert.equal(inside(skills,b),true);
 }
});
test('vertically adjacent living entity is not misclassified as overlapping',()=>assert.equal(inside(skills,entity('player',new Vec3(-5.5,25,4.5))),false));
function botWith(name,position){
 let placed=false;let called=0;
 const bot={
  entity:{position:new Vec3(-4.5,25,4.5)},entities:{1:entity(name,position)},
  inventory:{items:()=>[{name:'hopper',count:1}]},
  blockAt(p){return {name:p.equals(target)?(placed?'hopper':'air'):'stone',boundingBox:p.equals(target)&&!placed?'empty':'block',position:p};},
  equip:async()=>{},placeBlock:async()=>{called++;placed=true;},
 };
 return {bot,calls:()=>called};
}
test('placeAt preserves alsoClear protection for live mobs and players and permits XP/items',async t=>{
 const original=actions.goNear;actions.goNear=async()=>({ok:true});
 try{
  for(const name of ['bat','zombie','player','experience_orb','item'])await t.test(name,async()=>{
   const second=target.offset(0,0,1);
   const {bot,calls}=botWith(name,second.offset(.5,0,.5));
   const result=await skills.placeAt(bot,{signal:new AbortController().signal,record(){}},target,n=>n==='hopper',{
    stand:{x:-5,y:25,z:4},alsoClear:[second],
   });
   const expectedBlock=['bat','zombie','player'].includes(name);
   assert.equal(result.ok,!expectedBlock);
   assert.equal(calls(),expectedBlock?0:1);
   if(expectedBlock)assert.equal(result.reason,'cell_occupied_by_entity');
  });
 }finally{actions.goNear=original;}
});
