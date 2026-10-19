'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{AsyncLocalStorage}=require('node:async_hooks');
const req=require;
const {Vec3}=req('vec3'),{PlayerState}=req('prismarine-physics'),{pathfinder,Movements}=req('mineflayer-pathfinder'),registry=req('prismarine-registry')('1.21.8'),Block=req('prismarine-block')(registry);
const next=require('../vendor/server/minecraft/houseCreeperEscape'),old=require('../test-support/house-creeper-escape-pre-height-baseline.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,ms=3000){const deadline=Date.now()+ms;while(!fn()&&Date.now()<deadline)await sleep(5);assert.ok(fn(),'actual native condition within budget');}
// Explicit initial terrain/pose only. Original Mineflayer look/control and
// original PlayerState.apply at REAL20Hz; no Java, teleports, speed or pose patch.
function fixture(t,{shape='hill',unknown=false}={}){
 const storage=new AsyncLocalStorage(),first={label:'first',generation:1,lease:{}},foreign={label:'foreign',generation:1,lease:{}};let owner=first,cancelled=false;
 const height=(x,z)=>shape==='ridge'?Math.max(1,6-Math.ceil(Math.max(Math.max(x,0),Math.max(Math.abs(z)-1,0))/2)):3+Math.ceil(Math.max(Math.max(x,0),Math.max(Math.abs(z)-1,0))/2);
 const y=height(0,0),points=[],controls=[],packets=[],records=[],looks=[],primary={id:9,name:'creeper',position:new Vec3(-4.3,y,.5),isValid:true};
 const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',username:'CreeperHeightNative',health:20,food:20,entities:{9:primary},game:{minY:-64,height:384,dimension:'overworld',gameMode:'survival'},player:{ping:1},jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,inventory:{slots:Array(46).fill(null),items:()=>[]},entity:{id:1,position:new Vec3(.5,y,.5),velocity:new Vec3(0,-.0784000015258789,0),onGround:true,yaw:0,pitch:0,eyeHeight:1.62,height:1.8,width:.6,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false}});
 bot._client=Object.assign(new EventEmitter(),{state:'play',socket:{writable:true,destroyed:false},write:(name,payload)=>packets.push({name,payload})});bot.supportFeature=n=>registry.supportFeature(n);
 bot.blockAt=raw=>{const p=raw.floored();if(Math.abs(p.x)>16||Math.abs(p.z)>16||p.y< -3||p.y>24||unknown&&(p.x!==0||p.z!==0))return null;return Object.assign(Block.fromStateId(registry.blocksByName[p.y<height(p.x,p.z)?'stone':'air'].defaultState),{position:p});};
 bot.stopDigging=()=>{};bot.deactivateItem=()=>{};req('mineflayer/lib/plugins/physics')(bot,{physicsEnabled:false});
 const nativeControl=bot.setControlState,nativeLook=bot.look;bot.setControlState=function(name,value){controls.push({owner:storage.getStore()?.label||'native',name,value,cancelled});return nativeControl.call(this,name,value);};bot.look=function(...args){looks.push({owner:storage.getStore()?.label||'native',args});return nativeLook.apply(this,args);};
 pathfinder(bot);const profile=new Movements(bot);profile.canDig=false;profile.scafoldingBlocks=[];profile.allowParkour=false;profile.allow1by1towers=false;profile.allowSprinting=false;profile.allowFreeMotion=false;profile.maxDropDown=2;profile.infiniteLiquidDropdownDistance=false;profile.getMoveDiagonal=()=>{};profile.exclusionAreasStep.push(block=>block?.position&&bot.blockAt(block.position)&&!['water','lava'].includes(block.name)?0:Infinity);bot.pathfinder.setMovements(profile);
 const deps={getBot:()=>bot,getThreat:()=>primary,getThreats:()=>[primary],isOwnerCurrent:()=>owner===first,assertActive:()=>{if(cancelled)throw Object.assign(new Error('paused'),{code:'paused'});if(owner!==first)throw Object.assign(new Error('movement_preempted'),{code:'movement_preempted'});},record:(event,details)=>records.push({event,details})};
 const timer=setInterval(()=>storage.run(owner,()=>{bot.physics.simulatePlayer(new PlayerState(bot,bot.controlState),{getBlock:bot.blockAt}).apply(bot);points.push({position:bot.entity.position.clone(),velocity:bot.entity.velocity.clone(),onGround:bot.entity.onGround,wet:bot.entity.isInWater});bot.emit('physicsTick');}),50);
 t.after(()=>{owner=foreign;clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();bot.emit('end');bot.removeAllListeners();});
 return{bot,deps,profile,points,controls,records,looks,packets,first,run:module=>storage.run(first,()=>module.createHouseCreeperEscape(deps).escape()),cancel:()=>{cancelled=true;},takeover:()=>{owner=foreign;const replacement=new Movements(bot);replacement.canDig=false;replacement.scafoldingBlocks=[];storage.run(foreign,()=>{bot.pathfinder.setGoal(null);bot.pathfinder.setMovements(replacement);bot.clearControlStates();bot.setControlState('jump',true);});return{replacement,index:controls.length};}};
}
for(const shape of['hill','ridge'])test(`sameY baseline0probe rejects ${shape}; height-aware native20Hz escapes actual surface`,{timeout:10000},async t=>{
 const f=fixture(t,{shape});let baseline;try{await f.run(old);}catch(e){baseline=e;}assert.equal(baseline?.code,'house_creeper_escape_no_path');assert.equal(baseline.probes,0);assert.equal(f.controls.some(c=>c.value),false);
 const result=await f.run(next);assert.equal(result.confirmed,true);assert.ok(result.finalDistance>=8.5);assert.ok(result.traveled<=12);assert.ok(result.elapsedMs<=4000);assert.equal(f.bot.entity.onGround,true);assert.ok(f.points.some(p=>p.position.y!==f.points[0].position.y));assert.equal(f.points.some(p=>p.wet),false);assert.ok(f.looks.length);assert.equal(f.bot.pathfinder.movements,f.profile);assert.equal(f.bot.pathfinder.goal,null);
 const plan=f.records.find(e=>e.event==='creeper_escape_plan').details;assert.ok(plan.planStats.surfaceNodes<=512);assert.ok(plan.planStats.surfaceReads<=4096);assert.ok(plan.probes>=1&&plan.probes<=8);assert.ok(plan.path.length<=16);assert.ok(plan.path.some(p=>p.y!==plan.path[0].y));console.log(JSON.stringify({scenario:shape,baselineProbes:0,planStats:plan.planStats,actual:result.actual,finalDistance:result.finalDistance,traveled:result.traveled,elapsedMs:result.elapsedMs}));
});
test('unknown surface remains UNKNOWN/no route/no positive native controls',{timeout:2000},async t=>{const f=fixture(t,{unknown:true});await assert.rejects(f.run(next),e=>e.code==='house_creeper_escape_no_path'&&e.probes===0&&e.planStats.unknownCells>0);assert.equal(f.controls.some(c=>c.value),false);assert.equal(f.looks.length,0);});
test('business pause during original native hillside motion cannot issue late positive controls',{timeout:8000},async t=>{const f=fixture(t),running=f.run(next);running.catch(()=>{});await until(()=>f.points.some(p=>p.position.x>.8));f.cancel();await assert.rejects(running,e=>e.code==='paused');await sleep(180);assert.equal(f.controls.some(c=>c.cancelled&&c.value),false);assert.equal(f.bot.pathfinder.movements,f.profile);assert.equal(f.bot.pathfinder.goal,null);});
test('same-generation foreign actor takeover preserves replacement profile and controls',{timeout:8000},async t=>{const f=fixture(t),running=f.run(next);running.catch(()=>{});await until(()=>f.points.some(p=>p.position.x>.8));const at=f.takeover();await assert.rejects(running,e=>/preempted/.test(e.code));await sleep(180);assert.equal(f.bot.pathfinder.movements,at.replacement);assert.equal(f.bot.getControlState('jump'),true);assert.equal(f.controls.slice(at.index).filter(c=>c.owner==='first').length,0);});

test('actual native stale-ground observation predicts the same later floor without mutating actor; unsafe alternatives reject',{timeout:10000},async t=>{
 const f=fixture(t,{shape:'ridge'}),graph=req('../vendor/server/minecraft/houseSurfaceGraph');let tick=0,lastGrounded,captured;
 const names=['forward','back','left','right','jump','sprint','sneak'];
 const snapshot=()=>JSON.stringify({entity:f.bot.entity,controls:Object.fromEntries(names.map(n=>[n,f.bot.controlState[n]])),jumpTicks:f.bot.jumpTicks,jumpQueued:f.bot.jumpQueued,goal:f.bot.pathfinder.goal?.constructor.name,packets:f.packets.length,controlsWrites:f.controls.length,looks:f.looks.length});
 const observe=()=>{
  tick++;
  if(graph.hasGroundedBodySupport(f.bot)){lastGrounded={tick,position:{...f.bot.entity.position},contacts:next.actualFullCubeContacts(f.bot)};return;}
  if(captured||f.bot.entity.onGround!==true||!lastGrounded)return;
  const before=snapshot(),facts=next.inspectNativeStaleGroundDescent(f.bot,{tick,lastGrounded});
  assert.equal(facts.accepted,true);assert.equal(facts.predictionApplied,false);assert.equal(facts.actualGrounded,false);assert.ok(facts.predictions.length<=8);assert.ok(facts.reads<=512);assert.equal(snapshot(),before);
  assert.equal(f.bot.entity.onGround,true);assert.equal(graph.hasGroundedBodySupport(f.bot),false);
  const view=(entity={})=>{const b=Object.create(f.bot);b.entity={...f.bot.entity,...entity};return b;};
  const mutateWorld=(position,name)=>{const b=view();b.blockAt=p=>{const q=p.floored();return q.equals(position)?name===null?null:Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:q}):f.bot.blockAt(q);};return b;};
  const foot=f.bot.entity.position.floored(),oldSupport=lastGrounded.contacts[0].position;
  const rejects=[
   ['no previous contacts',f.bot,{...lastGrounded,contacts:[]}],
   ['stale previous tick',f.bot,{...lastGrounded,tick:lastGrounded.tick-1}],
   ['too far from previous contact',f.bot,{...lastGrounded,position:{...lastGrounded.position,x:f.bot.entity.position.x-.36}}],
   ['native vertical speed differs',view({velocity:new Vec3(f.bot.entity.velocity.x,-.08,0)}),lastGrounded],
   ['horizontal velocity too high',view({velocity:new Vec3(.26,f.bot.entity.velocity.y,0)}),lastGrounded],
   ['native airborne is a different contract',view({onGround:false}),lastGrounded],
   ['old support state changed',f.bot,{...lastGrounded,contacts:lastGrounded.contacts.map(c=>({...c,stateId:c.stateId+1}))}],
   ['old support removed',mutateWorld(new Vec3(oldSupport.x,oldSupport.y,oldSupport.z),'air'),lastGrounded],
   ['lower floor unknown',mutateWorld(foot.offset(0,-2,0),null),lastGrounded],
   ['lower floor fluid',mutateWorld(foot.offset(0,-2,0),'water'),lastGrounded],
   ['lower floor partial shape',mutateWorld(foot.offset(0,-2,0),'stone_slab'),lastGrounded],
   ['two-level descent rejected',mutateWorld(foot.offset(0,-2,0),'air'),lastGrounded],
   ['future native query hazard',mutateWorld(foot.offset(1,-2,0),'lava'),lastGrounded],
   ['future native query unknown',mutateWorld(foot.offset(1,-2,0),null),lastGrounded],
   ['body unknown',mutateWorld(foot,null),lastGrounded],
   ['body fluid',mutateWorld(foot,'water'),lastGrounded]
  ];
  const missingControls=view();Object.defineProperty(missingControls,'controlState',{value:{...Object.fromEntries(names.map(n=>[n,f.bot.controlState[n]])),forward:undefined}});rejects.push(['controls UNKNOWN',missingControls,lastGrounded]);
  const rejected=rejects.map(([name,bot,last])=>{const result=next.inspectNativeStaleGroundDescent(bot,{tick,lastGrounded:last});assert.equal(result.accepted,false,name);return{name,reason:result.reason};});
  assert.equal(snapshot(),before);captured={tick,pose:{...f.bot.entity.position},lastGrounded,facts,rejected};
 };
 f.bot.prependListener('physicsTick',observe);
 await f.bot.pathfinder.goto(new(req('mineflayer-pathfinder').goals.GoalBlock)(4,4,0));await until(()=>f.bot.entity.onGround===true);
 assert.ok(captured,'actual Y-before-X transition observed');
 const prediction=captured.facts.predictions.find(p=>p.onGround&&p.sameFloor);assert.ok(prediction);
 const actual=f.points[captured.tick+prediction.tick-1];assert.ok(actual?.onGround);assert.ok(actual.position.distanceTo(new Vec3(prediction.position.x,prediction.position.y,prediction.position.z))<1e-7);
 console.log(JSON.stringify({scenario:'native_stale_ground_observer',tick:captured.tick,pose:captured.pose,lastActualContact:captured.lastGrounded,facts:captured.facts,negativeCount:captured.rejected.length,rejected:captured.rejected,laterActualGrounded:actual.onGround,laterActualPosition:actual.position}));
});
