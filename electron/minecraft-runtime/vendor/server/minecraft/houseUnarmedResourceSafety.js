'use strict';
const {isThreateningMobEntity,getObservedEntityHealth}=require('./entitySemantics');
const {isHouseRangedThreatEntity}=require('./houseRangedCover');
// A hand-cut log takes longer than one walking step. Do not choose a work
// target inside observed attack/acquisition envelopes before tools exist.
function unarmedResourceTargetSafe(bot,position){
 if(!position||!bot?.entity?.position)return false;
 return Object.values(bot.entities||{}).every(e=>{
  if(e===bot.entity||!e?.position||e.isValid===false||!isThreateningMobEntity(e,bot.registry)
    ||getObservedEntityHealth(e,bot.registry)===0||Math.abs(e.position.y-bot.entity.position.y)>=8)return true;
  const radius=isHouseRangedThreatEntity(e)?24:e.name==='creeper'?17:12;
  return Math.hypot(position.x+.5-e.position.x,position.z+.5-e.position.z)>=radius;
 });
}
module.exports={unarmedResourceTargetSafe};
