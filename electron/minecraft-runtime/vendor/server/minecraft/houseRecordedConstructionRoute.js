'use strict';
const integer=p=>p&&['x','y','z'].every(k=>Number.isSafeInteger(p[k]));
const key=p=>`${p.x},${p.y},${p.z}`;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
// Reuse actually visited historical transport, not a remembered destination
// as movement permission. Every connector and saved water route is revalidated.
function recordedConstructionRoutes(material,actual,destination,safeFoot){
 if(!integer(actual)||!integer(destination))return [];
 const result=[];
 for(const [index,old]of (material.retiredCamps||[]).entries())for(const [resource,graph]of Object.entries(old.surfaceGraphs||{})){
  const root=graph.anchor;
  if(graph.schema!==2||graph.kind!=='loaded_dry_waypoint_graph'||graph.pendingWater||graph.pendingDryTrail||!integer(root)
   ||!graph.order?.includes(key(root))||distance(root,destination)>48)continue;
  for(const id of graph.order){
   const node=graph.nodes?.[id],p=node?.position;
   if(!integer(p)||key(p)!==id||node.terrainUnavailable||distance(p,actual)>96||!safeFoot(p))continue;
   const seen=new Set();let cursor=id,valid=true,length=0,prefixSafe=true;const ancestors=[];
   while(cursor!==key(root)){
    if(seen.has(cursor)||seen.size>=512){valid=false;break;}seen.add(cursor);
    const n=graph.nodes[cursor],parent=graph.nodes[n?.parent];
    if(!n||!integer(parent?.position)||!graph.order.includes(n.parent)){valid=false;break;}
    length+=distance(n.position,parent.position);cursor=n.parent;
    prefixSafe=prefixSafe&&safeFoot(parent.position);
    if(prefixSafe&&distance(parent.position,destination)<=48&&distance(p,destination)>=distance(parent.position,destination)+16)ancestors.push({id:cursor,position:{...parent.position},length});
   }
   if(valid)for(const target of ancestors)result.push({index,resource,entry:{...p},anchor:{...root},targetNodeId:target.id,targetPosition:target.position,graph,score:distance(actual,p)+distance(target.position,destination)+target.length*.1});
  }
 }
 // One inaccessible shore node must not crowd every other transport entry
 // out of the bounded probe batch merely because it has many ancestors.
 const entries=new Set();
 return result.sort((a,b)=>a.score-b.score).filter(route=>{
  const id=key(route.entry);if(entries.has(id))return false;
  entries.add(id);return true;
 }).slice(0,12);
}
function confirmRecordedConstructionEntry(route,actual,grounded){
 if(!grounded||!integer(actual)||key(actual)!==key(route.entry))throw Object.assign(Error('尚未实际抵达已记录的施工运输节点'),{code:'house_construction_recorded_entry_unconfirmed'});
 const graph=JSON.parse(JSON.stringify(route.graph));graph.current=key(actual);graph.resumeNode=graph.current;return graph;
}
function canRebaseCompletedConstructionBank(saved,error,actual,grounded,safeFoot){
 const arrival=saved?.graph?.pendingWater?.bankArrival;
 return ['house_surface_dry_graph_route_changed','house_surface_dry_graph_native_no_path'].includes(error?.code)
  &&arrival?.nativeTraversalConfirmed===true&&integer(arrival.position)&&integer(actual)
  &&key(actual)===key(arrival.position)&&grounded===true&&safeFoot(actual)===true;
}
module.exports={recordedConstructionRoutes,confirmRecordedConstructionEntry,canRebaseCompletedConstructionBank};
