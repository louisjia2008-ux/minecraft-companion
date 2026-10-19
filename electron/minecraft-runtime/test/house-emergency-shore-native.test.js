'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),{Physics,PlayerState}=require('prismarine-physics'),{pathfinder,Movements,goals}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {escapeEmergencyShore}=require('../vendor/server/minecraft/houseEmergencyShore');
const {naturalWalkingFoot,hasGroundedBodySupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
function fixture(t,{threat=false}={}){
 const origin=new Vec3(-63.5,62.2,20.5),controls=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false]));
 const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',health:15,food:17,game:{dimension:'overworld',minY:-64,height:384},entities:{},players:{},player:{ping:1},inventory:{slots:Array(46).fill(null),items:()=>[]},controlState:controls,jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,_client:{state:'play',socket:{writable:true,destroyed:false}},
 entity:{position:origin.clone(),velocity:new Vec3(0,0,0),yaw:0,pitch:0,onGround:false,width:.6,height:1.8,eyeHeight:1.62,isInWater:true,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:false,effects:{},attributes:{},elytraFlying:false},
 look:async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;},setControlState:(name,value)=>{controls[name]=value;},clearControlStates:()=>{for(const name of Object.keys(controls))controls[name]=false;},deactivateItem:()=>{},stopDigging:()=>{}});
 bot.blockAt=q=>{const p=q.floored();if(Math.abs(p.x-origin.x)>20||Math.abs(p.z-origin.z)>20)return null;
  const name=p.y<60?'stone':p.x>=-61?(p.y<=61?'stone':'air'):p.y<=62?'water':'air';return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:p});};
 if(threat)bot.entities[4]={id:4,name:'zombie',isValid:true,position:new Vec3(-67.5,63,20.5)};
 const world={getBlock:p=>bot.blockAt(p)};bot.physics=Physics(registry,world);pathfinder(bot);const previous=bot.pathfinder.movements,records=[],plans=[];
 const get=bot.pathfinder.getPathTo.bind(bot.pathfinder);bot.pathfinder.getPathTo=(...args)=>{const result=get(...args);plans.push({status:result.status,path:result.path.map(p=>({x:p.x,y:p.y,z:p.z}))});return result;};
 const timer=setInterval(()=>{bot.physics.simulatePlayer(new PlayerState(bot,controls),world).apply(bot);bot.emit('physicsTick');},5);
 t.after(()=>{clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();});
 return {bot,previous,records,plans,deps:{getBot:()=>bot,Vec3,Movements,GoalBlock:goals.GoalBlock,assertActive(){},isDryFoot:p=>naturalWalkingFoot(bot,p),isGrounded:()=>hasGroundedBodySupport(bot),goto:goal=>bot.pathfinder.goto(goal),record:(kind,facts)=>records.push({kind,facts})}};
}
for(const threat of [false,true])test(`native accidental swimming reaches a loaded dry bank through the installed pathfinder and actual physics: threat=${threat}`,{timeout:15000},async t=>{
 const f=fixture(t,{threat});try{assert.equal(await escapeEmergencyShore(f.deps),true);}catch(e){e.message+=' '+JSON.stringify({records:f.records,plans:f.plans.slice(0,2)});throw e;}
 assert.equal(hasGroundedBodySupport(f.bot),true);assert.equal(naturalWalkingFoot(f.bot,f.bot.entity.position.floored()),true);assert.ok(f.bot.entity.position.x>=-61);
 assert.equal(f.bot.pathfinder.movements,f.previous);assert.ok(f.records.some(r=>r.kind==='house_emergency_shore_confirmed'));
});
