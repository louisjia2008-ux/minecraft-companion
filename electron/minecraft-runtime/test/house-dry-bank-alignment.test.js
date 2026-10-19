/* global require, setTimeout, setInterval, clearInterval */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{AsyncLocalStorage}=require('node:async_hooks');
const req=require;
const {Vec3}=req('vec3'),{PlayerState}=req('prismarine-physics'),{pathfinder,Movements,goals}=req('mineflayer-pathfinder');
const registry=req('prismarine-registry')('1.21.8'),Block=req('prismarine-block')(registry);
const safety=require('../vendor/server/minecraft/houseShallowWaterTraversal');
const {createDryBankAlignmentAPI,createDryBankAlignment:defaultCreateDryBankAlignment}=require('../vendor/server/minecraft/houseDryBankAlignment');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// OFFLINE original Mineflayer look/control and installed pathfinder with
// unmodified Physics at REAL20Hz (50ms). Only initial fixture position/velocity
// are assigned. Dynamic voxel changes model server updates, not a live server.
function fixture(t,options={}){
 const context=new AsyncLocalStorage(),first={task:'first',lease:{},generation:1};let owner=first;
 const bank={x:10,y:2,z:-12},changes=new Map(),controls=[],looks=[],events=[],points=[];
 const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',username:'DryBank',health:20,food:20,
  game:{minY:-64,height:384,dimension:'overworld',gameMode:'survival'},entities:{},players:{},jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,
  player:{ping:1},controlState:Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false])),
  entity:{id:1,metadata:[],position:new Vec3(bank.x+.5+(options.dx??.35),bank.y,bank.z+.5+(options.dz??0)),velocity:new Vec3(options.vx||0,-.0784,options.vz||0),onGround:true,
   eyeHeight:1.62,height:1.8,width:.6,yaw:0,pitch:0,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false},inventory:{slots:Array(46).fill(null),items:()=>[]}});
 bot._client=Object.assign(new EventEmitter(),{state:'play',socket:{writable:true,destroyed:false},write:()=>{}});
 bot.blockAt=raw=>{const p=raw.floored(),key=`${p.x},${p.y},${p.z}`;const value=changes.has(key)?changes.get(key):p.y>=2?'air':options.sand&&p.y>=-1?'sand':'stone';if(value===null)return null;return Object.assign(Block.fromProperties(registry.blocksByName[typeof value==='string'?value:value.name].id,typeof value==='string'?{}:value.properties||{},0),{position:p});};
 bot.supportFeature=n=>registry.supportFeature(n);bot.stopDigging=()=>{};bot.deactivateItem=()=>{};
 req('mineflayer/lib/plugins/physics')(bot,{physicsEnabled:false});
 const nativeControl=bot.setControlState,nativeLook=bot.look;
 bot.setControlState=function(name,value){controls.push({owner:context.getStore()?.task||'native',name,value});return nativeControl.call(this,name,value);};
 bot.look=function(...args){looks.push({owner:context.getStore()?.task||'native',args});return nativeLook.apply(this,args);};
 pathfinder(bot);const profile=bot.pathfinder.movements,baseLook=bot.look;
 let gotoCalls=0;const nativeGoto=bot.pathfinder.goto;bot.pathfinder.goto=function(...args){gotoCalls++;return nativeGoto.apply(this,args);};
 let session,ticks=0;
 const createDryBankAlignment=options.safety?createDryBankAlignmentAPI(options.safety).createDryBankAlignment:defaultCreateDryBankAlignment;
 session=createDryBankAlignment({recoveryReturn:options.recoveryReturn===true,getBot:()=>bot,getOwner:()=>owner,isOwnerCurrent:o=>owner===o,Vec3,
  look:options.look?((...args)=>options.look({bot,session,context,first},...args)):undefined,
  record:(type,facts)=>{events.push({type,...facts});options.onRecord?.({type,facts,session,bot});}});
 const timer=setInterval(()=>context.run(owner||first,()=>{bot.physics.simulatePlayer(new PlayerState(bot,bot.controlState),{getBlock:bot.blockAt}).apply(bot);ticks++;points.push({position:bot.entity.position.clone(),velocity:bot.entity.velocity.clone(),wet:bot.entity.isInWater,grounded:bot.entity.onGround});bot.emit('physicsTick');options.onTick?.({ticks,bot,session,changes,bank});}),50);
 t.after(()=>{owner=null;clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();bot.emit('end');bot.removeAllListeners();});
 return{bot,bank,session,context,first,profile,baseLook,controls,looks,events,points,changes,
  run:()=>context.run(first,()=>session.align(bank)),gotos:()=>gotoCalls,
  foreign:()=>{owner={task:'foreign',lease:{},generation:2};return owner;}};
}
function confirmed(f,out){assert.equal(out.confirmed,true);assert.equal(out.stableTicks,3);assert.ok(out.elapsedMs<=2000);assert.ok(out.ticks<=40);assert.ok(out.horizontalDistance<=1);assert.ok(Math.abs(f.bot.entity.position.x-f.bank.x-.5)<=.08);assert.ok(Math.abs(f.bot.entity.position.z-f.bank.z-.5)<=.08);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.isInWater,false);assert.equal(f.bot.pathfinder.movements,f.profile);assert.equal(f.bot.pathfinder.goal,null);assert.equal(f.bot.getControlState('jump'),false);assert.equal(f.bot.getControlState('sneak'),false);assert.equal(f.session.isActive(),false);assert.equal(f.session.isHolding(),false);assert.ok(f.points.every(p=>Math.floor(p.position.x)===f.bank.x&&Math.floor(p.position.z)===f.bank.z));}
for(const [dx,dz]of[[.17,0],[-.17,0],[0,.17],[0,-.17],[.35,0],[-.35,0],[0,.35],[0,-.35],[.35,.35],[-.35,.35],[.35,-.35],[-.35,-.35]])test(`real20Hz original native bank alignment offset${dx},${dz}`,{timeout:3000},async t=>{const f=fixture(t,{dx,dz,sand:true}),out=await f.run();confirmed(f,out);assert.equal(f.gotos(),0);assert.ok(f.controls.some(c=>c.name==='sneak'&&c.value===true),'actual native slow forward/back');});
test('installed native goto settles before alignment; raw upstream fullStop is not imitated',{timeout:6000},async t=>{const f=fixture(t,{dx:-2.5,dz:0});await f.context.run(f.first,()=>f.bot.pathfinder.goto(new goals.GoalBlock(f.bank.x,f.bank.y,f.bank.z)));const offset=Math.hypot(f.bot.entity.position.x-f.bank.x-.5,f.bot.entity.position.z-f.bank.z-.5);assert.ok(offset<=.35,`native arrival offset${offset}`);assert.ok(Number.isFinite(f.bot.entity.velocity.x)&&Number.isFinite(f.bot.entity.velocity.z));f.points.length=0;const out=await f.run();confirmed(f,out);assert.equal(f.gotos(),1);});
for(const [vx,vz]of[[.05,0],[-.05,0],[0,.05],[0,-.05]])test(`real20Hz residual native inertia${vx},${vz} is safely centered`,{timeout:3000},async t=>{const f=fixture(t,{dx:.3,dz:-.25,vx,vz}),out=await f.run();confirmed(f,out);});
test('same-cell dry pause cleans controls without restoring/changing profile',{timeout:3000},async t=>{const f=fixture(t);const pending=f.run();pending.catch(()=>{});await sleep(120);f.session.requestCancel('paused');await assert.rejects(pending,e=>e.code==='paused'&&e.recoveredToDryBank===true);assert.equal(f.session.isHolding(),false);assert.equal(f.bot.getControlState('forward'),false);assert.equal(f.bot.getControlState('jump'),false);assert.equal(f.bot.pathfinder.movements,f.profile);const before=f.controls.length;await sleep(150);assert.equal(f.controls.length,before);});
test('pause during delayed native look cannot mutate yaw or send late controls',{timeout:3000},async t=>{const f=fixture(t,{look:async({bot},yaw,pitch)=>{await sleep(300);return bot.look(yaw,pitch,true);}});const yaw=f.bot.entity.yaw,pending=f.run();pending.catch(()=>{});await sleep(80);f.session.requestCancel('paused');await assert.rejects(pending,e=>e.code==='paused');const count=f.controls.length;await sleep(350);assert.equal(f.looks.length,0);assert.equal(f.bot.entity.yaw,yaw);assert.equal(f.controls.length,count);assert.equal(f.bot.look,f.baseLook);});
test('foreign takeover during delayed look cannot write controls/yaw/profile or overwrite replacement look',{timeout:3000},async t=>{const f=fixture(t,{look:async({bot},yaw,pitch)=>{await sleep(300);return bot.look(yaw,pitch,true);}});const pending=f.run();pending.catch(()=>{});await sleep(80);const foreign=f.foreign(),replacement=new Movements(f.bot);f.context.run(foreign,()=>f.bot.pathfinder.setMovements(replacement));const oldLook=f.bot.look;f.bot.look=function(...args){return oldLook.apply(this,args);};const replacementLook=f.bot.look,count=f.controls.filter(c=>c.owner==='first').length,yaw=f.bot.entity.yaw;await assert.rejects(pending,e=>e.code==='dry_bank_alignment_foreign_owner');await sleep(350);assert.equal(f.controls.filter(c=>c.owner==='first').length,count);assert.equal(f.bot.entity.yaw,yaw);assert.equal(f.bot.pathfinder.movements,replacement);assert.equal(f.bot.look,replacementLook);});
test('cancel in started record gap cannot begin orientation or movement',{timeout:1000},async t=>{const f=fixture(t,{onRecord:({type,session})=>{if(type==='dry_bank_alignment_started')session.requestCancel('paused');}});await assert.rejects(f.run(),e=>e.code==='paused');assert.equal(f.looks.length,0);assert.equal(f.controls.some(c=>c.value===true),false);await sleep(100);assert.equal(f.session.isActive(),false);});
test('unknown support preflight rejects before any control or look',{timeout:1000},async t=>{const f=fixture(t);f.changes.set(`${f.bank.x},1,${f.bank.z}`,null);await assert.rejects(f.run(),e=>e.code==='water_bank_unstable');assert.equal(f.controls.length,0);assert.equal(f.looks.length,0);});
test('unknown support during native alignment retains exact-owner jump HOLD and foreign never clears it',{timeout:3000},async t=>{const f=fixture(t,{onTick:({ticks,changes,bank})=>{if(ticks===1)changes.set(`${bank.x},1,${bank.z}`,null);}});const pending=f.run();pending.catch(()=>{});await assert.rejects(pending,e=>e.holding===true);assert.equal(f.session.isHolding(),true);assert.equal(f.bot.getControlState('jump'),true);assert.throws(()=>f.session.release(),e=>e.code==='dry_bank_alignment_release_wet');const count=f.controls.filter(c=>c.owner==='first').length;f.foreign();await sleep(150);assert.equal(f.controls.filter(c=>c.owner==='first').length,count);assert.deepEqual(f.session.release(),{foreign:true});});
test('server floor turns water, actual unmodified physics enters water and HOLD never clears flotation',{timeout:4000},async t=>{const f=fixture(t,{dx:.25,onTick:({ticks,changes,bank})=>{if(ticks===1)for(let y=-2;y<=1;y++)changes.set(`${bank.x},${y},${bank.z}`,'water');}});const pending=f.run();pending.catch(()=>{});await assert.rejects(pending,e=>e.holding===true);await sleep(1500);assert.equal(f.session.isHolding(),true);assert.equal(f.bot.getControlState('jump'),true);assert.equal(f.bot.getControlState('sneak'),false);assert.ok(f.points.some(p=>p.wet),'original Physics truly entered water');assert.throws(()=>f.session.release(),e=>e.code==='dry_bank_alignment_release_wet');});
test('two-second deadline closes a late native look while host remains owner',{timeout:4000},async t=>{const f=fixture(t,{look:async({bot},yaw,pitch)=>{await sleep(2300);return bot.look(yaw,pitch,true);}});const started=Date.now(),yaw=f.bot.entity.yaw;await assert.rejects(f.run(),e=>e.code==='dry_bank_alignment_timeout'&&e.recoveredToDryBank===true);assert.ok(Date.now()-started>=1900&&Date.now()-started<=2300);const count=f.controls.length;await sleep(400);assert.equal(f.looks.length,0);assert.equal(f.bot.entity.yaw,yaw);assert.equal(f.controls.length,count);});

