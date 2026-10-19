'use strict';
// A worn offhand item is not a backpack ingredient. Near-broken shields must
// be replaced before another expedition, using real crafting and readback.
function shieldUsable(bot,item,minDurability){
 if(item?.name!=='shield'||!(item.count>0))return false;
 const maximum=bot.registry?.items?.[item.type]?.maxDurability;
 return !Number.isFinite(maximum)||maximum-Number(item.durabilityUsed||0)>minDurability;
}
function getHouseShield(bot,minDurability=8){
 if(!Number.isSafeInteger(minDurability)||minDurability<0||minDurability>64)throw TypeError('Finite shield reserve required');
 const offhand=bot.inventory?.slots?.[45];
 if(shieldUsable(bot,offhand,minDurability))return{item:offhand,equipped:true};
 const item=bot.inventory?.items?.().find(i=>shieldUsable(bot,i,minDurability));
 return item?{item,equipped:false}:null;
}
function shieldCraftTarget(bot){return (bot.inventory?.items?.()||[]).filter(i=>i.name==='shield').reduce((n,i)=>n+i.count,0)+1;}
module.exports={getHouseShield,shieldCraftTarget};
