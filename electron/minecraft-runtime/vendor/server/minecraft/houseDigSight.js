'use strict';
const {isNaturalHouseTerrain}=require('./houseNaturalTerrain');
function canSeeHouseDigTarget(bot,target,feet){
 const block=bot.blockAt(target);if(!block)return false;
 const eye=feet.offset(0,Number(bot.entity.eyeHeight)||1.62,0),delta=target.offset(.5,.5,.5).minus(eye);
 if(delta.norm()>4.5)return false;
 if(!bot.world?.raycast)return true;
 // Native raycast skips plants without collision shapes. Only these natural
 // targets may use a clear segment instead of requiring a solid target hit.
 if(block.boundingBox==='empty'&&Array.isArray(block.shapes)&&block.shapes.length===0&&isNaturalHouseTerrain(block.name)){
  const hit=bot.world.raycast(eye,delta.normalize(),delta.norm());return !hit||hit.position?.equals(target)===true;
 }
 const hit=bot.world.raycast(eye,delta.normalize(),4.5);return hit?.position?.equals(target)===true;
}
module.exports={canSeeHouseDigTarget};
