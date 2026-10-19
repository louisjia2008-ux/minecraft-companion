'use strict';
const { createWaterVitalsGuard } = require('./houseWaterVitals');
const { readHouseBotOxygen } = require('./houseBotOxygen');
const { isNaturalWalkingBodyBlock } = require('./houseNaturalWalkingBody');
const { isAquaticBodyBlock } = require('./houseAquaticBody');
// Shallow source-water traversal with strict actual body/owner checks.
// The host supplies original Mineflayer dependencies and a captured safety
// capability; business pause and foreign-owner preemption remain distinct.
// Controlled Vanilla depth1/width4+12 narrow-sandbank components were validated;
// natural public tasks and arbitrary-river support require separate acceptance.
const failure = (code, message, details = {}) => Object.assign(new Error(message), {code,...details});
const pos = p => ({x:p.x,y:p.y,z:p.z});
const sameCell = (p,q) => Math.floor(p.x)===q.x&&Math.floor(p.y)===q.y&&Math.floor(p.z)===q.z;
const isAir = b => !!b&&['air','cave_air','void_air'].includes(b.name);
const source = b => !!b&&b.name==='water'&&Number(b.getProperties().level)===0;
const fluidOrHazard = b => !b||['lava','bubble_column','cactus','fire','soul_fire','magma_block','campfire','soul_campfire','powder_snow'].includes(b.name)||[true,'true'].includes(b.getProperties?.().waterlogged);

function inspectBody(bot,Vec3) {
  const e=bot.entity,p=e?.position,width=e?.width,height=e?.height,eyeHeight=e?.eyeHeight,eps=1e-8;
  if(!p||!['x','y','z'].every(k=>Number.isFinite(p[k])&&Number.isFinite(e.velocity?.[k]))||!Number.isFinite(width)||width<=0||width>1||!Number.isFinite(height)||height<=0||height>2||!Number.isFinite(eyeHeight)||eyeHeight<=0||eyeHeight>height)throw failure('water_actual_state_unknown','Real body dimensions, position and velocity must be finite');
  const cells=[],blocks=[];
  for(let x=Math.floor(p.x-width/2+eps);x<=Math.floor(p.x+width/2-eps);x++)for(let z=Math.floor(p.z-width/2+eps);z<=Math.floor(p.z+width/2-eps);z++)for(let y=Math.floor(p.y+eps);y<=Math.floor(p.y+height-eps);y++) {
    const b=bot.blockAt(new Vec3(x,y,z));blocks.push(b);cells.push({position:{x,y,z},name:b?.name||null,level:b?.getProperties?.().level??null,
      stateId:b?.stateId??null,boundingBox:b?.boundingBox??null,shapes:b?.shapes??null,waterlogged:b?.getProperties?.().waterlogged??null});
  }
  const eye=p.offset(0,eyeHeight,0),eyeBlock=bot.blockAt(eye.floored()),above=bot.blockAt(eye.floored().offset(0,1,0));
  // Body clearance is shared with dry walking. This does not relax eye-air,
  // water-source, depth, stable bank support or four-cell route headroom checks.
  for(const b of blocks)if(fluidOrHazard(b)||(!isAir(b)&&!source(b)&&!isNaturalWalkingBodyBlock(b)&&!isAquaticBodyBlock(b)))throw failure('water_body_unsafe','Strict actual body intersects unknown, unsafe fluid or solid',{position:pos(p),cells});
  return {position:pos(p),velocity:pos(e.velocity),onGround:e.onGround===true,isInWater:e.isInWater===true,isInLava:e.isInLava===true,
    health:Number.isFinite(bot.health)?bot.health:null,food:Number.isFinite(bot.food)?bot.food:null,eyeY:eye.y,eyeAir:isAir(eyeBlock),aboveEyeAir:isAir(above),...readHouseBotOxygen(bot),cells};
}