for(const [health,food] of [[15,20],[20,13]])test(`initial survival${health}/${food} rejects before motion`,async t=>{const f=fixture(t);f.bot.health=health;f.bot.food=food;await assert.rejects(f.run(),e=>e.code==='dry_bank_alignment_survival_limit');assert.equal(f.controls.length,0);assert.equal(f.looks.length,0);});
test('food drops during native alignment, exact-owner dry stop has no later control writes',async t=>{const f=fixture(t,{onTick:({ticks,bot})=>{if(ticks===1)bot.food=13;}});await assert.rejects(f.run(),e=>e.code==='dry_bank_alignment_survival_limit'&&e.recoveredToDryBank===true);assert.equal(f.session.isHolding(),false);const count=f.controls.length;await sleep(150);assert.equal(f.controls.length,count);});
test('same owner unsafe cleanup is HOLD, never mislabeled foreign owner',async t=>{
 let calls=0,failAt=Infinity;
 const f=fixture(t,{safety:{...safety,stableSupport:(...args)=>{calls++;if(calls===failAt)throw Object.assign(new Error('support update raced cleanup'),{code:'water_bank_unstable'});return safety.stableSupport(...args);}},onRecord:({type,session})=>{if(type==='dry_bank_alignment_tick'){failAt=calls+2;session.requestCancel('paused');}}});
 await assert.rejects(f.run(),e=>e.code==='paused'&&e.holding===true&&e.cleanupFailure?.code==='dry_bank_alignment_not_dry');
 assert.equal(f.session.isHolding(),true);assert.equal(f.events.some(e=>e.type==='dry_bank_alignment_owner_lost'),false);assert.equal(f.bot.pathfinder.movements,f.profile);
 assert.deepEqual(f.session.release(),{released:true});
});

test('native settled confirmation survives dry release and real inertia without center drift',async t=>{const f=fixture(t,{dx:.35,dz:.35,vx:.035,vz:-.025});const out=await f.run();confirmed(f,out);assert.deepEqual(f.session.release(),{released:true});await sleep(300);assert.ok(Math.abs(f.bot.entity.position.x-f.bank.x-.5)<=.08);assert.ok(Math.abs(f.bot.entity.position.z-f.bank.z-.5)<=.08);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.isInWater,false);assert.equal(f.bot.getControlState('sneak'),false);});

test('recorded low-health return aligns the actual dry bank without ordinary exploration permission',async t=>{
 const f=fixture(t,{dx:.35,recoveryReturn:true});f.bot.health=10;f.bot.food=6;
 confirmed(f,await f.run());assert.equal(f.bot.health,10);
 const ordinary=fixture(t,{dx:.35});ordinary.bot.health=10;
 await assert.rejects(ordinary.run(),{code:'dry_bank_alignment_survival_limit'});
});
