'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3'),{Movements,goals}=require('mineflayer-pathfinder');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const terrain=require('../test-support/fixtures/formal58-run101-passage.json'),host=fs.readFileSync(path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),'utf8'),start=host.indexOf('  function allowsUnarmedHouseRangedStep('),end=host.indexOf('  function terrainSeparatedHouseMelee(',start);
const {rangedCoverConfirmed}=require('../vendor/server/minecraft/houseRangedCover');
for(const mode of ['saved','open','unknown','witch'])test(`world58 actual covered passage is traversable only with observed full-body occlusion: ${mode}`,async t=>{
 const f=native.exports.fixture(t,{initialPosition:new Vec3(-159.5003338461554,66,70.5),worldAt:p=>{if(p.z<69&&mode==='unknown')return null;if(p.z<69&&mode==='open')return 'air';let id=terrain.states[`${p.x},${p.y},${p.z}`];return id===undefined?null:terrain.palette[id];}});
 const enemy={id:19,name:mode==='witch'?'witch':'skeleton',height:1.99,isValid:true,position:new Vec3(-166.79047975166165,71,50.26009031644726)};f.bot.entities[19]=enemy;
 const deps={currentTask:{status:'running'},TaskState:{RUNNING:'running'},isUnarmedHouseExplorer:()=>true,isThreateningMobEntity:()=>true,isHouseRangedThreatEntity:()=>true,shouldAvoidHouseRangedThreat:()=>true,activeSurvivalInterrupt:null,terrainSeparatedHouseMelee:()=>false,rangedCoverConfirmed,Vec3};
 const allowed=Function(...Object.keys(deps),`${host.slice(start,end)};return allowsUnarmedHouseRangedStep;`)(...Object.values(deps));
 const p=new Vec3(-160,66,69);assert.equal(allowed(f.bot,p),mode==='saved');
 const profile=new Movements(f.bot);Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allowSprinting:false,allow1by1towers:false});profile.getMoveDiagonal=()=>{};profile.exclusionAreasStep.push(b=>allowed(f.bot,b.position)?0:Infinity);f.bot.pathfinder.setMovements(profile);
 if(mode==='saved'){const goal=new goals.GoalBlock(p.x,p.y,p.z),plan=f.bot.pathfinder.getPathTo(profile,goal,100);assert.equal(plan.status,'success');await f.bot.pathfinder.goto(goal);assert.equal(f.bot.entity.position.floored().equals(p),true);assert.ok(f.points.length>0);}
});
