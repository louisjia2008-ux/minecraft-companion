'use strict';

// Reuse actual recorded transport between food searches. A moving frontier
// does not require another trip to camp each time the caller finds no animal.
async function advanceFoodFrontier(deps) {
  deps.assertActive();
  const graph=deps.getCheckpoint(),p=deps.getPosition();
  const current=`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  if(!graph){
    await deps.returnToRoot();deps.assertActive();
    deps.savePath([{...deps.anchor}]);
  }else if(graph.current!==current){
    try{await deps.rejoin();deps.assertActive();}
    catch(error){
      deps.assertActive();
      if(!['house_surface_dry_graph_transport_origin','dry_graph_transport_origin','house_surface_dry_graph_probe_inconclusive','dry_graph_probe_inconclusive'].includes(error.code))throw error;
      // A different owned operation can leave the old water approach. Return
      // physically to its fixed root, then let the SAME strict reconciler
      // settle the old frame. No pending edge is cleared or credited here.
      await deps.returnToRoot();deps.assertActive();
      await deps.rejoin();deps.assertActive();
    }
  }
  const result=await deps.explore();deps.assertActive();
  if(result.via)deps.savePath(result.via);
  return result.moved===true;
}
module.exports={advanceFoodFrontier};
