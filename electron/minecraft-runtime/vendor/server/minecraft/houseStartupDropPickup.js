'use strict';
const {Vec3}=require('vec3');
const {createLoadedDryGraph,naturalWalkingFoot,hasGroundedBodySupport}=require('./houseSurfaceGraph');
// A real dropped stack authorizes one loaded nearby dry endpoint, never a
// resource receipt. Only the caller's native inventory ACK can credit wood.
async function pickupStartupDrop(deps,{entity,expectedName,deadline}={}){
  deps.assertActive();const bot=deps.getBot(),p=bot?.entity?.position,q=entity?.position;
  if(!p||!q||bot.entities?.[entity.id]!==entity||entity.isValid===false||entity.getDroppedItem?.()?.name!==expectedName
    ||!Number.isFinite(deadline)||deadline<=Date.now()||p.distanceTo(q)>6||Math.abs(q.y-Math.round(q.y))>.08)return false;
  const anchor={x:Math.floor(p.x),y:Math.round(p.y),z:Math.floor(p.z)},target={x:Math.floor(q.x),y:Math.round(q.y),z:Math.floor(q.z)};
  if(Math.abs(p.y-anchor.y)>.05||Math.abs(anchor.y-target.y)>2||!hasGroundedBodySupport(bot)
    ||!naturalWalkingFoot(bot,new Vec3(anchor.x,anchor.y,anchor.z))||!naturalWalkingFoot(bot,new Vec3(target.x,target.y,target.z)))return false;
  const below=bot.blockAt(new Vec3(target.x,target.y-1,target.z));
  if(!below||below.boundingBox!=='block'||below.shapes?.length!==1||below.shapes[0].some((v,i)=>v!==[0,0,0,1,1,1][i]))return false;
  const id=`${anchor.x},${anchor.y},${anchor.z}`;
  // This root is the actual current observation. The only unvisited frontier
  // is the observed stack endpoint; no site checkpoint or camp is rewritten.
  let cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,step:16,radius:16,
    nodes:{[id]:{position:anchor,parent:null,expanded:true}},order:[id],current:id,resumeNode:id,visits:1,probes:0,
    frontier:[{parent:id,target,plannedSteps:12}],blockedEdges:[]};
  const graph=createLoadedDryGraph({...deps,getCP:()=>cp,saveCP:value=>{cp=value;},
    // Native cost callbacks also inspect head cells above the feet.
    // Endpoint height remains within two metres; retain loaded headroom.
    isStepAllowed:pos=>pos?.y>=anchor.y-2&&pos.y<=anchor.y+4&&(deps.isStepAllowed?.(pos)??true)},
    {anchor,radius:16,maxNodes:2,maxEdges:4,timeoutMs:Math.max(1,deadline-Date.now()),legTimeoutMs:Math.max(1,deadline-Date.now()),terrainRecovery:true,maximumControlledDrop:2});
  const result=await graph.next();deps.assertActive();
  const reached=result.moved===true&&result.actual.x===target.x&&result.actual.y===target.y&&result.actual.z===target.z;
  if(reached)deps.record?.({expectedName,entityId:entity.id,target,actual:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},maximumControlledDrop:2,inventoryCredit:false});
  return reached;
}
module.exports={pickupStartupDrop};
