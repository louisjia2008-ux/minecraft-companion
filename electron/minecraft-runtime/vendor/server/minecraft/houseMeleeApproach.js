'use strict';
const {goals}=require('mineflayer-pathfinder');
const {hasGroundedBodySupport,inspectSurfaceBody,naturalWalkingFoot}=require('./houseSurfaceGraph');
const {meleeReachDistance}=require('./combatGeometry');
const {createMiningNavigator}=require('./miningNavigation');
// Short, flat, freshly planned approach under the existing survival owner.
// This grants no chasing, digging, building or jump/drop capability.
async function approachHouseMelee(deps,{origin,deadline,maximumDisplacement=3,maximumSteps=4,timeoutMs=1500}){
 if(![3,12].includes(maximumDisplacement)||!Number.isInteger(maximumSteps)||maximumSteps<1||maximumSteps>16||timeoutMs<1||timeoutMs>12000)throw new TypeError("Invalid finite melee approach limits");
 const bot=deps.getBot(),client=bot._client,profile=bot.pathfinder.movements;
 const active=()=>{deps.assertActive();if(deps.getBot()!==bot||bot._client!==client||bot.pathfinder.movements!==profile||Date.now()>=deadline)
   throw Object.assign(Error('近战接近的原所有权或时间预算已结束'),{code:'house_surface_melee_preempted'});};
 active();const threat=deps.getThreat();if(!threat?.position||threat.isValid===false)return false;
 if(profile.canDig!==false||profile.allowParkour!==false||profile.scafoldingBlocks?.length)throw Object.assign(Error('近战接近不能借用额外移动能力'),{code:'house_surface_melee_profile'});
 const y=Math.floor(bot.entity.position.y),goal=new goals.GoalNear(Math.floor(threat.position.x),y,Math.floor(threat.position.z),2);
 const began=Date.now(),result=bot.pathfinder.getPathTo(profile,goal,75);active();
 if(Date.now()-began>75||result.status!=='success'||!Array.isArray(result.path)||!result.path.length||result.path.length>maximumSteps)return false;
 if(result.path.some(p=>p.y!==y||p.toBreak?.length||p.toPlace?.length||Math.hypot(p.x+.5-origin.x,p.z+.5-origin.z)>maximumDisplacement))return false;
 const guard=()=>{active();if(Math.hypot(bot.entity.position.x-origin.x,bot.entity.position.z-origin.z)>maximumDisplacement+.05
   ||Math.abs(bot.entity.position.y-origin.y)>.075||!inspectSurfaceBody(bot).dry||!hasGroundedBodySupport(bot))
   throw Object.assign(Error('有限平地近战接近离开了实际安全范围'),{code:'house_surface_melee_route_changed'});};
 let fault,reject;const failed=new Promise((_,r)=>reject=r);failed.catch(()=>{});
 const tick=()=>{try{guard();}catch(e){if(!fault){fault=e;deps.stopOwn?.(goal);reject(e);}}};
 bot.prependListener('physicsTick',tick);
 try{await Promise.race([deps.goto(goal,Math.max(1,Math.min(timeoutMs,deadline-Date.now()))),failed]);guard();return goal.isEnd(bot.entity.position.floored());}
 finally{bot.removeListener('physicsTick',tick);}
}
// Combat follows a finite native plan, one already clear cardinal step at a
// time: contact mode permits3m/one terrain level, ranged mode permits28m/8Y.
// It preserves the captured profile and cannot dig or place even if the live
// path changes. This adds checked one-block terrain steps, not free chasing.
async function approachHouseRanged(deps,{origin,deadline,contact=false}){
 const bot=deps.getBot(),profile=bot.pathfinder.movements,client=bot._client;
 const horizontalLimit=contact?3:28,verticalLimit=contact?1:8,pathLimit=contact?4:48;
 const startingHealth=bot.health;
 const active=()=>{deps.assertActive();
  const target=deps.getThreat();
  if(target?.position&&bot.entity.position.distanceTo(target.position)>3
    &&(bot.health<=10||bot.health<=startingHealth-4||deps.canContinueEngagement?.()===false))throw Object.assign(Error('接敌途中实际失血，停止冲锋并寻找遮挡'),
      {code:'house_surface_ranged_injured',startingHealth,health:bot.health});
  if(Object.values(bot.entities||{}).some(e=>e.name==='creeper'&&e.isValid!==false&&e.position?.distanceTo(bot.entity.position)<8.5))throw Object.assign(Error('接近远程敌人时出现苦力怕，停止追击'),{code:'house_surface_ranged_new_threat'});if(deps.getBot()!==bot||bot._client!==client||bot.pathfinder.movements!==profile
   ||Date.now()>=deadline||Math.hypot(bot.entity.position.x-origin.x,bot.entity.position.z-origin.z)>horizontalLimit+.05
   ||Math.abs(bot.entity.position.y-origin.y)>verticalLimit+.35)throw Object.assign(Error('自卫接近超出原归属、距离或时间'),{code:'house_surface_ranged_limit'});};
 active();
 // A warning may interrupt the upward half of a normal native jump. Its
 // floored feet are then above support; wait for original physics, without
 // assigning a predicted pose or treating the air cell as a standing node.
 const landingDeadline=Math.min(deadline,Date.now()+1200);
 while(!hasGroundedBodySupport(bot)){
  active();
  if(!inspectSurfaceBody(bot).dry)throw Object.assign(Error('接近远程敌人前身体接触危险或未知方块'),{code:'house_surface_ranged_landing_hazard'});
  if(Date.now()>=landingDeadline)throw Object.assign(Error('接近远程敌人前尚未实际落地'),{code:'house_surface_ranged_landing_unconfirmed'});
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 active();const threat=deps.getThreat();if(!threat?.position||threat.isValid===false)return false;
 // Every swing rechecks actual range. A one-block endpoint unnecessarily
 // rejects valid two-block striking positions around occupied camp cells.
 let goal=new goals.GoalNear(Math.floor(threat.position.x),Math.floor(threat.position.y),Math.floor(threat.position.z),2);
 if(contact){
  // Native nodes are block centers, while reach is eye-to-entity-hitbox.
  // A fixed radius around floored mob coordinates can demand a fourth meter
  // even when a valid strike stance exists inside the original three meters.
  const stances=[],from=bot.entity.position.floored();
  for(let dx=-3;dx<=3;dx++)for(let dz=-3;dz<=3;dz++)for(let dy=-1;dy<=1;dy++){
   const p=from.offset(dx,dy,dz),feet=p.offset(.5,0,.5);
   if(Math.hypot(feet.x-origin.x,feet.z-origin.z)>horizontalLimit+.001||Math.abs(p.y-origin.y)>verticalLimit
     ||!naturalWalkingFoot(bot,p)||meleeReachDistance({position:feet,eyeHeight:bot.entity.eyeHeight||1.62},threat)>2.25)continue;
   stances.push(new goals.GoalBlock(p.x,p.y,p.z));
  }
  if(!stances.length)return false;
  goal=new goals.GoalCompositeAny(stances);Object.assign(goal,{x:Math.floor(threat.position.x),y:Math.floor(threat.position.y),z:Math.floor(threat.position.z)});
 }
 const probeBudget=contact?100:Math.max(1,Math.min(500,deadline-Date.now()));
 const began=Date.now(),stepCosts=profile.exclusionAreasStep;
 // Native pathfinding accepts chest lids and other fractional supports that
 // the checked cardinal executor cannot stand on. Exclude them during native
 // planning so a valid route around owned furniture can be found instead.
 // This only narrows the captured owner's existing movement profile.
 const checkedFoot=block=>{
  active();if(!block?.position)return Infinity;
  // The native cost callback also receives head-clearance cells. Air below
  // such a cell is not a floor; reject only an actual fractional solid below.
  const below=bot.blockAt(block.position.offset(0,-1,0));
  return below?.boundingBox==='block'&&below.shapes?.length
    &&!below.shapes.some(shape=>shape.length===6&&shape.every((n,i)=>n===(i<3?0:1)))?Infinity:0;
 };
 stepCosts.push(checkedFoot);
 let plan;
 try{
  const iterator=bot.pathfinder.getPathFromTo(profile,bot.entity.position,goal,{optimizePath:false,timeout:probeBudget,tickTimeout:10});
  for(let i=0;i<(contact?10:50)&&Date.now()-began<=probeBudget;i++){
   active();const next=iterator.next();plan=next.value?.result;if(next.done||plan?.status!=='partial')break;
   // Yield between finite native slices so hurt/pause/new-threat observations
   // remain actionable while a complicated ranged route is still UNKNOWN.
   if(!contact)await new Promise(resolve=>setTimeout(resolve,0));
  }
 }finally{const index=stepCosts.indexOf(checkedFoot);if(index>=0)stepCosts.splice(index,1);}
 active();
 deps.onPlan?.({status:plan?.status||null,pathCount:plan?.path?.length||0,elapsedMs:Date.now()-began,
  origin:{...origin},goal:{x:goal.x,y:goal.y,z:goal.z},path:(plan?.path||[]).slice(0,32).map(p=>({x:p.x,y:p.y,z:p.z})),actualMovementConfirmed:false});
 if(Date.now()-began>probeBudget||plan?.status!=='success'||!Array.isArray(plan.path)||plan.path.length>pathLimit)return false;
 if(plan.path.some(p=>p.toBreak?.length||p.toPlace?.length||!naturalWalkingFoot(bot,p)||Math.abs(p.y-origin.y)>verticalLimit
   ||Math.hypot(p.x+.5-origin.x,p.z+.5-origin.z)>horizontalLimit))return false;
 const nav=createMiningNavigator({getBot:()=>bot,assertActive:active,preserveMovements:true,allowLeafSupport:true,allowStableGravitySupport:true,maxActions:48,
   movementTimeoutMs:Math.max(1000,Math.min(5000,deadline-Date.now())),
   goto:goal=>deps.goto(goal,Math.max(1,Math.min(5000,deadline-Date.now()))),
   digBlock:async()=>{throw Object.assign(Error('自卫接近不能挖掘'),{code:'house_surface_ranged_obstructed'});}});
 for(const point of plan.path){
  active();if(bot.entity.position.distanceTo(threat.position)<=3)return true;
  const from=bot.entity.position.floored(),dx=point.x-from.x,dz=point.z-from.z,dy=point.y-from.y;
  if(!dx&&!dz&&!dy)continue;
  if(Math.abs(dx)+Math.abs(dz)!==1||Math.abs(dy)>1)return false;
  try { await nav.advance({x:dx,z:dz},{ascend:dy===1,descend:dy===-1}); }
  catch(error){
   active();
   // A rejected approach is not a failed fight. Keep the actual dry stance
   // and let the original combat owner reassess contact or cover. Never
   // suppress a pause, ownership loss, wet body or unconfirmed landing.
   // A native-supported body can straddle a ledge after knockback even when
   // its floored center is not itself a valid navigation node. Holding that
   // actual stance grants no step or arrival credit.
   if(['MINING_FLUID','MINING_NO_SUPPORT','MINING_OBSTRUCTED','MINING_GRAVITY'].includes(error.code)
     &&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry){
    deps.onPlan?.({status:'checked_route_rejected',code:error.code,actualMovementConfirmed:false,
      actual:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z}});
    return false;
   }
   throw error;
  }
  active();
  deps.onStep?.({position:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},moves:nav.getState().moves});
 }
 return nav.getState().moves>0;
}
module.exports={approachHouseMelee,approachHouseRanged};
