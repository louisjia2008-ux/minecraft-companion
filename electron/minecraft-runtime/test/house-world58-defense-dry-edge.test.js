'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3'),{Movements,goals}=require('mineflayer-pathfinder');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const terrain=require('../test-support/fixtures/formal58-run113-dry-defense-edge.json'),bytes=require('zlib').gunzipSync(Buffer.from(terrain.statesGzipBase64,'base64'));
const {naturalWalkingFoot,hasGroundedBodySupport,inspectSurfaceBody}=require('../vendor/server/minecraft/houseSurfaceGraph');
const main=path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),host=fs.readFileSync(main,'utf8'),end=host.indexOf('        let creeperResponseDeadline=null;'),newStart=host.lastIndexOf('        if(bot.entity.isInWater===false&&inspectSurfaceBody(bot).dry&&hasGroundedBodySupport(bot)',end),oldStart=host.lastIndexOf('        if((bot.entity.isInWater===true||hasGroundedBodySupport(bot)',end),body=host.slice(newStart>=0?newStart:oldStart,end);
for(const pause of [false,true])test(`saved113 dry supported edge takes owned native alignment before any shore operation: pause=${pause}`,{timeout:5000},async t=>{
 const b=terrain.bounds,f=native.exports.fixture(t,{initialPosition:new Vec3(terrain.position.x,terrain.position.y,terrain.position.z),initialVelocity:new Vec3(terrain.velocity.x,terrain.velocity.y,terrain.velocity.z),worldAt:p=>{
  if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;const i=((p.x-b.minX)*(b.maxY-b.minY+1)+p.y-b.minY)*(b.maxZ-b.minZ+1)+p.z-b.minZ;return terrain.palette[bytes.readUInt16LE(i*2)];
 }}),bot=f.bot,profile=new Movements(bot);Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allowSprinting:false,allow1by1towers:false,allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false});profile.getMoveDiagonal=()=>{};bot.pathfinder.setMovements(profile);
 assert.equal(hasGroundedBodySupport(bot),true);assert.equal(naturalWalkingFoot(bot,bot.entity.position.floored()),false);assert.equal(inspectSurfaceBody(bot).dry,true);
 let shore=0;const records=[],realRequire=Module.createRequire(main),deps={Vec3,Movements,goals,dryFoot:require("../vendor/server/minecraft/houseSurfaceGraph").dryFoot,bot,currentBot:bot,inspectSurfaceBody,hasGroundedBodySupport,naturalWalkingFoot,activeHouseSurfaceWater:null,interrupt:{deadline:Date.now()+3000,task:{}},survivalLease:{},houseResourcePositionExcluded:()=>false,
 assertInterruptActive:()=>{if(pause)throw Object.assign(Error('paused'),{code:'paused'});},pathfinderGoto:g=>bot.pathfinder.goto(g),isSurvivalOwnerCurrent:()=>true,isMovementLeaseActive:()=>true,
 recordTaskDiagnostic:(_t,event,facts)=>records.push({event,facts}),require:n=>n.endsWith('houseEmergencyShore')?{escapeEmergencyShore:()=>{shore++;throw Error('dry edge must not request shore');}}:realRequire(n)};
 const run=Function(...Object.keys(deps),`return (async()=>{${body}});`)(...Object.values(deps));
 if(pause)await assert.rejects(run(),{code:'paused'});else{await run();assert.ok(records.some(r=>r.facts.aligned===true));assert.equal(naturalWalkingFoot(bot,bot.entity.position.floored()),true);assert.equal(bot.entity.onGround,true);assert.ok(f.points.length>0);}
 assert.equal(shore,0);
});
