'use strict';
const recoverable=new Set(['house_creeper_escape_no_path','house_creeper_escape_approaching','house_creeper_escape_braking_timeout',
 'house_creeper_escape_braking_unconfirmed','house_creeper_escape_airshaft','house_creeper_escape_unconfirmed','house_creeper_escape_path_changed','house_surface_defense_threat_remaining',
 'house_surface_defense_unconfirmed','house_surface_defense_ground_unconfirmed','house_ranged_cover_unavailable','house_dry_graph_survival_limit']);
function selfGatheredHouseWork(task){
 if(task?.materialSupply?.materialSource==='self_gathered')return true;
 const steps=task?.plan?.steps;
 return Boolean(task?.intent==='build_furnished_house'&&(task.startupWood?.schema===1||task.siteSearch?.kind==='loaded_natural_house_site_search')
  &&Array.isArray(steps)&&steps.length&&steps.every(s=>s.skill==='build_furnished_house_phase'&&s.args?.materialSource==='self_gathered'));
}
function armHouseRecovery(task,code,now){
 const canonical=String(code||'').replace(/^house_surface_creeper_escape_/,'house_creeper_escape_');
 if(!selfGatheredHouseWork(task)||!recoverable.has(canonical))return null;
 const attempts=task.automaticWorkRecovery?.attempts||0;
 if(attempts>=8)return null;
 return {enabled:true,attempts,code,armedAt:now,deadline:now+120000,nextAllowedAt:now+1000};
}
function houseRecoveryDecision(recovery,facts){
 if(!recovery?.enabled)return 'disabled';
 if(!Number.isSafeInteger(recovery.attempts)||recovery.attempts<0||recovery.attempts>=8
  ||!Number.isSafeInteger(recovery.armedAt)||recovery.deadline!==recovery.armedAt+120000
  ||recovery.nextAllowedAt!==recovery.armedAt+1000||!Number.isFinite(facts.now)||facts.now>=recovery.deadline)return 'expired';
 if(!facts.ownerCurrent)return 'foreign';
 if(facts.now<recovery.nextAllowedAt||!Number.isFinite(facts.health)||!Number.isFinite(facts.food)
  ||facts.grounded!==true||facts.dry!==true||facts.goalActive!==false||facts.controlsActive!==false||facts.threatPresent!==false)return 'waiting';
 if(facts.health>=16&&facts.food>=14)return 'ready';
 if(facts.provisionInOriginalTask===true&&facts.health>0&&facts.health<6&&facts.food>=8&&facts.food<18
   &&facts.carriedEmergencyMeal===true)return 'provision';
 if(facts.provisionInOriginalTask===true&&facts.health>=6&&facts.food>=8)return 'provision';
 return 'waiting';
}
module.exports={selfGatheredHouseWork,armHouseRecovery,houseRecoveryDecision};
