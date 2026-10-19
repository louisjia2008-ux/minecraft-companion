'use strict';
// Read native physics observations only. This neither grants arrival/material
// credit nor alters the task's absolute watchdog deadline.
function createHouseTaskNativeMotion(deps,frame){
 const {bot,task,client,token,lease,generation}=frame;let previous=null,lastAt=0,closed=false;
 const same=()=>!closed&&deps.getBot()===bot&&bot._client===client&&deps.getTask()===task
  &&task.status==='running'&&task.executionGeneration===generation&&task.cancellationToken===token
  &&task.movementLease===lease&&!token?.cancelled&&!token?.pauseRequested;
 const ownedDefense=()=>{
  const d=deps.getDefense();return Boolean(same()&&d&&!d.finished&&d.bot===bot&&d.client===client&&d.task===task
   &&d.runGeneration===generation&&(d.workToken||d.token)===token&&d.previousLease===lease
   &&Number.isFinite(d.deadline)&&Date.now()<d.deadline&&deps.isDefenseCurrent(d)&&deps.isLeaseActive(d.lease));
 };
 const allowed=()=>same()&&(deps.isLeaseActive(lease)||ownedDefense());
 const tick=()=>{
  if(!allowed()){previous=null;return;}
  const p=bot.entity?.position;if(!p||!['x','y','z'].every(k=>Number.isFinite(p[k]))){previous=null;return;}
  if(previous){const delta=Math.hypot(p.x-previous.x,p.y-previous.y,p.z-previous.z);if(delta>=.005&&delta<=1.75)lastAt=Date.now();}
  previous={x:p.x,y:p.y,z:p.z};
 };
 bot.on('physicsTick',tick);
 return {lastObservedAt:()=>lastAt,ownedDefense,close:()=>{closed=true;bot.removeListener('physicsTick',tick);}};
}
module.exports={createHouseTaskNativeMotion};
