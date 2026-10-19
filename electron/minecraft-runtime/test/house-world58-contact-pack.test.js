'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3'),{Movements}=require('mineflayer-pathfinder');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const terrain=require('../test-support/fixtures/formal58-run145-contact-pack.json'),{createHouseCreeperEscape}=require('../vendor/server/minecraft/houseCreeperEscape');
for(const mode of ['unarmed','armed','creeper','pause'])test(`world145 saved contact pack bounded escape: ${mode}`,{timeout:8000},async t=>{
 const f=native.exports.fixture(t,{initialPosition:new Vec3(-164.5,68,45.5),initialVelocity:new Vec3(0,-.0784000015258789,0),worldAt:p=>{const i=terrain.states[`${p.x},${p.y},${p.z}`];return i===undefined?null:terrain.palette[i];}}),bot=f.bot,profile=new Movements(bot);
 Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allowSprinting:false,allow1by1towers:false,allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false});profile.getMoveDiagonal=()=>{};profile.exclusionAreasStep.push(()=>0);bot.pathfinder.setMovements(profile);
 for(const [id,name,x,y,z]of [[30,'zombie',-164.87479625165327,68,46.03606593007716],[66,'zombie',-165.46135825172755,68,46.60253474927384],[31,'zombie_villager',-166.29542761442391,68.00129881501198,46.38650255787113],[63,'zombie',-166.13633060583882,68,47.05078972317035],[29,'zombie',-167.8543274156767,68,47.69999998807907],[62,'zombie',-168.92886675858784,70,45.91776512932758]])bot.entities[id]={id,name,isValid:true,position:new Vec3(x,y,z)};
 if(mode==='armed')bot.inventory.items=()=>[{name:'wooden_sword'}];
 if(mode==='creeper')bot.entities[30].name='creeper';
 const records=[],escape=createHouseCreeperEscape({...f.deps,isOwnerCurrent:()=>true,getThreat:()=>bot.entities[30],record:(kind,facts)=>records.push({kind,facts})},{threatName:mode==='creeper'?'creeper':'zombie',safeDistance:mode==='creeper'?8.5:5,emergencyRetreat:true,emergencySprinting:true});
 if(mode==='pause')f.cancel();
 if(mode!=='unarmed'){await assert.rejects(escape.escape(),e=>e.code===(mode==='pause'?'cancelled':'house_creeper_escape_no_path'));assert.equal(f.attempts.length,0);assert.equal(records.some(r=>r.kind==='dry_escape_contact_pack_floor'),false);return;}
 const r=await escape.escape();
 assert.equal(r.confirmed,true);assert.ok(r.traveled<=12);assert.ok(r.elapsedMs<=4000);assert.ok(f.points.length);assert.equal(bot.entity.onGround,true);assert.ok(records.some(r=>r.kind==='dry_escape_contact_pack_floor'));
});
