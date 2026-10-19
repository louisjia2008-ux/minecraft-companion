'use strict';
const {isThreateningMobEntity}=require('./entitySemantics');
const finite=p=>p&&['x','y','z'].every(k=>Number.isFinite(p[k]));
function neutralEyes(bot){
 const p=bot.entity?.position;if(!finite(p))return [];
 return Object.values(bot.entities||{}).filter(e=>e?.name==='enderman'&&e.isValid!==false&&finite(e.position)
  &&Math.hypot(e.position.x-p.x,e.position.y-p.y,e.position.z-p.z)<=32&&!isThreateningMobEntity(e,bot.registry))
  .map(e=>({id:e.id,x:e.position.x-p.x,y:e.position.y+(e.eyeHeight||(e.height||2.9)*.9)-p.y-(bot.entity.eyeHeight||1.62),z:e.position.z-p.z}));
}
function selectNeutralSafeLook(bot,yaw,pitch){
 if(!Number.isFinite(yaw)||!Number.isFinite(pitch))return null;
 const eyes=neutralEyes(bot),cone=Math.cos(.7);
 const facing=(y,p)=>eyes.filter(e=>{const n=Math.hypot(e.x,e.y,e.z);return n>.001&&(-Math.sin(y)*Math.cos(p)*e.x+Math.sin(p)*e.y-Math.cos(y)*Math.cos(p)*e.z)/n>cone;});
 const danger=facing(yaw,pitch);if(!danger.length)return null;
 for(const y of [yaw,yaw+Math.PI/2,yaw-Math.PI/2,yaw+Math.PI])for(const p of [-.7,-1.1,-1.5]){
  if(!facing(y,p).length)return {yaw:y,pitch:p,neutralEntityIds:danger.map(e=>e.id),original:{yaw,pitch}};
 }
 return null;
}
function installHouseNeutralGaze({bot,shouldGuard,record=()=>{}}){
 if(typeof bot?.look!=='function')return()=>{};
 const original=bot.look,client=bot._client;let lastRecorded=0,lastCorrection=0,closed=false;
 function guardedLook(yaw,pitch,...rest){
  const chosen=bot._client===client&&shouldGuard()?selectNeutralSafeLook(bot,yaw,pitch):null;
  if(chosen){
   if(Date.now()-lastRecorded>=250){lastRecorded=Date.now();record('house_neutral_gaze_avoided',{...chosen,position:{...bot.entity.position},nativeLookDelegated:true,positionOrVelocityWritten:false});}
   return original.call(this,chosen.yaw,chosen.pitch,...rest);
  }
  return original.call(this,yaw,pitch,...rest);
 }
 bot.look=guardedLook;
 const correctCurrentLook=()=>{
  if(closed||bot._client!==client||!shouldGuard()||Date.now()-lastCorrection<50)return;
  const chosen=selectNeutralSafeLook(bot,bot.entity?.yaw,bot.entity?.pitch);if(!chosen)return;
  lastCorrection=Date.now();
  // A newly loaded neutral can enter an already established gaze without
  // another pathfinder look call. Delegate correction to native look under
  // the same live owner; never assign the entity's yaw/pitch or movement.
  try{Promise.resolve(guardedLook.call(bot,chosen.yaw,chosen.pitch,true)).catch(error=>{
   if(!closed&&bot._client===client)record('house_neutral_gaze_current_failed',{code:error.code||error.name});
  });record('house_neutral_gaze_current_corrected',{...chosen,position:{...bot.entity.position},nativeLookDelegated:true,positionOrVelocityWritten:false});}
  catch(error){record('house_neutral_gaze_current_failed',{code:error.code||error.name});}
 };
 const seen=new Map();
 const observe=e=>{
  if(e?.name!=='enderman'||bot._client!==client||!finite(e.position)||!finite(bot.entity?.position)
    ||Math.hypot(e.position.x-bot.entity.position.x,e.position.y-bot.entity.position.y,e.position.z-bot.entity.position.z)>32)return;
  correctCurrentLook();
  const keys=bot.registry?.entitiesByName?.enderman?.metadataKeys||[],flags=Object.fromEntries(['creepy','stared_at'].map(k=>[k,e.metadata?.[keys.indexOf(k)]??null])),stamp=JSON.stringify(flags);
  if(seen.get(e.id)===stamp)return;if(seen.size>=64)seen.delete(seen.keys().next().value);seen.set(e.id,stamp);
  record('house_native_enderman_state',{id:e.id,flags,position:{...e.position},actor:{...bot.entity.position},yaw:bot.entity.yaw,pitch:bot.entity.pitch,observedBy:'mineflayer.entityUpdate_or_entitySpawn'});
 };
 bot.on?.('entityUpdate',observe);bot.on?.('entitySpawn',observe);bot.on?.('physicsTick',correctCurrentLook);
 return()=>{closed=true;bot.removeListener?.('physicsTick',correctCurrentLook);if(bot.look===guardedLook)bot.look=original;bot.removeListener?.('entityUpdate',observe);bot.removeListener?.('entitySpawn',observe);};
}
module.exports={selectNeutralSafeLook,installHouseNeutralGaze};
