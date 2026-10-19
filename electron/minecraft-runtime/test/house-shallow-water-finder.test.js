/* global require */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,Vec3,Movements,goals}=require('../test-support/shallow-water-native-fixture.cjs');
const {createLoadedShallowWaterFinder,routeIdentity}=require('../vendor/server/minecraft/houseShallowWaterFinder');
const make=f=>createLoadedShallowWaterFinder({getBot:()=>f.bot,assertActive:()=>{},Vec3,Movements,GoalBlock:goals.GoalBlock});
for(const direction of [{x:1,z:0},{x:-1,z:0},{x:0,z:1},{x:0,z:-1}])test(`loaded finder actual native dry approach ${direction.x},${direction.z} no controls`,t=>{
 const f=fixture(t,4,{direction});f.bot.entity.position=f.world(-3).offset(.5,0,.5);const origin={...f.world(-3)},controls=f.controls.length,previous=f.bot.pathfinder.movements;
 const found=make(f).find({origin,resultLimit:1,readLimit:8192,scanTimeoutMs:1500});assert.equal(found.routes.length,1,JSON.stringify(found.diagnostics));const r=found.routes[0];assert.equal(r.route.width,4);assert.deepEqual(r.route.direction,direction);assert.equal(r.nativeApproachProbeConfirmed,true);assert.equal(r.approach.actualConfirmed,false);assert.equal(r.actualTraversalConfirmed,false);assert.ok(r.approach.plannedPath.length>=2);assert.ok(r.approach.plannedLength<=16);assert.equal(found.actualMovementPerformed,false);assert.equal(f.controls.length,controls);assert.equal(f.bot.pathfinder.movements,previous);assert.equal(routeIdentity(r.route),routeIdentity({...r.route,from:r.route.to,to:r.route.from}));
});
test('finder known edge id skips duplicate without fabricating a crossing',t=>{const f=fixture(t,4),finder=make(f),found=finder.find({origin:f.route.from,resultLimit:1,scanTimeoutMs:1500});assert.equal(found.routes.length,1);const next=finder.find({origin:f.route.from,seenRouteIds:[found.routes[0].id],readLimit:1000,scanTimeoutMs:1500});assert.ok(next.routes.every(r=>r.id!==found.routes[0].id));});
test('finder loaded-budget termination is explicit and never implies no river exists',t=>{const f=fixture(t),found=make(f).find({origin:f.route.from,readLimit:1});assert.equal(found.routes.length,0);assert.equal(found.diagnostics.stopReason,'water_discovery_read_budget');assert.equal(found.diagnostics.reads,1);});
test('finder cannot accept blocked dry approach even if water strip itself is valid',t=>{const f=fixture(t,4,{override:(p,l)=>l.u===-2&&p.y>=2&&p.y<=5?'stone':null});f.bot.entity.position=f.world(-3).offset(.5,0,.5);const found=make(f).find({origin:{...f.world(-3)},resultLimit:1,probeLimit:2,scanTimeoutMs:1500});assert.equal(found.routes.length,0);assert.ok(found.diagnostics.rejections.water_discovery_approach_unreachable||found.diagnostics.rejections.water_discovery_path_unsafe||found.diagnostics.rejections.water_discovery_approach_over16);});
test('finder does not treat unloaded opposite bank or depth2 as valid',t=>{for(const options of [{unknown:(p,l)=>l.u===4&&p.y===1},{override:(p,l)=>l.u>=0&&l.u<4&&p.y===0?'water':null}]){const f=fixture(t,4,options),found=make(f).find({origin:f.route.from,readLimit:2000,scanTimeoutMs:1500});assert.ok(found.routes.every(r=>r.id!==routeIdentity(f.route)));assert.ok(found.diagnostics.rejections.water_bank_unstable||found.diagnostics.rejections.water_route_not_source);}});
test('finder exact origin and source-side active assertions cannot be bypassed',t=>{const f=fixture(t);assert.throws(()=>make(f).find({origin:{x:1.5,y:2,z:0}}),e=>e.code==='water_discovery_origin_unknown');assert.throws(()=>make(f).find({origin:{x:100,y:2,z:100}}),e=>e.code==='water_discovery_origin_not_actual');const finder=createLoadedShallowWaterFinder({getBot:()=>f.bot,assertActive:()=>{throw Object.assign(new Error('paused'),{code:'paused'});},Vec3,Movements,GoalBlock:goals.GoalBlock});assert.throws(()=>finder.find({origin:f.route.from}),e=>e.code==='paused');});
test('already-grounded thick sand approach uses the dry walking contract while water banks retain the three-layer limit',t=>{
 const f=fixture(t,4,{override:(p,l)=>l.u<=-2&&p.y<=1&&p.y>=-3?'sand':null});
 f.bot.entity.position=f.world(-3).offset(.5,0,.5);
 const before=f.controls.length,profile=f.bot.pathfinder.movements;
 const found=make(f).find({origin:{...f.world(-3)},resultLimit:1,scanTimeoutMs:1500});
 assert.equal(found.routes.length,1,JSON.stringify(found.diagnostics));
 assert.deepEqual(found.routes[0].route.from,f.route.from);
 assert.ok(found.routes[0].approach.plannedPath.length>=2);
 assert.equal(found.actualMovementPerformed,false);assert.equal(f.controls.length,before);assert.equal(f.bot.pathfinder.movements,profile);
});
test('thick sand at a water bank is still rejected instead of weakening its transport support contract',t=>{
 const f=fixture(t,4,{override:(p,l)=>l.u===-1&&l.v===0&&p.y===-2?'sand':null});
 f.bot.entity.position=f.world(-3).offset(.5,0,.5);
 const found=make(f).find({origin:{...f.world(-3)},resultLimit:1,scanTimeoutMs:1500});
 assert.ok(found.routes.every(r=>routeIdentity(r.route)!==routeIdentity(f.route)));
 assert.ok(found.diagnostics.rejections.near_bank_not_stable_dry||found.diagnostics.rejections.water_bank_gravity_limit);
});
