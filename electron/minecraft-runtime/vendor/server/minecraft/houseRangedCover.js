'use strict';
const {Vec3}=require('vec3');
const {goals}=require('mineflayer-pathfinder');
const {naturalWalkingFoot,inspectSurfaceBody,hasGroundedBodySupport}=require('./houseSurfaceGraph');
const {createMiningNavigator}=require('./miningNavigation');
const {getObservedEntityHealth}=require('./entitySemantics');
const ranged=new Set(['skeleton','stray','bogged','witch']);
const deferredPursuits=new WeakMap();
function deferHouseRangedPursuit(bot,target,now=Date.now()){
 if(!target?.position||target.id==null||!isHouseRangedThreatEntity(target)||target.position.distanceTo(bot.entity.position)<=8.5)return false;
 let entries=deferredPursuits.get(bot);if(!entries){entries=new Map();deferredPursuits.set(bot,entries);}
 if(entries.size>=64)entries.delete(entries.keys().next().value);
 entries.set(target.id,{position:target.position.clone(),until:now+30000,health:bot.health});return true;
}
function clearHouseRangedPursuits(bot){if(bot)deferredPursuits.delete(bot);}
function pursuitDeferred(bot,target,now=Date.now()){
 const entry=deferredPursuits.get(bot)?.get(target.id);if(!entry)return false;
 if(now>=entry.until||bot.health<entry.health||target.position.distanceTo(bot.entity.position)<=8.5||target.position.distanceTo(entry.position)>3){
  deferredPursuits.get(bot).delete(target.id);return false;
 }
 return true;
}
const isHouseRangedThreatEntity=e=>ranged.has(e?.name)||e?.name==='drowned'&&[e.heldItem,...(e.equipment||[])].some(item=>item?.name==='trident');
function cardinalCoverPath(path,from,safeFoot){
 const result=[];let current=from;
 for(const p of path){
  const dx=p.x-current.x,dz=p.z-current.z,dy=p.y-current.y;
  if(!dx&&!dz&&!dy)continue;
  if(Math.abs(dx)>1||Math.abs(dz)>1||Math.abs(dy)>1||!safeFoot(p))return null;
  if(dx&&dz){
   const middle=[{x:p.x,y:current.y,z:current.z},{x:current.x,y:current.y,z:p.z}].find(safeFoot);
   if(!middle)return null;
   result.push(middle);
  }else if(Math.abs(dx)+Math.abs(dz)!==1)return null;
  result.push({x:p.x,y:p.y,z:p.z});current=p;
  if(result.length>24)return null;
 }
 return result;
}
function findHouseRangedThreat(bot,radius=24){
 return Object.values(bot.entities||{}).filter(e=>isHouseRangedThreatEntity(e)&&e.isValid!==false&&getObservedEntityHealth(e,bot.registry)!==0&&e.position
  &&Math.abs(e.position.y-bot.entity.position.y)<=8&&e.position.distanceTo(bot.entity.position)<=radius)
  .sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position))[0]||null;
}
function findExposedHouseRangedThreat(bot,radius=24){
 return Object.values(bot.entities||{}).filter(e=>isHouseRangedThreatEntity(e)&&e.isValid!==false&&getObservedEntityHealth(e,bot.registry)!==0&&e.position
  &&Math.abs(e.position.y-bot.entity.position.y)<=8&&e.position.distanceTo(bot.entity.position)<=radius
  &&!pursuitDeferred(bot,e)&&!rangedCoverConfirmed(bot,bot.entity.position,[e]))
  .sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position))[0]||null;
}
// A sampled point inside an observed collision shape proves an obstruction;
// missing a thin shape only refuses cover. Unknown cells never prove cover.
function rangedCoverConfirmed(bot,position,threats){
 if(!threats.length)return false;
 // Arrow ray occlusion does not prove protection against arcing splash
 // potions. A witch must remain an active threat until separately resolved.
 if(threats.some(e=>e.name==='witch'))return false;
 for(const e of threats)for(const dy of [.6,1.2,1.62])for(const [dx,dz] of [[-.25,-.25],[.25,.25],[-.25,.25],[.25,-.25]]){
  const from=e.position.offset(0,e.eyeHeight||(e.height||1.99)*.9,0),to=new Vec3(position.x+dx,position.y+dy,position.z+dz),delta=to.minus(from),n=Math.ceil(delta.norm()*4);let blocked=false;
  for(let k=1;k<n;k++){
   const p=from.plus(delta.scaled(k/n)),b=bot.blockAt(p.floored());if(!b)return false;
   if(b.shapes?.some(s=>p.x>=b.position.x+s[0]&&p.x<=b.position.x+s[3]&&p.y>=b.position.y+s[1]&&p.y<=b.position.y+s[4]&&p.z>=b.position.z+s[2]&&p.z<=b.position.z+s[5])){blocked=true;break;}
  }
  if(!blocked)return false;
 }
 return true;
}
async function seekHouseRangedCover(deps,{deadline,boundaryOrigin}){
 const bot=deps.getBot(),profile=bot.pathfinder.movements,origin=(boundaryOrigin||bot.entity.position).clone(),client=bot._client;
 const active=()=>{deps.assertActive();if(deps.getBot()!==bot||bot._client!==client||bot.pathfinder.movements!==profile||Date.now()>=deadline||bot.health<=0||bot.entity.position.distanceTo(origin)>12.5)throw Object.assign(Error('远程避险达到原归属、生命或12米预算'),{code:'house_ranged_cover_limit'});};
 const threats=()=>Object.values(bot.entities||{}).filter(e=>isHouseRangedThreatEntity(e)&&e.isValid!==false&&getObservedEntityHealth(e,bot.registry)!==0&&e.position?.distanceTo(bot.entity.position)<=24);
 active();if(!threats().length)return {moved:false,covered:false,threatGone:true};
 if(rangedCoverConfirmed(bot,bot.entity.position,threats())){
  const landingDeadline=Math.min(deadline,Date.now()+1000);
  while(bot.entity.onGround!==true&&Date.now()<landingDeadline){active();await new Promise(resolve=>setTimeout(resolve,20));}
  active();if(hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry&&rangedCoverConfirmed(bot,bot.entity.position,threats()))
   return {moved:false,covered:true,actualPosition:bot.entity.position.clone(),actualGrounded:true};
 }
 if(profile.canDig!==false||profile.allowParkour!==false||profile.scafoldingBlocks?.length)return {moved:false,covered:false,reason:'strict_profile_required'};
 const began=Date.now(),candidates=[],near=threats(),initial=Math.min(...near.map(e=>e.position.distanceTo(origin)));
 const offsets=[];for(let x=-12;x<=12;x++)for(let z=-12;z<=12;z++)if((x||z)&&Math.hypot(x,z)<=12)offsets.push([x,z]);
 offsets.sort((a,b)=>Math.hypot(...a)-Math.hypot(...b));let samples=0;
 for(const [x,z] of offsets)for(const y of [0,-1,1,-2,2]){
  active();if(Date.now()-began>120)break;
  samples++;
  const p=origin.floored().offset(x,y,z),center=p.offset(.5,0,.5);if(center.distanceTo(origin)>12||!naturalWalkingFoot(bot,p))continue;
  // A scoped recorded-mine profile forbids leaving its observed prefix.
  // Unreachable covered endpoints must not consume all twelve native probes
  // ahead of a reachable protective cell on that same prefix.
  if(profile.exclusionAreasStep?.some(area=>area(bot.blockAt(p))===Infinity))continue;
  if(Object.values(bot.entities||{}).some(e=>['creeper','spider','cave_spider','zombie','husk','drowned'].includes(e.name)&&e.isValid!==false&&e.position?.distanceTo(center)<4.5))continue;
  const covered=rangedCoverConfirmed(bot,center,near),distance=Math.min(...near.map(e=>e.position.distanceTo(center)));
  // A few extra exposed meters do not resolve archers and led to repeated
  // back-and-forth retreats under fire. An uncovered endpoint must leave the
  // ranged perception envelope of every observed shooter.
  if(covered||distance>=Math.max(24,initial+3.5))candidates.push({p,covered,score:covered?100+Math.min(12,distance-initial)*4-center.distanceTo(origin):distance-initial-center.distanceTo(origin)*.1});
 }
 deps.record?.('house_ranged_cover_search',{samples,candidates:candidates.length,coveredCandidates:candidates.filter(c=>c.covered).length,
   elapsedMs:Date.now()-began,maximumRadius:12,planningBudgetMs:120,actualMovementPerformed:false});
 candidates.sort((a,b)=>b.score-a.score);let plan,choice;
 for(const c of candidates.slice(0,12)){
  await new Promise(resolve=>setTimeout(resolve,0));
  active();const iterator=bot.pathfinder.getPathFromTo(profile,bot.entity.position,new goals.GoalBlock(c.p.x,c.p.y,c.p.z),{optimizePath:false,timeout:40,tickTimeout:10});let result;
  for(let i=0;i<4;i++){active();const next=iterator.next();result=next.value?.result;if(next.done||result?.status!=='partial')break;}
  deps.record?.('house_ranged_cover_native_probe',{target:c.p,status:result?.status,pathCount:result?.path?.length,path:(result?.path||[]).slice(0,24).map(p=>({x:p.x,y:p.y,z:p.z,breakCount:p.toBreak?.length,placeCount:p.toPlace?.length})),actualMovementPerformed:false});
  if(result?.status!=='success'||!result.path?.length||result.path.length>24||result.path.some(p=>p.toBreak?.length||p.toPlace?.length||Math.hypot(p.x+.5-origin.x,p.z+.5-origin.z)>12||(p.y-origin.y>2||origin.y-p.y>3)))continue;
  const checked=cardinalCoverPath(result.path,bot.entity.position.floored(),p=>naturalWalkingFoot(bot,new Vec3(p.x,p.y,p.z))
    &&new Vec3(p.x+.5,p.y,p.z+.5).distanceTo(origin)<=12);
  if(!checked?.length)continue;
  plan=checked;choice=c;break;
 }
 if(!plan)return {moved:false,covered:false,reason:'no_loaded_bounded_route'};
 deps.record?.('house_ranged_cover_planned',{target:choice.p,expectedCover:choice.covered,steps:plan.length,actualProtectionConfirmed:false});
 const nav=createMiningNavigator({getBot:()=>bot,assertActive:active,preserveMovements:true,allowLeafSupport:true,allowStableGravitySupport:true,maxActions:24,movementTimeoutMs:Math.min(5000,Math.max(1,deadline-Date.now())),goto:g=>deps.goto(g,Math.min(5000,Math.max(1,deadline-Date.now()))),digBlock:async()=>{throw Object.assign(Error('避箭不能挖掘未授权方块'),{code:'house_ranged_cover_obstructed'});}});
 for(const p of plan){active();const from=bot.entity.position.floored(),dx=p.x-from.x,dz=p.z-from.z,dy=p.y-from.y;if(!dx&&!dz&&!dy)continue;if(Math.abs(dx)+Math.abs(dz)!==1||Math.abs(dy)>1)throw Object.assign(Error('避箭剩余步骤不能逐格执行'),{code:'house_ranged_cover_route_changed'});await nav.advance({x:dx,z:dz},{ascend:dy===1,descend:dy===-1});active();}
 // A shooter can step around the first thin obstruction. Complete the
 // selected bounded retreat instead of repeatedly stopping at that same
 // intermediate cell and calling a two-step detour successful.
 const actual=bot.entity.position.clone(),arrived=actual.floored().equals(choice.p);
 return {moved:nav.getState().moves>0,covered:arrived&&inspectSurfaceBody(bot).dry&&rangedCoverConfirmed(bot,actual,threats()),
   plannedTarget:choice.p,retreatArrivalConfirmed:arrived,actualPosition:actual};
}
module.exports={isHouseRangedThreatEntity,findHouseRangedThreat,findExposedHouseRangedThreat,rangedCoverConfirmed,seekHouseRangedCover,cardinalCoverPath,deferHouseRangedPursuit,clearHouseRangedPursuits,isHouseRangedPursuitDeferred:pursuitDeferred};
