/* global module */
'use strict';
// This chooses between already validated bank directions, never a new route.
function waterThreatEscapeForward(route, actual, threats) {
  const valid=p=>p&&['x','y','z'].every(k=>Number.isFinite(p[k]));
  if(!valid(route?.from)||!valid(route?.to)||!valid(actual)||!Array.isArray(threats)||!threats.length)return false;
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
  const destination={x:route.to.x+.5,y:route.to.y,z:route.to.z+.5};
  const origin={x:route.from.x+.5,y:route.from.y,z:route.from.z+.5};
  return threats.every(threat=>valid(threat.position)
    &&distance(destination,threat.position)>=16
    &&distance(destination,threat.position)>=distance(origin,threat.position)+8
    &&distance(destination,threat.position)>=distance(actual,threat.position)+4);
}
module.exports={waterThreatEscapeForward};
