'use strict';
const {Vec3}=require('vec3');
const noPath=message=>Object.assign(Error(message),{name:'NoPath',code:'NoPath'});
// Installed pathfinder2.4.5 goto resolves on *any* empty path_update, including
// an initial partial. Leave its original goal/physics running; await its real
// outcome within the captured action budget, without issuing another motor write.
async function settleNativeGoto(deps,{goal,deadline}={}){
 const bot=deps.getBot(),profile=bot.pathfinder.movements;let emptyPartial=false,lastStatus=null,reached=false,lastEndpoint=null,timeoutEndpoint=false;
 const onPath=r=>{if(bot.pathfinder.goal!==goal)return;lastStatus=r?.status;const p=Array.isArray(r?.path)?r.path.at(-1):null;lastEndpoint=p&&['x','y','z'].every(k=>Number.isFinite(p[k]))?new Vec3(p.x,p.y,p.z).floored():null;if(r?.status==='partial'&&Array.isArray(r.path)&&r.path.length===0)emptyPartial=true;};
 const onReached=g=>{if(g===goal)reached=true;};
 bot.on('path_update',onPath);bot.on('goal_reached',onReached);
 try{
  deps.assertActive();let result;
  try{result=await bot.pathfinder.goto(goal);}
  catch(error){
   // A captured guarded graph already proved this same native leg. Vanilla
   // can label its final complete endpoint timeout after spending its search
   // budget while still following that path. This grants no arrival credit.
   deps.assertActive();
   if(error.name!=='Timeout'||deps.allowPendingTimeout?.()!==true||lastStatus!=='timeout'||!lastEndpoint||goal.isEnd?.(lastEndpoint)!==true)throw error;
   timeoutEndpoint=true;
  }
  deps.assertActive();
  if(deps.isExpectedStop?.()===true||!emptyPartial&&!timeoutEndpoint||goal.isEnd?.(bot.entity.position.floored()))return result;
  const started=Date.now();
  while(!goal.isEnd?.(bot.entity.position.floored())){
   deps.assertActive();
   if(deps.getBot()!==bot||bot.pathfinder.movements!==profile||bot.pathfinder.goal!==goal&&!(reached&&bot.pathfinder.goal===null))
    throw Object.assign(Error('Original native goal or profile changed during pending path'),{name:'GoalChanged',code:'movement_preempted'});
   if(deps.isExpectedStop?.()===true)return result;
   if(lastStatus==='noPath')throw noPath('No original native path to the goal');
   if(lastStatus==='timeout'&&!(timeoutEndpoint&&lastEndpoint&&goal.isEnd?.(lastEndpoint)===true&&deps.allowPendingTimeout?.()===true))throw Object.assign(Error('Native planning timed out'),{name:'Timeout',code:'Timeout'});
   if(!Number.isFinite(deadline)||Date.now()>=deadline)throw Object.assign(Error('Original native action deadline expired'),{code:'step_timeout'});
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  deps.assertActive();deps.record?.({waitedMs:Date.now()-started,initialEmptyPartial:emptyPartial,nativeTimeoutWithGoalEndpoint:timeoutEndpoint,lastStatus,actualArrivalConfirmed:true});return result;
 }finally{bot.removeListener('path_update',onPath);bot.removeListener('goal_reached',onReached);}
}
module.exports={settleNativeGoto};
