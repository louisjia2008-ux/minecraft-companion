'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),zlib=require('node:zlib'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),{Physics,PlayerState}=require('prismarine-physics'),{pathfinder}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {planHouseLocalRoute}=require('../vendor/server/minecraft/houseLocalRoute'),{createMiningNavigator}=require('../vendor/server/minecraft/miningNavigation');
const saved=require('../test-support/fixtures/world58-one-stone-upward-route.json'),buf=zlib.gunzipSync(Buffer.from(saved.statesGzipBase64,'base64')),cells=new Uint16Array(buf.buffer,buf.byteOffset,buf.byteLength/2);
for(const permitted of [false,true])test(`recorded world58 climb requires exactly one explicit no-drop stone opening: permitted=${permitted}`,{timeout:10000},async t=>{
 const controls=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false])),overlay=new Map(),digs=[];
 const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',game:{dimension:'overworld',minY:-64,height:384},entities:{},players:{},player:{ping:1},inventory:{slots:Array(46).fill(null),items:()=>[]},controlState:controls,jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,
  entity:{position:new Vec3(saved.actualFrom.x,saved.actualFrom.y,saved.actualFrom.z),velocity:new Vec3(0,-.0784000015258789,0),onGround:true,height:1.8,width:.6,eyeHeight:1.62,yaw:0,pitch:0,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false},
  setControlState:(n,v)=>{controls[n]=v;},clearControlStates:()=>{for(const n of Object.keys(controls))controls[n]=false;},look:async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;}});
 bot.blockAt=point=>{const p=point.floored(),b=saved.bounds;if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;
  const state=overlay.get(p.toString())||saved.palette[cells[(p.x-b.minX)*(b.maxZ-b.minZ+1)*(b.maxY-b.minY+1)+(p.z-b.minZ)*(b.maxY-b.minY+1)+p.y-b.minY]];
  return Object.assign(Block.fromProperties(registry.blocksByName[state.name].id,state.properties,0),{position:p});};
 const world={getBlock:p=>bot.blockAt(p)};bot.physics=Physics(registry,world);pathfinder(bot);
 const timer=setInterval(()=>{bot.physics.simulatePlayer(new PlayerState(bot,controls),world).apply(bot);bot.emit('physicsTick');},5);
 t.after(()=>{clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();});
 const options={from:saved.from,goal:saved.goal,blockAt:p=>bot.blockAt(new Vec3(p.x,p.y,p.z)),canDig:b=>b.canHarvest(null),maxDigs:18};
 assert.ok(planHouseLocalRoute(options).position.y<67);
 const plan=planHouseLocalRoute({...options,maxNonHarvestableDigs:1,canOpenWithoutHarvest:b=>b.name==='stone'});
 assert.equal(plan.nonHarvestableOpenings.length,1);assert.equal(plan.position.y,67);
 const cell=plan.nonHarvestableOpenings[0];
 const navigator=createMiningNavigator({getBot:()=>bot,assertActive(){},maxActions:24,movementTimeoutMs:2500,allowLeafSupport:true,allowCeilingClearance:true,allowStableGravitySupport:true,
  canOpenWithoutHarvest:b=>permitted&&b.stateId===cell.stateId&&b.position.equals(new Vec3(cell.position.x,cell.position.y,cell.position.z)),
  // Only the server's dig ACK is modeled; every body step uses installed physics.
  digBlock:async b=>{digs.push(b.position.clone());overlay.set(b.position.toString(),{name:'air',properties:{}});}});
 const run=async()=>{for(const step of plan.path)await navigator.advance(step.direction,{ascend:step.ascend,descend:step.descend});};
 if(!permitted){await assert.rejects(run(),{code:'MINING_TOOL_REQUIRED'});assert.equal(digs.length,0);return;}
 try{await run();}catch(error){t.diagnostic(JSON.stringify({plan,actual:bot.entity.position,nav:navigator.getState(),digs}));throw error;}assert.equal(digs.length,1);assert.equal(navigator.getState().moves,plan.path.length);assert.ok(plan.path.length<=6);assert.equal(bot.entity.position.y,67);assert.equal(bot.entity.onGround,true);assert.equal(bot.inventory.items().length,0);
});
