'use strict';
// One controlled strike followed by fresh retreat planning. The game/server
// owns knockback; sending attack is never a displacement or kill receipt.
async function strikeCreeperBeforeRetreat(deps,{deadline}={}){
 const now=deps.now||Date.now,wait=deps.wait||(ms=>new Promise(r=>setTimeout(r,ms)));
 const bot=deps.getBot(),target=deps.getThreat(),origin=bot.entity.position.clone();
 const attackBy=Math.min(deadline-2000,now()+3000);
 while(now()<attackBy){
  deps.assertActive();
  if(deps.getThreat()!==target||target.isValid===false)return {threatGone:true,deathConfirmed:false};
  if(deps.canStrike?.()===false)return {attacked:false,reason:"threat_or_terrain_changed"};
  const distance=bot.entity.position.distanceTo(target.position);
  if(bot.health<=10||bot.entity.position.distanceTo(origin)>.75)return {attacked:false,reason:'stance_or_health_changed'};
  await deps.look(target);
  if(distance<=3){
   if(distance<1.5)return {attacked:false,reason:'too_close_for_deliberate_swing'};
   await deps.equipSword();deps.assertActive();await deps.shield(false);deps.assertActive();
   // Equipment acknowledgement may take time; never attack using stale reach.
   if(bot.health<=10||deps.canStrike?.()===false||deps.getThreat()!==target||bot.entity.position.distanceTo(target.position)>3||now()>=attackBy){await deps.shield(true);return {attacked:false,reason:'reach_or_deadline_changed'};}
   const before=target.position.clone(),stance=bot.entity.position.clone(),axis=before.minus(stance);axis.y=0;
   const length=axis.norm();if(length>0)axis.scale(1/length);
   let hurtObserved=false;const onHurt=entity=>{if(entity===target)hurtObserved=true;};
   bot.on?.('entityHurt',onHurt);
   try{
   await deps.attack(target);deps.assertActive();await deps.shield(true);
   const confirmBy=Math.min(deadline-1000,now()+200);let observed=0;
   while(now()<confirmBy){
    deps.assertActive();
    if(deps.getThreat()!==target||target.isValid===false){deps.record?.('house_creeper_strike_observed',{attackSent:true,threatGone:true,deathConfirmed:false});return {attacked:true,threatGone:true,deathConfirmed:false};}
    observed=target.position.minus(before).dot(axis);
    if(observed>=.15)break;
    await wait(20);
   }
   const result={attacked:true,knockbackObserved:hurtObserved&&observed>=.15,hurtObserved,observedOutwardDisplacement:observed,deathConfirmed:false};
   deps.record?.('house_creeper_strike_observed',result);return result;
   }finally{bot.removeListener?.('entityHurt',onHurt);}
  }
  await wait(25);
 }
 return {attacked:false,reason:'bounded_approach_wait_expired'};
}
// Emergency contact uses the currently held item (including an empty hand).
// It never waits for equipment, a shield or a deliberate approach. The server
// remains the authority for damage/knockback; this is only one attack packet.
async function strikeImmediateCloseCreeper(deps, { deadline } = {}) {
 const bot=deps.getBot(),target=deps.getThreat();
 deps.assertActive();
 if(!Number.isFinite(deadline)||Date.now()>=deadline||!Number.isFinite(bot.health)||bot.health<=0
  ||!target||target.name!=='creeper'||target.isValid===false||!target.position
  ||bot.entity.position.distanceTo(target.position)>3||deps.canStrike()!==true)
  return {attacked:false};
 await deps.attack(target);
 const result={attacked:true,knockbackObserved:false,deathConfirmed:false};
 deps.record?.('house_creeper_emergency_attack_sent',{...result,targetId:target.id,weapon:bot.heldItem?.name||null});
 return result;
}
module.exports={strikeCreeperBeforeRetreat,strikeImmediateCloseCreeper};
