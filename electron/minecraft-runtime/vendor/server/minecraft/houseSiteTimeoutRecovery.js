'use strict';
const {hasGroundedBodySupport,naturalWalkingFoot,inspectSurfaceBody}=require('./houseSurfaceGraph');
const key=p=>`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const copy=v=>JSON.parse(JSON.stringify(v));
// A failed leg stays failed. After its native owner has stopped and drained,
// the original search may observe a real dry landing as the next search root.
async function recoverTimedOutSiteLeg(deps,error,{deadline,maxNodes=256,maxProbes=8192}={}){
 if(error?.code!=='dry_graph_leg_timeout')return {confirmed:false};
 deps.assertActive();const bot=deps.getBot(),client=bot?._client,leg=error.observedDryLeg,initial=deps.getCP();
 if(!leg||!Number.isFinite(leg.deadline)||Date.now()<leg.deadline||Date.now()-leg.deadline>1800
   ||!Number.isFinite(deadline)||deadline<=Date.now()||!initial||initial.schema!==2||initial.kind!=='loaded_dry_waypoint_graph'
   ||initial.current!==leg.fromNode||!initial.nodes?.[leg.fromNode]||key(initial.nodes[leg.fromNode].position)!==leg.from
   ||initial.pendingWater||initial.pendingDryTrail||!Array.isArray(initial.order)||initial.order.length>maxNodes
   ||!Number.isSafeInteger(initial.probes)||initial.probes<0||initial.probes>maxProbes
   ||!leg.target||!['x','y','z'].every(k=>Number.isSafeInteger(leg.target[k])))return {confirmed:false};
 const stamp=JSON.stringify(initial),until=Math.min(deadline,Date.now()+1800);
 while(Date.now()<until){
  deps.assertActive();if(deps.getBot()!==bot||bot._client!==client)return {confirmed:false};
  const p=bot.entity.position,id=key(p);
  if(deps.isMotorIdle()===true&&bot.pathfinder.goal===null&&['forward','back','left','right','jump','sprint','sneak'].every(k=>bot.controlState[k]===false)
    &&bot.entity.onGround===true&&hasGroundedBodySupport(bot)&&naturalWalkingFoot(bot,p.floored())&&inspectSurfaceBody(bot).dry
    &&Math.hypot(bot.entity.velocity.x,bot.entity.velocity.z)<=.02){
   deps.assertActive();const latest=deps.getCP();if(JSON.stringify(latest)!==stamp)return {confirmed:false};
   const actual={x:Math.floor(p.x),y:Math.floor(p.y),z:Math.floor(p.z)};
   if(Math.hypot(actual.x-initial.anchor.x,actual.z-initial.anchor.z)>initial.radius)return {confirmed:false};
   const cp=copy(initial),created=!cp.nodes[id];if(created&&cp.order.length>=maxNodes)return {confirmed:false};
   const facts={kind:'actual_grounded_after_expired_site_leg',fromNode:leg.fromNode,abandonedTarget:copy(leg.target),
    originalLegDeadline:leg.deadline,originalSearchDeadline:deadline,actual,oldGoalAccepted:false,oldEdgeTraversalCredit:false,
    nativeMotorDrained:true,actualGrounded:true,positionOrVelocityWritten:false};
   if(created){cp.nodes[id]={position:actual,parent:leg.fromNode,expanded:false,timedOutLegLanding:facts};cp.order.push(id);cp.visits++;}
   cp.current=id;cp.resumeNode=id;
   cp.frontier=cp.frontier.filter(edge=>!(edge.parent===leg.fromNode&&key(edge.target)===key(leg.target)));
   cp.blockedEdges.push({kind:'unconfirmed_site_parent_replay',from:id,requestedFrom:leg.fromNode,targetNode:key(leg.target),
    reason:'dry_graph_leg_timeout',scope:'exploration_only',retryAfter:Date.now()+120000,actualMovementConfirmed:false,actualLandingConfirmed:true});
   deps.assertActive();deps.saveCP(cp);deps.record?.(facts);return {confirmed:true,actual,created};
  }
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 return {confirmed:false};
}
module.exports={recoverTimedOutSiteLeg};
