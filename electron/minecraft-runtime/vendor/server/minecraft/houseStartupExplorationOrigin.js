'use strict';
const {hasGroundedBodySupport,naturalWalkingFoot,inspectSurfaceBody}=require('./houseSurfaceGraph');
const copy=v=>JSON.parse(JSON.stringify(v));
const fail=(code,message,details={})=>Object.assign(Error(message),{code,...details});
// No camp exists during startup harvesting. Preserve each fixed graph rather
// than rewriting it or claiming an unobserved return from a real tree approach.
async function prepareStartupExplorationOrigin(deps,{deadline,maximumSegments=8,unresolvedTransportReason=null}={}){
 if(!Number.isSafeInteger(maximumSegments)||maximumSegments<1||maximumSegments>32)throw new TypeError("Finite origin segment limit must be1..32");
 if(unresolvedTransportReason!==null&&unresolvedTransportReason!=='house_surface_dry_graph_transport_origin')throw new TypeError('Only a bounded cleanup transport-origin refusal may archive an unresolved branch');
 deps.assertActive();const bot=deps.getBot(),client=bot._client;
 const active=()=>{deps.assertActive();if(deps.getBot()!==bot||bot._client!==client)throw fail('house_startup_origin_owner_changed','Startup origin connection changed');};
 const coastWindow=()=>require('./houseCreeperEscape').actualFullCubeContacts(bot).some(c=>['ice','frosted_ice','packed_ice','blue_ice'].includes(c.name))?3000:1200;
 let until=Math.min(deadline,Date.now()+coastWindow());
 while(Date.now()<until){
  const defended=await deps.ready?.();active();
  if(Date.now()>=deadline)break;
  if(defended===true)until=Math.min(deadline,Date.now()+coastWindow());
  if(deps.isMotorIdle()&&bot.pathfinder.goal===null&&['forward','back','left','right','jump','sprint','sneak'].every(k=>bot.controlState[k]===false)
    &&bot.entity.onGround===true&&hasGroundedBodySupport(bot)&&naturalWalkingFoot(bot,bot.entity.position.floored())
    &&inspectSurfaceBody(bot).dry&&bot.entity.velocity.x===0&&bot.entity.velocity.z===0){
   const state=deps.getState()||{},p=bot.entity.position.floored(),actual={x:p.x,y:p.y,z:p.z},id=`${p.x},${p.y},${p.z}`;
   if(!state.graph){
    if(!state.searchAnchor||state.searchAnchor.x!==p.x||state.searchAnchor.y!==p.y||state.searchAnchor.z!==p.z){active();deps.saveState({...state,searchAnchor:actual});}
    return {changed:false,actual};
   }
   const archiveUnresolved=unresolvedTransportReason!==null&&Boolean(state.graph.pendingWater||state.graph.pendingDryTrail);
   if(state.graph.nodes?.[id]&&!archiveUnresolved){
    if(state.graph.current!==id){
     if(state.graph.pendingWater||state.graph.pendingDryTrail)throw fail('house_startup_origin_pending_transport','An original startup transport remains pending');
     if(!state.graph.order?.includes(id))throw fail('house_startup_origin_unconfirmed','Actual node was not registered as visited');
     const previousCurrent=state.graph.current,graph={...state.graph,current:id,resumeNode:id};
     active();deps.saveState({...state,graph});
     deps.record?.({actual,previousCurrent,reobservedVisitedNode:true,newNodeOrVisitCredit:false,oldTraversalCredit:false,
       originalDeadline:deadline,requiredReturnToSpawn:false,materialCredit:false});
    }
    return {changed:false,actual};
   }
   if((state.graph.pendingWater||state.graph.pendingDryTrail)&&!archiveUnresolved)throw fail('house_startup_origin_pending_transport','An original startup transport remains pending');
   const segments=state.graphSegments||[];
   if(segments.length>=maximumSegments)throw fail('house_startup_origin_segment_limit','Finite startup origin segments reached');
   const previous={anchor:copy(state.searchAnchor),graph:copy(state.graph),actualAfterResourceWork:actual,closedAt:Date.now(),oldTraversalCredit:false,...(archiveUnresolved?{unresolvedTransport:{reason:unresolvedTransportReason,arrivalConfirmed:false,branchPreserved:true}}:{})};
   const next={...state,graphSegments:[...segments,previous],searchAnchor:actual,graph:null};
   active();deps.saveState(next);deps.record?.({actual,archivedAnchor:previous.anchor,archivedGraphs:next.graphSegments.length,
    originalDeadline:deadline,maximumSegments,unresolvedTransportPreserved:archiveUnresolved,oldTraversalCredit:false,requiredReturnToSpawn:false,materialCredit:false});return {changed:true,actual};
  }
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw fail('house_startup_origin_unconfirmed','Current startup actor did not settle on a loaded dry stand',
  {originFacts:{actual:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},velocity:{x:bot.entity.velocity.x,y:bot.entity.velocity.y,z:bot.entity.velocity.z},onGround:bot.entity.onGround,motorIdle:deps.isMotorIdle(),goalActive:bot.pathfinder.goal!==null,originalDeadline:deadline}});
}
module.exports={prepareStartupExplorationOrigin};
