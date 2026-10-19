'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const {createEmergencyBuoyancy}=require('../vendor/server/minecraft/houseEmergencyBuoyancy');
test('buoyancy owns only upward input and never writes through a replaced connection or formal water owner',()=>{
 const writes=[],bot={health:20,_client:{state:'play'},entity:{position:new Vec3(0,1,0),eyeHeight:1.62,isInWater:true},blockAt:()=>({name:'water'}),setControlState:(...x)=>writes.push(x)};
 let current=bot,handled=false;const f=createEmergencyBuoyancy({getBot:()=>current,isHandled:()=>handled,isDryGrounded:()=>false});
 f.tick();assert.deepEqual(writes,[['jump',true]]);
 handled=true;f.tick();assert.equal(writes.length,1);handled=false;
 current={...bot};f.tick();assert.equal(writes.length,1);current=bot;
 bot._client={state:'play'};f.tick();assert.equal(writes.length,1);f.close();f.tick();assert.equal(writes.length,1);
});
