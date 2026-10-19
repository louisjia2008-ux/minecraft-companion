'use strict';
const {classifyMiningBlock}=require('./miningNavigation');
const soil=new Set(['grass_block','dirt','coarse_dirt','rooted_dirt']);
const failure=(code,message)=>Object.assign(Error(message),{code});
const sides=p=>[[1,0],[-1,0],[0,1],[0,-1]].map(([x,z])=>({...p,x:p.x+x,z:p.z+z}));
function planEmergencyDugout({position,blockAt,excluded=()=>false}){
 if(!position||![position.x,position.y,position.z].every(Number.isFinite)||Math.abs(position.y-Math.round(position.y))>.075)return null;
 const origin={x:Math.floor(position.x),y:Math.round(position.y),z:Math.floor(position.z)};
 if(Math.floor(position.x-.2999)!==origin.x||Math.floor(position.x+.2999)!==origin.x||Math.floor(position.z-.2999)!==origin.z||Math.floor(position.z+.2999)!==origin.z)return null;
 const digs=[1,2,3].map(dy=>({...origin,y:origin.y-dy}));
 if(digs.at(-1).y<=-63)return null;
 for(const p of digs){const cell=classifyMiningBlock(blockAt(p));
  if(!soil.has(cell.name)||!cell.diggable||!cell.support||excluded(p)||!sides(p).every(q=>classifyMiningBlock(blockAt(q)).support))return null;
 }
 if(!classifyMiningBlock(blockAt({...origin,y:origin.y-4})).support)return null;
 return {schema:1,origin,digs,cap:{...origin,y:origin.y-1},floor:{...origin,y:origin.y-4},actualProtectionConfirmed:false};
}
function emergencyDugoutConfirmed({plan,position,blockAt,entities=[]}){
 if(!plan||!position||Math.abs(position.y-(plan.origin.y-3))>.075
  ||Math.floor(position.x-.2999)!==plan.origin.x||Math.floor(position.x+.2999)!==plan.origin.x
  ||Math.floor(position.z-.2999)!==plan.origin.z||Math.floor(position.z+.2999)!==plan.origin.z)return false;
 const foot={...plan.origin,y:plan.origin.y-3},head={...foot,y:foot.y+1};
 if(![plan.cap,plan.floor,...sides(foot),...sides(head)].every(p=>classifyMiningBlock(blockAt(p)).support)
  ||![foot,head].every(p=>classifyMiningBlock(blockAt(p)).passable))return false;
 return !entities.some(e=>e.isValid!==false&&e.position&&e.position.y<plan.cap.y+1&&e.position.y+(e.height||1.8)>foot.y
  &&e.position.x+(e.width||.6)/2>foot.x&&e.position.x-(e.width||.6)/2<foot.x+1
  &&e.position.z+(e.width||.6)/2>foot.z&&e.position.z-(e.width||.6)/2<foot.z+1);
}
async function enterEmergencyDugout(deps,plan){
 const now=deps.now||Date.now,wait=deps.wait||((ms)=>new Promise(r=>setTimeout(r,ms))),deadline=now()+12000;
 for(const p of plan.digs){
  deps.assertActive();const current=deps.observe();
  if(now()>=deadline||Math.floor(current.position.x)!==plan.origin.x||Math.floor(current.position.z)!==plan.origin.z)throw failure('house_dugout_displaced','避难下挖时位置或时限改变');
  const cell=classifyMiningBlock(deps.blockAt(p));
  if(cell.passable&&current.position.y<=p.y+.075)continue;
  if(!soil.has(cell.name)||!cell.support||!sides(p).every(q=>classifyMiningBlock(deps.blockAt(q)).support))throw failure('house_dugout_changed','避难下挖的实际土层或侧壁改变');
  await deps.dig(deps.blockAt(p));deps.assertActive();
  const landDeadline=Math.min(deadline,now()+1500);
  while(true){deps.assertActive();const state=deps.observe();
   if(Math.abs(state.position.y-p.y)<.075&&state.onGround&&classifyMiningBlock(deps.blockAt({...p,y:p.y-1})).support)break;
   if(now()>=landDeadline)throw failure('house_dugout_landing','避难下挖后未实际落稳');await wait(20);
  }
  deps.onProgress?.({kind:'dugout_dig',position:p});
 }
 deps.assertActive();if(now()>=deadline)throw failure('house_dugout_timeout','避难坑封口达到原时限');
 await deps.cap(plan.cap);deps.assertActive();
 const state=deps.observe();
 if(!emergencyDugoutConfirmed({plan,position:state.position,blockAt:deps.blockAt,entities:state.entities}))throw failure('house_dugout_unsealed','避难坑未实际封闭或有生物进入');
 deps.onProgress?.({kind:'dugout_sealed',position:state.position});return {plan,sealed:true};
}
module.exports={planEmergencyDugout,enterEmergencyDugout,emergencyDugoutConfirmed};
