'use strict';
async function prepareHouseDefense(deps){
 deps.assertActive();const reused=deps.getOffhand()?.name==='shield';
 if(!reused){await deps.ensure({shield:1});deps.assertActive();const shield=deps.findShield();
  if(!shield)throw Object.assign(Error('未确认自制盾牌产出'),{code:'house_defense_shield_missing'});
  await deps.equip(shield,'off-hand');deps.assertActive();}
 if(deps.getOffhand()?.name!=='shield')throw Object.assign(Error('盾牌尚未实际装备到副手'),{code:'house_defense_shield_not_equipped'});
 const result={shieldEquipped:true,reused};
 if(typeof deps.getTorso==='function'){
  const hasArmor=()=>Boolean(deps.getTorso()?.name?.endsWith('_chestplate'));
  if(!hasArmor()){
   await deps.ensure({iron_chestplate:1});deps.assertActive();const armor=deps.findTorso();
   if(!armor)throw Object.assign(Error('未确认自制胸甲产出'),{code:'house_defense_armor_missing'});
   await deps.equip(armor,'torso');deps.assertActive();
   if(!hasArmor())throw Object.assign(Error('胸甲尚未实际装备'),{code:'house_defense_armor_not_equipped'});
  }
  result.armorEquipped=true;result.armor=deps.getTorso().name;
 }
 return result;
}
module.exports={prepareHouseDefense};
