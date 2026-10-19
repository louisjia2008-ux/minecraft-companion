'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3'),{Movements,goals}=require('mineflayer-pathfinder');
const filename=path.join(__dirname,'mining-combat-coordination.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\ntest('))+'\nmodule.exports={fixture};\n',filename);
const {approachHouseRanged}=require('../vendor/server/minecraft/houseMeleeApproach');
test('formal22 checked contact approach routes around an owned chest instead of stepping onto its fractional lid',{timeout:8000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false}),profile=new Movements(f.bot);Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allowSprinting:false,allow1by1towers:false,allowFreeMotion:false,infiniteLiquidDropdownDistance:false,maxDropDown:2});profile.getMoveDiagonal=()=>{};f.bot.pathfinder.setMovements(profile);
 f.change('chest',new Vec3(0,1,1));const threat={id:88,name:'zombie',position:new Vec3(.5,1,5),height:1.95,isValid:true},plans=[],before=profile.exclusionAreasStep.length;
 const r=await approachHouseRanged({getBot:()=>f.bot,assertActive:()=>f.task.cancellationToken.throwIfRequested(),getThreat:()=>threat,canContinueEngagement:()=>true,onPlan:p=>plans.push(p),goto:goal=>f.bot.pathfinder.goto(goal)}, {origin:{x:.5,y:1,z:.5},deadline:Date.now()+5000,contact:true});
 assert.equal(r,true,JSON.stringify(plans));assert.equal(f.bot.entity.onGround,true);assert.ok(f.bot.entity.position.distanceTo(threat.position)<=3);assert.equal(f.bot.blockAt(new Vec3(0,1,1)).name,'chest');assert.ok(plans.every(p=>p.path.every(n=>n.x!==0||n.z!==1||n.y!==2)));assert.equal(profile.exclusionAreasStep.length,before);
});

test('pause during the narrowed native proposal removes only its own planning restriction and sends no move',{timeout:5000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false}),profile=new Movements(f.bot);Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allowSprinting:false,allow1by1towers:false,allowFreeMotion:false,infiniteLiquidDropdownDistance:false,maxDropDown:2});profile.getMoveDiagonal=()=>{};f.bot.pathfinder.setMovements(profile);
 const before=profile.exclusionAreasStep.length,probe=f.bot.pathfinder.getPathFromTo;
 f.bot.pathfinder.getPathFromTo=function*(...args){const it=probe.apply(this,args),next=it.next();f.task.cancellationToken.pause();yield next.value;};
 const threat={id:88,name:'zombie',position:new Vec3(.5,1,5),height:1.95,isValid:true};
 await assert.rejects(approachHouseRanged({getBot:()=>f.bot,assertActive:()=>f.task.cancellationToken.throwIfRequested(),getThreat:()=>threat,goto:goal=>f.bot.pathfinder.goto(goal)}, {origin:{x:.5,y:1,z:.5},deadline:Date.now()+2000,contact:true}),{code:'paused'});
 assert.equal(profile.exclusionAreasStep.length,before);assert.equal(f.attempts.length,0);assert.equal(f.attacks.length,0);
});

test('modeled fluid rejection of native proposed approach retains actual dry stance for original combat owner',{timeout:5000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false}),profile=new Movements(f.bot);Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allowSprinting:false,allow1by1towers:false,allowFreeMotion:false,infiniteLiquidDropdownDistance:false,maxDropDown:2});profile.getMoveDiagonal=()=>{};f.bot.pathfinder.setMovements(profile);
 const threat={id:88,name:'polar_bear',position:new Vec3(.5,1,5),height:1.4,isValid:true},plans=[],start=f.bot.entity.position.clone();
 const result=await approachHouseRanged({getBot:()=>f.bot,assertActive:()=>f.task.cancellationToken.throwIfRequested(),getThreat:()=>threat,onPlan:p=>plans.push(p),goto:async()=>{throw Object.assign(Error('modeled checked step rejected before movement'),{code:'MINING_FLUID'});}}, {origin:{x:.5,y:1,z:.5},deadline:Date.now()+3000,contact:true});
 assert.equal(result,false);assert.equal(f.bot.entity.position.distanceTo(start),0);assert.equal(f.attacks.length,0);assert.ok(plans.some(p=>p.status==='checked_route_rejected'&&p.actualMovementConfirmed===false));
});

test('modeled knockback to a native-supported ledge holds the real body without granting a center-column step',{timeout:5000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false}),profile=new Movements(f.bot);Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allowSprinting:false,allow1by1towers:false,allowFreeMotion:false,infiniteLiquidDropdownDistance:false,maxDropDown:2});profile.getMoveDiagonal=()=>{};f.bot.pathfinder.setMovements(profile);
 const threat={id:88,name:'zombie',position:new Vec3(.5,1,5),height:1.95,isValid:true},plans=[];
 const result=await approachHouseRanged({getBot:()=>f.bot,assertActive:()=>f.task.cancellationToken.throwIfRequested(),getThreat:()=>threat,onPlan:p=>plans.push(p),goto:async()=>{
  // Explicit modeled impact, not a native movement or real-server receipt.
  f.change('air',new Vec3(0,0,0));f.bot.entity.position=new Vec3(.5,1,.18);
  throw Object.assign(Error('modeled center-column support refusal'),{code:'MINING_NO_SUPPORT'});
 }},{origin:{x:.5,y:1,z:.5},deadline:Date.now()+3000,contact:true});
 assert.equal(result,false);assert.equal(require('../vendor/server/minecraft/houseSurfaceGraph').naturalWalkingFoot(f.bot,f.bot.entity.position.floored()),false);
 assert.ok(plans.some(p=>p.status==='checked_route_rejected'&&!p.actualMovementConfirmed));assert.equal(f.attacks.length,0);
});
