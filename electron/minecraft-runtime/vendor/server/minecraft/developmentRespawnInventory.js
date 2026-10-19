
'use strict';
// Compatibility boundary for the retained private development runner. Vanilla
// death drops items, but the pinned native client may retain its old window0
// until a later full inventory packet. Never turn that cache into survival proof.
function createDevelopmentRespawnInventory(deps){
 let enabled=false,bot=null,client=null,pending=null;
 const onDeath=()=>{if(enabled&&deps.getBot()===bot&&bot?._client===client){pending={bot,client,task:deps.getTask(),requested:false};deps.record?.('development_death_inventory_unconfirmed',{cachedItemCount:bot.inventory?.items?.().length||0,currentInventoryCredit:false});}};
 function detach(){bot?.removeListener?.('death',onDeath);bot=null;client=null;pending=null;}
 function attach(next){detach();bot=next;client=next?._client;bot?.on?.('death',onDeath);}
 function beforeClaim(kind,ownerId){
  const task=deps.getTask();
  if(kind==='task'&&ownerId===task?.taskId)enabled=true;
  if(kind!=='task'||ownerId!==`${task?.taskId}:development-survival`)return;
  enabled=true;
  if(!pending||deps.getBot()!==pending.bot||pending.client!==pending.bot?._client||pending.task!==task)return;
  const error=Object.assign(Error('复活背包尚未重新确认，先只重连开发机器人读取原生库存'),{code:'house_respawn_inventory_unconfirmed'});
  if(bot.health>0&&bot.isAlive!==false&&deps.canReconnect()===true&&!pending.requested){
   pending.requested=true;deps.record?.('development_respawn_inventory_reconnect',{worldRestarted:false,inventoryMutated:false});
   deps.reconnect(bot);
  }
  throw error;
 }
 return {attach,detach,beforeClaim};
}
module.exports={createDevelopmentRespawnInventory};
