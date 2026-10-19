'use strict';
const retryable=e=>e?.name==='NoPath'||['house_surface_dry_graph_native_no_path','house_surface_dry_graph_rejoin_unconfirmed','NoPath','house_NoPath'].includes(e?.code);
// An old surface waypoint may be above an actual ravine landing. Try short
// physically checked upward passages, without inventing traversal of the old
// edge. False requests fresh exploration from the real current stance.
async function rejoinOwnedCampRoute(deps){
 for(let attempt=0;attempt<=3;attempt++){
  deps.assertActive();if(Date.now()>=deps.deadline)throw Object.assign(Error('返营接续达到原总时限'),{code:'house_owned_stock_visit_timeout'});
  try{await deps.rejoin();deps.assertActive();return true;}
  catch(error){
   deps.assertActive();if(!retryable(error))throw error;
   const before=deps.position();
   if(attempt===3||!deps.target||deps.target.y<=before.y)return false;
   if(!await deps.recover(deps.target,Math.min(deps.deadline,Date.now()+20000)))return false;
   deps.assertActive();const after=deps.position();
   if(after.y<=before.y+.5)return false;
   deps.record?.({before,after,target:deps.target,attempt:attempt+1,oldRouteTraversalCredit:false});
  }
 }
 return false;
}
module.exports={rejoinOwnedCampRoute};
