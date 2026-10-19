'use strict';
const ordinary=new Set(['zombie','husk','drowned','spider']);
const weapons=new Set(['stone_sword','iron_sword','diamond_sword','netherite_sword','stone_axe','iron_axe','diamond_axe','netherite_axe']);
function usable(bot,item){
 const maximum=bot.registry?.items?.[item?.type]?.maxDurability,damage=Number(item?.durabilityUsed||0);
 return item?.count===1&&Number.isFinite(maximum)&&Number.isFinite(damage)&&damage>=0&&maximum-damage>16;
}
// A small ordinary melee pair is different from a mixed group or creeper.
// Actual worn armor and offhand shield are required; backpack gear grants no
// protection. Navigation, attack cooldown and the original owner/deadline stay.
function canPressMeleePair(bot,target,threats,{exposedRanged=()=>false}={}){
 const p=bot.entity?.position,chest=bot.inventory?.slots?.[6],shield=bot.inventory?.slots?.[45];
 if(!p||!(bot.health>=14)||!(bot.food>=8)||bot.entity.onGround!==true
   ||bot.entity.isInWater!==false||bot.entity.isInLava!==false
   ||!['iron_chestplate','diamond_chestplate','netherite_chestplate'].includes(chest?.name)||!usable(bot,chest)
   ||shield?.name!=='shield'||!usable(bot,shield)||!bot.inventory.items().some(i=>weapons.has(i.name)&&usable(bot,i)))return false;
 if(!Array.isArray(threats)||threats.length!==2||!threats.includes(target))return false;
 if(!threats.every(e=>e.isValid!==false&&ordinary.has(e.name)&&e.position
   &&Math.abs(e.position.y-p.y)<=1.35&&Math.hypot(e.position.x-p.x,e.position.y-p.y,e.position.z-p.z)<=8.5))return false;
 const distance=e=>Math.hypot(e.position.x-p.x,e.position.y-p.y,e.position.z-p.z);
 if(distance(target)>6.5)return false;
 const [a,b]=threats.map(e=>({x:e.position.x-p.x,z:e.position.z-p.z}));
 if(a.x*b.x+a.z*b.z<0)return false; // Opposite sides cannot share one shield facing.
 try{return exposedRanged()===false;}catch{return false;}
}
module.exports={canPressMeleePair};
