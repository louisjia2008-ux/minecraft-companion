'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture,Vec3,goals,registry}=require('../test-support/bank-alignment-native-fixture.cjs');
const {selectNeutralSafeLook,installHouseNeutralGaze}=require('../vendor/server/minecraft/houseNeutralGaze');
function setup(t){const f=fixture(t,4,{bank:'stone',initialLateral:0});f.bot.entities[5]={id:5,name:'enderman',isValid:true,height:2.9,metadata:[],position:new Vec3(9.5,1,-17.5)};return f;}
test('neutral eye-line prevention delegates to original native look without editing pose/velocity or controls',async t=>{
 const f=setup(t),before=f.bot.entity.position.clone(),v=f.bot.entity.velocity.clone(),controls={...f.bot.controlState},records=[];
 const close=installHouseNeutralGaze({bot:f.bot,shouldGuard:()=>true,record:(type,facts)=>records.push({type,facts})});t.after(close);
 await f.bot.look(0,0,true);assert.equal(f.bot.entity.yaw,0);assert.ok(f.bot.entity.pitch<-.7);assert.ok(Math.abs(f.bot.entity.pitch-records[0].facts.pitch)<.01);assert.deepEqual(f.bot.entity.position,before);assert.deepEqual(f.bot.entity.velocity,v);assert.deepEqual(f.bot.controlState,controls);
 assert.equal(records[0].facts.nativeLookDelegated,true);assert.equal(records[0].facts.positionOrVelocityWritten,false);
});
for(const mode of ['out_of_scope','angry','foreign_client'])test(`look guard leaves ${mode} orientation with its actual owner`,async t=>{
 const f=setup(t);if(mode==='angry')f.bot.entities[5].metadata[registry.entitiesByName.enderman.metadataKeys.indexOf('creepy')]=true;
 const close=installHouseNeutralGaze({bot:f.bot,shouldGuard:()=>mode!=='out_of_scope'});t.after(close);if(mode==='foreign_client')f.bot._client={...f.bot._client};
 await f.bot.look(0,0,true);assert.equal(f.bot.entity.pitch,0);
});
test('native pathfinder and Physics still walk their actual destination while neutral gaze prevention is active',{timeout:9000},async t=>{
 const f=setup(t),records=[],close=installHouseNeutralGaze({bot:f.bot,shouldGuard:()=>f.bot.pathfinder.isMoving(),record:(type,facts)=>records.push({type,facts})});t.after(close);
 await f.bot.pathfinder.goto(new goals.GoalBlock(8,2,-20));assert.equal(f.bot.entity.position.floored().equals(new Vec3(8,2,-20)),true);assert.equal(f.bot.entity.onGround,true);assert.ok(f.points.length>0);assert.ok(records.some(r=>r.type==='house_neutral_gaze_avoided'));
});
test('native metadata transitions are observed without granting combat or mutation authority',t=>{
 const f=setup(t),records=[],close=installHouseNeutralGaze({bot:f.bot,shouldGuard:()=>false,record:(type,facts)=>records.push({type,facts})});t.after(close);
 f.bot.emit('entityUpdate',f.bot.entities[5]);f.bot.entities[5].metadata[registry.entitiesByName.enderman.metadataKeys.indexOf('creepy')]=true;f.bot.emit('entityUpdate',f.bot.entities[5]);assert.equal(records.length,2);assert.equal(records[1].facts.flags.creepy,true);assert.equal(selectNeutralSafeLook(f.bot,0,0),null);
});
for(const mode of ['spawn','physics_tick','paused','angry'])test(`new neutral entity enters an existing current look ${mode}`,async t=>{
 const f=setup(t),before=f.bot.entity.position.clone(),v=f.bot.entity.velocity.clone(),controls={...f.bot.controlState};
 if(mode==='angry')f.bot.entities[5].metadata[registry.entitiesByName.enderman.metadataKeys.indexOf('creepy')]=true;
 const close=installHouseNeutralGaze({bot:f.bot,shouldGuard:()=>mode!=='paused'});t.after(close);
 // No new bot.look request: this is the gap after a current yaw is already set.
 if(mode==='physics_tick')f.bot.emit('physicsTick');else f.bot.emit('entitySpawn',f.bot.entities[5]);
 await Promise.resolve();
 assert.equal(f.bot.entity.pitch<-.7,mode==='spawn'||mode==='physics_tick');
 assert.deepEqual(f.bot.entity.position,before);assert.deepEqual(f.bot.entity.velocity,v);assert.deepEqual(f.bot.controlState,controls);
 close();assert.equal(f.bot.listenerCount('entitySpawn'),0);
});
