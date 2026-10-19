'use strict';
// Negative observations are local to an actual approach position and block
// state. They deny repeated work; they never establish global unreachability.
const point=p=>p&&['x','y','z'].every(k=>Number.isFinite(p[k]));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const same=(a,b)=>a.x===b.x&&a.y===b.y&&a.z===b.z;
const valid=e=>e&&point(e.target)&&point(e.origin)&&typeof e.name==='string'&&Number.isInteger(e.stateId);
function canRetryResource(entries,block,origin,{approachRevision}={}){
  if(!point(origin)||!point(block?.position))return false;
  return !(Array.isArray(entries)?entries:[]).some(e=>valid(e)&&(approachRevision===undefined||(e.approachRevision??1)===approachRevision)&&same(e.target,block.position)
    &&e.name===block.name&&e.stateId===block.stateId&&distance(e.origin,origin)<32
    &&!(distance(e.origin,origin)>=4&&distance(origin,block.position)<=distance(e.origin,block.position)-4));
}
function rememberResourceFailure(entries,block,origin,{approachRevision}={}){
  if(!point(origin)||!point(block?.position)||!Number.isInteger(block.stateId))return Array.isArray(entries)?entries:[];
  return [...(Array.isArray(entries)?entries:[]).filter(e=>valid(e)&&(!same(e.target,block.position)||approachRevision!==undefined&&(e.approachRevision??1)!==approachRevision)),
    {target:{x:block.position.x,y:block.position.y,z:block.position.z},name:block.name,stateId:block.stateId,
      origin:{x:origin.x,y:origin.y,z:origin.z},...(approachRevision===undefined?{}:{approachRevision})}].slice(-256);
}
function forgetResourceFailuresNear(entries,changed){
  return (Array.isArray(entries)?entries:[]).filter(e=>valid(e)&&(!point(changed)||distance(e.target,changed)>4));
}
module.exports={canRetryResource,rememberResourceFailure,forgetResourceFailuresNear};
