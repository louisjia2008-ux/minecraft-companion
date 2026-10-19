'use strict';
function canWorkAtOwnedCamp({position,anchor,stations,blockAt,grounded,dry}){
 if(!grounded||!dry||!position||!anchor||Math.abs(position.y-anchor.y)>.075
  ||Math.hypot(position.x-anchor.x-.5,position.z-anchor.z-.5)>2.5)return false;
 return ['crafting_table','furnace'].every(name=>{
  const owned=stations?.[name],p=owned?.position;
  return owned?.confirmedPlaced===true&&p&&blockAt(p)?.name===name
    &&Math.hypot(position.x-p.x-.5,position.y+1.62-p.y-.5,position.z-p.z-.5)<=4.5;
 });
}
module.exports={canWorkAtOwnedCamp};
