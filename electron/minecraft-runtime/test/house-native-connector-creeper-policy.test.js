'use strict';
// Installed native pathfinder against original Physics fixture, static modeled
// threat coordinates. Planning policy alone is not actual Java combat proof.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3'),{Movements,goals}=require('mineflayer-pathfinder');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const {restrictNativeDryConnectorProfile}=require('../vendor/server/minecraft/houseNativeDryConnector');
for(const mode of ['ordinary','safe_other_direction','owned_defense','unowned_defense','underground'])test(`native cleanup connector avoids repeated creeper warning approach ${mode}`,t=>{
 const f=native.exports.fixture(t),bot=f.bot,profile=new Movements(bot);Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allow1by1towers:false,allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false});
 bot.entities[7]={id:7,name:'creeper',isValid:true,position:new Vec3(-9.5,mode==='underground'?-12:1,.5),metadata:[]};
 restrictNativeDryConnectorProfile(profile,{bot,isDefenseOwner:()=>mode==='owned_defense'?true:mode==='unowned_defense'?1:false});
 const goal=new goals.GoalBlock(mode==='safe_other_direction'?4:-5,1,0),probe=bot.pathfinder.getPathTo(profile,goal,200);
 if(mode==='ordinary'||mode==='unowned_defense')assert.notEqual(probe.status,'success');else assert.equal(probe.status,'success');
 assert.equal(profile.canDig,false);assert.equal(profile.allowSprinting,false);assert.equal(profile.maxDropDown,2);assert.equal(f.points.length,0);
});
