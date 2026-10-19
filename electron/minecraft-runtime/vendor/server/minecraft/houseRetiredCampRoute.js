'use strict';
const {classifyMiningBlock}=require('./miningNavigation');
const integer = p => p && ['x','y','z'].every(k => Number.isSafeInteger(p[k]));
const key = p => `${p.x},${p.y},${p.z}`;
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function selectRetiredCampRoute(supply,actual,safeFoot) {
  if (!integer(actual) || !integer(supply?.camp?.anchor)) return null;
  for (let index=(supply.retiredCamps?.length||0)-1;index>=0;index--) {
    const retired=supply.retiredCamps[index];
    for (const [resource,graph] of Object.entries(retired.surfaceGraphs||{})) {
      const trace=retired.surfaceResources?.searches?.[resource]?.observedPath;
      if (graph.pendingWater || graph.pendingDryTrail || !integer(graph.anchor)
          || !integer(retired.camp?.anchor) || key(graph.anchor)!==key(retired.camp.anchor)
          || !Array.isArray(trace) || !trace.length || !trace.every(integer)
          || distance(trace.at(-1),supply.camp.anchor)>12) continue;
      const target=graph.nodes?.[graph.current],at=trace.findLastIndex(p=>key(p)===graph.current);
      if (!target || at<0 || !graph.order?.includes(graph.current)) continue;
      const nearby=Object.entries(graph.nodes||{}).filter(([id,node])=>!node.terrainUnavailable&&graph.order.includes(id)
        &&integer(node.position)&&key(node.position)===id&&distance(actual,node.position)<=32&&safeFoot(node.position))
        .sort((a,b)=>distance(a[1].position,supply.camp.anchor)-distance(b[1].position,supply.camp.anchor)
          ||distance(actual,a[1].position)-distance(actual,b[1].position));
      if (nearby.length) return {index,resource,graph,entry:nearby[0][1].position,target:target.position,suffix:trace.slice(at+1)};
    }
  }
  return null;
}
function retiredCampKnownUnusable(camp,blockAt){
  const p=camp?.anchor;if(!integer(p))return true;
  const feet=blockAt(p),head=blockAt({...p,y:p.y+1}),floor=blockAt({...p,y:p.y-1});
  // Unknown chunks remain unknown. A loaded blast crater is positive evidence
  // that the archived arrival position no longer exists.
  if(!feet||!head||!floor)return false;
  return !classifyMiningBlock(feet).passable||!classifyMiningBlock(head).passable||!classifyMiningBlock(floor).support;
}
function selectFieldCampReturn(supply,actual,safeFoot){
 const graph=supply?.fieldWoodSearch?.graph,camp=supply?.camp?.anchor;
 if(!integer(actual)||!integer(camp)||graph?.schema!==2||graph.kind!=='loaded_dry_waypoint_graph'
   ||graph.pendingWater||graph.pendingDryTrail||!integer(graph.anchor))return null;
 // The same field graph may lead away from the current camp to the first
 // trees. Its current node is then the departure, while the root is the
 // return destination. Retain the old forward replay for a relocated camp.
 const target=graph.nodes?.[key(graph.anchor)===key(camp)?key(graph.anchor):graph.current]?.position;
 if(!integer(target)||distance(target,camp)>32||!graph.order?.includes(graph.current))return null;
 const valid=id=>graph.order.includes(id)&&integer(graph.nodes?.[id]?.position)&&key(graph.nodes[id].position)===id;
 const chain=new Set();let id=graph.current;
 while(id&&chain.size<512&&!chain.has(id)&&valid(id)){chain.add(id);id=graph.nodes[id].parent;}
 if(id||!chain.has(key(graph.anchor)))return null;
 const entry=[...chain].map(id=>graph.nodes[id].position).filter(p=>distance(actual,p)<=32&&safeFoot(p))
   .sort((a,b)=>distance(actual,a)-distance(actual,b))[0];
 return entry?{graph,entry,target,camp}:null;
}
function fieldCampReturnCheckpoint(route,actual){
 if(!integer(actual)||!integer(route?.entry)||key(actual)!==key(route.entry))
  throw Object.assign(Error('Field return entry has not actually been reached'),{code:'house_camp_recovery_entry_unconfirmed'});
 const graph=JSON.parse(JSON.stringify(route.graph));
 graph.current=key(actual);graph.resumeNode=graph.current;return graph;
}
module.exports={selectRetiredCampRoute,retiredCampKnownUnusable,selectFieldCampReturn,fieldCampReturnCheckpoint};
