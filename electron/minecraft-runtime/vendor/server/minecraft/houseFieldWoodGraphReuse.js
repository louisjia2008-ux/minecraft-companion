'use strict';
// Select a retained observation domain; this grants neither travel nor visits.
function reuseNearbyFieldWoodGraph({search,history=[],actual}={}){
 if(!actual||!['x','y','z'].every(k=>Number.isFinite(actual[k]))||!search?.graph
   ||search.graph.pendingWater||search.graph.pendingDryTrail)return null;
 const entries=[];
 for(const [searchIndex,s] of [...history,search].entries()){
  if(!s||typeof s!=='object')continue;
  const {graph,graphSegments=[],...meta}=s;
  for(const [segmentIndex,segment] of graphSegments.entries())if(segment?.graph)entries.push({...meta,...segment,graphSegments:[],
   graphReuseSource:{searchIndex,segmentIndex,searchAnchor:s.anchor}});
  if(graph)entries.push({...meta,graph,graphSegments:[],graphReuseSource:{searchIndex,segmentIndex:null,searchAnchor:s.anchor}});
 }
 const current=search.graph.nodes?.[search.graph.current]?.position;
 if(current&&Math.hypot(...['x','y','z'].map(k=>current[k]-actual[k]))<=32)return null;
 const eligible=entries.filter(e=>e.graph!==search.graph&&!e.graph.pendingWater&&!e.graph.pendingDryTrail
  &&e.graph.order?.includes(e.graph.current)&&e.graph.nodes?.[e.graph.current]?.position)
  .map(e=>({entry:e,distance:Math.hypot(...['x','y','z'].map(k=>e.graph.nodes[e.graph.current].position[k]-actual[k]))}))
  .filter(e=>e.distance<=32).sort((a,b)=>a.distance-b.distance);
 if(!eligible.length)return null;
 const {entry,distance}=eligible[0];
 return {search:entry,history:entries.filter(e=>e!==entry),evidence:{retainedGraphs:entries.length,
  selectedCurrent:entry.graph.current,actualDistance:distance,newSegmentCredit:false,newNodeOrVisitCredit:false,
  oldEdgeTraversalCredit:false,budgetsReset:false}};
}
module.exports={reuseNearbyFieldWoodGraph};
