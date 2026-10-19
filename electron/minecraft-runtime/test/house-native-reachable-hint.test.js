/* global require, setInterval, clearInterval */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),{Physics,PlayerState}=require('prismarine-physics'),{pathfinder}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {createLoadedDryGraph,hasGroundedBodySupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
const copy=v=>JSON.parse(JSON.stringify(v));
// Original installed pathfinder/Physics in an explicitly bounded loaded voxel
// corridor. No server, model, target-pose assignment or native package changes.
function fixture(t,options={}) {
 const controls=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false])),moves=[];
 let cp=null;
 const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',username:'NativeHint',health:20,food:20,entities:{},players:{},player:{ping:1},
  game:{dimension:'overworld',minY:-64,height:384},inventory:{items:()=>[],slots:Array(46).fill(null)},controlState:controls,
  jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,_client:{state:'play',socket:{writable:true,destroyed:false}},
  entity:{position:new Vec3(.5,1,.5),velocity:new Vec3(0,0,0),onGround:true,yaw:0,pitch:0,eyeHeight:1.62,width:.6,height:1.8,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false}});
 bot.blockAt=raw=>{const p=raw.floored();if(p.x< -2||p.x>20||Math.abs(p.z)>1||p.y< -40||p.y>40)return null;
  const name=p.y<1||p.x===8&&p.y<=4?'stone':'air';return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:p});};
 bot.look=async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;};bot.setControlState=(n,v)=>{controls[n]=v;};bot.clearControlStates=()=>{for(const n of Object.keys(controls))controls[n]=false;};
 bot.stopDigging=()=>{};bot.deactivateItem=()=>{};
 bot.physics=Physics(registry,{getBlock:bot.blockAt});pathfinder(bot);
 const nativeGoto=bot.pathfinder.goto.bind(bot.pathfinder);bot.pathfinder.goto=goal=>{moves.push({x:goal.x,y:goal.y,z:goal.z});return nativeGoto(goal);};
 const timer=setInterval(()=>{bot.physics.simulatePlayer(new PlayerState(bot,controls),{getBlock:bot.blockAt}).apply(bot);bot.emit('physicsTick');},5);
 const deps={getBot:()=>bot,assertActive:()=>{},isMovementOwner:()=>true,getCP:()=>cp,saveCP:v=>{cp=copy(v);},...(options.pathprobe?{pathprobe:options.pathprobe}:{}),
  ...(options.noArrival?{actualnativegoto:async()=>{}}:{})};
 const graph=createLoadedDryGraph(deps,{anchor:{x:0,y:1,z:0},step:16,radius:32,maxNodes:8,maxEdges:64,timeoutMs:10000,legTimeoutMs:4000,nativeReachableHints:options.enabled===true});
 t.after(()=>{clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();});
 return{bot,graph,moves,state:()=>cp};
}
test('conclusive failed distant goal offers a separately re-probed reachable native endpoint, credited only after real arrival',{timeout:7000},async t=>{
 const f=fixture(t,{enabled:true}),result=await f.graph.next();
 if(!result.moved)t.diagnostic(JSON.stringify({result,state:f.state()}));
 assert.equal(result.moved,true);assert.ok(result.actual.x>=4&&result.actual.x<8);
 assert.equal(f.state().visits,2);assert.equal(f.state().order.length,2);assert.equal(f.state().nodes['16,1,0'],undefined);
 assert.ok(f.state().blockedEdges.some(e=>e.target.x===16&&e.reason==='native_no_path'&&e.observedProbe.conclusive));
 assert.ok(f.moves.every(p=>p.x<8));assert.equal(hasGroundedBodySupport(f.bot),true);
});
test('default exploration does not reinterpret a noPath route as successful movement',async t=>{
 const f=fixture(t),result=await f.graph.next();assert.equal(result.moved,false);assert.equal(f.moves.length,0);assert.equal(f.state().visits,1);
});
test('an endpoint hint with an inconclusive own probe grants neither movement nor a visit',async t=>{
 const f=fixture(t,{enabled:true,pathprobe:(_m,g)=>g.x===16?{status:'noPath',path:[{x:7,y:1,z:0,toBreak:[],toPlace:[]}]}:{status:'timeout',path:[{x:7,y:1,z:0,toBreak:[],toPlace:[]}]}});
 const result=await f.graph.next();assert.equal(result.moved,false);assert.equal(f.moves.length,0);assert.equal(f.state().visits,1);
});

test('a successful endpoint probe followed by a resolved executor without actual arrival grants no visit',{timeout:7000},async t=>{
 const f=fixture(t,{enabled:true,noArrival:true});
 const outcome=await f.graph.next().then(value=>({value}),error=>({error}));
 assert.ok(outcome.error||outcome.value?.moved===false);
 assert.equal(f.state().visits,1);assert.equal(f.state().order.length,1);
 assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,1,.5))<.01);
});
