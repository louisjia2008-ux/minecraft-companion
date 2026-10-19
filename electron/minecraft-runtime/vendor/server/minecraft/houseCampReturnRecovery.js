'use strict';
function isCampReturnRouteFailure(error){
 const code=String(error?.code||error?.name||'');
 if(/paused|cancelled|preempted|owner|connection/i.test(code))return false;
 return ['NoPath','no_path','executor_stalled','Timeout','path_timeout'].includes(code)
  ||!error?.code&&error?.message==='自给采集返回固定营地超时';
}
// Divide one finite return budget among real native attempts and guarded local
// alternatives. The caller still verifies actual grounded camp arrival.
async function returnCampWithLocalRecovery(deps,{deadline,nativeTimeoutMs=8000,maxRecoveries=4}={}){
 if(!Number.isFinite(deadline)||!Number.isSafeInteger(nativeTimeoutMs)||nativeTimeoutMs<=0||!Number.isSafeInteger(maxRecoveries)||maxRecoveries<0||maxRecoveries>4)throw TypeError('Finite camp return budget required');
 const now=deps.now||Date.now,origins=new Set();
 for(let recoveryCount=0;;recoveryCount++){
  deps.assertActive();const origin=deps.positionKey();
  if(now()>=deadline)throw Object.assign(Error('自给采集返回固定营地超时'),{code:'house_camp_return_timeout'});
  try{return await deps.native(Math.max(1,Math.min(nativeTimeoutMs,deadline-now())));}
  catch(error){
   deps.assertActive();
   if(recoveryCount>=maxRecoveries||origins.has(origin)||now()>=deadline||!isCampReturnRouteFailure(error))throw error;
   if(await deps.recover(deadline)!==true)throw error;
   deps.assertActive();if(now()>=deadline)throw error;origins.add(origin);
  }
 }
}
module.exports={isCampReturnRouteFailure,returnCampWithLocalRecovery};
