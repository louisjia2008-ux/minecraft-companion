'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),{Physics,PlayerState}=require('prismarine-physics'),{pathfinder}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {planHouseLocalRoute}=require('../vendor/server/minecraft/houseLocalRoute'),{createMiningNavigator}=require('../vendor/server/minecraft/miningNavigation');
const terrain=require('../test-support/fixtures/formal10-camp-return.json');
// Offline replay of read-only saved terrain. Subsequent body motion belongs
// exclusively to installed Prismarine Physics and native pathfinder.
test('formal10 new local plan physically executes through the recorded slope without excavating its own route support',{timeout:15000},async t=>{
 const controls=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false])),changed=new Map(),digs=[];
 const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',game:{dimension:'overworld',minY:-64,height:384},entities:{},players:{},player:{ping:1},inventory:{slots:Array(46).fill(null),items:()=>[]},controlState:controls,jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,
  entity:{position:new Vec3(terrain.from.x+.5,terrain.from.y,terrain.from.z+.5),velocity:new Vec3(0,-.0784000015258789,0),onGround:true,height:1.8,width:.6,eyeHeight:1.62,yaw:0,pitch:0,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false},
  setControlState:(n,v)=>{controls[n]=v;},clearControlStates:()=>{for(const n of Object.keys(controls))controls[n]=false;},look:async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;}});
 bot.blockAt=point=>{const p=point.floored(),b=terrain.bounds;if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;const state=changed.get(p.toString())||terrain.states[`${p.x},${p.y},${p.z}`]||{name:'air',properties:{}};return Object.assign(Block.fromProperties(registry.blocksByName[state.name].id,state.properties,0),{position:p});};
 const world={getBlock:p=>bot.blockAt(p)};bot.physics=Physics(registry,world);pathfinder(bot);
 const timer=setInterval(()=>{bot.physics.simulatePlayer(new PlayerState(bot,controls),world).apply(bot);bot.emit('physicsTick');},5);
 t.after(()=>{clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();});
 const prior=new Set(terrain.priorFloors.map(p=>`${p.x},${p.y},${p.z}`));
 const plan=planHouseLocalRoute({blockAt:p=>bot.blockAt(new Vec3(p.x,p.y,p.z)),from:terrain.from,goal:terrain.goal,protectedPosition:p=>prior.has(`${p.x},${p.y},${p.z}`),canDig:()=>true,maxDigs:18});assert.ok(plan);
 const navigator=createMiningNavigator({getBot:()=>bot,assertActive(){},maxActions:24,movementTimeoutMs:2500,allowLeafSupport:true,allowCeilingClearance:true,allowStableGravitySupport:true,
  digBlock:async block=>{const floors=navigator.getState().breadcrumbs.map(p=>new Vec3(p.x,p.y-1,p.z));assert.ok(floors.every(p=>!p.equals(block.position)));digs.push(block.position.clone());changed.set(block.position.toString(),{name:'air',properties:{}});}});
 for(const step of plan.path)await navigator.advance(step.direction,{ascend:step.ascend,descend:step.descend});
 assert.equal(navigator.getState().moves,plan.path.length);assert.equal(navigator.getState().moves,6);assert.ok(digs.length>0);
 assert.ok(bot.entity.position.floored().equals(new Vec3(plan.position.x,plan.position.y,plan.position.z)));assert.equal(bot.entity.onGround,true);
});
