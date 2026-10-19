'use strict';
const {Vec3}=require('vec3'),{Movements}=require('mineflayer-pathfinder');
const {naturalWalkingFoot,hasGroundedBodySupport}=require('./houseSurfaceGraph');
const fail=(code,message)=>Object.assign(Error(message),{code});
// A survival-only movement scope over the original actually walked quarry
// prefix. It cannot dig, place, add a node, or credit a mining step.
async function withRecordedMiningRangedRetreat(deps,action){
 const bot=deps.getBot(),client=bot._client,previous=bot.pathfinder.movements,origin=bot.entity.position.clone(),deadline=deps.deadline;
 deps.assertActive();
 if(!Number.isFinite(deadline)||Date.now()>=deadline||!Array.isArray(deps.positions)||deps.positions.length<1||deps.positions.length>8192
   ||!hasGroundedBodySupport(bot)||!naturalWalkingFoot(bot,origin.floored()))throw fail('house_mining_retreat_unavailable','没有确认原矿道和实际干地站位');
 const positions=deps.positions.map(p=>{if(!p||!['x','y','z'].every(k=>Number.isSafeInteger(p[k])))throw TypeError('Recorded integer quarry prefix required');return new Vec3(p.x,p.y,p.z);});
 for(let i=1;i<positions.length;i++){const a=positions[i-1],b=positions[i];if(Math.abs(a.x-b.x)+Math.abs(a.z-b.z)!==1||Math.abs(a.y-b.y)>1)throw fail('house_mining_retreat_unavailable','原矿道前缀不是已确认的相邻步进');}
 if(!positions.some(p=>p.equals(origin.floored())))throw fail('house_mining_retreat_unavailable','实际站位不在原矿道前缀');
 const allowed=positions.filter(p=>p.offset(.5,0,.5).distanceTo(origin)<=12&&Math.abs(p.y-origin.y)<=2&&naturalWalkingFoot(bot,p));
 const profile=new Movements(bot);Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allow1by1towers:false,allowSprinting:false,allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false});profile.getMoveDiagonal=()=>{};
 profile.exclusionAreasStep.push(b=>b?.position&&allowed.some(p=>p.x===b.position.x&&p.z===b.position.z&&b.position.y>=p.y-1&&b.position.y<=p.y+2)?0:Infinity);
 profile.exclusionAreasBreak.push(()=>Infinity);profile.exclusionAreasPlace.push(()=>Infinity);
 const active=()=>{deps.assertActive();if(deps.getBot()!==bot||bot._client!==client||bot.pathfinder.movements!==profile||Date.now()>=deadline||bot.entity.position.distanceTo(origin)>12.5)throw fail('movement_preempted','原矿道自卫避箭控制权已结束');};
 deps.setActive(profile);bot.pathfinder.setMovements(profile);
 try{active();return await action({assertActive:active,profile});}
 finally{
  let owns=false;try{if(deps.isOwnerCurrent){if(deps.isOwnerCurrent()!==true)throw fail('movement_preempted','原自卫归属已更换');}else deps.assertActive();owns=deps.getBot()===bot&&bot._client===client&&bot.pathfinder.movements===profile;}catch{}
  if(owns)bot.pathfinder.setMovements(previous);
  deps.setActive(null);
 }
}
module.exports={withRecordedMiningRangedRetreat};
