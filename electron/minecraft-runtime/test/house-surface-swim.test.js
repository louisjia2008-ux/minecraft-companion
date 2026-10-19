/* global require, setTimeout, setInterval, clearInterval */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{AsyncLocalStorage}=require('node:async_hooks');
const req=require;
const {Vec3}=req('vec3'),{PlayerState}=req('prismarine-physics'),{pathfinder,Movements}=req('mineflayer-pathfinder');
const registry=req('prismarine-registry')('1.21.8'),Block=req('prismarine-block')(registry);
const api=require('../vendor/server/minecraft/houseSurfaceSwim');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
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
  else if((l.u>=0&&l.u<width||options.narrow&&(l.u===-1||l.u===width)&&l.v!==0)&&Math.abs(l.v)<=2)value={name:p.y>=-2?'water':'stone'};
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
 const session=api.createNaturalSurfaceSwim({recoveryReturn:options.recoveryReturn===true,getBot:()=>bot,getOwner:()=>owner,isOwnerCurrent:captured=>captured===owner,Vec3,Movements,
  look:options.look?(...args)=>options.look(bot,...args):undefined,record:(type,data)=>events.push({type,...data})});
 const timer=setInterval(()=>context.run(first,()=>{bot.physics.simulatePlayer(new PlayerState(bot,bot.controlState),{getBlock:bot.blockAt}).apply(bot);
  points.push({position:bot.entity.position.clone(),wet:bot.entity.isInWater,grounded:bot.entity.onGround});bot.emit('physicsTick');}),5);
 t.after(()=>{owner=null;clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();bot.emit('end');bot.removeAllListeners();});
 const route={schema:1,kind:'loaded_surface_swim',depth:'surface_only',from:pos(world(-1)),to:pos(world(width)),waterStart:origin,surfaceY,direction,width,timeoutMs:10000,retreatTimeoutMs:10000};
 return{bot,session,route,local,world,points,controls,events,looks,reads,previous,changes,airIndex,context,first,
  run:r=>context.run(first,()=>session.traverse(r||route)),gotos:()=>gotos,
  foreign:()=>{owner={label:'foreign',lease:{},generation:1};return owner;}};
}
const pos=p=>({x:p.x,y:p.y,z:p.z});
for(const direction of[{x:1,z:0},{x:-1,z:0},{x:0,z:1},{x:0,z:-1}])for(const width of[4,12,32])test(`native surface-only deep4 swim ${direction.x},${direction.z} width${width} out/back`,{timeout:15000},async t=>{
 const f=fixture(t,width,{direction}),surface=api.validateSurfaceRoute(f.bot,f.route,Vec3);
 assert.equal(surface.riverBottomObserved,false);assert.equal(surface.facts.some(p=>p.position.y<1),false);
 let out,back;try{out=await f.run();back=await f.run({...f.route,from:f.route.to,to:f.route.from});}catch(error){t.diagnostic(JSON.stringify({code:error.code,cause:error.cause?.code,retreat:error.retreatError?.code,last:f.events.filter(e=>e.type==='surface_swim_tick').slice(-6)}));throw error;}
 assert.equal(out.confirmed,true);assert.equal(back.confirmed,true);assert.ok(out.waterTicks>0&&back.waterTicks>0);
 assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.isInWater,false);assert.equal(f.gotos(),0);
 assert.equal(f.bot.pathfinder.movements,f.previous);assert.ok(f.events.filter(e=>e.type==='surface_swim_tick').every(e=>e.eyeAir&&e.aboveEyeAir&&e.oxygenLevel===20));
 assert.ok(f.points.filter(p=>p.wet).every(p=>p.position.y+1.62>2),'Actual native eyes remained above the water surface');
});
test('unknown/flowing/lava top surface and unknown air reject before controls',{timeout:1000},async t=>{
 for(const [value,y]of[[null,1],[{name:'water',properties:{level:1}},1],[{name:'lava'},1],[null,3]]){
  const f=fixture(t,4),p=f.world(1,0,y);f.changes.set(`${p.x},${p.y},${p.z}`,value);const before=f.controls.length;
  await assert.rejects(f.run(),e=>['surface_swim_surface_unknown','surface_swim_air_unknown'].includes(e.code));assert.equal(f.controls.length,before);assert.equal(f.gotos(),0);
 }
});
test('omitted default self oxygen stays UNKNOWN and never borrows the global value',async t=>{
 const f=fixture(t,4);f.bot.oxygenLevel=20;delete f.bot.entity.metadata[f.airIndex];
 assert.equal((await f.run()).confirmed,true);
 assert.ok(f.events.filter(e=>e.type==='surface_swim_tick').every(e=>e.oxygenLevel===null&&e.rawAirSupply===null&&e.source==='own_entity_metadata_unknown'&&e.eyeAir&&e.aboveEyeAir));
});
test('pause while actually wet returns to original dry bank before rejecting',{timeout:15000},async t=>{
 const f=fixture(t,12);let requested=false;f.bot.on('physicsTick',()=>{if(!requested&&f.bot.entity.isInWater&&api.routeFrame(f.route).u(f.bot.entity.position)>3){requested=true;f.session.requestCancel('paused');}});
 await assert.rejects(f.run(),e=>e.code==='paused'&&e.recoveredToDryBank===true);assert.equal(requested,true);assert.equal(f.session.isHolding(),false);
 assert.equal(f.bot.entity.isInWater,false);assert.equal(f.bot.entity.onGround,true);assert.ok(f.events.some(e=>e.type==='surface_swim_recovered'));assert.equal(f.gotos(),0);
});
test('native deadline while wet physically retreats rather than clearing flotation',{timeout:15000},async t=>{
 const f=fixture(t,32);await assert.rejects(f.run({...f.route,timeoutMs:200}),e=>e.code==='surface_swim_timeout'&&e.recoveredToDryBank===true);
 assert.equal(f.bot.entity.isInWater,false);assert.equal(f.bot.entity.onGround,true);assert.equal(f.session.isHolding(),false);
});
test('same-generation foreign lease/profile takeover leaves zero old writes and preserves new controls',{timeout:15000},async t=>{
 const f=fixture(t,12);let after=null,profile;
 f.bot.on('physicsTick',()=>{if(after===null&&f.bot.entity.isInWater){const other=f.foreign();f.context.run(other,()=>{profile=new Movements(f.bot);f.bot.pathfinder.setMovements(profile);f.bot.setControlState('forward',false);f.bot.setControlState('jump',true);});after=f.controls.length;}});
 await assert.rejects(f.run(),e=>e.code==='surface_swim_foreign_owner');await sleep(30);
 assert.notEqual(after,null);assert.equal(f.bot.pathfinder.movements,profile);assert.deepEqual(f.controls.slice(after),[]);assert.equal(f.session.release().foreign,true);
});
test('cancel during an awaited look prevents its late native look and controls',{timeout:15000},async t=>{
 let release;const wait=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,4,{look:async(bot,yaw,pitch)=>{await wait;await bot.look(yaw,pitch,true);}}),before=f.looks.length;
 const pending=f.run();await sleep(20);f.session.requestCancel('paused');await assert.rejects(pending,e=>e.code==='paused'&&e.recoveredToDryBank===true);
 release();await sleep(20);assert.equal(f.looks.length,before);assert.equal(f.bot.entity.isInWater,false);assert.equal(f.gotos(),0);
});
test('unknown retreat body holds only exact-owner jump and refuses release until dry',{timeout:15000},async t=>{
 const f=fixture(t,12);let blocked=false;
 f.bot.on('physicsTick',()=>{if(!blocked&&f.bot.entity.isInWater&&api.routeFrame(f.route).u(f.bot.entity.position)>3){blocked=true;
  const p=f.bot.entity.position.floored().offset(0,1,0);f.changes.set(`${p.x},${p.y},${p.z}`,null);f.session.requestCancel('paused');}});
 await assert.rejects(f.run(),e=>e.holding===true&&e.recoveredToDryBank===false);assert.equal(f.session.isHolding(),true);
 assert.equal(f.bot.controlState.jump,true);for(const k of['forward','back','left','right'])assert.equal(f.bot.controlState[k],false);
 assert.throws(()=>f.session.release(),e=>e.code==='surface_swim_release_wet');const count=f.controls.length;f.foreign();await sleep(20);assert.equal(f.controls.length,count);assert.equal(f.session.release().foreign,true);
});

