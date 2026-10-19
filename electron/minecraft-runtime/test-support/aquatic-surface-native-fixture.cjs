'use strict';
// Constructed underwater flora; original installed Mineflayer controls, look,
// entities, Physics and Pathfinder. No Java/server or manual pose updates after
// initialization. This fixture provides no natural-world acceptance authority.
const assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{AsyncLocalStorage}=require('node:async_hooks');
const req=require,{Vec3}=req('vec3'),{PlayerState}=req('prismarine-physics'),{pathfinder,Movements}=req('mineflayer-pathfinder');
const registry=req('prismarine-registry')('1.21.8'),Block=req('prismarine-block')(registry);
const root=process.env.HOUSE_AQUATIC_BODY_RUNTIME;
const api=require(root?`${root}/vendor/server/minecraft/houseSurfaceSwim`:'../vendor/server/minecraft/houseSurfaceSwim');
function fixture(t,width=12,options={}){
 const direction=options.direction||{x:1,z:0},tangent={x:-direction.z,z:direction.x},origin={x:10,z:-12},surfaceY=2;
 const local=p=>({u:(p.x-origin.x)*direction.x+(p.z-origin.z)*direction.z,v:(p.x-origin.x)*tangent.x+(p.z-origin.z)*tangent.z});
 const world=(u,v=0,y=surfaceY)=>new Vec3(origin.x+direction.x*u+tangent.x*v,y,origin.z+direction.z*u+tangent.z*v);
 const context=new AsyncLocalStorage(),first=Object.freeze({label:'first',lease:{},generation:1});let owner=first;
 const changes=new Map(),controls=[],events=[],points=[],looks=[],reads=[];
 const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',username:'SurfaceSwim',health:20,food:20,oxygenLevel:0,
  game:{minY:-64,height:384,dimension:'overworld',gameMode:'survival'},entities:{},players:{},jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,
  player:{ping:1},_client:{state:'play',socket:{writable:true,destroyed:false}},controlState:Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(k=>[k,false])),
  entity:{id:1,metadata:[],position:world(-1).offset(.5,0,.5),velocity:new Vec3(0,0,0),onGround:true,
   eyeHeight:1.62,height:1.8,width:.6,yaw:0,pitch:0,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false},inventory:{slots:Array(46).fill(null),items:()=>[]}});
 const airIndex=registry.entitiesByName.player.metadataKeys.indexOf('air_supply');bot.entity.metadata[airIndex]=300;
 bot.blockAt=raw=>{const p=raw.floored(),l=local(p);reads.push({x:p.x,y:p.y,z:p.z});let value;
  if(changes.has(`${p.x},${p.y},${p.z}`))value=changes.get(`${p.x},${p.y},${p.z}`);
  else if(options.unknown?.(p,l))return null;
  else if(p.y>=2)value={name:'air'};
  else if((l.u>=0&&l.u<width||options.narrow&&(l.u===-1||l.u===width)&&l.v!==0)&&Math.abs(l.v)<=2){
    const plant=['seagrass','tall_seagrass','kelp','kelp_plant'][((l.u%4)+4)%4];
    if(p.y===0)value={name:plant,properties:plant==='tall_seagrass'?{half:'upper'}:{}};
    else if(p.y===-1&&plant==='tall_seagrass')value={name:plant,properties:{half:'lower'}};
    else value={name:p.y>=-2?'water':'stone'};
  }
  else value={name:options.bank==='sand'&&p.y>=-1?'sand':'stone'};
  if(!value)return null;
  return Object.assign(Block.fromProperties(registry.blocksByName[value.name].id,value.properties||{},0),{position:p});
 };
 bot.stopDigging=()=>{};bot.deactivateItem=()=>{};
 // Original Mineflayer look/control plugin, with no login/background timer.
 // Only this fixture's original Physics loop advances subsequent player state.
 bot._client=Object.assign(new EventEmitter(),bot._client,{write:()=>{}});
 bot.supportFeature=feature=>registry.supportFeature(feature);
 req('mineflayer/lib/plugins/physics')(bot,{physicsEnabled:false});
 req('mineflayer/lib/plugins/entities')(bot);
 bot.entity.name='player';bot.entity.type='player';bot.entities[bot.entity.id]=bot.entity;
 const nativeControl=bot.setControlState,nativeLook=bot.look;
 bot.setControlState=function(name,value){controls.push({owner:context.getStore()?.label||'native',name,value});return nativeControl.call(this,name,value);};
 bot.look=function(yaw,pitch,force){looks.push({owner:context.getStore()?.label||'native',yaw});return nativeLook.call(this,yaw,pitch,force);};
 assert.equal(typeof bot.getControlState,'function');
 pathfinder(bot);const previous=bot.pathfinder.movements;
 let gotos=0;const originalGoto=bot.pathfinder.goto;bot.pathfinder.goto=function(...args){gotos++;return originalGoto.apply(this,args);};
 const session=api.createNaturalSurfaceSwim({getBot:()=>bot,getOwner:()=>owner,isOwnerCurrent:captured=>captured===owner,Vec3,Movements,
  look:options.look?(...args)=>options.look(bot,...args):undefined,record:(type,data)=>{
   events.push({type,...data});
   if(options.failBodyDiagnostic&&type==='surface_swim_body_rejected')throw Error('modeled diagnostic sink failure');
  }});
 const timer=setInterval(()=>context.run(first,()=>{bot.physics.simulatePlayer(new PlayerState(bot,bot.controlState),{getBlock:bot.blockAt}).apply(bot);
  points.push({position:bot.entity.position.clone(),wet:bot.entity.isInWater,grounded:bot.entity.onGround});bot.emit('physicsTick');}),5);
 t.after(()=>{owner=null;clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();bot.emit('end');bot.removeAllListeners();});
 const route={schema:1,kind:'loaded_surface_swim',depth:'surface_only',from:pos(world(-1)),to:pos(world(width)),waterStart:origin,surfaceY,direction,width,timeoutMs:10000,retreatTimeoutMs:10000};
 return{bot,session,route,local,world,points,controls,events,looks,reads,previous,changes,airIndex,context,first,
  run:r=>context.run(first,()=>session.traverse(r||route)),gotos:()=>gotos,
  foreign:()=>{owner={label:'foreign',lease:{},generation:1};return owner;}};
}
const pos=p=>({x:p.x,y:p.y,z:p.z});
module.exports={fixture,Vec3,registry,Block,api};
