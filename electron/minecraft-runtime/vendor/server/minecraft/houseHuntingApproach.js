'use strict';
const {goals}=require('mineflayer-pathfinder');
// Keep a moving animal's target fresh at the original one-block cadence,
// while accepting an ordinary two-block melee approach instead of contact.
class HouseFoodApproachGoal extends goals.GoalFollow {
 constructor(entity){super(entity,2);}
 hasChanged(){
  const p=this.entity.position.floored(),dx=this.x-p.x,dy=this.y-p.y,dz=this.z-p.z;
  if(dx*dx+dy*dy+dz*dz>1){this.x=p.x;this.y=p.y;this.z=p.z;return true;}
  return false;
 }
}
module.exports={HouseFoodApproachGoal};
