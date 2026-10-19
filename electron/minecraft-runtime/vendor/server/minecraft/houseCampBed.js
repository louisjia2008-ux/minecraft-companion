'use strict';
const {Vec3}=require('vec3');
const fail=(code,message)=>Object.assign(new Error(message),{code});
const same=(a,b)=>a&&b&&['x','y','z'].every(k=>a[k]===b[k]);
const plain=p=>({x:p.x,y:p.y,z:p.z});
function bedMatches(bot,record){
 return record&&['foot','head'].every(part=>{const b=bot.blockAt(new Vec3(...['x','y','z'].map(k=>record[part][k]))),p=b?.getProperties?.();return b?.name==='white_bed'&&p?.part===part&&p.facing==='north';});
}
function chooseCampBed(bot,camp,excluded){
 const at=p=>bot.blockAt(new Vec3(p.x,p.y,p.z));
 const clear=p=>['air','cave_air','void_air'].includes(at(p)?.name)&&['air','cave_air','void_air'].includes(at({...p,y:p.y+1})?.name);
 const floor=p=>{const b=at({...p,y:p.y-1});return b&&!b.name.endsWith('_leaves')&&!['magma_block','cactus','powder_snow','ice','packed_ice','blue_ice'].includes(b.name)&&![true,'true'].includes(b.getProperties?.().waterlogged)
  &&b.shapes?.some(s=>s.every((v,i)=>v===[0,0,0,1,1,1][i]));};
 for(let radius=2;radius<=8;radius++)for(let dx=-radius;dx<=radius;dx++)for(let dz=-radius;dz<=radius;dz++){
  if(Math.max(Math.abs(dx),Math.abs(dz))!==radius)continue;
  const foot={x:camp.x+dx,y:camp.y,z:camp.z+dz},head={...foot,z:foot.z-1};
  if([foot,head].every(p=>!excluded(p)&&clear(p)&&floor(p))){
   const access=[{...foot,x:foot.x+1},{...foot,x:foot.x-1},{...foot,z:foot.z+1},{...head,x:head.x+1},{...head,x:head.x-1},{...head,z:head.z-1}]
    .find(p=>!excluded(p)&&clear(p)&&floor(p));
   if(access)return {foot,head,access,facing:'north',camp:plain(camp)};
  }
 }
 throw fail('house_camp_bed_site_unconfirmed','施工营地附近尚未找到双格干燥完整地基放床');
}
function spawnMessage(message){
 const visit=v=>v&&typeof v==='object'&&(v.translate==='block.minecraft.set_spawn'||Object.values(v).some(x=>Array.isArray(x)?x.some(visit):visit(x)));
 return visit(message?.json||message)===true;
}
async function prepareHouseCampBed(deps){
 const bot=deps.getBot();deps.assertActive();
 if(bot.game?.dimension!=='overworld')throw fail('house_camp_bed_dimension','营地床仅用于主世界');
 let record=deps.getCheckpoint();const camp=deps.getCamp();
 if(record&&same(record.camp,camp)&&record.spawnConfirmed===true&&bedMatches(bot,record))return record;
 if(!record||!same(record.camp,camp)||!bedMatches(bot,record)){
  await deps.ensure({white_bed:1});deps.assertActive();
  record=chooseCampBed(bot,deps.getCamp(),deps.excluded);deps.save({...record,spawnConfirmed:false,placed:false});
  await deps.place({id:'camp:respawn-bed',item:'white_bed',position:record.foot,properties:{facing:'north',part:'foot',occupied:false}},()=>{});deps.assertActive();
  if(!bedMatches(bot,record))throw fail('house_camp_bed_placement_unconfirmed','营地床双格方向未获得实际确认');
  record={...record,placed:true,spawnConfirmed:false};deps.save(record);
 }
 await deps.reach(record.foot);deps.assertActive();
 if(!bedMatches(bot,record))throw fail('house_camp_bed_changed','自有营地床在使用前已改变');
 let acknowledged=false,slept=false,woke=false,occupied=false;
 const onMessage=m=>{if(spawnMessage(m))acknowledged=true;},onSleep=()=>{slept=true;},onWake=()=>{woke=true;};
 bot.on('message',onMessage);bot.on('sleep',onSleep);bot.on('wake',onWake);
 try{
  await deps.activate(bot.blockAt(new Vec3(record.foot.x,record.foot.y,record.foot.z)));deps.assertActive();
  const until=Date.now()+4000;
  while(Date.now()<until){
   deps.assertActive();if(deps.getBot()!==bot)throw fail('house_camp_bed_owner_changed','营地床使用期间连接改变');
   if(!bedMatches(bot,record))throw fail('house_camp_bed_changed','营地床使用期间双格已改变');
   occupied=[record.foot,record.head].some(p=>bot.blockAt(new Vec3(p.x,p.y,p.z))?.getProperties?.().occupied===true);
   if(acknowledged||slept&&occupied)break;
   await deps.sleep(40);
  }
  if(!acknowledged&&!(slept&&occupied))throw fail('house_camp_bed_spawn_unconfirmed','服务器尚未确认营地床重生点');
  record={...record,spawnConfirmed:true,confirmation:acknowledged?'native_server_respawn_message':'native_sleep_and_occupied',confirmedAt:Date.now(),slept,occupied};deps.save(record);
  const wakeUntil=Date.now()+20000;
  while(bot.isSleeping&&Date.now()<wakeUntil){deps.assertActive();await deps.sleep(100);}
  if(bot.isSleeping)throw fail('house_camp_bed_wake_unconfirmed','营地床尚未自然醒来');
  deps.assertActive();record={...record,woke};deps.save(record);deps.record?.(record);return record;
 }finally{bot.off('message',onMessage);bot.off('sleep',onSleep);bot.off('wake',onWake);}
}
module.exports={prepareHouseCampBed,chooseCampBed,spawnMessage};
