'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,Vec3,registry,Block}=require('../test-support/aquatic-surface-native-fixture.cjs');
const root=process.env.HOUSE_AQUATIC_BODY_RUNTIME;
const {inspectBody}=require(root?`${root}/vendor/server/minecraft/houseShallowWaterTraversal`:'../vendor/server/minecraft/houseShallowWaterTraversal');
const {isAquaticBodyBlock,AQUATIC_BODY_PLANTS}=require('../vendor/server/minecraft/houseAquaticBody');
const {isNaturalWalkingBodyBlock}=require('../vendor/server/minecraft/houseNaturalWalkingBody');

test('native aquatic plant states grant water-body clearance, never dry-body permission',()=>{
 for(const name of AQUATIC_BODY_PLANTS){const type=registry.blocksByName[name];
  for(let state=type.minStateId;state<=type.maxStateId;state++){
   const block=Block.fromStateId(state);assert.equal(isAquaticBodyBlock(block),true,`${name}:${state}`);
   assert.equal(isNaturalWalkingBodyBlock(block),false,`${name}:${state}`);
  }
 }
 for(const name of ['bubble_column','water','stone','powder_snow','nether_portal','wither_rose'])
  assert.equal(isAquaticBodyBlock(Block.fromStateId(registry.blocksByName[name].defaultState)),false,name);
});

test('saved whole19 HOLD pose replay accepts native upper tall seagrass while retaining eye AIR',()=>{
 const saved=require('../test-support/whole19-aquatic-hold-observation.json'),map=new Map(saved.facts.map(c=>[`${c.position.x},${c.position.y},${c.position.z}`,c]));
 const p=saved.actualSnapshot.position,bot={entity:{position:new Vec3(p.x,p.y,p.z),velocity:new Vec3(0,0,0),
  width:.6,height:1.8,eyeHeight:1.62,onGround:false,isInWater:true,isInLava:false},health:20,food:20,blockAt:q=>{
   const c=map.get(`${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`);if(!c)return null;
   const block=Object.assign(Block.fromStateId(c.stateId),{position:q.floored()});assert.equal(block.name,c.name);assert.deepEqual(block.shapes,c.shapes);return block;
  }};
 const result=inspectBody(bot,Vec3);assert.equal(result.eyeAir,true);assert.equal(result.aboveEyeAir,true);
 assert.ok(result.cells.some(c=>c.name==='tall_seagrass'));assert.equal(result.onGround,false);
});

for(const direction of[{x:1,z:0},{x:-1,z:0},{x:0,z:1},{x:0,z:-1}])test(`original Physics swims through aquatic flora width30 and returns ${JSON.stringify(direction)}`,{timeout:15000},async t=>{
 const f=fixture(t,30,{direction}),position=f.bot.entity.position.clone();
 assert.equal((await f.run(f.route)).confirmed,true);
 assert.equal((await f.run({...f.route,from:f.route.to,to:f.route.from})).confirmed,true);
 assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.isInWater,false);assert.equal(f.bot.entity.isInLava,false);
 assert.ok(f.bot.entity.position.distanceTo(position)<.2);assert.equal(f.gotos(),0);
 const samples=f.events.filter(e=>e.type==='surface_swim_tick');assert.ok(samples.some(e=>e.isInWater));
 assert.ok(samples.every(e=>e.eyeAir&&e.aboveEyeAir));
 assert.ok(samples.some(e=>e.cells.some(c=>AQUATIC_BODY_PLANTS.includes(c.name))));
});

test('cancel in aquatic flora physically retreats before rejecting and releasing the owned profile',{timeout:15000},async t=>{
 const f=fixture(t,30);let requested=false;
 f.bot.on('physicsTick',()=>{if(!requested&&f.bot.entity.isInWater&&f.local(f.bot.entity.position).u>7){requested=true;f.session.requestCancel('paused');}});
 await assert.rejects(f.run(f.route),e=>e.code==='paused'&&e.recoveredToDryBank===true);
 assert.ok(requested);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.isInWater,false);
 assert.equal(f.session.isHolding(),false);assert.equal(f.bot.pathfinder.movements,f.previous);
});

test('unknown body rejection retains fresh state facts; malformed aquatic shapes and portal never pass',()=>{
 const air=Block.fromStateId(registry.blocksByName.air.defaultState);
 for(const invalid of [null,{...Block.fromStateId(registry.blocksByName.kelp.defaultState),stateId:null},
  {...Block.fromStateId(registry.blocksByName.kelp.defaultState),shapes:[[0,0,0,1,.1,1]]},Block.fromStateId(registry.blocksByName.bubble_column.defaultState)]){
  const bot={entity:{position:new Vec3(.5,64,.5),velocity:new Vec3(0,0,0),width:.6,height:1.8,eyeHeight:1.62},
   blockAt:p=>p.y===64?invalid:air};
  assert.throws(()=>inspectBody(bot,Vec3),e=>e.code==='water_body_unsafe'&&Array.isArray(e.cells));
 }
});

test('a failed diagnostic sink cannot replace a live unsafe-body rejection or clear wet HOLD',{timeout:15000},async t=>{
 const f=fixture(t,30,{failBodyDiagnostic:true});let changed=false;
 f.bot.on('physicsTick',()=>{if(!changed&&f.bot.entity.isInWater&&f.local(f.bot.entity.position).u>3){
  changed=true;const p=f.bot.entity.position.floored();f.changes.set(`${p.x},${p.y},${p.z}`,{name:'nether_portal'});
 }});
 await assert.rejects(f.run(f.route),e=>e.code==='water_body_unsafe'&&e.holding===true);
 assert.ok(changed);assert.equal(f.session.isHolding(),true);
 const rejected=f.events.filter(e=>e.type==='surface_swim_body_rejected');assert.ok(rejected.length>0);
 assert.ok(rejected.some(e=>e.cells.some(c=>c.name==='nether_portal'&&Number.isSafeInteger(c.stateId))));
 assert.equal(f.bot.controlState.forward,false);assert.equal(f.bot.controlState.jump,true);
});
