'use strict';
// Player reach is eye-to-hitbox distance, not feet-to-feet distance. In
// particular a jumping spider can be hittable while its feet exceed 3m.
function meleeReachDistance(player,target){
 const p=player?.position,t=target?.position,w=target?.width??.6,h=target?.height??1.8,eye=player?.eyeHeight??1.62;
 if(![p?.x,p?.y,p?.z,t?.x,t?.y,t?.z,w,h,eye].every(Number.isFinite)||w<=0||w>4||h<=0||h>12||eye<=0||eye>2)return Infinity;
 const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
 return Math.hypot(p.x-clamp(p.x,t.x-w/2,t.x+w/2),p.y+eye-clamp(p.y+eye,t.y,t.y+h),p.z-clamp(p.z,t.z-w/2,t.z+w/2));
}
// All contact-defense paths share the timestamp of the actual packet.
// Publishing progress after a hit must not start a second full cooldown.
function meleeAttackReadyAt(lastSentAt,weaponName){
 const ordinaryHand=!weaponName||!/(?:_sword|_axe|_pickaxe|_shovel|_hoe)$/.test(weaponName)&&!['trident','mace'].includes(weaponName);
 // Native empty/non-tool hand attack_speed is4: allow its250ms cooldown
 // plus10ms margin; keep the existing sword/axe timing unchanged.
 return Math.max(0,Number(lastSentAt)||0)+(ordinaryHand?260:weaponName.endsWith("_axe")?1100:650);
}
// Knockback lasts less than a swing cycle. Retain a recently hit reachable
// opponent unless a different mob is already at immediate contact distance.
// Creeper/ranged prioritization is handled independently by the caller.
function retainMeleeTargetAfterKnockback(player,target,other,memory,now=Date.now()){
 return memory?.lastOwnAttackTargetId===target?.id
  &&now-Number(memory.lastOwnAttackAt)>=0&&now-Number(memory.lastOwnAttackAt)<1000
  &&meleeReachDistance(player,target)<=4.5&&meleeReachDistance(player,other)>1.5;
}
module.exports={meleeReachDistance,meleeAttackReadyAt,retainMeleeTargetAfterKnockback};
