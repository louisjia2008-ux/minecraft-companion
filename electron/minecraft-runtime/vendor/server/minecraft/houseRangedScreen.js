'use strict';
const {classifyMiningBlock}=require('./miningNavigation');
const {ANY_PLANKS,LOG_TO_PLANK}=require('./taskCatalog');
const RANGED_SCREEN_ITEMS=Object.freeze(['dirt','cobblestone',...ANY_PLANKS,...Object.keys(LOG_TO_PLANK)]);
function loadedCoverThreats(bot,terrainSeparated=()=>false){
 const {isThreateningMobEntity}=require('./entitySemantics');
 return Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&e.isValid!==false&&e.position
   &&isThreateningMobEntity(e,bot.registry)&&Math.abs(e.position.y-bot.entity.position.y)<=8
   &&!terrainSeparated(bot,e)&&e.position.distanceTo(bot.entity.position)<=24)
   // A distant walking mob cannot veto the first wall against an actual
   // shooter. Nearby contact/blast threats still block an unsuitable screen.
   .filter(e=>['skeleton','stray','bogged','witch'].includes(e.name)
     ||e.position.distanceTo(bot.entity.position)<=(e.name==='creeper'?8.5:4.5));
}
function crosses(from,to,p){
 let lo=0,hi=1;
 for(const axis of ['x','y','z']){
  const d=to[axis]-from[axis];if(Math.abs(d)<1e-9){if(from[axis]<p[axis]||from[axis]>p[axis]+1)return false;continue;}
  const a=(p[axis]-from[axis])/d,b=(p[axis]+1-from[axis])/d;lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b));
 }
 return lo<=hi&&lo<1&&hi>0;
}
// Only the observed lines of fire need temporary walls. Unlike a complete
// enclosure this can protect a survivor carrying fewer than16 blocks. The
// executor must still verify every native body ray after actual placement.
function planRangedScreen({position,threats,blockAt,inventory,excluded=()=>false}){
 if(!position||Math.abs(position.y-Math.round(position.y))>.075||!threats.length
  ||threats.some(e=>!['skeleton','stray','bogged','drowned'].includes(e.name)||!e.position))return null;
 const y=Math.round(position.y),loX=Math.floor(position.x-.30001)-1,hiX=Math.floor(position.x+.30001)+1,
  loZ=Math.floor(position.z-.30001)-1,hiZ=Math.floor(position.z+.30001)+1;
 const rays=[];
 for(const e of threats)for(const dy of [.6,1.2,1.62])for(const [dx,dz]of [[-.25,-.25],[.25,.25],[-.25,.25],[.25,-.25]])rays.push({
  from:{x:e.position.x,y:e.position.y+(e.eyeHeight||(e.height||1.99)*.9),z:e.position.z},
  to:{x:position.x+dx,y:y+dy,z:position.z+dz}});
 const candidates=[];
 for(let x=loX;x<=hiX;x++)for(let z=loZ;z<=hiZ;z++){
  if(x!==loX&&x!==hiX&&z!==loZ&&z!==hiZ)continue;
  const column=[{x,y,z},{x,y:y+1,z}],needs=[];
  if(!classifyMiningBlock(blockAt({x,y:y-1,z})).support)continue;
  let safe=true;for(const p of column){const c=classifyMiningBlock(blockAt(p));
   if(!c.loaded||c.hazard||c.gravity){safe=false;break;}
   if(c.support)continue;if(!c.passable||excluded(p)){safe=false;break;}needs.push(p);
  }
  if(safe)candidates.push({column,needs,hits:rays.map((r,i)=>column.some(p=>crosses(r.from,r.to,p))?i:-1).filter(i=>i>=0)});
 }
 const remaining=new Set(rays.map((_,i)=>i)),stock=Object.fromEntries(RANGED_SCREEN_ITEMS.map(name=>[name,Math.max(0,Math.floor(inventory[name]||0))])),blocks=[];
 for(let tries=0;remaining.size&&tries<8;tries++){
  const available=candidates.filter(c=>c.needs.length<=Object.values(stock).reduce((a,b)=>a+b,0)&&c.hits.some(i=>remaining.has(i)))
   .sort((a,b)=>b.hits.filter(i=>remaining.has(i)).length-a.hits.filter(i=>remaining.has(i)).length||a.needs.length-b.needs.length);
  const c=available[0];if(!c)return null;
  for(const p of c.needs){const item=RANGED_SCREEN_ITEMS.find(name=>stock[name]>0);stock[item]--;blocks.push({id:`ranged-screen:${p.x},${p.y},${p.z}`,position:p,item,properties:{}});}
  c.hits.forEach(i=>remaining.delete(i));candidates.splice(candidates.indexOf(c),1);
 }
 if(remaining.size||blocks.length>16)return null;
 return {blocks,actualProtectionConfirmed:false,fullEnclosure:false};
}
module.exports={planRangedScreen,RANGED_SCREEN_ITEMS,loadedCoverThreats};
