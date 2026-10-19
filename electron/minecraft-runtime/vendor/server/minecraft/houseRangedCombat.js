'use strict';
const { isThreateningMobEntity, getObservedEntityHealth } = require('./entitySemantics');
// Press a known ranged attacker while a real weapon, shield and remaining
// health support it. Damage alone is not a reason to turn our back at 16HP.
function hasEngagementBudget(bot, distance, target) {
  if (!(bot.health > 0)) return false;
  const items = bot.inventory.items();
  if (!items.some(item => /_(sword|axe)$/.test(item.name))) return false;
  if (distance <= 3) return true;
  const origin = bot.entity?.position;
  const others = origin && target?.position ? Object.values(bot.entities || {}).filter(entity => entity !== bot.entity && entity !== target
    && entity?.position && entity.isValid !== false && isThreateningMobEntity(entity, bot.registry) && getObservedEntityHealth(entity, bot.registry) !== 0
    && Math.abs(entity.position.y - origin.y) <= 6 && (entity.position.distanceTo(origin) <= 8.5 || entity.position.distanceTo(target.position) <= 8)) : [];
  const torso = bot.inventory.slots[6], maximumTorso = torso && bot.registry.items[torso.type]?.maxDurability;
  const protectedTorso = ['iron_chestplate','diamond_chestplate','netherite_chestplate'].includes(torso?.name)
    && Number.isFinite(maximumTorso) && maximumTorso - Number(torso.durabilityUsed || 0) > 16;
  // A usable shield covers one facing, not two archers and approaching melee.
  // Worn protection is required for a mixed pair; a larger observed group
  // requires cover even with armor. Contact retaliation remains immediate.
  if (others.length >= 2 || others.length >= 1 && !protectedTorso) return false;
  // Shields do not justify a low-health charge into splash potions.
  if(target?.name==='witch')return distance<=8?bot.health>=12:distance<=24&&bot.health>=16;
  const shield = bot.inventory.slots[45];
  const maximum = shield && bot.registry.items[shield.type]?.maxDurability;
  const shieldUsable = shield?.name === 'shield' && Number.isFinite(maximum) && maximum - Number(shield.durabilityUsed || 0) > 8;
  if (shieldUsable) return distance <= 8 ? bot.health > 6 : distance <= 24 && bot.health >= 12;
  // A bare survivor at13HP lost5HP before contact in world58 run114.
  // Preserve room for an actual arrow during approach and another during
  // withdrawal; owning a sword alone does not supply shield/torso protection.
  // Immediate contact retaliation was admitted above, before this gate.
  if(!protectedTorso)return distance<=8?bot.health>=16:distance<=24&&bot.health>=18;
  return distance <= 8 ? bot.health >= 10 : distance <= 24 && bot.health >= 14;
}
function shouldPressHouseRanged(bot,target){
  return Boolean(target?.position&&target.isValid!==false&&hasEngagementBudget(bot,bot.entity.position.distanceTo(target.position),target));
}
function shouldAvoidHouseRangedThreat(bot,target){
  // Ordinary work outside detection range must still respect the same combat
  // budget as the interrupt. Owning a wooden sword does not cure critical HP.
  return Boolean(target?.position&&target.isValid!==false&&!hasEngagementBudget(bot,Math.min(24,bot.entity.position.distanceTo(target.position)),target));
}
function shouldInterruptWorkForRanged(bot,target,recentDamage=false){
 if(!target?.position||target.isValid===false)return false;
 const distance=bot.entity.position.distanceTo(target.position);
 // Perception remains24m. A distant observed mob is not automatically a
 // reason to abandon work; actual new damage always enables the response.
 return distance<=24&&(recentDamage||distance<=8.5||distance<=16&&shouldPressHouseRanged(bot,target));
}
module.exports = { shouldPressHouseRanged,shouldAvoidHouseRangedThreat,shouldInterruptWorkForRanged };
