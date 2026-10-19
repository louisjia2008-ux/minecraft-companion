'use strict';
const fail=(code,message)=>Object.assign(Error(message),{code});
// Startup acquisition belongs to the original task, before any fixed site or
// camp exists. Carried native inventory is the only completion evidence.
// Three logs yield12 planks: table4, wooden pick3, sticks2, bed3.
// Remaining construction supply is gathered after selecting the actual camp.
async function prepareHousePreSiteWood(deps,{target=3}={}){
 if(!Number.isSafeInteger(target)||target<1||target>8)throw new TypeError('Finite startup wood target required');
 deps.assertActive();const bot=deps.getBot(),client=bot._client;
 const active=()=>{deps.assertActive();if(deps.getBot()!==bot||bot._client!==client)throw fail('house_startup_wood_owner_changed','启动采木期间连接改变');};
 const count=()=>{active();const n=deps.countLogs();if(!Number.isSafeInteger(n)||n<0)throw fail('house_startup_wood_inventory_unknown','启动木材库存未确认');return n;};
 const before=count();deps.save({schema:1,target,startedCount:before,confirmed:false});
 if(before<target){await deps.gather(target-before);active();}
 const after=count();if(after<target)throw fail('house_startup_wood_unconfirmed','启动采木尚未实际入包');
 const record={schema:1,target,startedCount:before,confirmedCount:after,confirmed:true,
  actual:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},requiredReturnToSpawn:false};
 active();deps.save(record);deps.record?.(record);return record;
}
// Ranking grants no digging permission; the normal captured reach/dig guards
// recheck every chosen target. Prefer an actual current view over a far route.
function prioritizeStartupWood(bot,candidates,deps){
 const {firstLoadedResourceShape}=require('./houseResourceVisibility');
 const score=b=>{
  deps.assertActive();if(!deps.standingSafely()||!deps.avoidsSupport(b.position))return 3;
  const first=firstLoadedResourceShape(bot,b,{assertActive:deps.assertActive})?.block;
  if(first?.position.equals(b.position)&&first.stateId===b.stateId&&first.name===b.name)return 0;
  if(first?.name.endsWith('_leaves')&&bot.canDigBlock(first)===true&&deps.avoidsSupport(first.position)&&!deps.excluded(first.position))return 1;
  return 2;
 };
 return candidates.map((block,index)=>({block,index,score:score(block)})).sort((a,b)=>a.score-b.score||a.index-b.index).map(v=>v.block);
}
module.exports={prepareHousePreSiteWood,prioritizeStartupWood};
