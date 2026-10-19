'use strict';

// Select observations only. The caller must freshly probe and physically walk
// every connector; this grants no graph-node, transport or arrival credit.
function selectHouseCampReturnTrace(supply, graph, actual) {
  const point = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]));
  const key = p => `${p.x},${p.y},${p.z}`;
  const anchor = supply?.camp?.anchor;
  const memory = supply?.surfaceResources;
  if (!point(anchor) || !point(actual) || !point(memory?.anchor)
      || key(memory.anchor) !== key(anchor) || graph?.current !== key(anchor)) return null;
  let selected = null, best = 32;
  for (const search of Object.values(memory.searches || {})) {
    const path = search?.observedPath;
    if (!Array.isArray(path) || path.length < 2 || path.length > 4096
        || !path.every(point) || key(path[0]) !== key(anchor)
        || path.slice(1).some(p => graph.nodes?.[key(p)])) continue;
    const distance = Math.min(...path.map(p => Math.hypot(p.x - actual.x, p.y - actual.y, p.z - actual.z)));
    if (distance < best) { best = distance; selected = path; }
  }
  return selected?.map(p => ({ x: p.x, y: p.y, z: p.z })) || null;
}

function selectHouseCampGraph(supply, target, preferred) {
  const point=p=>p&&['x','y','z'].every(k=>Number.isSafeInteger(p[k]));
  if(!point(target))return null;
  const key=p=>`${p.x},${p.y},${p.z}`,root=key(target),graphs=supply?.surfaceGraphs||{};
  const matches=g=>g?.schema===2&&g.kind==='loaded_dry_waypoint_graph'&&point(g.anchor)
    &&key(g.anchor)===root&&g.order?.includes(root)&&point(g.nodes?.[root]?.position)&&key(g.nodes[root].position)===root;
  if(matches(graphs[preferred]))return preferred;
  return Object.keys(graphs).filter(name=>matches(graphs[name]))
    .sort((a,b)=>Number(graphs[b].current===root)-Number(graphs[a].current===root)
      ||Number(Boolean(graphs[a].pendingWater))-Number(Boolean(graphs[b].pendingWater)))[0]||null;
}
function campReturnRejoinTargets(path,actual,safeFoot){
 if(!Array.isArray(path)||path.length>4096||!actual)return [];
 const seen=new Set();return path.filter(p=>p&&['x','y','z'].every(k=>Number.isSafeInteger(p[k])))
  .filter(p=>{const id=`${p.x},${p.y},${p.z}`;if(seen.has(id))return false;seen.add(id);
   const d=Math.hypot(p.x-actual.x,p.y-actual.y,p.z-actual.z);return d>.5&&d<=96&&safeFoot(p);})
  .sort((a,b)=>Math.hypot(a.x-actual.x,a.y-actual.y,a.z-actual.z)-Math.hypot(b.x-actual.x,b.y-actual.y,b.z-actual.z)).slice(0,8);
}
module.exports = { selectHouseCampReturnTrace, selectHouseCampGraph,campReturnRejoinTargets };
