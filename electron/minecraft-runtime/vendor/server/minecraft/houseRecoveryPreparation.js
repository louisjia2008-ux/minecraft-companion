'use strict';
const failure=(code,message)=>Object.assign(new Error(message),{code});
// Passive recovery uses only carried food and observed natural health changes.
// No navigation, resource search, health writes or unbounded waiting.
async function prepareHouseRecovery(deps){
 const now=deps.now||Date.now,wait=deps.wait||((ms)=>new Promise(resolve=>setTimeout(resolve,ms)));
 deps.assertActive();let state=deps.observe();
 if(!Number.isFinite(state.health)||!Number.isFinite(state.food)||state.health<=0)throw failure('house_recovery_unknown','没有可恢复的实际生命和饥饿状态');
 const targetHealth=deps.targetHealth===undefined?18:deps.targetHealth;
 if(!Number.isFinite(targetHealth)||targetHealth<1||targetHealth>20)throw failure('house_recovery_target','无效的回血目标');
 if(state.health>=targetHealth)return {recovered:false,health:state.health};
 const deadline=now()+60000,initialHealth=state.health;let damageDefenses=0;
 while(state.health<targetHealth){
  deps.assertActive();
  if(state.threat&&typeof deps.defend==='function'){await deps.defend();deps.assertActive();state=deps.observe();}
  if(!state.safe||state.threat&&!state.blocking&&!state.covered)throw failure('house_recovery_unsafe','当前位置不适合停留回血');
  if(now()>=deadline)throw failure('house_recovery_timeout','自然回血未在一分钟内恢复到可返营状态');
  if(!state.blocking&&state.food<20&&deps.hasFood()){
   await deps.eat();deps.assertActive();state=deps.observe();
  }
  if(state.food<18){
   const requested=deps.provisionMinimumHealth?.(),minimum=Number.isFinite(requested)&&requested>0&&requested<=14?requested:14;
   if(state.safe&&!state.threat&&state.health>=minimum&&deps.canProvision?.())return {recovered:false,needsProvision:true,health:state.health,food:state.food};
   throw failure('house_recovery_food_missing','现有口粮不足以支持自然回血');
  }
  await wait(250);deps.assertActive();const next=deps.observe();
  if(next.health<state.health){
   if(damageDefenses>=8||typeof deps.defend!=='function'||await deps.defend()!==true)
    throw failure('house_recovery_damage','回血期间受到伤害，停止等待');
   damageDefenses++;deps.assertActive();state=deps.observe();
   if(!Number.isFinite(state.health)||state.health<=0||!state.safe||state.threat)
    throw failure('house_recovery_unsafe','自卫后尚未实际确认安全回血站位');
   deps.onDefenseResumed?.({health:state.health,food:state.food,originalDeadline:deadline,damageDefenses});
   continue;
  }
  if(next.health>state.health)deps.onProgress?.({health:next.health,food:next.food});
  state=next;
 }
 return {recovered:true,initialHealth,health:state.health,food:state.food};
}
module.exports={prepareHouseRecovery};
