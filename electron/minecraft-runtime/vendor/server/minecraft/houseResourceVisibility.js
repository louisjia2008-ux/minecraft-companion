'use strict';
const {Vec3}=require('vec3');
const {RaycastIterator}=require('prismarine-world/src/iterators');
function firstLoadedResourceShape(bot,target,{assertActive=()=>{}}={}){
 assertActive();const p=bot.entity?.position,height=bot.entity?.eyeHeight??1.62;
 if(!p||!Number.isFinite(height)||height<=0||height>2||!target?.position
   ||!['x','y','z'].every(k=>Number.isFinite(p[k])&&Number.isSafeInteger(target.position[k]))
   ||!Number.isSafeInteger(target.stateId)||bot.canDigBlock?.(target)!==true)return null;
 const eye=p.offset(0,height,0),delta=target.position.offset(.5,.5,.5).minus(eye),length=delta.norm();
 if(!Number.isFinite(length)||length<=0||length>5.4)return null;
 const direction=delta.scaled(1/length),range=Math.min(4.5,length+1e-6),iterator=new RaycastIterator(eye,direction,range);
 let cell=eye.floored();
 for(let reads=0;cell&&reads<32;reads++,cell=iterator.next()){
  assertActive();const position=new Vec3(Math.floor(cell.x),Math.floor(cell.y),Math.floor(cell.z)),b=bot.blockAt(position);assertActive();
  if(!b||typeof b.name!=='string'||!b.position?.equals(position)||!Number.isSafeInteger(b.stateId)||!Array.isArray(b.shapes)
    ||b.shapes.some(s=>!Array.isArray(s)||s.length!==6||s.some(v=>!Number.isFinite(v)))
    ||['water','lava','bubble_column'].includes(b.name)||[true,'true'].includes(b.getProperties?.().waterlogged))return null;
  const hit=iterator.intersect(b.shapes,position);if(!hit)continue;
  const traveled=hit.pos.minus(eye).dot(direction);if(traveled<0||traveled>4.5+1e-6)return null;
  return {block:b,hitDistance:traveled,readCount:reads+1,maximumReach:4.5,actualEye:{x:eye.x,y:eye.y,z:eye.z}};
 }
 return null;
}
// Resource-only fallback for installed canSeeBlock's corner-distance ray.
// No native API/physics is patched; only a fresh exact first shape hit counts.
function hasHouseResourceSight(bot,target,{assertActive=()=>{},onRecovered}={}){
 assertActive();if(typeof bot.canSeeBlock!=='function')return true;
 if(bot.canSeeBlock(target)===true){assertActive();return true;}
 const observed=firstLoadedResourceShape(bot,target,{assertActive}),b=observed?.block;
 if(!b||!b.position.equals(target.position)||b.name!==target.name||b.stateId!==target.stateId)return false;
 assertActive();onRecovered?.({target:{x:b.position.x,y:b.position.y,z:b.position.z},stateId:b.stateId,
  actualEye:observed.actualEye,hitDistance:observed.hitDistance,readCount:observed.readCount,maximumReach:4.5,
  nativeCanSeeBlockConfirmed:false,actualFirstShapeHitConfirmed:true,movementOrMaterialCredit:false});return true;
}
module.exports={hasHouseResourceSight,firstLoadedResourceShape};
