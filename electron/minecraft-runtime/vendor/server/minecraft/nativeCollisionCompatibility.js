'use strict';
// prismarine-physics 1.11.0 loses a contacting block when subtracting player
// half-width gives 31.999999999999996 instead of32. Resolve numerical contact
// in collision queries, never by assigning player position/velocity or blocks.
const AABB=require('prismarine-physics/lib/aabb');
const version=require('prismarine-physics/package.json').version;
const marker=Symbol.for('deskpet.nativeCollisionContactCompatibility');
function installNativeCollisionCompatibility(protocolVersion){
 if(protocolVersion!=='1.21.8'||version!=='1.11.0')return false;
 if(AABB.prototype[marker])return true;
 const epsilon=1e-9;
 for(const axis of ['X','Y','Z']){
  const name=`computeOffset${axis}`,original=AABB.prototype[name],otherAxes=['X','Y','Z'].filter(a=>a!==axis);
  AABB.prototype[name]=function(other,offset){
   if(otherAxes.every(a=>other[`max${a}`]>this[`min${a}`]+epsilon&&other[`min${a}`]<this[`max${a}`]-epsilon)){
    const positiveGap=this[`min${axis}`]-other[`max${axis}`],negativeGap=other[`min${axis}`]-this[`max${axis}`];
    if(offset>0&&positiveGap<0&&positiveGap>=-epsilon)return 0;
    if(offset<0&&negativeGap<0&&negativeGap>=-epsilon)return 0;
   }
   return original.call(this,other,offset);
  };
 }
 const originalIntersects=AABB.prototype.intersects;
 AABB.prototype.intersects=function(other){
  if(!originalIntersects.call(this,other))return false;
  return ['X','Y','Z'].every(a=>Math.min(this[`max${a}`],other[`max${a}`])-Math.max(this[`min${a}`],other[`min${a}`])>epsilon);
 };
 Object.defineProperty(AABB.prototype,marker,{value:true});return true;
}
module.exports={installNativeCollisionCompatibility};
