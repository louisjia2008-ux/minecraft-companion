/* global setInterval, clearInterval */
'use strict';
// OFFLINE NEW constructor-offset fixture with original Mineflayer look/control,
// real20Hz Prismarine Physics and installed pathfinder; old fixture unchanged.
// Immutable voxel fixtures with original installed Prismarine Physics
// and pathfinder. Initial state is configured; later motion uses PlayerState.
// This does not prove server oxygen or natural-world/public-task acceptance.
const {EventEmitter}=require('node:events'),{AsyncLocalStorage}=require('node:async_hooks');
const {Vec3}=require('vec3'),{PlayerState}=require('prismarine-physics'),{pathfinder,Movements,goals}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const api=require('../vendor/server/minecraft/houseShallowWaterTraversal');
function fixture(t,width=12,options={}) {
  if(!Number.isFinite(options.initialLateral??0)||Math.abs(options.initialLateral??0)>.4)throw new Error('Finite constructor-only bank offset required');
  const direction=options.direction||{x:1,z:0},tangent={x:-direction.z,z:direction.x},origin={x:10,z:-12};
  const local=p=>({u:(p.x-origin.x)*direction.x+(p.z-origin.z)*direction.z,v:(p.x-origin.x)*tangent.x+(p.z-origin.z)*tangent.z});
  const world=(u,v=0,y=2)=>new Vec3(origin.x+direction.x*u+tangent.x*v,y,origin.z+direction.z*u+tangent.z*v);
  const storage=new AsyncLocalStorage(),first=Object.freeze({label:'first',generation:1,lease:{}});let owner=first;
  const controls=[],events=[],points=[],looks=[],packets=[];
  const geometry=p=>{
    const {u,v}=local(p),water=(u>=0&&u<width&&Math.abs(v)<=3)||(options.narrow!==false&&(u===-1||u===width)&&v!==0&&Math.abs(v)<=3);
    if(p.y>1)return 'air';if(water)return p.y===1?'water':'stone';
    return p.y>=-1?(options.bank||'sand'):'stone';
  };
  // Original grounded Physics uses vy=-0.0784000015258789 after gravity.
  // vy0 gives no first-tick vertical collision and is not a settled spawn.
  // This is constructor-only state; later motion is native PlayerState.apply.
  const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',username:'NativeNaturalWater',health:20,food:20,game:{minY:-64,height:384,dimension:'overworld',gameMode:'survival'},entities:{},players:{},jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,player:{ping:1},_client:{state:'play',socket:{writable:true,destroyed:false}},controlState:Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(k=>[k,false])),entity:{position:world(-1).offset(.5+tangent.x*(options.initialLateral??0),0,.5+tangent.z*(options.initialLateral??0)),velocity:new Vec3(0,-0.0784000015258789,0),onGround:true,eyeHeight:1.62,height:1.8,width:.6,yaw:0,pitch:0,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false},inventory:{slots:Array(46).fill(null),items:()=>[]}});
  bot._client=Object.assign(new EventEmitter(),{state:'play',socket:{writable:true,destroyed:false},write:(name,payload)=>packets.push({name,payload})});
  bot.supportFeature=name=>registry.supportFeature(name);
  bot.blockAt=raw=>{const p=raw.floored();if(options.unknown?.(p,local(p)))return null;let name=options.override?.(p,local(p))||geometry(p);return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:p});};
  bot.stopDigging=()=>{};bot.deactivateItem=()=>{};
  require('mineflayer/lib/plugins/physics')(bot,{physicsEnabled:false});
  const nativeControl=bot.setControlState,nativeLook=bot.look;
  bot.setControlState=function(name,value){controls.push({owner:storage.getStore()?.label||'native-tick',name,value});return nativeControl.call(this,name,value);};
  bot.look=function(...args){looks.push({owner:storage.getStore()?.label||'native-tick',args});return nativeLook.apply(this,args);};
  pathfinder(bot);const previous=bot.pathfinder.movements;
  const timer=setInterval(()=>{try {bot.physics.simulatePlayer(new PlayerState(bot,bot.controlState),{getBlock:bot.blockAt}).apply(bot);points.push({position:bot.entity.position.clone(),velocity:bot.entity.velocity.clone(),wet:bot.entity.isInWater,grounded:bot.entity.onGround});bot.emit('physicsTick');}catch(error){clearInterval(timer);throw error;}},50);
  const session=api.createNaturalShallowWaterTraversal({getBot:()=>bot,getOwner:()=>owner,isOwnerCurrent:captured=>captured===owner,Vec3,Movements,GoalBlock:goals.GoalBlock,record:(type,data)=>events.push({type,...data})});
  t.after(()=>{owner=null;clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();bot.emit('end');bot.removeAllListeners();});
  const route={schema:1,kind:'loaded_source_water_wade',from:{...world(-1)},to:{...world(width)},waterStart:origin,surfaceY:2,direction,width,depth:1,timeoutMs:15000};
  return {bot,session,events,controls,points,looks,packets,previous,owner:first,route,world,local,run:route=>storage.run(first,()=>session.traverse(route)),takeover:()=>{owner=Object.freeze({label:'foreign',generation:1,lease:{}});storage.run(owner,()=>{bot.pathfinder.setGoal(null);bot.clearControlStates();bot.setControlState('jump',true);});},storage};
}
module.exports={fixture,Vec3,Movements,goals,registry,Block};