test('native surface-only deep4 width64 stays within its fixed bound and returns dry', {timeout:15000}, async t=>{const f=fixture(t,64);assert.equal((await f.run()).confirmed,true);assert.equal((await f.run({...f.route,from:f.route.to,to:f.route.from})).confirmed,true);assert.equal(f.gotos(),0);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.isInWater,false);});

for(const width of[12,32])test(`native deep4 narrow center-bank width${width} out/back and wet pause`,{timeout:15000},async t=>{
 const f=fixture(t,width,{narrow:true,bank:'sand'});assert.equal((await f.run()).confirmed,true);assert.equal((await f.run({...f.route,from:f.route.to,to:f.route.from})).confirmed,true);
 let requested=false;f.bot.on('physicsTick',()=>{if(!requested&&f.bot.entity.isInWater&&api.routeFrame(f.route).u(f.bot.entity.position)>3){requested=true;f.session.requestCancel('paused');}});
 await assert.rejects(f.run(),e=>e.code==='paused'&&e.recoveredToDryBank===true);assert.equal(requested,true);assert.equal(f.bot.entity.isInWater,false);assert.equal(f.bot.entity.onGround,true);
});

test('known own low oxygen rejects before motion despite global oxygen20',async t=>{const f=fixture(t,4);f.bot.entity.metadata[f.airIndex]=240;f.bot.oxygenLevel=20;const before=f.controls.length;await assert.rejects(f.run(),e=>e.code==='surface_swim_oxygen_limit');assert.equal(f.controls.length,before);});


