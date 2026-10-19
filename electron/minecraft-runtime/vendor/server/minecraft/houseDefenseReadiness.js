'use strict';
const {getHouseShield}=require('./houseShieldState');
// Ordering only: a mostly armored survivor may finish a previously built
// shelter before replacing every iron item. This never completes kit acceptance.
function canFinishShelterBeforeIronUpgrade(bot,{phase,roofComplete}={}){
 if(!['furniture','finish'].includes(phase)||!roofComplete||bot.health<12||bot.food<12||!getHouseShield(bot))return false;
 const usable=i=>{const max=bot.registry.items[i?.type]?.maxDurability;return i&&Number.isFinite(max)&&max-Number(i.durabilityUsed||0)>8;};
 if(!bot.inventory.items().some(i=>/^(stone|iron|diamond|netherite)_(sword|axe)$/.test(i.name)&&usable(i)))return false;
 return [6,7].every(slot=>{const i=bot.inventory.slots[slot];return /^(iron|diamond|netherite)_(chestplate|leggings)$/.test(i?.name||'')&&usable(i);});
}
module.exports={canFinishShelterBeforeIronUpgrade};