const gravity=b=>b&&(['sand','red_sand','gravel','suspicious_sand','suspicious_gravel','dragon_egg','anvil','chipped_anvil','damaged_anvil'].includes(b.name)||b.name.endsWith('_concrete_powder'));
const fullCube=b=>!!b&&b.boundingBox==='block'&&!fluidOrHazard(b)&&!['water'].includes(b.name)&&b.shapes?.some(s=>s.length===6&&s.every((v,i)=>v===(i<3?0:1)));
function stableSupport(bot,p,Vec3) {
  const facts=[];let b=bot.blockAt(new Vec3(p.x,p.y,p.z));
  for(let down=0;down<=3;down++) {
    if(!fullCube(b))throw failure('water_bank_unstable','Loaded full-cube support is required',{position:p,down,actual:b?.name||null});
    facts.push({position:pos(b.position),name:b.name,stateId:b.stateId});
    if(!gravity(b))return facts;
    if(!['sand','red_sand','gravel'].includes(b.name)||down===3)throw failure('water_bank_gravity_limit','Sand/gravel needs a loaded non-gravity solid base within3 below',{position:p,facts});
    b=bot.blockAt(new Vec3(p.x,p.y-down-1,p.z));
  }
  throw failure('water_bank_unstable','Missing stable support');
}
function routeFrame(route) {
  if(!route||route.schema!==1||route.kind!=='loaded_source_water_wade'||![route.from,route.to].every(p=>p&&['x','y','z'].every(k=>Number.isSafeInteger(p[k]))))throw failure('water_route_invalid','Schema1 typed wading descriptor and integer bank coordinates required');
  const d=route.direction;
  if(!d||!Number.isInteger(d.x)||!Number.isInteger(d.z)||Math.abs(d.x)+Math.abs(d.z)!==1)throw failure('water_route_invalid','One cardinal direction required');
  const start=route.waterStart;if(!start||![start.x,start.z,route.surfaceY,route.width].every(Number.isSafeInteger)||route.width<1||route.width>12||route.depth!==1)throw failure('water_route_unsupported','Only loaded depth1 still water width1..12 is supported');
  const tangent={x:-d.z,z:d.x},origin={x:start.x+.5,z:start.z+.5};
  const u=p=>(p.x-origin.x)*d.x+(p.z-origin.z)*d.z,v=p=>(p.x-origin.x)*tangent.x+(p.z-origin.z)*tangent.z;
  const center=p=>({x:p.x+.5,z:p.z+.5}),fromU=u(center(route.from)),toU=u(center(route.to));
  if(route.from.y!==route.surfaceY||route.to.y!==route.surfaceY||Math.abs(v(center(route.from)))>1e-8||Math.abs(v(center(route.to)))>1e-8||!((fromU===-1&&toU===route.width)||(toU===-1&&fromU===route.width)))throw failure('water_route_invalid','Same-level cardinal dry banks must immediately bracket the declared source water');
  return {d,tangent,u,v,fromU,toU,minU:Math.min(fromU,toU),maxU:Math.max(fromU,toU),motionSign:Math.sign(toU-fromU),cell:(i,j,y)=>({x:start.x+d.x*i+tangent.x*j,y,z:start.z+d.z*i+tangent.z*j})};
}
function validateRoute(bot,route,Vec3) {
  const f=routeFrame(route),facts=[];
  for(const p of [route.from,route.to])for(let j=-1;j<=1;j++) {
    const q={x:p.x+f.tangent.x*j,y:p.y,z:p.z+f.tangent.z*j};
    if(j===0)facts.push(...stableSupport(bot,{...q,y:q.y-1},Vec3));
    else {const side=bot.blockAt(new Vec3(q.x,q.y-1,q.z));if(fluidOrHazard(side)||side.name==='water'&&!source(side))throw failure('water_bank_side_unsafe','Narrow bank sides must be loaded without hazardous/flowing fluid',{position:q,actual:side?.name||null});}
    for(let dy=0;dy<4;dy++)if(!isAir(bot.blockAt(new Vec3(q.x,q.y+dy,q.z))))throw failure('water_bank_headroom','Four loaded air cells required above each bank center and its safe loaded sides',{position:q});
  }
  for(let i=0;i<route.width;i++)for(let j=-1;j<=1;j++) {
    const q=f.cell(i,j,route.surfaceY-1),b=bot.blockAt(new Vec3(q.x,q.y,q.z));
    if(!source(b))throw failure('water_route_not_source','Every3wide route cell must be loaded level0 water',{position:q,actual:b?.name||null,level:b?.getProperties?.().level??null});
    facts.push({position:q,name:b.name,stateId:b.stateId,level:0});facts.push(...stableSupport(bot,{...q,y:q.y-1},Vec3));
    for(let dy=0;dy<4;dy++){const p={...q,y:route.surfaceY+dy};if(!isAir(bot.blockAt(new Vec3(p.x,p.y,p.z))))throw failure('water_headroom_unknown','Four loaded air cells above each3wide source cell required',{position:p});}
  }
  return {confirmedGeometry:true,actualTraversalConfirmed:false,schema:1,kind:'loaded_source_water_wade',width:route.width,depth:1,bankContract:'center stable fullcube; loaded safe sides, cardinal centerline and strict actual0.6AABB; not3wide dry floors',facts};
}

