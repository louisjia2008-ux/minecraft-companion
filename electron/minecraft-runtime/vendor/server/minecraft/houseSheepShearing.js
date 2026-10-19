'use strict';
const {houseMaterialAnimalAllowed}=require('./houseResourceGatherer');
const fail=(code,message)=>Object.assign(new Error(message),{code});
async function shearHouseSheep(deps,target){
 const bot=deps.getBot(),client=bot._client,deadline=Date.now()+30000;
 const active=()=>{deps.assertActive();if(deps.getBot()!==bot||bot._client!==client)throw fail('movement_preempted','剪毛连接归属改变');
  if(Date.now()>=deadline)throw fail('house_shearing_timeout','剪毛达到本轮时限');};
 const live=()=>bot.entities[target.id];
 const allowed=()=>houseMaterialAnimalAllowed(bot,live(),'white_wool',deps.safeFoot);
 active();if(!allowed())throw fail('house_shearing_target_changed','白羊状态未确认');
 await deps.approach(live(),Math.max(1,deadline-Date.now()));active();
 if(!allowed()||bot.entity.position.distanceTo(live().position)>3.2)throw fail('house_shearing_out_of_reach','没有实际到达白羊身边');
 await deps.equip();active();if(bot.heldItem?.name!=='shears')throw fail('house_shearing_tool_missing','剪刀没有实际装备');
 const before=deps.count(),position=live().position.clone();
 await deps.activate(live());active();
 const confirmBy=Math.min(deadline,Date.now()+2500),woolIndex=bot.registry.entitiesByName.sheep.metadataKeys.indexOf('wool');
 while(!(Number.isInteger(live()?.metadata?.[woolIndex])&&(live().metadata[woolIndex]&16)!==0)){
  active();if(!live()||live().isValid===false||Date.now()>=confirmBy)throw fail('house_shearing_unconfirmed','服务器尚未确认白羊已剪毛');
  await deps.sleep(50);
 }
 await deps.collect(position);active();
 const acquired=deps.count()-before;
 if(acquired<=0)throw fail('house_shearing_no_pickup','白羊已剪毛但尚未拾取羊毛');
 return {acquired,sheared:true,entityId:target.id};
}
module.exports={shearHouseSheep};
