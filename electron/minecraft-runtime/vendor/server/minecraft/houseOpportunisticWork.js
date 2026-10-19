'use strict';
const {observeHouseTree}=require('./houseTreeHarvest');
// Opportunistic work never navigates away from the live main-route position.
// Only an entire small reachable trunk or a few exposed ore blocks qualify.
async function runHouseOpportunisticWork(deps){
 const bot=deps.getBot(),client=bot._client,origin=bot.entity.position.clone();
 const active=()=>{deps.assertActive();if(deps.getBot()!==bot||bot._client!==client||bot.entity.position.distanceTo(origin)>1.5)
  throw Object.assign(Error('顺路采集归属或站位改变'),{code:'movement_preempted'});};
 active();if(deps.urgent()||deps.freeSlots()<3)return {acted:false};
 const ready=b=>b&&b.position.distanceTo(bot.entity.position)<=4.4
  &&Math.hypot(b.position.x+.5-origin.x,b.position.z+.5-origin.z)<=1.5&&!deps.excluded(b.position)
  &&bot.canDigBlock(b)&&bot.canSeeBlock(b)&&deps.canDigSafely(b);
 let blocks=[];
 if(deps.logCount()<24){
  const roots=deps.scan('wood').filter(ready);
  for(const root of roots.slice(0,4)){
   const tree=observeHouseTree(bot,root,deps.excluded);
   const candidate=(tree?.pending||[]).map(p=>bot.blockAt(root.position.offset(p.x-root.position.x,p.y-root.position.y,p.z-root.position.z)));
   if(candidate.length&&candidate.length<=8&&candidate.every(ready)&&deps.logCount()+candidate.length<=24){blocks=candidate.sort((a,b)=>b.position.y-a.position.y);break;}
  }
 }
 if(!blocks.length)blocks=deps.scan('ore').filter(ready).filter(b=>deps.wantsOre(b.name,b)).slice(0,3);
 if(!blocks.length)return {acted:false};
 const before=deps.counts(),deadline=Date.now()+12000;let dug=0;
 for(const planned of blocks){
  active();if(Date.now()>=deadline||deps.urgent())break;
  const b=bot.blockAt(planned.position);if(b?.stateId!==planned.stateId||!ready(b))break;
  await deps.equip(b);active();await deps.dig(b);active();dug++;
 }
 if(dug){await deps.collect(origin);active();}
 const after=deps.counts(),acquired=Object.fromEntries(Object.entries(after).map(([name,n])=>[name,n-(before[name]||0)]).filter(([,n])=>n>0));
 return {acted:dug>0,dug,acquired,extraNavigation:0,treeComplete:blocks[0]?.name?.endsWith('_log')?dug===blocks.length:undefined};
}
module.exports={runHouseOpportunisticWork};
