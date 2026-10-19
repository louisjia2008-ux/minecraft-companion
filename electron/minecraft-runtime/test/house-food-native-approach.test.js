'use strict';
// Native actor/pathfinder; independently modeled fleeing rabbit and attack
// ACK only. This does not prove a Java kill, drop, or nutrition acceptance.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const main=path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),host=fs.readFileSync(main,'utf8'),start=host.indexOf('  async function huntFoodAnimal('),end=host.indexOf('\n  function saveEmergencyFoodPath(',start),callback=host.slice(start,end),{HouseFoodApproachGoal}=require('../vendor/server/minecraft/houseHuntingApproach');
test('food approach uses two-block end with original one-block target refresh',()=>{
 const animal={position:new Vec3(5.5,1,.5)},g=new HouseFoodApproachGoal(animal);assert.equal(g.rangeSq,4);assert.equal(g.isEnd({x:3,y:1,z:0}),true);
 animal.position.x+=2;assert.equal(g.hasChanged(),true);assert.equal(g.x,7);assert.equal(g.rangeSq,4);
});
for(const mode of ['flee','pause'])test(`production hunt arms before native approach and attacks in reach: ${mode}`,{timeout:5000},async t=>{
 const f=native.exports.fixture(t),bot=f.bot,order=[],rabbit={id:2,name:'rabbit',isValid:true,width:.4,height:.5,position:new Vec3(6.5,1,.5),metadata:[]};bot.entities[2]=rabbit;bot.heldItem={name:'snowball',type:1};
 bot.on('physicsTick',()=>{if(rabbit.isValid&&rabbit.position.distanceTo(bot.entity.position)<2.8)rabbit.position.x+=.22;});
 const reach=(a,b)=>Math.max(0,a.position.distanceTo(b.position)-.5);
 const deps={goals:require('mineflayer-pathfinder').goals,require:Module.createRequire(main),Date,ensureBotReady:()=>bot,checkTaskSignal:f.deps.assertActive,foodSupplyRunning:false,
  getExecutionContext:()=>({houseSelfSupply:true,task:{}}),settleHouseFoodThreats:async()=>{},isHuntableFoodAnimal:e=>e.isValid,assertHuntingHealth:()=>{},meleeReachDistance:reach,
  clamp:(n,a,b)=>Math.max(a,Math.min(n,b)),pathfinderGoto:async goal=>{assert.equal(bot.heldItem.name,'wooden_sword');assert.equal(goal.rangeSq,4);order.push('approach');if(mode==='pause')f.cancel();f.deps.assertActive();const timer=setTimeout(()=>bot.pathfinder.stop(),1800);try{await bot.pathfinder.goto(goal);}finally{clearTimeout(timer);}},
  recoverHouseLocalRoute:async()=>false,toPlainPosition:p=>({x:p.x,y:p.y,z:p.z}),waitForSurfaceGround:async()=>{},stopBotActions:()=>{bot.pathfinder.setGoal(null);bot.clearControlStates();},
  equipBestWeapon:async()=>{order.push('equip');bot.heldItem={name:'wooden_sword',type:2};},combatMemory:{},meleeAttackReadyAt:last=>last+30,sleep:ms=>new Promise(r=>setTimeout(r,Math.min(ms,30))),
  safeBotLookAt:async()=>{},physicalAttack:async live=>{assert.ok(reach(bot.entity,live)<=2.75);assert.equal(bot.heldItem.name,'wooden_sword');order.push('attack');live.isValid=false;},
  recordTaskHeartbeat:()=>{},recordTaskDiagnostic:()=>{},currentTask:{},collectNearbyDroppedItems:async()=>order.push('observe_drops')};
 const hunt=Function(...Object.keys(deps),`${callback};return huntFoodAnimal;`)(...Object.values(deps));
 if(mode==='pause'){await assert.rejects(hunt(rabbit,bot.entity.position.clone(),64),{code:'cancelled'});assert.equal(order.includes('attack'),false);return;}
 await hunt(rabbit,bot.entity.position.clone(),64);assert.equal(order[0],'equip');assert.ok(order.includes('approach'));assert.ok(order.includes('attack'));assert.ok(f.points.length>5);assert.equal(bot.entity.onGround,true);
});
