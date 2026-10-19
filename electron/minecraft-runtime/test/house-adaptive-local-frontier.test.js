'use strict';
// Original installed Physics and A*: only initialization configures the actor.
// Saved geometry is a component fixture, never a production coordinate input.
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),{Physics,PlayerState}=require('prismarine-physics'),{pathfinder}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const root=process.env.HOUSE_ADAPTIVE_FRONTIER_RUNTIME;
const {createLoadedDryGraph}=require(root?`${root}/vendor/server/minecraft/houseSurfaceGraph`:'../vendor/server/minecraft/houseSurfaceGraph');
function fixture(t,position,read){
 let cancelled=false,owner=true,cp=null;const controls=[],points=[],gotos=[],beforeGotos=[];
 const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',username:'OfflineAdaptive',health:20,food:20,oxygenLevel:20,
  game:{minY:-64,height:384,dimension:'overworld'},players:{},entities:{},player:{ping:1},inventory:{slots:Array(46).fill(null),items:()=>[]},
  _client:{state:'play',socket:{writable:true,destroyed:false}},jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,
  controlState:Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false])),
  entity:{position:position.clone(),velocity:new Vec3(0,-.0784000015258789,0),onGround:true,width:.6,height:1.8,eyeHeight:1.62,
   yaw:0,pitch:0,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false}});
 bot.blockAt=q=>read(q.floored());bot.look=async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;};
 bot.setControlState=(n,v)=>{controls.push({n,v,cancelled,owner});bot.controlState[n]=v;};
 bot.clearControlStates=()=>Object.keys(bot.controlState).forEach(n=>bot.setControlState(n,false));bot.stopDigging=()=>{};bot.deactivateItem=()=>{};
 bot.physics=Physics(registry,{getBlock:bot.blockAt});pathfinder(bot);const native=bot.pathfinder.goto.bind(bot.pathfinder);
 bot.pathfinder.goto=goal=>{gotos.push({x:goal.x,y:goal.y,z:goal.z});beforeGotos.push(JSON.parse(JSON.stringify(cp)));return native(goal);};
 const timer=setInterval(()=>{bot.physics.simulatePlayer(new PlayerState(bot,bot.controlState),{getBlock:bot.blockAt}).apply(bot);points.push(bot.entity.position.clone());bot.emit('physicsTick');},10);
 t.after(()=>{clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();});
 const deps={getBot:()=>bot,assertActive:()=>{if(cancelled)throw Object.assign(Error('cancelled'),{code:'cancelled'});},isMovementOwner:()=>owner,
  getCP:()=>cp,saveCP:v=>{cp=JSON.parse(JSON.stringify(v));}};
 return{bot,deps,controls,points,gotos,beforeGotos,checkpoint:()=>cp,cancel:()=>{cancelled=true;},loseOwner:()=>{owner=false;}};
}
const native=(name,p)=>Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:p});
const island=p=>Math.abs(p.x)<=4&&Math.abs(p.z)<=4?native(p.y<1?'stone':'air',p):null;

test('coarse frontier stays default; opt-in local native probes physically visit and return without claiming unknown land',{timeout:10000},async t=>{
 const f=fixture(t,new Vec3(.5,1,.5),island),anchor={x:0,y:1,z:0};
 const coarse=createLoadedDryGraph(f.deps,{anchor});assert.equal((await coarse.next()).moved,false);assert.equal(f.gotos.length,0);
 const g=createLoadedDryGraph(f.deps,{anchor,adaptiveLocalFrontier:true,maxEdges:256});
 const result=await g.next();assert.equal(result.moved,true);assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,1,.5))>1);
 assert.equal(f.bot.entity.onGround,true);assert.equal(f.checkpoint().visits,2);assert.equal(f.checkpoint().order.length,2);
 assert.ok(f.beforeGotos.every(cp=>cp.visits===1&&cp.order.length===1),'plans never add visits');
 assert.deepEqual(f.checkpoint().nodes['0,1,0'].localFrontierObservation.testedRanges,[8,4]);
 assert.equal(f.checkpoint().nodes['0,1,0'].localFrontierObservation.actualMovementConfirmed,false);
 await g.returnToAnchor();assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,1,0));assert.equal(f.checkpoint().visits,2);
 assert.equal(g.movements.canDig,false);assert.deepEqual(g.movements.scafoldingBlocks,[]);
});

test('original Physics actually reaches a short saved-world21 endpoint that the coarse16 grid missed',{timeout:10000},async t=>{
 const saved=require('../test-support/whole21-local-frontier-voxels.json'),b=saved.bounds,dy=b.maxY-b.minY+1,dz=b.maxZ-b.minZ+1;
 const read=p=>{if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;
  const index=saved.data[(p.x-b.minX)*dz*dy+(p.z-b.minZ)*dy+p.y-b.minY];if(index<0)return null;
  const value=saved.palette[index],block=Object.assign(Block.fromStateId(value.stateId),{position:p});assert.equal(block.name,value.name);assert.deepEqual(block.shapes,value.shapes);return block;};
 const p=saved.initialPosition,f=fixture(t,new Vec3(p.x,p.y,p.z),read),g=createLoadedDryGraph(f.deps,
  {anchor:saved.anchor,adaptiveLocalFrontier:true,maxEdges:512});
 const result=await g.next();assert.equal(result.moved,true);assert.ok(f.gotos.length>0);assert.equal(f.bot.entity.onGround,true);
 assert.equal(f.bot.entity.isInWater,false);assert.equal(f.bot.entity.isInLava,false);assert.equal(f.checkpoint().visits,2);
 assert.ok(f.points.some(point=>point.distanceTo(new Vec3(p.x,p.y,p.z))>2));
 assert.ok(f.checkpoint().nodes[`${saved.anchor.x},${saved.anchor.y},${saved.anchor.z}`].localFrontierObservation.testedRanges.includes(4));
});

test('simulated empty movement completion cannot turn a local plan into a visit',{timeout:6000},async t=>{
 const f=fixture(t,new Vec3(.5,1,.5),island);f.bot.pathfinder.goto=async()=>{};
 const g=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0},adaptiveLocalFrontier:true,maxEdges:256});
 const result=await g.next();assert.equal(result.moved,false);assert.equal(f.checkpoint().visits,1);assert.equal(f.checkpoint().order.length,1);
});

test('cancelling a local native leg preserves original cancellation and prohibits later positive controls',{timeout:10000},async t=>{
 const f=fixture(t,new Vec3(.5,1,.5),island);let cancelledAt=null;
 f.bot.on('physicsTick',()=>{if(!cancelledAt&&f.bot.entity.position.distanceTo(new Vec3(.5,1,.5))>.8){cancelledAt=Date.now();f.cancel();}});
 const g=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0},adaptiveLocalFrontier:true,maxEdges:256});
 await assert.rejects(g.next(),e=>e.code==='cancelled');assert.ok(cancelledAt);
 assert.equal(f.checkpoint().visits,1);assert.equal(f.controls.some(c=>c.cancelled&&c.v),false);
});