function createNaturalShallowWaterTraversal(deps) {
  const {Vec3,Movements,GoalBlock}=deps;
  if(!Vec3||!Movements||!GoalBlock||typeof deps.getBot!=='function'||typeof deps.getOwner!=='function'||typeof deps.isOwnerCurrent!=='function')throw new TypeError('Original native dependencies and exact owner capability required');
  const bot=deps.getBot(),client=bot?._client,owner=deps.getOwner();
  let active=false,requested=null,profile=null,tickListener=null,hold=false,ownerLost=false;
  const record=(type,data={})=>deps.record?.(type,data);
  const owned=()=>{if(ownerLost)return false;const same=deps.getBot()===bot&&bot?._client===client&&deps.isOwnerCurrent(owner)===true&&client?.state==='play'&&(!(active||hold)||!profile||bot.pathfinder.movements===profile);if(!same)ownerLost=true;return same;};
  const assertOwner=()=>{if(!owned())throw failure('water_foreign_owner','Captured water traversal owner changed');};
  const dryAt=p=>{const e=bot.entity;if(!e||!e.onGround||e.isInWater||e.isInLava||!sameCell(e.position,p)||Math.abs(e.position.y-p.y)>.08)return false;try{stableSupport(bot,{x:p.x,y:p.y-1,z:p.z},Vec3);inspectBody(bot,Vec3);return true;}catch{return false;}};
  const floatNow=()=>{assertOwner();bot.setControlState('sprint',false);bot.setControlState('sneak',false);bot.setControlState('jump',true);};
  const stopDry=()=>{assertOwner();if(bot.entity.isInWater)throw failure('water_unsafe_clear','Cannot clear owned controls while in water');bot.pathfinder.setGoal(null);bot.clearControlStates();};
  function requestCancel(code='water_cancelled') { requested ||= failure(code,'Controlled traversal requested to stop'); }

  async function traverse(route) {
    assertOwner();if(active||hold)throw failure('water_session_busy','Water session is already active or holding safe flotation');
    const vitalsSafe=createWaterVitalsGuard(bot,deps.recoveryReturn===true);
    const frame=routeFrame(route);validateRoute(bot,route,Vec3);if(!Number.isFinite(bot.health)||!Number.isFinite(bot.food))throw failure('water_vitals_unknown','Actual initial health/food must be finite');if(!vitalsSafe())throw failure('water_survival_limit','Initial health/food below16/14',{health:bot.health,food:bot.food});if(Math.abs(frame.v(bot.entity.position))>.15)throw failure('water_centerline_lost','Initial actual bank position is outside0.15m centerline');if(!dryAt(route.from))throw failure('water_start_not_grounded','Native dry-bank start not confirmed',{position:pos(bot.entity.position),from:route.from});
    const timeoutMs=route.timeoutMs===undefined?45000:route.timeoutMs;if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>90000)throw failure('water_route_invalid','Native deadline must be finite1..90000ms');
    active=true;requested=null;
    const previous=bot.pathfinder.movements;
    profile=new Movements(bot);profile.canDig=false;profile.scafoldingBlocks=[];profile.allowParkour=false;profile.allow1by1towers=false;profile.allowSprinting=false;profile.maxDropDown=2;profile.infiniteLiquidDropdownDistance=false;profile.getMoveDiagonal=()=>{};
    profile.exclusionAreasStep.push(b=>b?.position&&Math.abs(frame.v({x:b.position.x+.5,z:b.position.z+.5}))<1e-8&&frame.u({x:b.position.x+.5,z:b.position.z+.5})>=frame.minU&&frame.u({x:b.position.x+.5,z:b.position.z+.5})<=frame.maxU?0:Infinity);
    bot.pathfinder.setMovements(profile);
    const began=Date.now(),deadline=began+timeoutMs;
    function shoreControls(target,recovery=false) {
      assertOwner();const e=bot.entity,p=e.position,targetU=frame.u({x:target.x+.5,z:target.z+.5}),west=targetU<0;
      const distance=west?frame.u(p)+.5:route.width-.5-frame.u(p),towardVelocity=(e.velocity.x*frame.d.x+e.velocity.z*frame.d.z)*(west?-1:1);
      const inTargetCell=Math.floor(p.x)===target.x&&Math.floor(p.z)===target.z;
      if(recovery&&inTargetCell&&p.y>=route.surfaceY-.05&&!e.isInWater) {
        bot.setControlState('forward',false);bot.setControlState('jump',false);bot.setControlState('back',towardVelocity>.008);return;
      }
      if(distance>=.3-1e-8&&distance<.45&&p.y<route.surfaceY-.01) {
        bot.setControlState('jump',true);
        if(distance<=.305){bot.setControlState('forward',false);bot.setControlState('back',p.y<route.surfaceY-.78);}
        else if(p.y>=route.surfaceY-.85&&e.velocity.y>.05){bot.setControlState('forward',true);bot.setControlState('back',false);}
        else {bot.setControlState('forward',false);bot.setControlState('back',false);}
      } else {bot.setControlState('back',false);if(recovery)bot.setControlState('forward',true);}
    }

    let stopReject,timer,ticks=0,waterTicks=0,lastFacts=null,recovered=false;
    const stopped=new Promise((_resolve,reject)=>{stopReject=reject;});stopped.catch(()=>{});
    const stopReason=()=>{if(!owned())return failure('water_foreign_owner','Exact owner changed during water motion');if(requested)return requested;if(Date.now()>=deadline)return failure('water_timeout','Native water traversal deadline elapsed');return null;};
    tickListener=()=>{
      if(!owned()){stopReject(failure('water_foreign_owner','Exact owner changed during water motion'));return;}
      try {
        ticks++;lastFacts=inspectBody(bot,Vec3,route);if(lastFacts.isInWater)waterTicks++;
        if(Math.abs(frame.v(bot.entity.position))>.15)throw failure('water_centerline_lost','Actual body left the0.15m cardinal centerline',{position:pos(bot.entity.position),lateral:frame.v(bot.entity.position)});
        if(!Number.isFinite(bot.health)||!Number.isFinite(bot.food))requested ||= failure('water_vitals_unknown','Actual health/food must be finite',{health:bot.health??null,food:bot.food??null});
        else if(!vitalsSafe())requested ||= failure('water_survival_limit','Actual health/food below16/14 requires retreat',{health:bot.health,food:bot.food});
        if(!requested)shoreControls(route.to,false,lastFacts);
        record('water_physics_tick',{ticks,waterTicks,...lastFacts,eyeAboveSurface:lastFacts.eyeY-route.surfaceY});
        if(lastFacts.isInLava||!lastFacts.eyeAir||!lastFacts.aboveEyeAir||lastFacts.oxygenLevel!==null&&lastFacts.oxygenLevel<18)requested ||= failure('water_safety_retreat','Actual air/oxygen safety threshold requires retreat');
        const reason=stopReason();if(reason)stopReject(reason);
      } catch(error) {requested ||= error;stopReject(error);}
    };
    bot.on('physicsTick',tickListener);
    timer=setTimeout(()=>stopReject(failure('water_timeout','Native water traversal deadline elapsed')),timeoutMs);
    record('water_native_started',{route,ownerLabel:owner?.label||null,position:pos(bot.entity.position),profile:{canDig:false,scaffold:false,parkour:false,sprint:false,diagonal:false,maxDropDown:2}});
    const native=bot.pathfinder.goto(new GoalBlock(route.to.x,route.to.y,route.to.z));native.catch(()=>{});
    try {
      await Promise.race([native,stopped]);assertOwner();if(stopReason())throw stopReason();
      const settle=Date.now()+3000;while(!dryAt(route.to)||Math.abs(frame.v(bot.entity.position))>.15){assertOwner();if(stopReason())throw stopReason();if(Date.now()>settle)throw failure('water_landing_unconfirmed','Native goal resolved without actual dry landing');await new Promise(r=>setTimeout(r,25));}
      record('water_native_confirmed',{position:pos(bot.entity.position),ticks,waterTicks,onGround:bot.entity.onGround});
      return {confirmed:true,ticks,waterTicks,position:pos(bot.entity.position)};
    } catch(error) {
      if(!owned())throw failure('water_foreign_owner','Foreign owner preemption prohibits old recovery',{cause:error});
      // The safety capability survives this operation's cancellation only. A
      // foreign bot/client/generation/lease invalidates it immediately.
      clearTimeout(timer);bot.removeListener('physicsTick',tickListener);tickListener=null;
      const keepFloating=()=>{if(!owned())return;try{if(dryAt(route.from)){bot.setControlState('forward',false);bot.setControlState('back',false);bot.setControlState('jump',false);}else{floatNow();shoreControls(route.from,true,inspectBody(bot,Vec3,route));}}catch{/* main recovery reports invalid body, holding jump until disconnect */}};
      bot.pathfinder.setGoal(null);if(bot.entity.isInWater){hold=true;floatNow();tickListener=keepFloating;bot.on('physicsTick',tickListener);}
      await Promise.race([native.catch(()=>{}),new Promise((_r,reject)=>setTimeout(()=>reject(failure('water_native_unsettled','Old native goto did not settle')),1000))]);assertOwner();
      if(dryAt(route.from)||dryAt(route.to)){recovered=true;record('water_cancel_already_dry',{position:pos(bot.entity.position),code:error.code||error.name});}
      else {
        const recoveryDeadline=Date.now()+30000;
        const facts=inspectBody(bot,Vec3,route);record('water_recovery_started',{reason:error.code||error.name,originalFailure:{code:error.code||null,message:error.message,health:error.health??null,food:error.food??null},facts,target:route.from});
        hold=true;floatNow();
        // Head and body must remain in the prevalidated loaded lane. Floating
        // uses native jump, cardinal look and forward controls, never teleport.
        if(!tickListener){tickListener=keepFloating;bot.on('physicsTick',tickListener);}
        await bot.look(Math.atan2(frame.d.x*frame.motionSign,frame.d.z*frame.motionSign),0,true);assertOwner();bot.setControlState('forward',true);
        while(!dryAt(route.from)||Math.abs(frame.v(bot.entity.position))>.15) {
          assertOwner();const actual=inspectBody(bot,Vec3,route),p=bot.entity.position;
          record('water_recovery_tick',{...actual,eyeAboveSurface:actual.eyeY-route.surfaceY});
          if(!actual.eyeAir||!actual.aboveEyeAir||actual.isInLava)throw failure('water_retreat_air_unsafe','Actual retreat eye/head air or fluid safety changed',{position:pos(p)});
          if(Math.abs(frame.v(p))>.35||frame.u(p)<frame.minU-.65||frame.u(p)>frame.maxU+.65||Date.now()>recoveryDeadline)throw failure('water_retreat_blocked','Native retreat left checked lane or exceeded safety budget',{position:pos(p)});
          await new Promise(r=>setTimeout(r,25));
        }
        recovered=true;hold=false;record('water_recovery_confirmed',{position:pos(bot.entity.position),onGround:bot.entity.onGround});
      }
      throw failure(error.code||error.name||'water_blocked',error.message,{cause:error,recoveredToDryBank:recovered,position:pos(bot.entity.position)});
    } finally {
      clearTimeout(timer);active=false;
      if(owned()&&!hold) {
        if(tickListener)bot.removeListener('physicsTick',tickListener);tickListener=null;
        if(!bot.entity.isInWater){stopDry();if(bot.pathfinder.movements===profile)bot.pathfinder.setMovements(previous);}
      } else if(!owned()) {if(tickListener)bot.removeListener('physicsTick',tickListener);tickListener=null;}
      // If checked retreat failed while still in water, retain only jump under
      // exact safe-owner capability; release() refuses to clear a wet actor.
      if(owned()&&hold){
        if(tickListener)bot.removeListener('physicsTick',tickListener);
        tickListener=()=>{if(!owned()){if(tickListener)bot.removeListener('physicsTick',tickListener);tickListener=null;return;}for(const name of ['forward','back','left','right'])bot.setControlState(name,false);floatNow();};
        bot.on('physicsTick',tickListener);tickListener();record('water_safety_hold',{position:pos(bot.entity.position),reason:'Retreat BLOCKED; no horizontal motion, same-owner native jump retained until owned disconnect'});
      }
    }
  }
  function release() {
    if(!owned()){if(tickListener)bot.removeListener('physicsTick',tickListener);tickListener=null;return {foreign:true};}
    if(bot.entity.isInWater)throw failure('water_release_blocked','Refuse to release flotation while still wet');
    if(tickListener)bot.removeListener('physicsTick',tickListener);tickListener=null;hold=false;stopDry();return {released:true};
  }
  return {traverse,requestCancel,release,isHolding:()=>hold,isActive:()=>active};
}
module.exports={createNaturalShallowWaterTraversal,validateRoute,inspectBody,routeFrame,stableSupport};
