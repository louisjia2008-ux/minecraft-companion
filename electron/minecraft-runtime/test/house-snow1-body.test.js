'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,Vec3,registry,Block}=require('../test-support/shallow-water-native-fixture.cjs');
const root=process.env.HOUSE_SNOW1_RUNTIME;
const graph=require(root?`${root}/vendor/server/minecraft/houseSurfaceGraph`:'../vendor/server/minecraft/houseSurfaceGraph');
const {isNaturalWalkingBodyBlock,isNaturalWalkingBodyFact}=require(root?`${root}/vendor/server/minecraft/houseNaturalWalkingBody`:'../vendor/server/minecraft/houseNaturalWalkingBody');
const block=(layers,p)=>Object.assign(Block.fromProperties(registry.blocksByName.snow.id,{layers:String(layers)},0),{position:p});

test('only native empty-shape snow layer1 grants body clearance; layers2..8 and missing layer data stay refused',()=>{
 for(let layers=1;layers<=8;layers++){
  const native=block(layers,new Vec3(0,64,0));
  assert.equal(isNaturalWalkingBodyBlock(native),layers===1,`layers${layers}`);
  if(layers===1){assert.equal(native.boundingBox,'empty');assert.deepEqual(native.shapes,[]);}
 }
 assert.equal(isNaturalWalkingBodyFact({loaded:true,name:'snow',stateId:registry.blocksByName.snow.defaultState,
  boundingBox:'empty',shapes:[],waterlogged:false}),false);
 assert.equal(isNaturalWalkingBodyFact({loaded:true,name:'snow',stateId:registry.blocksByName.snow.defaultState,
  boundingBox:'empty',shapes:[],waterlogged:false,layers:2}),false);
});

test('saved whole20 original native snow1 body has actual full grass support, not snow support or facility AIR',()=>{
 const saved=require('../test-support/whole20-snow1-body-observation.json'),p=saved.actualSnapshot.position,
  map=new Map(saved.facts.map(c=>[`${c.position.x},${c.position.y},${c.position.z}`,c]));
 const bot={entity:{position:new Vec3(p.x,p.y,p.z),width:.6,height:1.8,onGround:true,isInWater:false,isInLava:false},blockAt:q=>{
  const c=map.get(`${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`);if(!c)return null;
  const native=Object.assign(Block.fromStateId(c.stateId),{position:q.floored()});assert.equal(native.name,c.name);assert.deepEqual(native.shapes,c.shapes);return native;
 }};
 assert.equal(saved.surface.walkingFoot,false);assert.equal(graph.inspectSurfaceBody(bot).dry,true);
 assert.equal(graph.hasGroundedBodySupport(bot),true);assert.equal(graph.naturalWalkingFoot(bot,bot.entity.position.floored()),true);
 assert.equal(graph.dryFoot(bot,bot.entity.position.floored()),false);
 const snow=graph.inspectSurfaceBody(bot).cells.find(c=>c.name==='snow');assert.equal(Number(snow.layers),1);
 assert.equal(isNaturalWalkingBodyFact(snow),true);
 const read=bot.blockAt;bot.blockAt=q=>q.floored().equals(new Vec3(-6,77,-3))?Object.assign(Block.fromStateId(0),{position:q.floored()}):read(q);
 assert.equal(graph.hasGroundedBodySupport(bot),false);assert.equal(graph.naturalWalkingFoot(bot,bot.entity.position.floored()),false);
});

test('original installed Physics traverses snow1 on full native support with fresh integer positions',{timeout:8000},async t=>{
 const f=fixture(t,4,{narrow:false,override:(p)=>p.y===2?'snow':p.y<2?'stone':null}),p=f.bot.entity.position.clone();
 // The shared fixture timer alone advances the player; no pose, velocity,
 // shapes, native module, planner outcome or onGround override occurs.
 let cp=null;const g=graph.createHouseSurfaceGraph({getBot:()=>f.bot,assertActive:()=>{},isMovementOwner:()=>true,
  getCP:()=>cp,saveCP:value=>{cp=JSON.parse(JSON.stringify(value));}},{step:16,radius:32,maxNodes:4,maxEdges:128});
 const result=await g.next({anchor:{x:Math.floor(p.x),y:Math.floor(p.y),z:Math.floor(p.z)}});
 assert.equal(result.moved,true);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.isInWater,false);
 assert.equal(f.bot.entity.position.y,2);assert.equal(cp.visits,2);
 assert.equal(graph.naturalWalkingFoot(f.bot,f.bot.entity.position.floored()),true);assert.equal(graph.dryFoot(f.bot,f.bot.entity.position.floored()),false);
 assert.ok(f.points.some(v=>v.position.distanceTo(p)>8));
});
