'use strict';
const {classifyMiningBlock}=require('./miningNavigation');
const key=p=>`${p.x},${p.y},${p.z}`;
const air=b=>b&&['air','cave_air','void_air'].includes(b.name);
const ownedCoverMatches=(block,spec)=>block&&(block.name===spec.item
 ||spec.item==='dirt'&&['grass_block','mycelium'].includes(block.name))&&require('./houseRangedScreen').RANGED_SCREEN_ITEMS.includes(spec.item);
function rememberCombatCover(material,spec){
 const all=[...(material.defensiveCoverBlocks||[]),...(material.defensiveCover?.placed||[]),spec];
 material.defensiveCoverBlocks=[...new Map(all.filter(Boolean).map(s=>[key(s.position),s])).values()];
}
function combatCover(material){
 return [...new Map([...(material.defensiveCoverBlocks||[]),...(material.defensiveCover?.placed||[])].map(s=>[key(s.position),s])).values()];
}
function transitionCombat(material,phase,facts={},now=Date.now()){
 const old=material.combatMode||{};
 material.combatMode={...(phase==='fighting'&&facts.startedAt!==undefined?{cleanupPending:combatCover(material).length}:old),...facts,phase,updatedAt:now};
 return material.combatMode;
}
// Cleanup grants no travel, excavation or new placement capability. Only
// already-recorded self-built cover in current eye reach may be removed.
async function cleanupCombatCover(deps){
 const material=deps.material,started=Date.now();let removed=0;
 const pending=new Map(combatCover(material).map(s=>[key(s.position),s]));
 const persist=()=>{material.defensiveCoverBlocks=[...pending.values()];
  if(material.defensiveCover)material.defensiveCover.placed=material.defensiveCover.placed.filter(s=>pending.has(key(s.position)));};
 const safe=()=>{deps.assertActive();return !deps.hasThreat()&&deps.grounded()&&deps.dry();};
 if(!safe())return {removed,pending:pending.size,deferred:'threat_or_unstable'};
 for(const spec of [...pending.values()].sort((a,b)=>b.position.y-a.position.y)){
  if(removed>=12||Date.now()-started>4000)break;
  if(!safe()){persist();return {removed,pending:pending.size,deferred:'threat_or_unstable'};}
  const p=spec.position,block=deps.blockAt(p);
  if(air(block)){pending.delete(key(p));continue;}
  if(!ownedCoverMatches(block,spec)){deps.recordSkip?.({position:p,reason:block?'type_changed':'unloaded',actual:block?.name||null});continue;}
  const feet=deps.position(),eye={x:feet.x,y:feet.y+1.62,z:feet.z};
  const reach=Math.hypot(eye.x-p.x-.5,eye.y-p.y-.5,eye.z-p.z-.5);
  if(reach>4.5){deps.recordSkip?.({position:p,reason:'out_of_reach',reach});continue;}
  if(!deps.canSee(p)){deps.recordSkip?.({position:p,reason:'sight_blocked',reach});continue;}
  // Keep every recorded return floor and the actor's actual support.
  if(deps.protectedFloor(p)||p.y<Math.floor(feet.y)&&Math.abs(p.x+.5-feet.x)<.85&&Math.abs(p.z+.5-feet.z)<.85){deps.recordSkip?.({position:p,reason:'protected_support'});continue;}
  if([[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([x,y,z])=>{
   const c=classifyMiningBlock(deps.blockAt({x:p.x+x,y:p.y+y,z:p.z+z}));return !c.loaded||c.hazard||(y===1&&c.gravity);
  })){deps.recordSkip?.({position:p,reason:'hazard_or_unknown_neighbour'});continue;}
  // Revalidate on the immediate write boundary, including a newly arrived mob.
  if(!safe())break;
  await deps.remove(spec,()=>{deps.assertActive();if(deps.hasThreat())throw Object.assign(Error('清理时出现新威胁'),{code:'house_combat_cleanup_preempted'});});
  deps.assertActive();
  if(!air(deps.blockAt(p)))throw Object.assign(Error('服务器未确认掩体移除'),{code:'house_combat_cleanup_unconfirmed'});
  pending.delete(key(p));removed++;persist();deps.record?.({position:p,removed,pending:pending.size});
 }
 persist();return {removed,pending:pending.size,deferred:pending.size?'out_of_reach_or_protected':null};
}
// Final housekeeping can visit deferred owned cover. Each visit is a fresh
// executor operation; a failed/unloaded approach never retires its receipt.
async function sweepCombatCover(deps,{timeoutMs=180000,maxVisits=24}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>180000||!Number.isSafeInteger(maxVisits)||maxVisits<1||maxVisits>24)throw TypeError('Finite cleanup limits required');
 const deadline=Date.now()+timeoutMs,attempted=new Set();let removed=0,visits=0;
 const inspect=()=>combatCover(deps.material).map(spec=>({spec,block:deps.blockAt(spec.position)}));
 while(Date.now()<deadline){
  deps.assertActive();if(deps.hasThreat()||!deps.grounded()||!deps.dry())break;
  const result=await cleanupCombatCover(deps);removed+=result.removed;
  // An unloaded receipt authorizes only an approach request. Demolition
  // still needs a fresh loaded identity, safe neighbours and AIR readback.
  const next=inspect().filter(({spec,block})=>(!block||ownedCoverMatches(block,spec))&&!deps.protectedFloor(spec.position)&&!attempted.has(key(spec.position)))
   .sort((a,b)=>{const p=deps.position();return Math.hypot(a.spec.position.x-p.x,a.spec.position.y-p.y,a.spec.position.z-p.z)-Math.hypot(b.spec.position.x-p.x,b.spec.position.y-p.y,b.spec.position.z-p.z);})[0];
  if(!next||visits>=maxVisits)break;
  attempted.add(key(next.spec.position));visits++;
  const progressBefore=deps.approachProgress?.();
  const arrived=await deps.approach(next.spec,deadline);deps.assertActive();
  // A newly confirmed excavation can make the same owned obstruction
  // reachable. Retry only with monotonic physical progress, under the SAME
  // visit limit/deadline; an unchanged failed approach stays attempted.
  const progressAfter=deps.approachProgress?.();
  if(Number.isSafeInteger(progressBefore)&&Number.isSafeInteger(progressAfter)&&progressAfter>progressBefore)
    attempted.delete(key(next.spec.position));
  deps.recordDecision?.({position:next.spec.position,arrived:arrived===true,visits,removed,deadline});
 }
 deps.assertActive();
 // Reconcile loaded AIR even after the final visit, with the same no-threat
 // guard. Protected structure/return support remains explicitly accounted for.
 if(Date.now()<deadline&&!deps.hasThreat()&&deps.grounded()&&deps.dry())removed+=(await cleanupCombatCover(deps)).removed;
 const remaining=inspect(),retained=remaining.filter(({spec,block})=>ownedCoverMatches(block,spec)&&deps.protectedFloor(spec.position)).map(x=>x.spec);
 return {removed,visits,pending:remaining.length,retainedProtected:retained,pendingWork:remaining.length-retained.length,
  interrupted:deps.hasThreat()||!deps.grounded()||!deps.dry(),deadlineReached:Date.now()>=deadline};
}
module.exports={rememberCombatCover,combatCover,transitionCombat,cleanupCombatCover,sweepCombatCover};
