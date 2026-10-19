'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3'),{Movements}=require('mineflayer-pathfinder');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const terrain=require('../test-support/fixtures/formal58-run145-contact-pack.json'),{createHouseCreeperEscape}=require('../vendor/server/minecraft/houseCreeperEscape');

test('world162 saved saddle escape', {timeout:8000},async t=>{
const terrain=require('../test-support/fixtures/formal58-run162-creeper-saddle.json');
const f=native.exports.fixture(t,{initialPosition:new Vec3(-246.39375780219683,69,73.58360568403664),initialVelocity:new Vec3(0,-.0784000015258789,0),worldAt:p=>{const i=terrain.states[`${p.x},${p.y},${p.z}`];return i===undefined?null:terrain.palette[i];}}),bot=f.bot,profile=new Movements(bot);
Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allowSprinting:false,allow1by1towers:false,allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false});profile.getMoveDiagonal=()=>{};profile.exclusionAreasStep.push(()=>0);bot.pathfinder.setMovements(profile);
bot.health=20;bot.inventory.items=()=>[{name:'wooden_sword'}];
for(const [id,x,y,z]of [[42,-240.14100255645167,68,69.14674104964418],[52,-259.15380928720475,67,69.47195958170711]])bot.entities[id]={id,name:'creeper',isValid:true,position:new Vec3(x,y,z)};
const helper=path.join(__dirname,'../vendor/server/minecraft/houseCreeperEscape.js'),probe=new Module(helper,module);probe.filename=helper;probe.paths=Module._nodeModulePaths(path.dirname(helper));
// Model the spent first-leg budget from native162, then run original native
// pathfinder/physics from its actual stopped pose. No live Java credit.
probe._compile(fs.readFileSync(helper,'utf8').replace('traveled:0,steps:0,probes:0,planningMs:0','traveled:9.617562972898764,steps:10,probes:1,planningMs:0,previousThreatPosition:{x:-239.25330724395167,z:68.28272737776918}').replace('let leg=0;leg<maximumLegs','let leg=1;leg<maximumLegs'),helper);
const records=[],escape=probe.exports.createHouseCreeperEscape({...f.deps,isOwnerCurrent:()=>true,getThreat:()=>bot.entities[42],record:(kind,facts)=>records.push({kind,facts})},{threatName:'creeper',safeDistance:8.5,emergencyRetreat:true,emergencySprinting:true});
try{const r=await escape.escape();assert.equal(r.confirmed,true);}catch(e){console.log(e.code,e.planStats,records.slice(-3));throw e;}
});
