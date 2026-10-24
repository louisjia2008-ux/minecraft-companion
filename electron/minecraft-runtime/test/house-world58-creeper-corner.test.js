'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3'),{Movements}=require('mineflayer-pathfinder');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const {createHouseCreeperEscape}=require('../vendor/server/minecraft/houseCreeperEscape');

for(const mode of ['ordinary','ignited','powered','low_health'])test(`world163 saved cliff corner ${mode}`, {timeout:8000},async t=>{
const terrain=require('../test-support/fixtures/formal58-run163-creeper-corner.json');
const f=native.exports.fixture(t,{initialPosition:new Vec3(-234.46720768114218,69,77.49943786466605),initialVelocity:new Vec3(0,-.0784000015258789,0),worldAt:p=>{const i=terrain.states[`${p.x},${p.y},${p.z}`];return i===undefined?null:terrain.palette[i];}}),bot=f.bot,profile=new Movements(bot);
Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allowSprinting:false,allow1by1towers:false,allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false});profile.getMoveDiagonal=()=>{};profile.exclusionAreasStep.push(()=>0);bot.pathfinder.setMovements(profile);
bot.health=mode==='low_health'?11:20;bot.inventory.items=()=>[{name:'wooden_sword'}];
for(const [id,name,x,y,z]of [[48,'creeper',-241.21527856255517,69,75.91206385776594],[55,'zombie',-238.48501210086934,69,73.46641443763689],[56,'zombie',-238.38691295274563,69,74.6212640957412]])bot.entities[id]={id,name,isValid:true,metadata:[],position:new Vec3(x,y,z)};
const keys=bot.registry.entitiesByName.creeper.metadataKeys;
if(mode==='ignited')bot.entities[48].metadata[keys.indexOf('is_ignited')]=true;
if(mode==='powered')bot.entities[48].metadata[keys.indexOf('is_powered')]=true;
const records=[],escape=createHouseCreeperEscape({...f.deps,isOwnerCurrent:()=>true,getThreat:()=>bot.entities[48],record:(kind,facts)=>records.push({kind,facts})},{threatName:'creeper',safeDistance:8.5,emergencyRetreat:true,emergencySprinting:true});
if(mode!=='ordinary'){await assert.rejects(escape.escape(),{code:'house_creeper_escape_no_path'});assert.equal(f.attempts.length,0);return;}
const r=await escape.escape();assert.equal(r.confirmed,true);assert.ok(r.traveled<=12);assert.ok(r.finalDistance>=8.5);assert.ok(records.some(e=>e.kind==='dry_escape_primary_lateral_floor'));assert.equal(bot.entity.onGround,true);
});
