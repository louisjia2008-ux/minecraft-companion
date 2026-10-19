'use strict';
const {combatCover}=require('./houseCombatMode');
const {shouldInterruptWorkForRanged}=require('./houseRangedCombat');
const {rangedCoverConfirmed}=require('./houseRangedCover');
const key=p=>`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
function naturalTerrainSeparatesMelee(bot,target,material,{recentDamage=false}={}){
 if(recentDamage||!target?.position||target.isValid===false
   ||!['creeper','zombie','husk','drowned','spider','cave_spider'].includes(target.name)
   ||target.position.distanceTo(bot.entity.position)<=3)return false;
 if(target.name==='creeper'){
  const keys=bot.registry?.entitiesByName?.creeper?.metadataKeys||[],metadata=target.metadata;
  if(bot.version!=='1.21.8'||!metadata||!['is_ignited','is_powered','swell_dir'].every(name=>keys.indexOf(name)>=0))return false;
  if(!['is_ignited','is_powered'].every(name=>[undefined,false,0].includes(metadata[keys.indexOf(name)]))
    ||![undefined,-1].includes(metadata[keys.indexOf('swell_dir')]))return false;
 }
 const temporary=new Set(combatCover(material).map(s=>key(s.position)));
 const natural=require('./houseNaturalTerrain').isNaturalHouseTerrain;
 const terrain={blockAt:p=>{const b=bot.blockAt(p);return !b?b:temporary.has(key(p))||!natural(b.name)?{position:b.position,shapes:[]}:b;}};
 return rangedCoverConfirmed(terrain,bot.entity.position,[target]);
}
function isCombatCleanupThreat(bot,target,material,{ranged=false,recentDamage=false}={}){
 if(!target?.position||target.isValid===false)return false;
 const distance=target.position.distanceTo(bot.entity.position),height=Math.abs(target.position.y-bot.entity.position.y);
 if(!ranged)return height<4&&distance<=(target.name==='creeper'?8.5:4.5)&&!naturalTerrainSeparatesMelee(bot,target,material,{recentDamage});
 if(height>8&&!recentDamage||!shouldInterruptWorkForRanged(bot,target,recentDamage))return false;
 // A fresh hit disproves the static ray snapshot: preserve protection until
 // the existing damage window expires or combat resolves.
 if(recentDamage&&distance<=24)return true;
 // Count real terrain as cover, but never rely on a temporary block that this
 // cleanup is about to remove. Unknown collision geometry cannot prove cover.
 const temporary=new Set(combatCover(material).map(s=>key(s.position)));
 const terrain={blockAt:p=>{const block=bot.blockAt(p);return block&&temporary.has(key(p))?{position:block.position,shapes:[]}:block;}};
 return !rangedCoverConfirmed(terrain,bot.entity.position,[target]);
}
module.exports={isCombatCleanupThreat,naturalTerrainSeparatesMelee};
