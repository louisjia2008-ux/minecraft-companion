'use strict';
// Archive an interrupted search, with no traversal/success credit, only after
// the actor is observed on dry ground well outside its entire swim segment.
function isDisplacedFieldWaterSearch(search, actual) {
  const finite=p=>p&&['x','y','z'].every(k=>Number.isFinite(p[k]));
  const graph=search?.graph,route=graph?.pendingWater?.edge?.transport?.route;
  if(graph?.pendingDryTrail||route?.kind!=='loaded_surface_swim'||!finite(actual)||!finite(route.from)||!finite(route.to))return false;
  const delta=['x','y','z'].map(k=>route.to[k]-route.from[k]);
  const length2=delta.reduce((sum,d)=>sum+d*d,0);
  if(!length2)return false;
  const t=Math.max(0,Math.min(1,delta.reduce((sum,d,i)=>sum+d*(actual[['x','y','z'][i]]-route.from[['x','y','z'][i]]),0)/length2));
  return Math.hypot(...delta.map((d,i)=>actual[['x','y','z'][i]]-route.from[['x','y','z'][i]]-t*d))>32;
}
module.exports={isDisplacedFieldWaterSearch};
