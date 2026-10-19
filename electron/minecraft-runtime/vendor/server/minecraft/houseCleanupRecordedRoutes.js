'use strict';
const integer=p=>p&&['x','y','z'].every(k=>Number.isSafeInteger(p[k]));
const key=p=>`${p.x},${p.y},${p.z}`;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
// These are approach hints only. The existing graph executor or a fresh
// conclusive native connector must still authorize every physical movement.
function recordedCleanupRoutes(material,actual,destination,safeFoot){
 if(!integer(actual)||!integer(destination))return [];
 const result=[];
 for(const [index,old]of(material.retiredCamps||[]).entries()){
  for(const [resource,graph]of Object.entries(old.surfaceGraphs||{})){
   if(graph.schema!==2||graph.kind!=='loaded_dry_waypoint_graph'||graph.pendingWater||graph.pendingDryTrail||!integer(graph.anchor))continue;
   const chain=id=>{const path=[],seen=new Set();while(id!=null){if(seen.has(id)||seen.size>=512||!graph.order?.includes(id))return null;
    seen.add(id);const n=graph.nodes?.[id];if(!integer(n?.position)||key(n.position)!==id||n.terrainUnavailable)return null;
    path.push(id);if(id===key(graph.anchor))return path;id=n.parent;}return null;};
   const nodes=(graph.order||[]).map(id=>({id,node:graph.nodes?.[id]})).filter(({node})=>integer(node?.position)&&safeFoot(node.position));
   const targets=nodes.filter(({node})=>distance(node.position,destination)<=96).sort((a,b)=>distance(a.node.position,destination)-distance(b.node.position,destination)).slice(0,3);
   for(const entry of nodes.filter(({node})=>distance(node.position,actual)<=96))for(const target of targets){
    if(distance(target.node.position,destination)+16>distance(entry.node.position,destination))continue;
    const a=chain(entry.id),b=chain(target.id);if(!a||!b)continue;
    const meet=a.find(id=>b.includes(id));if(!meet)continue;
    const ids=[...a.slice(0,a.indexOf(meet)),...b.slice(0,b.indexOf(meet)+1).reverse()];
    const length=ids.slice(1).reduce((n,id,i)=>n+distance(graph.nodes[id].position,graph.nodes[ids[i]].position),0);
    result.push({kind:'surface',index,resource,entry:{...entry.node.position},anchor:{...graph.anchor},targetNodeId:target.id,targetPosition:{...target.node.position},graph,
     score:distance(actual,entry.node.position)+distance(target.node.position,destination)+length*.1});
   }
  }
  for(const [resource,route]of Object.entries(old.quarry?.routes||{}))for(const navigation of [route.navigation,...(route.abandonedNavigations||[]).map(a=>a.navigation)]){
   const trail=navigation?.breadcrumbs;if(!Array.isArray(trail)||trail.length<2||trail.length>1024||trail.some(p=>!integer(p)))continue;
   const target=trail.map((p,i)=>({p,i})).filter(({p})=>distance(p,destination)<=8&&safeFoot(p)).sort((a,b)=>distance(a.p,destination)-distance(b.p,destination))[0];
   if(!target)continue;
   for(let i=0;i<target.i;i++){
    const entry=trail[i];if(distance(actual,entry)>96||!safeFoot(entry)||distance(entry,destination)<distance(target.p,destination)+16)continue;
    const points=trail.slice(i,target.i+1);if(points.length>256||points.some((p,j)=>j&&distance(p,points[j-1])>1.75))continue;
    result.push({kind:'mining',index,resource,entry:{...entry},targetPosition:{...target.p},waypoints:points.map(p=>({...p})),
     score:distance(actual,entry)+distance(target.p,destination)+points.length*.1});
   }
  }
 }
 const entries=new Set();return result.sort((a,b)=>a.score-b.score).filter(c=>{const id=`${c.kind}:${key(c.entry)}`;if(entries.has(id))return false;entries.add(id);return true;}).slice(0,12);
}
module.exports={recordedCleanupRoutes};
