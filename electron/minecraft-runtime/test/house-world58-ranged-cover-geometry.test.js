'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3'),{Movements}=require('mineflayer-pathfinder');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const terrain=require('../test-support/fixtures/formal58-run142-ranged-cover.json'),{seekHouseRangedCover}=require('../vendor/server/minecraft/houseRangedCover');
test('world142 saved terrain checks native reachable cover beyond sparse ring samples',{timeout:10000},async t=>{
 const f=native.exports.fixture(t,{initialPosition:new Vec3(-166.88566706473435,71,55.46452624882942),initialVelocity:new Vec3(-.045155173211483414,-.0784000015258789,0),worldAt:p=>{const i=terrain.states[`${p.x},${p.y},${p.z}`];return i===undefined?null:terrain.palette[i];}}),bot=f.bot,profile=new Movements(bot);
 Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allowSprinting:false,allow1by1towers:false,allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false});profile.getMoveDiagonal=()=>{};bot.pathfinder.setMovements(profile);
 bot.entities[10]={id:10,name:'skeleton',isValid:true,height:1.99,position:new Vec3(-159.6,71,49.1)};
 const records=[],result=await seekHouseRangedCover({...f.deps,goto:g=>bot.pathfinder.goto(g),record:(kind,facts)=>records.push({kind,facts})},{deadline:Date.now()+8000});
 assert.equal(result.covered,true);assert.ok(records.some(r=>r.kind==='house_ranged_cover_native_probe'&&r.facts.path.some(p=>p.y===68)));assert.ok(f.points.length);assert.equal(bot.entity.onGround,true);
});
