'use strict';
const {createMiningNavigator,inspectMiningStep,classifyMiningBlock}=require('./miningNavigation');
const {hasGroundedBodySupport,inspectSurfaceBody,naturalWalkingFoot}=require('./houseSurfaceGraph');
const {Vec3}=require('vec3');
const same=(a,b)=>a&&b&&['x','y','z'].every(k=>a[k]===b[k]);
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const keyPosition=p=>`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const fail=(code,message)=>Object.assign(Error(message),{code});
// Combat can leave the actor beyond the old six-block cursor tolerance.
// Find a fresh, finite, already-clear connector; a plan grants no route credit.
function planQuarryRejoin(bot,saved,active){
 const origin=bot.entity.position.floored(),key=p=>`${p.x},${p.y},${p.z}`;
 const targets=new Map(saved.breadcrumbs.map((p,i)=>[key(p),i]));
 const queue=[{point:origin,path:[]}],seen=new Set([key(origin)]),deadline=Date.now()+100;
 for(let i=0;i<queue.length&&i<1024&&Date.now()<deadline;i++){
  active();const node=queue[i],index=targets.get(key(node.point));
  if(index!==undefined)return {index,path:node.path};
  if(node.path.length>=32)continue;
  for(const [x,z]of [[1,0],[0,1],[-1,0],[0,-1]])for(const dy of [0,1,-1]){
   const step={direction:{x,z},ascend:dy===1,descend:dy===-1};
   const next=inspectMiningStep({blockAt:p=>bot.blockAt(p),from:node.point,...step,minY:bot.game?.minY??-64,maxY:319});
   if(!next.ok||next.needsSupport||distance(origin,next.target)>16||seen.has(key(next.target))
    ||next.clearance.some(p=>!classifyMiningBlock(bot.blockAt(new Vec3(p.x,p.y,p.z))).passable))continue;
   seen.add(key(next.target));queue.push({point:next.target,path:[...node.path,step]});
  }
 }
 return null;
}
async function returnInterruptedHouseQuarry(deps){
 deps.assertActive();const bot=deps.getBot(),client=bot._client,q=deps.getQuarry(),name=q?.activeResource;
 const saved=q?.routes?.[name]?.navigation;
 if(!q?.anchor||!saved?.breadcrumbs?.length||!(saved.routeIndex>0)||bot.entity.position.y>=q.anchor.y-1)return false;
 // A surface valley may be below camp too. An old mine cursor alone cannot
 // take ownership of a distant wood/food trip. This local helper applies only
 // near actual recorded mine cells; false grants no movement or return credit.
 if(!saved.breadcrumbs.some(p=>distance(bot.entity.position,p)<=16))return false;
 const active=()=>{deps.assertActive();const latest=deps.getQuarry();if(deps.getBot()!==bot||bot._client!==client
  ||latest?.activeResource!==name||!same(latest.anchor,q.anchor))throw fail('movement_preempted','矿道返程归属已改变');};
 active();await deps.waitGround?.();active();
 const actual=bot.entity.position.floored();let exact=saved.breadcrumbs.findIndex(p=>same(p,actual));
 if(exact<0){
  if(!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry)throw fail('house_quarry_rejoin_unconfirmed','矿道接续需要实际站稳的干燥落脚点');
  let connector=planQuarryRejoin(bot,saved,active);
  if(!connector&&typeof deps.recoverLocal==='function'){
   const deadline=Date.now()+60000,attempted=new Set();
   for(let attempt=0;!connector&&attempt<3&&Date.now()<deadline;attempt++){
    active();const before=bot.entity.position.clone();
    const target=saved.breadcrumbs.filter(p=>distance(before,p)<=16&&naturalWalkingFoot(bot,new Vec3(p.x,p.y,p.z))
      &&!attempted.has(`${keyPosition(before)}>${keyPosition(p)}`))
      .sort((a,b)=>distance(before,a)-distance(before,b))[0];
    if(!target)break;attempted.add(`${keyPosition(before)}>${keyPosition(target)}`);
    const moved=await deps.recoverLocal(target,Math.min(deadline,Date.now()+20000));active();
    if(!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry)throw fail('house_quarry_rejoin_unconfirmed','局部开路后尚未实际站稳');
    connector=planQuarryRejoin(bot,saved,active);
    deps.record?.({resource:name,kind:'local_rejoin_recovery',target,actual:bot.entity.position.clone(),localMovementReported:moved===true,
      connectorConfirmed:Boolean(connector),oldRouteTraversalCredit:false});
   }
  }
  if(!connector)throw fail('house_quarry_rejoin_unavailable','未找到通往原矿道的已加载安全连接，不能借用地表返营路线');
  const nav=createMiningNavigator({getBot:()=>bot,assertActive:active,goto:deps.goto,maxActions:32,movementTimeoutMs:10000,
   digBlock:async()=>{throw fail('MINING_ROUTE_CHANGED','原矿道接续不能授权额外挖掘');}});
  for(const step of connector.path){await nav.advance(step.direction,step);active();}
  if(!same(bot.entity.position.floored(),saved.breadcrumbs[connector.index])||!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry)
   throw fail('house_quarry_rejoin_unconfirmed','没有实际接回记录矿道');
  exact=connector.index;
  deps.record?.({resource:name,kind:'fresh_clear_connector',actual:bot.entity.position.clone(),moves:nav.getState().moves,routeIndex:exact});
 }
 let restored=saved;
 if(exact>=0&&exact!==saved.routeIndex&&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry){
  restored={...saved,routeIndex:exact};deps.saveNavigation(name,restored,{reconciled:true,previousRouteIndex:saved.routeIndex,actual:bot.entity.position.clone(),newMovementCredit:false});
 }
 const clearOwnedReturnCover=async navigation=>{
  active();const i=navigation.routeIndex;if(i<=0||!deps.clearOwnedCover)return;
  const from=navigation.breadcrumbs[i],target=navigation.breadcrumbs[i-1];
  const checked=inspectMiningStep({blockAt:p=>bot.blockAt(p),from,
   direction:{x:target.x-from.x,z:target.z-from.z},ascend:target.y>from.y,descend:target.y<from.y,minY:bot.game?.minY??-64,maxY:319});
  if(!checked.ok||checked.needsSupport)return;
  for(const p of checked.clearance){
   active();const block=bot.blockAt(new Vec3(p.x,p.y,p.z));if(classifyMiningBlock(block).passable)continue;
   const owned=deps.getOwnedCover?.().find(s=>same(s.position,p)&&s.item===block?.name);
   if(!owned||!['dirt','cobblestone'].includes(block.name))continue;
   // Never remove a recorded route floor or expose fluid/gravity hazards.
   if(navigation.breadcrumbs.some(q=>q.x===p.x&&q.z===p.z&&q.y-1===p.y))continue;
   if([[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([x,y,z])=>{
    const c=classifyMiningBlock(bot.blockAt(new Vec3(p.x+x,p.y+y,p.z+z)));return !c.loaded||c.hazard||(y===1&&c.gravity);
   }))continue;
   await deps.clearOwnedCover(owned);active();
   if(!classifyMiningBlock(bot.blockAt(new Vec3(p.x,p.y,p.z))).passable)throw fail('house_quarry_cover_not_removed','服务器未确认拆除自有返程掩体');
   deps.record?.({resource:name,kind:'owned_return_cover_removed',position:p});
  }
 };
 await clearOwnedReturnCover(restored);
 const navigator=createMiningNavigator({getBot:()=>bot,assertActive:active,restoredState:restored,
  goto:deps.goto,movementTimeoutMs:10000,afterRecordedMove:clearOwnedReturnCover,
  checkpoint:value=>{active();deps.saveNavigation(name,value);},
  digBlock:async()=>{throw fail('MINING_ROUTE_CHANGED','原矿道返程不能授权额外挖掘');}});
 await navigator.retreat({preserveRoute:true});active();
 if(!same(bot.entity.position.floored(),q.anchor)||!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry)
  throw fail('house_quarry_return_unconfirmed','没有沿原矿道实际返回入口');
 deps.record?.({resource:name,actual:bot.entity.position.clone(),routeIndex:navigator.getState().routeIndex});
 return true;
}
module.exports={returnInterruptedHouseQuarry};