test('new lava in the next observed surface row triggers dry retreat before actual body contact',{timeout:15000},async t=>{
 const f=fixture(t,12);let changed=false;
 f.bot.on('physicsTick',()=>{const u=api.routeFrame(f.route).u(f.bot.entity.position);if(!changed&&f.bot.entity.isInWater&&u>3){changed=true;const p=f.world(Math.floor(u+.5)+2,0,1);f.changes.set(`${p.x},${p.y},${p.z}`,{name:'lava'});}});
 await assert.rejects(f.run(),e=>e.code==='surface_swim_surface_changed'&&e.recoveredToDryBank===true);
 assert.equal(changed,true);assert.ok(f.events.filter(e=>e.type==='surface_swim_tick').every(e=>!e.isInLava));assert.equal(f.bot.entity.isInWater,false);
});

test('foreign takeover during awaited recovery look blocks that exact late native look',{timeout:15000},async t=>{
 let release;const wait=new Promise(resolve=>{release=resolve;});let calls=0;
 const f=fixture(t,12,{look:async(bot,yaw,pitch)=>{calls++;if(calls===2)await wait;await bot.look(yaw,pitch,true);}});let cancelled=false;
 f.bot.on('physicsTick',()=>{if(!cancelled&&f.bot.entity.isInWater&&api.routeFrame(f.route).u(f.bot.entity.position)>3){cancelled=true;f.session.requestCancel('paused');}});
 const pending=f.run();pending.catch(()=>{});const deadline=Date.now()+2000;while(calls<2&&Date.now()<deadline)await sleep(5);assert.equal(calls,2,'Recovery look must begin within the finite fixture budget');const other=f.foreign(),profile=new Movements(f.bot);
 await f.context.run(other,async()=>{f.bot.pathfinder.setMovements(profile);await f.bot.look(.25,0,true);});const after=f.looks.length,controls=f.controls.length;
 await assert.rejects(pending,e=>e.code==='surface_swim_foreign_owner');release();await sleep(30);
 assert.equal(f.looks.length,after);assert.equal(f.controls.length,controls);assert.equal(f.bot.pathfinder.movements,profile);
});


