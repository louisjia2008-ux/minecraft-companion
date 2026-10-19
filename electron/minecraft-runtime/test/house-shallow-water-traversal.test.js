/* global require, setTimeout */
'use strict';
// Installed native Physics/pathfinder acceptance boundaries; no live server.
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,Vec3,Movements,registry,Block}=require('../test-support/shallow-water-native-fixture.cjs');
const api=require('../vendor/server/minecraft/houseShallowWaterTraversal');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(const direction of [{x:1,z:0},{x:-1,z:0},{x:0,z:1},{x:0,z:-1}])test(`native narrow3sand bank ${direction.x},${direction.z} width12 out/back strict0`,{timeout:15000},async t=>{
  const f=fixture(t,12,{direction}),out=await f.run(f.route),back=await f.run({...f.route,from:f.route.to,to:f.route.from});assert.ok(out.confirmed&&back.confirmed);assert.ok(out.waterTicks>20&&back.waterTicks>20);assert.equal(f.bot.pathfinder.movements,f.previous);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.isInWater,false);
  assert.ok(f.events.filter(e=>e.type==='water_physics_tick').every(e=>e.eyeAir&&e.aboveEyeAir&&e.oxygenLevel===null));
});
for(const width of [1,4,6])test(`native center-only gravelbank width${width} strict0 out/back`,{timeout:10000},async t=>{const f=fixture(t,width,{bank:'gravel'});assert.equal((await f.run(f.route)).confirmed,true);assert.equal((await f.run({...f.route,from:f.route.to,to:f.route.from})).confirmed,true);});
test('native narrow sandbank cancel while wet physically returns dry before rejecting',{timeout:15000},async t=>{
  const f=fixture(t);let cancelled=false;f.bot.on('physicsTick',()=>{if(!cancelled&&f.bot.entity.isInWater&&api.routeFrame(f.route).u(f.bot.entity.position)>4){cancelled=true;f.session.requestCancel();}});
  await assert.rejects(f.run(f.route),e=>e.code==='water_cancelled'&&e.recoveredToDryBank===true);assert.ok(cancelled);assert.equal(f.session.isHolding(),false);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.isInWater,false);assert.ok(f.events.some(e=>e.type==='water_recovery_confirmed'));
});
// Use original20Hz and a deadline shorter than the physical12-block crossing.
// The old180ms accelerated fixture could expire before entry under suite load;
// its dry-stop success did not satisfy the required wet-retreat scenario.
test('native narrow sandbank real deadline returns dry before rejecting',{timeout:15000},async t=>{const f=fixture(t,12,{physicsTickMs:50});await assert.rejects(f.run({...f.route,timeoutMs:3000}),e=>e.code==='water_timeout'&&e.recoveredToDryBank===true);assert.ok(f.events.some(e=>e.type==='water_recovery_started'&&e.facts.isInWater));assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.isInWater,false);});
test('same-generation foreign lease cannot be cleared or have original profile restored',{timeout:10000},async t=>{const f=fixture(t);let after=null;f.bot.on('physicsTick',()=>{if(after===null&&f.bot.entity.isInWater){f.takeover();after=f.controls.length;}});await assert.rejects(f.run(f.route),e=>e.code==='water_foreign_owner');await sleep(40);assert.notEqual(after,null);assert.deepEqual(f.controls.slice(after).filter(c=>c.owner==='first'),[]);assert.notEqual(f.bot.pathfinder.movements,f.previous);});
test('foreign profile takeover is permanently latched even after finally active=false',{timeout:10000},async t=>{const f=fixture(t);let after=null,foreign;f.bot.on('physicsTick',()=>{if(after===null&&f.bot.entity.isInWater){foreign=new Movements(f.bot);f.bot.pathfinder.setMovements(foreign);after=f.controls.length;}});await assert.rejects(f.run(f.route),e=>e.code==='water_foreign_owner');await sleep(30);assert.equal(f.bot.pathfinder.movements,foreign);assert.deepEqual(f.controls.slice(after).filter(c=>c.owner==='first'),[]);assert.equal(f.session.release().foreign,true);});
test('strict actual body rejects even0.000001m bank penetration',{timeout:1000},t=>{const f=fixture(t);f.bot.entity.position=f.world(0).offset(.299999, -.5,.5);assert.throws(()=>api.inspectBody(f.bot,Vec3),e=>e.code==='water_body_unsafe');});
test('unsafe/unknown/flowing/deep geometry and descriptors reject before motion',{timeout:1000},async t=>{for(const [opts,code]of [[{unknown:(_p,l)=>l.u===0&&l.v===0},'water_route_not_source'],[{override:(p,l)=>l.u===0&&p.y===0?'air':null},'water_bank_unstable'],[{override:(p,l)=>l.u===-1&&l.v===0&&p.y===-2?'sand':null},'water_bank_gravity_limit']]){const f=fixture(t,4,opts),before=f.controls.length;await assert.rejects(f.run(f.route),e=>e.code===code);assert.equal(f.controls.length,before);assert.equal(f.bot.pathfinder.movements,f.previous);}const f=fixture(t);for(const route of [{...f.route,schema:2},{...f.route,from:{x:1.5,y:2,z:0}},{...f.route,width:13},{...f.route,depth:2},{...f.route,direction:{x:1,z:1}}])assert.throws(()=>api.routeFrame(route),e=>e.code.startsWith('water_route_'));});
test('low real health while wet preserves cause and returns dry',{timeout:15000},async t=>{const f=fixture(t);let low=false;f.bot.on('physicsTick',()=>{if(!low&&f.bot.entity.isInWater&&api.routeFrame(f.route).u(f.bot.entity.position)>2){low=true;f.bot.health=15;}});await assert.rejects(f.run(f.route),e=>e.code==='water_survival_limit'&&e.recoveredToDryBank===true);assert.ok(f.events.some(e=>e.type==='water_recovery_started'&&e.originalFailure.health===15));assert.equal(f.bot.entity.isInWater,false);});
for(const width of [2,3,5,7,8,9,10,11])test(`supported native narrow sandbank width${width} out/back`,{timeout:15000},async t=>{const f=fixture(t,width,{direction:{x:0,z:1}});assert.equal((await f.run(f.route)).confirmed,true);assert.equal((await f.run({...f.route,from:f.route.to,to:f.route.from})).confirmed,true);});
test('pause request retains only exact captured safeowner until actual dry retreat',{timeout:15000},async t=>{const f=fixture(t,12,{direction:{x:0,z:-1}});let paused=false;f.bot.on('physicsTick',()=>{if(!paused&&f.bot.entity.isInWater){paused=true;f.session.requestCancel('paused');}});await assert.rejects(f.run(f.route),e=>e.code==='paused'&&e.recoveredToDryBank===true);assert.ok(paused);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.isInWater,false);});
test('unknown and insufficient initial vitals fail on dry bank without controls',{timeout:1000},async t=>{for(const field of['health','food'])for(const value of[NaN,0]){const f=fixture(t),before=f.controls.length;f.bot[field]=value;await assert.rejects(f.run(f.route),e=>['water_vitals_unknown','water_survival_limit'].includes(e.code));assert.equal(f.controls.length,before);assert.equal(f.bot.pathfinder.movements,f.previous);}});
test('actual centerline and immediately-adjacent banks are required before motion',{timeout:1000},async t=>{const f=fixture(t);assert.throws(()=>api.routeFrame({...f.route,from:{...f.route.from,x:f.route.from.x-1}}),e=>e.code==='water_route_invalid');f.bot.entity.position.z+=.16;const before=f.controls.length;await assert.rejects(f.run(f.route),e=>e.code==='water_centerline_lost');assert.equal(f.controls.length,before);});
test('flowing water fixture is rejected at bank or route before motion',{timeout:1000},async t=>{const f=fixture(t),actual=f.bot.blockAt;f.bot.blockAt=p=>{const b=actual(p);if(b.name==='water')return Object.assign(Block.fromProperties(registry.blocksByName.water.id,{level:1}),{position:p.floored()});return b;};await assert.rejects(f.run(f.route),e=>['water_route_not_source','water_bank_side_unsafe'].includes(e.code));});
test('foreign global oxygen cannot stop actual native traversal when own metadata is unknown',{timeout:10000},async t=>{
  const f=fixture(t,4);f.bot.oxygenLevel=9;f.bot.entity.id=1;
  const result=await f.run(f.route);assert.equal(result.confirmed,true);assert.ok(result.waterTicks>0);
  const samples=f.events.filter(e=>e.type==='water_physics_tick');
  assert.ok(samples.length>0&&samples.every(e=>e.oxygenLevel===null&&e.rawAirSupply===null&&e.source==='own_entity_metadata_unknown'));
});
test('actual own metadata depletion while wet still triggers native dry retreat despite foreign full-air global',{timeout:10000},async t=>{
  const f=fixture(t,12),index=registry.entitiesByName.player.metadataKeys.indexOf('air_supply');
  f.bot.entity.id=1;f.bot.entity.metadata={[index]:300};f.bot.oxygenLevel=20;let depleted=false;
  f.bot.on('physicsTick',()=>{if(!depleted&&f.bot.entity.isInWater&&api.routeFrame(f.route).u(f.bot.entity.position)>2){
    depleted=true;f.bot.entity.metadata[index]=255;
  }});
  await assert.rejects(f.run(f.route),e=>e.code==='water_safety_retreat'&&e.recoveredToDryBank===true);
  assert.ok(depleted);assert.equal(f.bot.entity.isInWater,false);assert.equal(f.bot.entity.onGround,true);
  assert.ok(f.events.some(e=>e.type==='water_physics_tick'&&e.oxygenLevel===17&&e.rawAirSupply===255));
});
