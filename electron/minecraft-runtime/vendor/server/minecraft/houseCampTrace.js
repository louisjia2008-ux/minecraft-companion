'use strict';
// A chronological walk contains work loops. Revisiting an actually observed
// cell closes that loop; it does not authorize any unobserved shortcut.
function appendObservedCampPoint(path, point, anchor, limit = 4096) {
  const valid=p=>p&&['x','y','z'].every(k=>Number.isSafeInteger(p[k]));
  const same=(a,b)=>a&&b&&['x','y','z'].every(k=>a[k]===b[k]);
  if(!Array.isArray(path)||!valid(point)||!valid(anchor)||!Number.isSafeInteger(limit)||limit<1||limit>4096
    ||path.length>limit||!path.every(valid)) throw new TypeError('Invalid bounded observed camp trace');
  if(same(point,anchor))return [{...point}];
  if(same(path.at(-1),point))return path;
  const at=path.findLastIndex(p=>same(p,point));
  if(at>=0)return path.slice(0,at+1);
  if(path.length>=limit)throw Object.assign(new Error('营地操作实际路线超过有限观察上限'),{code:'house_surface_camp_work_route_limit'});
  return [...path,{...point}];
}
// Choose a shorter already-observed chronology only when it keeps the
// required known graph node. It never creates an edge or touches source memory.
function compactObservedReturnTrace(path,{anchor,requiredNode,pendingTransport=false}={}){
 const key=p=>`${p?.x},${p?.y},${p?.z}`;
 if(pendingTransport||!Array.isArray(path)||!path.length||path.length>4096||key(path[0])!==key(anchor))return {path,removed:0};
 let compact=[];for(const p of path)compact=appendObservedCampPoint(compact,p,anchor);
 if(requiredNode&&!compact.some(p=>key(p)===requiredNode))return {path,removed:0};
 return {path:compact,removed:path.length-compact.length};
}
module.exports={appendObservedCampPoint,compactObservedReturnTrace};
