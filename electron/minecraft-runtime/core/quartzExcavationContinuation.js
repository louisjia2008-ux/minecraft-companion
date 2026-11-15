'use strict';
// Query-only direction ranking. No bot, actions, pose or actual ledger writes.
const crypto=require('node:crypto'),{performance}=require('node:perf_hooks');
const DIRS=[[1,0],[0,1],[-1,0],[0,-1]],key=p=>`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const unknown=r=>/unknown|unloaded|changed|budget|reserve|deadline|cancel|aborted/.test(r||'');
function cloneLedger(s){return{...s,route:s.route.map(p=>p.clone()),used:{...s.used},routeFeet:new Set(s.routeFeet),protectedFloors:new Set(s.protectedFloors),open:new Set(s.open),digCells:new Set(s.digCells),confirmedDigCells:new Set(s.confirmedDigCells)};}
function rankContinuations(input){
 const {geometry,readBlock,ledger,from,shore,portal,signal,contextCurrent=()=>true,recentlyPlaced=()=>false,protectedBlock=()=>false}=input,{CAPS,Vec3}=geometry;
 const ownedSupports=new Set(input.ownedSupports||[]),now=input.now||(()=>performance.now()),start=now(),maxMs=Math.min(100,Math.max(1,input.maxMs||50)),until=start+maxMs,maxReads=Math.min(20000,input.maxReads||20000),reads=new Map(),rows=[];
 let readCount=0,firstQueries=0,secondQueries=0,candidateSlotsRead=0,stopReason=null;
 const stop=reason=>{throw Object.assign(new Error(reason),{prototypeStop:reason});};
 function gate(){if(signal?.aborted)stop('aborted');if(!contextCurrent())stop('context_changed');if(now()>=until)stop('deadline');if(readCount>=maxReads)stop('read_budget');}
 function snapshotRead(p,overlay){gate();readCount++;const cell=key(p),future=overlay.has(cell),b=future?overlay.get(cell):readBlock(p);reads.set(`${future?'future:':'actual:'}${cell}`,{cell,provenance:future?'planned_first_dig_future_air':'actual_snapshot',name:b?.name||null,stateId:b?.stateId??null,boundingBox:b?.boundingBox??null,shapes:b?.shapes??null,ownedSupport:ownedSupports.has(cell),recentlyPlaced:Boolean(recentlyPlaced(p)),protectedBlock:Boolean(b&&protectedBlock(b))});return b;}
 function geometryQuery(s,p,step,overlay,second=false){gate();if(second){if(secondQueries>=64)stop('second_query_budget');secondQueries++;}else{if(firstQueries>=8)stop('first_query_budget');firstQueries++;}return geometry.query({readBlock:q=>snapshotRead(q,overlay),ledger:s,from:p,direction:step.direction,descend:step.descend,shore,portal,ownedSupports,recentlyPlaced,protectedBlock});}
 function budget(s,step,plan,nextIndex){const u=s.used,category=step.descend?'down':'flat';if(u[category]>=CAPS[category]||u.feet>=CAPS.feet||u.digs+plan.dig.length>CAPS.digs||u.nativeDigAttempts+plan.dig.length>CAPS.nativeDigAttempts||u.outboundEdges>=CAPS.outboundEdges||u.totalEdges+1+nextIndex>CAPS.totalEdges||u.knownEdges+nextIndex>CAPS.knownEdges||u.returnEdges+nextIndex>CAPS.returnEdges)return'projection_budget_or_return_reserve';return null;}
 const oreSafety=geometry.oreSafety;
 function possibleOre(s,p,overlay){
  let unknownOre=false;const found=[],eye=p.offset(.5,1.62,.5),view={blockAt:q=>snapshotRead(q,overlay),companionProtectBlock:protectedBlock,companionPlacedRecently:recentlyPlaced};
  // Bounded local reach envelope only; never a global ore/world scan.
  for(let x=p.x-5;x<=p.x+5;x++)for(let y=p.y-4;y<=p.y+6;y++)for(let z=p.z-5;z<=p.z+5;z++){
   gate();const q=new Vec3(x,y,z);if(q.offset(.5,.5,.5).distanceTo(eye)>4.5)continue;const b=view.blockAt(q);if(!b){unknownOre=true;continue;}if(b.name!=='nether_quartz_ore')continue;
   const failure=oreSafety(view,q,s,'before');if(!failure)found.push(key(q));else if(unknown(failure))unknownOre=true;
  }
  return{found,unknown:unknownOre,reachMeaning:'Possible planned-centre reach envelope plus unchanged oreSafety only; actual eye/LOS/native dig admission is NOT granted.'};
 }
 const modes=[];
 try{gate();const inputSlots=Array.isArray(input.candidates)?Math.min(8,input.candidates.length):0;for(let slot=0;slot<inputSlots;slot++){gate();candidateSlotsRead++;const step=input.candidates[slot];if(!step||!Number.isInteger(step.direction)||!DIRS[step.direction]||typeof step.descend!=='boolean')continue;const k=`${step.direction}:${step.descend?'down':'flat'}`;if(!modes.some(x=>x.attemptKey===k))modes.push({...step,attemptKey:k});}
 for(const step of modes){
  const row={attemptKey:step.attemptKey,direction:step.direction,descend:step.descend,actualFrom:key(from),plannedFrom:null,queryOnly:true,progress:false,second:[],classification:'unknown',permanentRejection:false};rows.push(row);
  const first=geometryQuery(ledger,from,step,new Map());row.first={ok:first.ok,reason:first.reason||null,target:first.target?key(first.target):null,dig:(first.dig||[]).map(key)};
  if(!first.ok){row.classification=unknown(first.reason)?'unknown_first_geometry':'first_geometry_refused';continue;}
  if(budget(ledger,step,first,ledger.route.length)){row.firstBudgetAdmitted=false;row.classification='unknown_budget';continue;}row.firstBudgetAdmitted=true;
  const s=cloneLedger(ledger),overlay=new Map();
  for(const p of first.dig){const b=snapshotRead(p,new Map());if(!geometry.full(b)||!geometry.futureRockAllowed(b)||s.protectedFloors.has(key(p))||ownedSupports.has(key(p))||recentlyPlaced(p)||protectedBlock(b)){row.classification='unknown_first_projection_changed';break;}overlay.set(key(p),{name:'air',position:p.clone(),boundingBox:'empty',shapes:[],diggable:true,stateId:0});s.open.add(key(p));}
  if(row.classification==='unknown_first_projection_changed')continue;
  const next=first.target.clone();row.plannedFrom=key(next);row.futureAir=[...overlay.keys()];
  s.route.push(next.clone());s.routeIndex=s.route.length-1;s.routeFeet.add(key(next));s.protectedFloors.add(key(next.offset(0,-1,0)));s.used[step.descend?'down':'flat']++;s.used.feet++;s.used.digs+=first.dig.length;s.used.nativeDigAttempts+=first.dig.length;s.used.outboundEdges++;s.used.totalEdges++;
  // Projection deliberately never increments confirmedDigCredit or actual credit.
  const ores=possibleOre(s,next,overlay);row.oreOpportunity=ores;
  const projectionCap=s.used.feet>=CAPS.feet||s.used.digs>=CAPS.digs||s.used.nativeDigAttempts>=CAPS.nativeDigAttempts||s.used.totalEdges+1+s.route.length>CAPS.totalEdges;
  let uncertain=ores.unknown||projectionCap,hasNext=false;row.projectionBudgetUncertain=projectionCap;
  for(const descend of[true,false])for(let direction=0;direction<4;direction++){
   const target=next.offset(DIRS[direction][0],descend?-1:0,DIRS[direction][1]),mode=`${direction}:${descend?'down':'flat'}`;
   if(s.routeFeet.has(key(target))){row.second.push({attemptKey:mode,classification:'known_route_not_new_outward',target:key(target)});continue;}
   const plan=geometryQuery(s,next,{direction,descend},overlay,true);const outcome={attemptKey:mode,target:key(target),ok:plan.ok,reason:plan.reason||null,dig:(plan.dig||[]).map(key)};
   if(plan.ok){const cap=budget(s,{direction,descend},plan,s.route.length);if(cap){outcome.classification='unknown_budget';uncertain=true;}else{outcome.classification='possible_new_outward_geometry';hasNext=true;}}
   else if(unknown(plan.reason)){outcome.classification='unknown_geometry';uncertain=true;}else outcome.classification='stable_geometry_refused_this_query';
   row.second.push(outcome);
  }
  row.classification=ores.found.length?'possible_guard_allowed_ore_at_planned_stance':hasNext?'possible_continuation_geometry':uncertain?'unknown_continuation':'confirmed_no_new_outward_edge_here';
 }gate();}catch(e){if(!e.prototypeStop)throw e;stopReason=e.prototypeStop;const current=rows.at(-1);if(current&&!['possible_guard_allowed_ore_at_planned_stance','possible_continuation_geometry','confirmed_no_new_outward_edge_here','first_geometry_refused'].includes(current.classification))current.classification='unknown_'+stopReason;}
 const rank=r=>r.classification==='possible_guard_allowed_ore_at_planned_stance'?0:r.classification==='possible_continuation_geometry'?1:r.classification.startsWith('unknown')?2:r.classification==='confirmed_no_new_outward_edge_here'?3:4;
 const rankingUncertain=Boolean(stopReason)||rows.some(r=>r.classification.startsWith('unknown')||r.oreOpportunity?.unknown||r.projectionBudgetUncertain||r.second.some(s=>s.classification.startsWith('unknown')));
 const admitted=rows.filter(r=>r.first?.ok&&r.firstBudgetAdmitted!==false);
 const preferred=signal?.aborted||stopReason==='context_changed'?null:rankingUncertain?admitted[0]:admitted.map((r,i)=>({r,i})).sort((a,b)=>rank(a.r)-rank(b.r)||a.i-b.i)[0]?.r;
 const fingerprint=crypto.createHash('sha256').update(JSON.stringify({from:key(from),ledger:{route:ledger.route.map(key),open:[...ledger.open].sort(),protectedFloors:[...ledger.protectedFloors].sort(),used:ledger.used},reads:[...reads].sort(([a],[b])=>a.localeCompare(b)),geometrySource:geometry.source.sha256})).digest('hex');
 return{classification:'QUERY_ONLY_BOUNDED_TWO_STEP_CONTINUATION',queryOnly:true,progress:false,actualCreditDelta:0,permanentRejection:false,stopReason,rankingUncertain,orderPolicy:rankingUncertain?'original_first_admitted_on_uncertainty':'bounded_continuation_rank',limits:{first:8,second:64,maxMs,maxReads},counts:{candidateSlotsRead,firstQueries,secondQueries,readCount,elapsedMs:now()-start},preferred:preferred?{direction:preferred.direction,descend:preferred.descend,classification:preferred.classification,requiresOriginalFreshActualExecution:true}:null,rows,fingerprint,source:geometry.source,readEvidence:[...reads.values()],actualExecutionGatesNotEvaluated:['actualAt/onGround/centre','health/food/threat/profile','native equip/dig/readback/physics/lease/cancel joins','actual eye/LOS/ore pickup'],meaning:'Only ranks first-direction proposals. Second edges and future air are not execution receipts, route credit, cached authorization, or permanent target/edge rejection.'};
}
module.exports={rankContinuations,cloneLedger};
