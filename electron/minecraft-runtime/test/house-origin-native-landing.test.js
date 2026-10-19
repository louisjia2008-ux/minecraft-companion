'use strict';
// Native actor motion. A separate fixture jump models the falling state seen
// after the real world156 alignment; it does not attribute a Java hurt source.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3'),{Movements}=require('mineflayer-pathfinder');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const {alignHouseGraphOrigin}=require('../vendor/server/minecraft/houseGraphOriginAlignment');
for(const mode of ['native','pause','foreign','changed_floor'])test(`world156 native post-goal falling alignment: ${mode}`,{timeout:5000},async t=>{
 let changed=false;const f=native.exports.fixture(t,{initialPosition:new Vec3(.9,1,.5),initialVelocity:new Vec3(0,-.0784000015258789,0),worldAt:p=>p.y<0?'stone':p.y===0?(p.x>=1?(changed?'air':'stone'):'air'):'air'}),bot=f.bot,profile=new Movements(bot);
 Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allowSprinting:false,allow1by1towers:false,allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false});profile.getMoveDiagonal=()=>{};bot.pathfinder.setMovements(profile);
 let airborne=null,other=null;
 const result=alignHouseGraphOrigin({...f.deps,goto:async goal=>{
  await bot.pathfinder.goto(goal);bot.setControlState('jump',true);await new Promise(r=>bot.once('physicsTick',r));bot.clearControlStates();
  const until=Date.now()+1500;while(Date.now()<until&&!(bot.entity.onGround===false&&bot.entity.velocity.y<0&&bot.entity.position.y<1.3))await new Promise(r=>bot.once('physicsTick',r));
  assert.equal(bot.entity.onGround,false);airborne=bot.entity.position.clone();
  if(mode==='changed_floor')changed=true;
  if(mode==='pause')setTimeout(f.cancel,1);
  if(mode==='foreign')setTimeout(()=>{other=new Movements(bot);bot.pathfinder.setMovements(other);},1);
 }},{deadline:Date.now()+3000});
 if(mode==='native'){const r=await result;assert.equal(r.aligned,true);assert.ok(airborne.y>1);assert.equal(bot.entity.position.y,1);assert.equal(bot.entity.onGround,true);assert.equal(r.positionOrVelocityWritten,false);assert.equal(r.graphNodeCredit,false);}
 else{await assert.rejects(result,e=>e.code===({pause:'cancelled',foreign:'house_graph_origin_preempted',changed_floor:'house_graph_origin_arrival_unconfirmed'}[mode]));if(mode==='foreign')assert.equal(bot.pathfinder.movements,other);}
});
