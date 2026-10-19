'use strict';
const {classifyMiningBlock}=require('./miningNavigation');
const key=p=>`${p.x},${p.y},${p.z}`;
// Search only loaded, naturally supported, connected dry ground. This planner
// never digs, places blocks or turns an unobserved route into travel credit.
function planHouseCampRelocation({from,blockAt,excluded=()=>false,threatened=()=>false,stepAllowed=()=>true,radius=16,maxNodes=1200,preferNearby=false}){
 const cell=p=>classifyMiningBlock(blockAt(p));
 const foot=p=>cell(p).passable&&cell({...p,y:p.y+1}).passable&&cell({...p,y:p.y-1}).support;
 if(!foot(from))return null;
 const nodes=new Map([[key(from),{position:{...from},path:[{...from}]}]]),queue=[nodes.get(key(from))];
 for(let i=0;i<queue.length&&nodes.size<maxNodes;i++){
  const current=queue[i];
  for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])for(const dy of [0,1,-1]){
   const p={x:current.position.x+dx,y:current.position.y+dy,z:current.position.z+dz};
   if(nodes.has(key(p))||Math.hypot(p.x-from.x,p.z-from.z)>radius||Math.abs(p.y-from.y)>6||!foot(p)||!stepAllowed(p))continue;
   if(dy===1&&!cell({...current.position,y:current.position.y+2}).passable||dy===-1&&!cell({...p,y:p.y+2}).passable)continue;
   const next={position:p,path:[...current.path,p]};nodes.set(key(p),next);queue.push(next);
  }
 }
 const candidates=[...nodes.values()].filter(n=>!excluded(n.position)&&[-1,0,1].every(dx=>[-1,0,1].every(dz=>{
  const p={...n.position,x:n.position.x+dx,z:n.position.z+dz};return foot(p)&&!excluded(p)&&!threatened(p);
 })));
 candidates.sort((a,b)=>preferNearby?a.path.length-b.path.length||b.position.y-a.position.y:b.position.y-a.position.y||a.path.length-b.path.length);
 for(const n of candidates){
  const sites=[...nodes.values()].map(v=>v.position).filter(p=>p.y===n.position.y&&!excluded(p)&&!threatened(p)&&Math.hypot(p.x-n.position.x,p.z-n.position.z)>=2&&Math.hypot(p.x-n.position.x,p.z-n.position.z)<=8);
  sites.sort((a,b)=>Math.hypot(a.x-n.position.x,a.z-n.position.z)-Math.hypot(b.x-n.position.x,b.z-n.position.z));
  // Keep separate container footprints; chest adjacency would merge ownership.
  const chosen=[];for(const p of sites)if(chosen.every(q=>Math.abs(p.x-q.x)+Math.abs(p.z-q.z)>=2))chosen.push(p);
  if(chosen.length>=10)return{camp:{anchor:n.position,stations:{crafting_table:chosen[0],furnace:chosen[1]},storageSites:chosen.slice(2,10)},path:n.path};
 }
 return null;
}
module.exports={planHouseCampRelocation};
