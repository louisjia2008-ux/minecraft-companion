'use strict';
const {classifyMiningBlock}=require('./miningNavigation');
const cellKey=p=>`${p.x},${p.y},${p.z}`;
const emergencyCoverThreatSupported=e=>['skeleton','stray','bogged','zombie','zombie_villager','husk','drowned'].includes(e?.name);
const requiredEmergencyCoverCell=(plan,p)=>plan.cornerPolicy==='corners_first'||!(
 [plan.bounds.loX,plan.bounds.hiX].includes(p.x)&&[plan.bounds.loZ,plan.bounds.hiZ].includes(p.z));
// A small temporary survival shelter uses carried blocks, real placement and
// observed geometry. Planning never changes the world or grants protection.
function planEmergencyShelter({position,threat,blockAt,inventory,excluded=()=>false}){
 if(!position||!threat||![position.x,position.y,position.z,threat.x,threat.y,threat.z].every(Number.isFinite)
   ||Math.abs(position.y-Math.round(position.y))>.075)return null;
 const y=Math.round(position.y),loX=Math.floor(position.x-.30001)-1,hiX=Math.floor(position.x+.30001)+1,
   loZ=Math.floor(position.z-.30001)-1,hiZ=Math.floor(position.z+.30001)+1;
 const columns=[];
 for(let x=loX;x<=hiX;x++)for(let z=loZ;z<=hiZ;z++)if(x===loX||x===hiX||z===loZ||z===hiZ)columns.push({x,z});
 const dx=threat.x-position.x,dz=threat.z-position.z;
 const entry=p=>{
  let near=0,far=1;
  for(const [v,d,a]of [[position.x,dx,p.x],[position.z,dz,p.z]]){
   if(Math.abs(d)<1e-9){if(v<a||v>a+1)return Infinity;continue;}
   const t1=(a-v)/d,t2=(a+1-v)/d;near=Math.max(near,Math.min(t1,t2));far=Math.min(far,Math.max(t1,t2));
  }
  return near<=far?near:Infinity;
 };
 const corner=p=>Number([loX,hiX].includes(p.x)&&[loZ,hiZ].includes(p.z));
 // Stop the actual line of fire before building remote corners.
 columns.sort((a,b)=>entry(a)-entry(b)||corner(b)-corner(a)||Math.hypot(a.x+.5-threat.x,a.z+.5-threat.z)-Math.hypot(b.x+.5-threat.x,b.z+.5-threat.z));
 const structure=columns.flatMap(p=>[0,1].map(dy=>({...p,y:y+dy})));
 // Two-block walls interrupt nearby horizontal ranged fire. This is an
 // open-top temporary cover, never a completed house or all-threat shelter.
 if(structure.length>32)return null;
 const stock={dirt:inventory.dirt||0,cobblestone:inventory.cobblestone||0},blocks=[];
 for(const p of structure){
  const current=classifyMiningBlock(blockAt(p));
  if(!current.loaded||current.hazard||current.gravity)return null;
  if(current.support)continue;
  if(!current.passable||excluded(p))return null;
  if(p.y===y&&!classifyMiningBlock(blockAt({...p,y:y-1})).support)return null;
  const item=stock.dirt>0?'dirt':stock.cobblestone>0?'cobblestone':null;if(!item)return null;stock[item]--;
  blocks.push({id:`emergency-cover:${cellKey(p)}`,position:p,item,properties:{}});
 }
 return {schema:1,cornerPolicy:'corners_first',origin:{...position},bounds:{loX,hiX,loZ,hiZ,y},structure,blocks,actualProtectionConfirmed:false};
}
function planEmergencyRoof({plan,blockAt,inventory,excluded=()=>false}){
 const b=plan?.bounds;if(!b)return null;
 const remaining=[];for(let x=b.loX+1;x<b.hiX;x++)for(let z=b.loZ+1;z<b.hiZ;z++)remaining.push({x,y:b.y+2,z});
 const pending=remaining.filter(p=>!classifyMiningBlock(blockAt(p)).support),ready=new Set(),blocks=[],stock={dirt:inventory.dirt||0,cobblestone:inventory.cobblestone||0};
 while(pending.length){
  const index=pending.findIndex(p=>[[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dz])=>ready.has(cellKey({...p,x:p.x+dx,z:p.z+dz}))||classifyMiningBlock(blockAt({...p,x:p.x+dx,z:p.z+dz})).support));
  if(index<0){
   // Raise one supported perimeter cap before connecting the interior roof.
   // This is only a placement plan; protection still needs actual block reads.
   const cap=plan.structure.filter(p=>p.y===b.y+1).map(p=>({...p,y:b.y+2})).find(p=>{
    const c=classifyMiningBlock(blockAt(p));return c.loaded&&c.passable&&!c.hazard&&!c.gravity&&!excluded(p)
     &&classifyMiningBlock(blockAt({...p,y:p.y-1})).support
     &&pending.some(q=>Math.abs(q.x-p.x)+Math.abs(q.z-p.z)===1);
   });
   const item=stock.dirt>0?'dirt':stock.cobblestone>0?'cobblestone':null;
   if(!cap||!item||ready.has(cellKey(cap)))return null;stock[item]--;
   blocks.push({id:`emergency-roof:${cellKey(cap)}`,position:cap,item,properties:{}});ready.add(cellKey(cap));remaining.push(cap);continue;
  }
  const p=pending.splice(index,1)[0],cell=classifyMiningBlock(blockAt(p));if(!cell.loaded||!cell.passable||cell.hazard||cell.gravity||excluded(p))return null;
  const item=stock.dirt>0?'dirt':stock.cobblestone>0?'cobblestone':null;if(!item)return null;stock[item]--;
  blocks.push({id:`emergency-roof:${cellKey(p)}`,position:p,item,properties:{}});ready.add(cellKey(p));
 }
 return {structure:remaining,blocks};
}
function selectEmergencyExit({plan,placed,position,threat}){
 const b=plan?.bounds;if(!b)return null;
 const candidates=placed.filter(p=>p.position.y===b.y&&!([b.loX,b.hiX].includes(p.position.x)&&[b.loZ,b.hiZ].includes(p.position.z))
  &&placed.some(q=>q.position.x===p.position.x&&q.position.z===p.position.z&&q.position.y===b.y+1));
 if(!threat){candidates.sort((a,b)=>Math.hypot(a.position.x+.5-position.x,a.position.z+.5-position.z)-Math.hypot(b.position.x+.5-position.x,b.position.z+.5-position.z));return candidates[0]?.position||null;}
 const dx=threat.x-position.x,dz=threat.z-position.z,length=dx*dx+dz*dz;
 const score=p=>{const x=p.position.x+.5-position.x,z=p.position.z+.5-position.z,t=length?(x*dx+z*dz)/length:0;
  return (t>=0?1000:0)+Math.hypot(x-dx*t,z-dz*t)+Math.hypot(x,z)*.01;};
 candidates.sort((a,b)=>score(a)-score(b));return candidates[0]?.position||null;
}
function emergencyShelterConfirmed({plan,position,blockAt,threats=[],raycast}){
 if(!plan?.bounds||!Array.isArray(plan.structure))return false;
 const b=plan.bounds;
 let roof=true;for(let x=b.loX+1;x<b.hiX;x++)for(let z=b.loZ+1;z<b.hiZ;z++)if(!classifyMiningBlock(blockAt({x,y:b.y+2,z})).support)roof=false;
 let raisedApproach=false;
 // A zombie can step onto a two-high wall from adjacent higher ground.
 // Unknown approach cells cannot establish the absence of that route.
 for(let x=b.loX-1;x<=b.hiX+1;x++)for(let z=b.loZ-1;z<=b.hiZ+1;z++)if(x===b.loX-1||x===b.hiX+1||z===b.loZ-1||z===b.hiZ+1){
  const cell=classifyMiningBlock(blockAt({x,y:b.y,z}));if(!cell.loaded||cell.support)raisedApproach=true;
 }
 const enclosed=position.x-.3>b.loX+1-1e-6&&position.x+.3<b.hiX+1e-6
  &&position.z-.3>b.loZ+1-1e-6&&position.z+.3<b.hiZ+1e-6&&Math.abs(position.y-b.y)<.075
  &&threats.every(e=>emergencyCoverThreatSupported(e)&&(roof||e.position.y+(e.height||1.8)<b.y+2)
    &&(roof||!['zombie','zombie_villager','husk','drowned'].includes(e.name)||!raisedApproach)
    &&(e.position.x<b.loX||e.position.x>b.hiX+1||e.position.z<b.loZ||e.position.z>b.hiZ+1))
  &&plan.structure.filter(p=>requiredEmergencyCoverCell(plan,p)).every(p=>classifyMiningBlock(blockAt(p)).support);
 if(!enclosed)return false;
 if(threats.length&&typeof raycast!=='function')return false;
 for(const threat of threats)for(const dy of [.6,1.2,1.62])for(const [dx,dz]of [[-.25,-.25],[.25,.25],[-.25,.25],[.25,-.25]]){
  const from={x:threat.position.x,y:threat.position.y+(threat.eyeHeight||(threat.height||1.8)*.9),z:threat.position.z};
  const to={x:position.x+dx,y:position.y+dy,z:position.z+dz};
  let hit;try{hit=raycast(from,to);}catch{return false;}
  if(!hit||!classifyMiningBlock(hit).support)return false;
 }
 return true;
}
module.exports={planEmergencyShelter,planEmergencyRoof,selectEmergencyExit,emergencyShelterConfirmed,requiredEmergencyCoverCell,emergencyCoverThreatSupported};