test('actual own255 metadata while wet retreats dry despite unrelated cow300 polluting global oxygen20',{timeout:15000},async t=>{
 const f=fixture(t,32,{narrow:true,bank:'sand'});let lowered=false;
 const Entity=req('prismarine-entity')('1.21.8'),cow=new Entity(2);cow.name='cow';cow.type='mob';cow.position=f.world(100);
 f.bot.entities[cow.id]=cow;
 f.bot.on('physicsTick',()=>{if(!lowered&&f.bot.entity.isInWater&&api.routeFrame(f.route).u(f.bot.entity.position)>3){lowered=true;
  f.bot._client.emit('entity_metadata',{entityId:f.bot.entity.id,metadata:[{key:f.airIndex,type:'varint',value:255}]});
  f.bot._client.emit('entity_metadata',{entityId:cow.id,metadata:[{key:registry.entitiesByName.cow.metadataKeys.indexOf('air_supply'),type:'varint',value:300}]});
  assert.equal(f.bot.oxygenLevel,20,'Installed entities plugin reproduces unrelated-entity global oxygen pollution');
 }});
 await assert.rejects(f.run(),e=>e.code==='surface_swim_oxygen_limit'&&e.recoveredToDryBank===true&&e.holding===false);
 assert.equal(lowered,true);assert.equal(f.bot.entity.metadata[f.airIndex],255,'Do not pretend the server replenished self air');assert.equal(f.bot.oxygenLevel,20);
 assert.equal(f.bot.entity.isInWater,false);assert.equal(f.bot.entity.onGround,true);assert.equal(f.session.isHolding(),false);
 const retreat=f.events.filter(e=>e.type==='surface_swim_tick'&&e.recovery&&e.rawAirSupply===255);
 assert.ok(retreat.length>3);assert.ok(retreat.every(e=>e.oxygenLevel===17&&e.source==='own_entity_metadata'&&e.eyeAir&&e.aboveEyeAir&&e.eyeY>f.route.surfaceY+.05));
});

test('recorded recovery capability swims below ordinary health floor while route-only requests reject', {timeout:15000}, async t=>{
 const ordinary=fixture(t,4);ordinary.bot.health=5;ordinary.bot.food=6;
 await assert.rejects(ordinary.run({...ordinary.route,recoveryReturn:true}),{code:'surface_swim_survival_limit'});
 assert.equal(ordinary.gotos(),0);
 const f=fixture(t,18,{recoveryReturn:true});f.bot.health=5;f.bot.food=6;
 const result=await f.run();assert.equal(result.confirmed,true);assert.ok(result.waterTicks>0);
 assert.equal(f.bot.entity.isInWater,false);assert.equal(f.bot.health,5);
});
test('recorded recovery swim retreats after actual damage', {timeout:15000}, async t=>{
 const f=fixture(t,12,{recoveryReturn:true});f.bot.health=10;f.bot.food=6;let hit=false;
 f.bot.on('physicsTick',()=>{if(!hit&&f.bot.entity.isInWater&&api.routeFrame(f.route).u(f.bot.entity.position)>3){hit=true;f.bot.health=9;}});
 await assert.rejects(f.run(),e=>e.code==='surface_swim_survival_limit'&&e.recoveredToDryBank===true);
 assert.equal(hit,true);assert.equal(f.bot.entity.isInWater,false);assert.equal(f.bot.entity.onGround,true);
});
