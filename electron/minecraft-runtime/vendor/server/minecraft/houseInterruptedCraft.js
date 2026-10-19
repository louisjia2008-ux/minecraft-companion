'use strict';
// A stopped physical operation may already have produced a native inventory
// ACK. Drain only its captured defense, then inspect output before any retry.
async function craftWithSurvivalRecovery(deps,{target,deadline}){
 let recoveries=0;
 for(;;){
  deps.assertActive();
  if(Date.now()>=deadline)throw Object.assign(Error('营地合成恢复达到有限时限'),{code:'house_craft_recovery_timeout'});
  if(deps.count()>=target)return;
  try {await deps.craft();return;}
  catch(error){
   if(error.code!=='movement_preempted'||recoveries>=4||await deps.resume(error,deadline)!==true)throw error;
   recoveries++;deps.assertActive();
  }
 }
}
module.exports={craftWithSurvivalRecovery};
