'use strict';
// A failed local graph rejoin must use the existing bounded camp recovery
// (including checked digging), rather than repeatedly chasing surface targets
// from a cave. Neither branch grants arrival or inventory credit.
async function returnHouseResourceExploration(deps) {
  deps.assertActive();
  try {
    await deps.rejoin();
  } catch (error) {
    deps.assertActive();
    if (!/^house_surface_dry_graph_(native_no_path|probe_inconclusive|movement_timeout|leg_timeout|route_changed|rejoin_unconfirmed)$/.test(String(error.code || '')))
      throw error;
    deps.onCampRecovery?.(error);
    deps.assertActive();
    await deps.returnCamp();
  }
  deps.assertActive();
}
// Only after a physically verified camp return: do not replay a lower branch
// that required an escape staircase. Preserve all historical nodes and stocks.
function deferEscapedExplorationBranch(graph, minimumY, actual) {
  if(!graph||!Number.isSafeInteger(minimumY)||graph.pendingWater||graph.pendingDryTrail)return false;
  const key=p=>`${p?.x},${p?.y},${p?.z}`;
  if(key(actual)!==key(graph.anchor)||graph.current!==key(actual))return false;
  const seen=new Set();let id=graph.resumeNode,bad=null;
  while(id&&graph.nodes?.[id]&&seen.size<512){
    if(seen.has(id))return false;seen.add(id);
    if(graph.nodes[id].position.y>=minimumY)break;
    bad=id;id=graph.nodes[id].parent;
  }
  if(!bad||!id||!graph.nodes[id])return false;
  const invalid=new Set([bad]);let changed=true;
  while(changed){changed=false;for(const [node,value]of Object.entries(graph.nodes))
    if(invalid.has(value.parent)&&!invalid.has(node)){invalid.add(node);changed=true;}}
  if(invalid.has(graph.current))return false;
  for(const node of invalid)graph.nodes[node].terrainUnavailable={at:Date.now(),reason:'return_required_escape_digging',minimumY,scope:'exploration_replay'};
  graph.frontier=(graph.frontier||[]).filter(edge=>!invalid.has(edge.parent)&&!invalid.has(key(edge.target)));
  graph.blockedEdges||=[];graph.blockedEdges.push({kind:'escaped_exploration_branch',targetNode:bad,minimumY,reason:'return_required_escape_digging',actualCampReturnConfirmed:true});
  graph.resumeNode=graph.current;
  return true;
}
module.exports = { returnHouseResourceExploration, deferEscapedExplorationBranch };
