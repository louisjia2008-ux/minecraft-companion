'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Vec3}=require('vec3');
const registry=require('minecraft-data')('1.21.8');
const rayTrace=require('mineflayer/lib/plugins/ray_trace');
const {createMobFarmGoal}=require('../core/goals/mobFarm');
const realSkills=require('../core/skills');
// Frozen full-01 stopped-world entities r.-1.0.mca, chunk(-1,0), hopper(-6,24,4).
// Both were live bat (Health6/DeathTime0); these are measured positions, not a
// claim that every preceding failed placement had the same blocker.
const saved={overlap:[
 {name:'bat',pos:[-5.454164529814669,24.404434394097887,4.624815921407757]},
 {name:'bat',pos:[-5.684814724753429,24,4.609796393050761]},
]};
const key=p=>`${p.x},${p.y},${p.z}`;
function fixture({savedBats=true,onHit,occluded=false}={}){
 const placed=new Map(),events=[],attacks=[],placements=[];
 const controller=new AbortController();
 const bot={
  entity:{id:1000,name:'player',username:'test',position:new Vec3(-4.5,25,4.5),height:1.8,width:.6,eyeHeight:1.62,yaw:.1,pitch:.1},
  username:'test',entities:{},registry,inventory:{items:()=>[{name:'bone',count:1},{name:'hopper',count:1}]},
  world:{raycast:(start,dir)=>occluded?{intersect:start.plus(dir.scaled(.1))}:null},
  blockAt(p){const entry=placed.get(key(p));return {name:entry?.name||'air',position:p,boundingBox:entry?'block':'empty',getProperties:()=>entry?.props||{}};},
  lookAt:async(point)=>{const d=point.minus(bot.entity.position.offset(0,bot.entity.eyeHeight,0));bot.entity.yaw=Math.atan2(-d.x,-d.z);bot.entity.pitch=Math.atan2(d.y,Math.hypot(d.x,d.z));},
  attack(e){attacks.push(e.id);onHit?.(e,{bot,controller,placed});},
 };
 rayTrace(bot);
 const add=(name,p,id)=>{const r=registry.entitiesByName[name];const e={id,name,type:r.type,width:r.width,height:r.height,isValid:true,position:p};bot.entities[id]=e;return e;};
 if(savedBats)saved.overlap.forEach((e,i)=>add(e.name,new Vec3(...e.pos),i+1));
 const skills={...realSkills,isFluidSource:b=>b?.name==='water',placeAt:async(_bot,_ctx,p,match)=>{
  assert.equal(match('hopper'),true);assert.equal(match('stone'),false);
  placements.push(key(p));if(realSkills.entityInside(bot,new Vec3(p.x,p.y,p.z)))return {ok:false,reason:'cell_occupied_by_entity'};
  placed.set(key(p),{name:'hopper',props:{facing:'west'}});return {ok:true};
 }};
 const goal=createMobFarmGoal({bot,anchor:{x:-6,y:63,z:4},skills,actions:{countItems:()=>1}});
 const f=goal.memory.farm;placed.set(key(f.cells.chest),{name:'chest'});f.water.forEach(p=>placed.set(key(p),{name:'water'}));
 const ctx={signal:controller.signal,record:(type,data)=>events.push({type,...data})};
 return {bot,goal,ctx,controller,events,attacks,placements,placed,add};
}
test('two exact saved bats require real departure before the original hopper placement can succeed',async()=>{
 const s=fixture({onHit:e=>{e.position=e.position.offset(0,2,0);}});
 const before=s.goal.progress();
 const first=await s.goal.run(s.ctx);
 assert.equal(first.ok,false);assert.equal(first.reason,'cell_occupied_by_entity');
 assert.equal(s.attacks.length,1);assert.equal(s.placements.length,1);assert.equal(s.goal.progress(),before);
 const second=await s.goal.run(s.ctx);
 assert.equal(second.ok,true);assert.equal(s.attacks.length,2);assert.equal(s.placements.length,3);
 assert.equal(s.goal.progress(),before+1);assert.equal(s.goal.memory.taken,0);assert.equal(s.goal.memory.baseline,1);
 assert.equal(s.goal.isDone(),false);assert.equal(s.events.some(e=>e.type==='mob_drops'),false);
 assert.equal(s.events.filter(e=>e.type==='mob_collector_clear').length,2);
});
test('ineffective native attack sends exactly one packet and preserves failure/progress/materials',async()=>{
 const s=fixture({savedBats:false});s.add('bat',new Vec3(-5.5,24.3,4.5),1);
 const before=s.goal.progress();const result=await s.goal.run(s.ctx);
 assert.equal(result.reason,'cell_occupied_by_entity');assert.equal(s.attacks.length,1);assert.equal(s.placements.length,1);
 assert.equal(s.goal.progress(),before);assert.equal(s.goal.memory.taken,0);assert.equal(s.goal.memory.baseline,1);
});
test('a real gone packet permits retry without granting synthetic mob drops',async()=>{
 const s=fixture({savedBats:false,onHit:(e,{bot})=>{delete bot.entities[e.id];}});s.add('bat',new Vec3(-5.5,24.3,4.5),1);
 assert.equal((await s.goal.run(s.ctx)).ok,true);assert.equal(s.placements.length,2);assert.equal(s.goal.memory.taken,0);assert.equal(s.goal.isDone(),false);
});
for(const name of ['player','villager','zombie','skeleton','creeper'])test(`${name} occupying the hopper is never attacked or ignored`,async()=>{
 const s=fixture({savedBats:false});s.add(name,new Vec3(-5.5,24,4.5),1);
 assert.equal((await s.goal.run(s.ctx)).reason,'cell_occupied_by_entity');assert.equal(s.attacks.length,0);assert.equal(s.placements.length,1);
});
test('nearby bat outside the hopper is not chased while a player blocks it',async()=>{
 const s=fixture({savedBats:false});s.add('player',new Vec3(-5.5,24,4.5),1);s.add('bat',new Vec3(-5.5,26,4.5),2);
 assert.equal((await s.goal.run(s.ctx)).reason,'cell_occupied_by_entity');assert.equal(s.attacks.length,0);
});
test('overlapping bat out of native reach is not chased',async()=>{
 const s=fixture({savedBats:false});s.add('bat',new Vec3(-5.5,24.3,4.5),1);s.bot.entity.position=new Vec3(-1.5,25,4.5);
 assert.equal((await s.goal.run(s.ctx)).reason,'cell_occupied_by_entity');assert.equal(s.attacks.length,0);
});
test('opaque block on the look ray forbids native attack',async()=>{
 const s=fixture({savedBats:false,occluded:true});s.add('bat',new Vec3(-5.5,24.3,4.5),1);
 assert.equal((await s.goal.run(s.ctx)).reason,'cell_occupied_by_entity');assert.equal(s.attacks.length,0);
});
test('a different native cursor target forbids attack',async()=>{
 const s=fixture({savedBats:false});s.add('bat',new Vec3(-5.5,24.3,4.5),1);const player=s.add('player',new Vec3(-5.5,24.3,4.5),2);
 s.bot.entityAtCursor=()=>player;
 assert.equal((await s.goal.run(s.ctx)).reason,'cell_occupied_by_entity');assert.equal(s.attacks.length,0);
});
test('bat moving out of the cell during aim is not pursued or struck',async()=>{
 const s=fixture({savedBats:false});const bat=s.add('bat',new Vec3(-5.5,24.3,4.5),1);s.bot.lookAt=async()=>{bat.position=bat.position.offset(0,3,0);};
 assert.equal((await s.goal.run(s.ctx)).reason,'cell_occupied_by_entity');assert.equal(s.attacks.length,0);assert.equal(s.placements.length,1);
 // A subsequent ordinary run observes that the cell is now clear and places.
 assert.equal((await s.goal.run(s.ctx)).ok,true);assert.equal(s.attacks.length,0);
});
test('another living blocker entering after the hit prevents retry',async()=>{
 let s;s=fixture({savedBats:false,onHit:e=>{delete s.bot.entities[e.id];s.add('villager',new Vec3(-5.5,24,4.5),2);}});s.add('bat',new Vec3(-5.5,24.3,4.5),1);
 assert.equal((await s.goal.run(s.ctx)).reason,'cell_occupied_by_entity');assert.equal(s.attacks.length,1);assert.equal(s.placements.length,1);
});
test('abort during aim never sends an attack',async()=>{
 const s=fixture({savedBats:false});s.add('bat',new Vec3(-5.5,24.3,4.5),1);s.bot.lookAt=async()=>s.controller.abort('test_abort');
 await assert.rejects(s.goal.run(s.ctx),e=>e.code==='aborted');assert.equal(s.attacks.length,0);
});
test('abort after native hit does not retry placement or fabricate recovery',async()=>{
 const s=fixture({savedBats:false,onHit:(_e,{controller})=>controller.abort('test_abort')});s.add('bat',new Vec3(-5.5,24.3,4.5),1);
 await assert.rejects(s.goal.run(s.ctx),e=>e.code==='aborted');assert.equal(s.attacks.length,1);assert.equal(s.placements.length,1);
});
test('missing native visibility API fails closed',async()=>{
 const s=fixture({savedBats:false});s.add('bat',new Vec3(-5.5,24.3,4.5),1);delete s.bot.entityAtCursor;
 assert.equal((await s.goal.run(s.ctx)).reason,'cell_occupied_by_entity');assert.equal(s.attacks.length,0);
});
