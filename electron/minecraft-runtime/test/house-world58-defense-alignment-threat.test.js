'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3'),{Movements}=require('mineflayer-pathfinder');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const main=path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),host=fs.readFileSync(main,'utf8'),start=host.indexOf('      isStepAllowed: position => {',host.indexOf('async function exploreHouseSurfaceGraph')),end=host.indexOf('\n      onFailure:',start),callback=host.slice(start,end).replace('      isStepAllowed:','').trim().replace(/,$/,'');
const terrain=require('../test-support/fixtures/formal58-run138-defense-alignment.json'),{naturalWalkingFoot,hasGroundedBodySupport,inspectSurfaceBody}=require('../vendor/server/minecraft/houseSurfaceGraph'),{alignHouseGraphOrigin}=require('../vendor/server/minecraft/houseGraphOriginAlignment');
for(const mode of ['owned','ordinary','foreign','pause'])test(`world138 supported alignment against inherited melee avoidance: ${mode}`,{timeout:4000},async t=>{
 const f=native.exports.fixture(t,{initialPosition:new Vec3(-175.04045246828971,69,43.49968226915429),initialVelocity:new Vec3(-.005218368867040633,-.0784000015258789,0),worldAt:p=>{const i=terrain.states[`${p.x},${p.y},${p.z}`];return i===undefined?null:terrain.palette[i];}}),bot=f.bot,profile=new Movements(bot),ownerTask={},client=bot._client,generation=3;
 Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allowSprinting:false,allow1by1towers:false,allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false});profile.getMoveDiagonal=()=>{};
 bot.entities[41]={id:41,name:'creeper',isValid:true,position:new Vec3(-169.15310643543583,69,43.50755972490217)};
 const deps={bot,ownerTask,client,generation,Vec3,require:Module.createRequire(main),toVec3:p=>new Vec3(p.x,p.y,p.z),allowsUnarmedHouseRangedStep:()=>true,isUnarmedHouseExplorer:()=>true,isThreateningMobEntity:require('../vendor/server/minecraft/entitySemantics').isThreateningMobEntity,hasGroundedBodySupport,inspectSurfaceBody,
  activeSurvivalInterrupt:{originAlignmentActive:mode!=='ordinary',bot,client,task:ownerTask,runGeneration:generation,lease:{}},isSurvivalOwnerCurrent:()=>mode!=='foreign',isMovementLeaseActive:()=>true};
 const allow=Function(...Object.keys(deps),`return (${callback});`)(...Object.values(deps));profile.exclusionAreasStep.push(b=>allow(b.position)?0:Infinity);bot.pathfinder.setMovements(profile);
 assert.equal(naturalWalkingFoot(bot,bot.entity.position.floored()),false);assert.equal(hasGroundedBodySupport(bot),true);
 if(mode==='pause')f.cancel();
 const run=alignHouseGraphOrigin({...f.deps,goto:g=>bot.pathfinder.goto(g)},{deadline:Date.now()+2000});
 if(mode==='owned'){await run;assert.equal(naturalWalkingFoot(bot,bot.entity.position.floored()),true);assert.ok(f.points.length);}
 else{await assert.rejects(run);assert.equal(f.attempts.length,0);}
});
