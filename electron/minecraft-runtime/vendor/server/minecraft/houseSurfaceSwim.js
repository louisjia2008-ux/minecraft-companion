/* global require, module, setTimeout, clearTimeout */
'use strict';
// Surface-only swimming makes no river-bottom/depth claim.
const {AsyncLocalStorage}=require('node:async_hooks');
const { createWaterVitalsGuard } = require('./houseWaterVitals');
function createSurfaceSwimAPI(nativeSafety){
 for(const name of ['inspectBody','stableSupport','readHouseBotOxygen'])if(typeof nativeSafety?.[name]!=='function')throw new TypeError(`Immutable native safety ${name} is required`);
 const {inspectBody,stableSupport,readHouseBotOxygen}=nativeSafety;
const lookContexts=new AsyncLocalStorage(),lookFrames=new WeakMap();
const fail=(code,message,facts={})=>Object.assign(new Error(message),{code,...facts});
const pos=p=>({x:p.x,y:p.y,z:p.z}),air=b=>b&&['air','cave_air','void_air'].includes(b.name);
const source=b=>b?.name==='water'&&[0,'0'].includes(b.getProperties?.().level);
function routeFrame(route){
 if(!route||route.schema!==1||route.kind!=='loaded_surface_swim'||route.depth!=='surface_only'
  ||![route.from,route.to].every(p=>p&&['x','y','z'].every(k=>Number.isSafeInteger(p[k])))
  ||![route.width,route.surfaceY,route.waterStart?.x,route.waterStart?.z].every(Number.isSafeInteger)||route.width<1||route.width>64
  ||!route.direction||![route.direction.x,route.direction.z].every(Number.isInteger)||Math.abs(route.direction.x)+Math.abs(route.direction.z)!==1)
  throw fail('surface_swim_route_invalid','Explicit surface_only source-water route width1..64 required');
 const d=route.direction,t={x:-d.z,z:d.x},origin={x:route.waterStart.x+.5,z:route.waterStart.z+.5};
 const u=p=>(p.x-origin.x)*d.x+(p.z-origin.z)*d.z,v=p=>(p.x-origin.x)*t.x+(p.z-origin.z)*t.z;
 const center=p=>({x:p.x+.5,z:p.z+.5}),fromU=u(center(route.from)),toU=u(center(route.to));
 if(route.from.y!==route.surfaceY||route.to.y!==route.surfaceY||Math.abs(v(center(route.from)))>1e-8||Math.abs(v(center(route.to)))>1e-8
  ||!((fromU===-1&&toU===route.width)||(toU===-1&&fromU===route.width)))throw fail('surface_swim_route_invalid','Stable same-level banks must bracket the real cardinal surface lane');
 return{d,t,u,v,fromU,toU,minU:-1,maxU:route.width,sign:Math.sign(toU-fromU),cell:(i,j,y)=>({x:route.waterStart.x+d.x*i+t.x*j,y,z:route.waterStart.z+d.z*i+t.z*j})};
}
function validateSurfaceRoute(bot,route,Vec3){
 const f=routeFrame(route),facts=[];
 for(const bank of[route.from,route.to])for(let j=-1;j<=1;j++){
  const p={x:bank.x+f.t.x*j,y:bank.y,z:bank.z+f.t.z*j};
  if(j===0)facts.push(...stableSupport(bot,{...p,y:p.y-1},Vec3));
  else { const side=bot.blockAt(new Vec3(p.x,p.y-1,p.z));
   if(!side||['lava','bubble_column','magma_block','fire','soul_fire','cactus','campfire','soul_campfire','powder_snow'].includes(side.name)
    ||[true,'true'].includes(side.getProperties?.().waterlogged)||side.name==='water'&&!source(side))throw fail('surface_swim_bank_side','Bank sides must be loaded safe, not flowing or hazardous',{position:p,name:side?.name||null});
  }
  for(let y=0;y<4;y++)if(!air(bot.blockAt(new Vec3(p.x,p.y+y,p.z))))throw fail('surface_swim_bank_air','Bank center and safe sides need four loaded air cells',{position:p});
 }
 for(let i=0;i<route.width;i++)for(let j=-1;j<=1;j++){
  const p=f.cell(i,j,route.surfaceY-1),b=bot.blockAt(new Vec3(p.x,p.y,p.z));
  if(!source(b))throw fail('surface_swim_surface_unknown','Every3wide top-water cell must be loaded level0 source',{position:p,name:b?.name||null,level:b?.getProperties?.().level??null});
  facts.push({position:p,name:b.name,stateId:b.stateId,level:0});
  for(let y=0;y<4;y++){const a=f.cell(i,j,route.surfaceY+y);if(!air(bot.blockAt(new Vec3(a.x,a.y,a.z))))throw fail('surface_swim_air_unknown','Four loaded air cells are required above each surface cell',{position:a});}
 }
 return{schema:1,kind:'loaded_surface_swim',depth:'surface_only',width:route.width,confirmedSurfaceGeometry:true,riverBottomObserved:false,actualTraversalConfirmed:false,facts};
}
function createNaturalSurfaceSwim(deps){
 const{Vec3,Movements}=deps;
 for(const name of['getBot','getOwner','isOwnerCurrent'])if(typeof deps[name]!=='function')throw new TypeError(`Surface swim requires ${name}`);
 if(!Vec3||!Movements)throw new TypeError('Installed native Vec3/Movements required');
 const bot=deps.getBot(),client=bot?._client,owner=deps.getOwner();
 let active=false,hold=false,ownerLost=false,profile=null,requested=null,holdListener=null,currentRoute=null;
 const record=(type,facts={})=>deps.record?.(type,facts);
 const owned=()=>{if(ownerLost)return false;const yes=deps.getBot()===bot&&bot._client===client&&deps.isOwnerCurrent(owner)===true
  &&client?.state==='play'&&(!(active||hold)||!profile||bot.pathfinder.movements===profile);if(!yes)ownerLost=true;return yes;};
 const assertOwner=()=>{if(!owned())throw fail('surface_swim_foreign_owner','The exact captured safety actor was replaced');};
 const control=(name,value)=>{assertOwner();bot.setControlState(name,value);};
 const horizontalStop=()=>{for(const name of['forward','back','left','right','sprint','sneak'])control(name,false);};
 const float=()=>{horizontalStop();control('jump',true);};
 const body=()=>inspectBody(bot,Vec3);
 function dryAt(route,p){
  const e=bot.entity;if(!e.onGround||e.isInWater||e.isInLava||Math.abs(e.position.y-p.y)>.075
   ||Math.floor(e.position.x)!==p.x||Math.floor(e.position.z)!==p.z)return false;
  try{stableSupport(bot,{...p,y:p.y-1},Vec3);const facts=body();return facts.eyeAir&&facts.aboveEyeAir&&facts.eyeY>route.surfaceY+.05;}catch{return false;}
 }
 function nativeLook(yaw,deadline){
  const token={closed:false},previous=bot.look,entry={previous,live:true};
  function guarded(...args){if(entry.live&&lookContexts.getStore()===token){if(token.closed)throw fail('surface_swim_late_look','Expired swim look cannot write');assertOwner();}return previous.apply(this,args);}
  lookFrames.set(guarded,entry);bot.look=guarded;
  const restore=()=>{entry.live=false;if(bot.look===guarded){let p=previous;while(lookFrames.get(p)?.live===false)p=lookFrames.get(p).previous;bot.look=p;}};
  const promise=lookContexts.run(token,()=>Promise.resolve().then(()=>{assertOwner();if(token.closed)throw fail('surface_swim_late_look','Expired swim look');
   return deps.look?deps.look(yaw,0,{beforeSend:()=>{assertOwner();if(token.closed)throw fail('surface_swim_late_look','Expired swim look');}}):bot.look(yaw,0,true);}));
  promise.then(restore,restore);return{promise,close:()=>{token.closed=true;},deadline};
 }
 function requestCancel(code='surface_swim_cancelled'){requested ||= fail(code,'Requested controlled surface retreat');}
 async function traverse(route){
  assertOwner();if(active||hold)throw fail('surface_swim_busy','A surface safety session remains active');
  const f=routeFrame(route),geometry=validateSurfaceRoute(bot,route,Vec3),initial=body();
  const vitalsSafe=createWaterVitalsGuard(bot,deps.recoveryReturn===true);
  if(!vitalsSafe())throw fail('surface_swim_survival_limit','Real health16 and food14 required');
  const oxygen=readHouseBotOxygen(bot);if(oxygen.oxygenLevel!==null&&oxygen.oxygenLevel<18)throw fail('surface_swim_oxygen_limit','Known own-player actual air below18 prohibits starting');
  // Missing default self air metadata stays UNKNOWN. Strict native surface
  // eyes/air/body checks are still mandatory; global bot.oxygenLevel is unused.
  if(!initial.eyeAir||!initial.aboveEyeAir||initial.eyeY<=route.surfaceY+.05)throw fail('surface_swim_body_air','Actual initial eyes must stay above the surface in loaded air');
  if(Math.abs(f.v(bot.entity.position))>.15||!dryAt(route,route.from))throw fail('surface_swim_start','Actual centered dry source bank required');
  const timeoutMs=route.timeoutMs??Math.min(120000,8000+route.width*1500),retreatTimeoutMs=route.retreatTimeoutMs??Math.min(120000,10000+route.width*1500);
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000||!Number.isInteger(retreatTimeoutMs)||retreatTimeoutMs<1||retreatTimeoutMs>120000)throw fail('surface_swim_route_invalid','Finite1..120000ms forward/retreat budgets required');
  if(bot.pathfinder.goal)throw fail('surface_swim_native_goal_active','Original native movement must settle before surface controls');
  const previous=bot.pathfinder.movements;
  profile=new Movements(bot);profile.canDig=false;profile.scafoldingBlocks=[];profile.allowParkour=false;profile.allow1by1towers=false;
  profile.allowSprinting=false;profile.allowFreeMotion=false;profile.maxDropDown=2;profile.infiniteLiquidDropdownDistance=false;profile.getMoveDiagonal=()=>{};
  profile.exclusionAreasStep.push(()=>Infinity);active=true;currentRoute=route;requested=null;bot.pathfinder.setMovements(profile);
  let ticks=0,waterTicks=0,horizontalDistance=0,lastPosition=pos(bot.entity.position),recovered=false;
  record('surface_swim_started',{route,geometry:{...geometry,facts:geometry.facts.length},initial,riverBottomObserved:false});
  function stopDry(){assertOwner();if(bot.entity.isInWater||bot.entity.isInLava)throw fail('surface_swim_release_wet','Cannot clear flotation while wet');horizontalStop();control('jump',false);}
  async function leg(target,sign,recovery,budget){
   assertOwner();const began=Date.now(),targetU=f.u({x:target.x+.5,z:target.z+.5}),deadline=began+budget;
   let done=false,looking=true,resolveLeg,rejectLeg,lastProgress=began,furthest=f.u(bot.entity.position)*sign,stable=0;
   const ended=new Promise((resolve,reject)=>{resolveLeg=resolve;rejectLeg=reject;});ended.catch(()=>{});
   const look=nativeLook(Math.atan2(-f.d.x*sign,-f.d.z*sign),deadline);
   const finish=(error)=>{if(done)return;done=true;look.close();if(error)rejectLeg(error);else resolveLeg();};
   const check=()=>{
    if(done)return;
    try{
     assertOwner();ticks++;const facts=body(),p=bot.entity.position,u=f.u(p),v=f.v(p);
     horizontalDistance+=Math.hypot(p.x-lastPosition.x,p.z-lastPosition.z);lastPosition=pos(p);if(facts.isInWater)waterTicks++;
     record('surface_swim_tick',{recovery,ticks,waterTicks,...facts,lateral:v,along:u,horizontalDistance,riverBottomObserved:false});
     if(Math.abs(v)>.15||u<f.minU-.2||u>f.maxU+.2||horizontalDistance>2*(route.width+3)+2)throw fail('surface_swim_lane','Actual body left the bounded source-water centerline');
     if(facts.isInLava||!facts.eyeAir||!facts.aboveEyeAir||facts.eyeY<=route.surfaceY+.05||p.y<route.surfaceY-1.45)throw fail('surface_swim_body_air','Actual eye/head/source-water surface safety failed');
     if(!recovery&&(!vitalsSafe()))throw fail('surface_swim_survival_limit','Actual health/food require physical retreat');
     if(!recovery&&facts.oxygenLevel!==null&&facts.oxygenLevel<18)throw fail('surface_swim_oxygen_limit','Known own-player actual oxygen below18');
     if(!recovery&&requested)throw requested;
     if(Date.now()>=deadline)throw fail('surface_swim_timeout','Bounded native surface leg deadline');
     if(u*sign>furthest+.02){furthest=u*sign;lastProgress=Date.now();}
     if(Date.now()-lastProgress>3000)throw fail('surface_swim_no_progress','No actual surface progress for3s');
     if(looking){if(bot.entity.isInWater)float();else{horizontalStop();control('jump',false);}return;}
     // Re-read only the next two real surface rows before applying forward
     // controls. A changed far shore never grants permission to enter a new
     // flow/unknown/lava cell, and retreat rechecks in its own direction.
     const current=Math.floor(u+.5);
     for(const i of[current,current+sign,current+2*sign])if(i>=0&&i<route.width)for(let j=-1;j<=1;j++){
      const q=f.cell(i,j,route.surfaceY-1),b=bot.blockAt(new Vec3(q.x,q.y,q.z));
      if(!source(b))throw fail('surface_swim_surface_changed','Upcoming source-water surface is no longer loaded level0',{position:q,name:b?.name||null});
      for(let y=0;y<4;y++){const p=f.cell(i,j,route.surfaceY+y);if(!air(bot.blockAt(new Vec3(p.x,p.y,p.z))))throw fail('surface_swim_surface_changed','Upcoming surface air clearance changed',{position:p});}
     }
     if(Math.abs(targetU-u)<2.5){for(let j=-1;j<=1;j++){const p={x:target.x+f.t.x*j,y:target.y,z:target.z+f.t.z*j};
      if(j===0)stableSupport(bot,{...p,y:p.y-1},Vec3);
      for(let y=0;y<4;y++)if(!air(bot.blockAt(new Vec3(p.x,p.y+y,p.z))))throw fail('surface_swim_surface_changed','Upcoming bank headroom changed');}}
     const error=targetU-u,toward=error*sign,velocity=(bot.entity.velocity.x*f.d.x+bot.entity.velocity.z*f.d.z)*sign;
     if(dryAt(route,target)&&Math.abs(error)<=.15){
      control('forward',false);control('back',velocity>.008);control('jump',false);
      stable=Math.abs(velocity)<=.035?stable+1:0;if(stable>=3){finish();return;}return;
     }
     stable=0;control('sprint',false);control('sneak',false);control('left',false);control('right',false);
     // Stop just before bank contact while the feet are still below its top.
     // Native jump lifts the real body; no position/velocity or block is edited.
     const boundary=targetU-sign*.5,distance=(boundary-u)*sign;
     control('jump',facts.isInWater||distance<.48&&p.y<route.surfaceY-.01);
     if(distance>=.3-1e-8&&distance<.48&&p.y<route.surfaceY-.01){
      if(distance<=.305){control('forward',false);control('back',p.y<route.surfaceY-.78);}
      else if(p.y>=route.surfaceY-.85&&bot.entity.velocity.y>.05){control('forward',true);control('back',false);}
      else{control('forward',false);control('back',false);}return;
     }
     control('forward',toward>.06);control('back',toward<-.06);
    }catch(error){
     if(error.code==='water_body_unsafe')try{record('surface_swim_body_rejected',{
      recovery,code:error.code,position:error.position||pos(bot.entity.position),cells:error.cells||null,
      velocity:pos(bot.entity.velocity),onGround:bot.entity.onGround===true,isInWater:bot.entity.isInWater===true,
      isInLava:bot.entity.isInLava===true});}catch{/* Diagnostics cannot replace the safety rejection. */}
     finish(error);
    }
   };
   bot.on('physicsTick',check);const timer=setTimeout(()=>finish(fail('surface_swim_timeout','Native surface deadline')),budget);
   try{await Promise.race([look.promise,ended]);assertOwner();if(done)await ended;looking=false;check();await ended;}
   finally{look.close();clearTimeout(timer);bot.removeListener('physicsTick',check);if(owned()){if(bot.entity.isInWater)float();else horizontalStop();}}
  }
  try{
   await leg(route.to,f.sign,false,timeoutMs);assertOwner();
   if(!dryAt(route,route.to)||Math.abs(f.v(bot.entity.position))>.15)throw fail('surface_swim_landing_unconfirmed','Native controls did not reach real dry target bank');
   record('surface_swim_confirmed',{position:pos(bot.entity.position),ticks,waterTicks,riverBottomObserved:false});
   return{confirmed:true,kind:'loaded_surface_swim',depth:'surface_only',ticks,waterTicks,horizontalDistance,position:pos(bot.entity.position),riverBottomObserved:false};
  }catch(error){
   if(!owned())throw fail('surface_swim_foreign_owner','Foreign actor prohibits old recovery',{cause:error});
   try{
    if(!dryAt(route,route.from))await leg(route.from,-f.sign,true,retreatTimeoutMs);
    recovered=dryAt(route,route.from);if(!recovered)throw fail('surface_swim_retreat_unconfirmed','No real dry original-bank return');
    record('surface_swim_recovered',{reason:error.code,position:pos(bot.entity.position)});
   }catch(retreatError){
    if(!owned())throw fail('surface_swim_foreign_owner','Foreign actor prohibits old HOLD',{cause:retreatError});
    hold=true;horizontalStop();control('jump',true);
    holdListener=()=>{if(!owned()){bot.removeListener('physicsTick',holdListener);holdListener=null;return;}float();};bot.on('physicsTick',holdListener);
    record('surface_swim_hold',{reason:retreatError.code,position:pos(bot.entity.position),actualDry:false});
    throw fail(error.code||'surface_swim_blocked',error.message,{cause:error,retreatError,recoveredToDryBank:false,holding:true});
   }
   throw fail(error.code||'surface_swim_blocked',error.message,{cause:error,recoveredToDryBank:recovered,holding:false});
  }finally{
   active=false;
   if(owned()&&!hold){stopDry();if(bot.pathfinder.movements===profile)bot.pathfinder.setMovements(previous);}
   else if(!owned()&&holdListener){bot.removeListener('physicsTick',holdListener);holdListener=null;}
  }
 }
 function release(){
  if(!owned()){if(holdListener)bot.removeListener('physicsTick',holdListener);holdListener=null;return{foreign:true};}
  if(!currentRoute)return{released:true,neverStarted:true};
  if(!dryAt(currentRoute,currentRoute.from)&&!dryAt(currentRoute,currentRoute.to))throw fail('surface_swim_release_wet','Only actual supported dry source/target banks can release HOLD');
  if(holdListener)bot.removeListener('physicsTick',holdListener);holdListener=null;horizontalStop();control('jump',false);hold=false;return{released:true};
 }
 return{traverse,requestCancel,release,isHolding:()=>hold,isActive:()=>active};
}
return{createNaturalSurfaceSwim,validateSurfaceRoute,routeFrame};
}
// Default bindings use only this runtime's installed native safety helpers.
// The factory remains available for fixed-runtime dependency injection.
const { inspectBody, stableSupport } = require('./houseShallowWaterTraversal');
const { readHouseBotOxygen } = require('./houseBotOxygen');
const defaultAPI = createSurfaceSwimAPI({ inspectBody, stableSupport, readHouseBotOxygen });
module.exports = { createSurfaceSwimAPI, ...defaultAPI };
