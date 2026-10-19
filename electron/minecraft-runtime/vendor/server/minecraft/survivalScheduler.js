'use strict';
// Observations may run concurrently. Body actions run at cooperative boundaries;
// urgent defense keeps using the engine's existing revocable movement lease.
const {FOOD_ITEM_PRIORITY}=require('./taskCatalog');
function selectBootstrapFood(items,{health,food}){
 if(!Number.isFinite(health)||health<=0||!Number.isFinite(food)||!Array.isArray(items))return null;
 for(const name of [...FOOD_ITEM_PRIORITY,'rabbit','mutton']){const item=items.find(i=>i?.name===name&&i.count>0);if(item)return item;}
 if((health<20&&food<18)||food<8){
  for(const name of ['chicken','rotten_flesh']){const item=items.find(i=>i?.name===name&&i.count>0);if(item)return item;}
 }
 return null;
}
function surfaceReserveTarget({health,food,requestedPoints,maintenance}) {
  return maintenance===true&&requestedPoints===8&&health>=6&&food>=8?4:requestedPoints;
}
// Empty-handed survivors need nearby prerequisites at partial health too.
// This chooses a strategy; each physical resource leg retains threat/hazard guards.
function shouldBootstrapField(s){
 return Number.isFinite(s.health)&&s.health>0&&Number.isFinite(s.food)&&s.food>=8
  &&Number.isFinite(s.campDistance)&&s.campDistance>32&&!s.hasWeapon&&!s.hasPick&&s.ownedBootstrapStockHint!==true
  &&s.grounded===true&&s.dryFoot===true;
}
async function restoreLocalSurvivalMeal(deps){
 deps.assertActive();const before=deps.observe();
 const carriedEmergency=before.hasEmergencyMeal===true;
 if(before.maintenance!==true||before.hasWeapon&&!carriedEmergency||before.health<=0
   ||before.health>=(carriedEmergency?14:10)||before.food>=18)return null;
 await deps.acquireAndEat();deps.assertActive();const after=deps.observe();
 if(!Number.isFinite(after.food)||after.food<18||!Number.isFinite(after.health)||after.health<=0)
  throw Object.assign(Error('Local survival meal was not actually confirmed'),{code:'house_local_meal_unconfirmed'});
 // Consumed food restores hunger; it does not fulfill a spare-food contract.
 return {localMealConfirmed:true,food:after.food,health:after.health,reserveConfirmed:false};
}
function selectSurvivalJob(s) {
  if (!s || !Number.isFinite(s.health) || s.health<=0 || !Number.isFinite(s.food)) return 'unavailable';
  if (s.threat) return 'defend';
  if (!s.safe) return 'foreground'; // Never begin a meal/rest/search midair or underwater.
  if (s.hasMeal && (s.food<=18 || s.health<20 && s.food<20)) return 'eat';
  if (s.health<14 && s.food>=18) return 'recover';
  // Empty reserves alone never block useful surface work. Deep expeditions
  // retain their separate explicit provisioning contract.
  if (s.canProvision && (s.food<8 || s.health<14 && s.food<18)) return 'provision';
  // A visible nearby food source and an already usable outpost permit a small
  // reserve as part of normal work. Empty reserves alone still do not block it.
  if(s.canProvision&&s.reserveLow&&s.localFoodAvailable)return 'provision';
  return 'foreground';
}
function createSurvivalScheduler(deps) {
  let active=null;
  const observe=()=>({job:selectSurvivalJob(deps.observe()),activeJob:active?.job||null});
  async function runBoundary() {
    deps.assertActive();
    // A second caller must not execute the same body job, nor borrow its context.
    if(active)throw Object.assign(Error('Survival maintenance already owns this boundary'),{code:'survival_boundary_busy'});
    const frame={job:null};active=frame;
    try {
      for(let turn=0;turn<8;turn++) {
        deps.assertActive();const facts=deps.observe(),job=selectSurvivalJob(facts);
        if(job==='foreground')return {ready:true};
        if(job==='unavailable')throw Object.assign(Error('Survival state unavailable'),{code:'survival_state_unavailable'});
        if(typeof deps[job]!=='function')throw Object.assign(Error(`Missing survival action ${job}`),{code:'survival_handler_missing'});
        frame.job=job;deps.record?.('survival_job_started',{job,health:facts.health,food:facts.food});
        await deps[job]();deps.assertActive();
        // Always reobserve; action completion/logs do not prove restored health,
        // a dead enemy, usable food, or a still-current foreground owner.
        deps.record?.('survival_job_finished',{job});
      }
      throw Object.assign(Error('Survival actions made insufficient confirmed progress'),{code:'survival_boundary_limit'});
    } finally {if(active===frame)active=null;}
  }
  return {observe,runBoundary};
}
module.exports={selectSurvivalJob,createSurvivalScheduler,surfaceReserveTarget,shouldBootstrapField,restoreLocalSurvivalMeal,selectBootstrapFood};
