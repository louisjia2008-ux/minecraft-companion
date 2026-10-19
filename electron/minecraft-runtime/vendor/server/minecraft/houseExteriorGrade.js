'use strict';
const {isNaturalHouseTerrain}=require('./houseNaturalTerrain');
const air=b=>b&&['air','cave_air','void_air'].includes(b.name);
const solid=b=>b&&b.boundingBox==='block'&&!b.name.endsWith('_leaves')&&isNaturalHouseTerrain(b.name)
  &&b.getProperties?.().waterlogged!==true;
// Repair only the previously cleared outer strip. The current adjacent grade
// supplies the height; no guessed original terrain or wider flattening.
function planHouseExteriorGrade(blueprint,blockAt){
 const b=blueprint.bounds,y=blueprint.anchor.y,protectedColumns=new Set([
  ...(blueprint.clearance||[]).map(p=>p.position),...(blueprint.scaffoldRoute||[]),blueprint.entrance.outside
 ].map(p=>`${p.x},${p.z}`));
 const plan=[];
 for(let x=b.minX;x<=b.maxX;x++)for(let z=b.minZ;z<=b.maxZ;z++){
  if(x!==b.minX&&x!==b.maxX&&z!==b.minZ&&z!==b.maxZ)continue;
  if(protectedColumns.has(`${x},${z}`))continue;
  const exterior=[];
  if(x===b.minX)exterior.push({x:x-1,z});if(x===b.maxX)exterior.push({x:x+1,z});
  if(z===b.minZ)exterior.push({x,z:z-1});if(z===b.maxZ)exterior.push({x,z:z+1});
  // Loaded natural neighbours only; maximum two soil layers, leaving windows
  // (floor+2) and all existing roof/door/route cells unobstructed.
  let height=y-1;
  for(const p of exterior)for(let h=y;h<=y+1;h++)if(solid(blockAt({...p,y:h})))height=Math.max(height,h);
  let footing=blockAt({x,y:y-1,z});
  for(let h=y;h<=height;h++){
   const p={x,y:h,z},actual=blockAt(p);
   if(solid(actual)){footing=actual;continue;}
   if(!air(actual)||!solid(footing))break;
   if(blueprint.blocks.some(s=>s.position.x===x&&s.position.y===h&&s.position.z===z))break;
   plan.push({id:`exterior:${x},${h},${z}`,position:p,item:'dirt',phase:'exterior'});
   footing={name:'dirt',boundingBox:'block'};
  }
 }
 return plan.sort((a,b)=>a.position.y-b.position.y);
}
module.exports={planHouseExteriorGrade};
