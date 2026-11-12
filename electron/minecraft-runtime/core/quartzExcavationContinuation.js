'use strict';
// Query-only direction ranking. No bot, actions, pose or actual ledger writes.
const crypto=require('node:crypto'),{performance}=require('node:perf_hooks');
const { excavationDirections } = require('./quartzExcavationTarget');
const DIRS=[[1,0],[0,1],[-1,0],[0,-1]],key=p=>`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const unknown=r=>/unknown|unloaded|changed|budget|reserve|deadline|cancel|aborted/.test(r||'');
function cloneLedger(s){return{...s,route:s.route.map(p=>p.clone()),used:{...s.used},routeFeet:new Set(s.routeFeet),protectedFloors:new Set(s.protectedFloors),open:new Set(s.open),digCells:new Set(s.digCells),confirmedDigCells:new Set(s.confirmedDigCells)};}
function rankContinuations(input){
 const {geometry,readBlock,ledger,from,shore,portal,signal,contextCurrent=()=>true,recentlyPlaced=()=>false,protectedBlock=()=>false}=input,{CAPS,Vec3}=geometry;
 const target = typeof geometry.targetVisible === 'function' ? input.target : null;
 const ownedSupports=new Set(input.ownedSupports||[]),now=input.now||(()=>performance.now()),start=now(),maxMs=Math.min(100,Math.max(1,input.maxMs||50)),until=start+maxMs,maxReads=Math.min(20000,input.maxReads||20000),reads=new Map(),rows=[];
 let readCount=0,firstQueries=0,secondQueries=0,candidateSlotsRead=0,stopReason=null;
 const stop=reason=>{throw Object.assign(new Error(reason),{prototypeStop:reason});};
 function gate(){if(signal?.aborted)stop('aborted');if(!contextCurrent())stop('context_changed');if(now()>=until)stop('deadline');if(readCount>=maxReads)stop('read_budget');}
 function snapshotRead(p,overlay){gate();readCount++;const cell=key(p),projected=overlay.get(cell),b=projected?projected.block:readBlock(p);reads.set(`${projected?'future:':'actual:'}${cell}`,{cell,provenance:projected?.provenance||'actual_snapshot',name:b?.name||null,stateId:b?.stateId??null,boundingBox:b?.boundingBox??null,shapes:b?.shapes??null,ownedSupport:ownedSupports.has(cell),recentlyPlaced:Boolean(recentlyPlaced(p)),protectedBlock:Boolean(b&&protectedBlock(b))});return b;}
 function geometryQuery(s,p,step,overlay,second=false){gate();if(second){if(secondQueries>=64)stop('second_query_budget');secondQueries++;}else{if(firstQueries>=8)stop('first_query_budget');firstQueries++;}return geometry.query({readBlock:q=>snapshotRead(q,overlay),ledger:s,from:p,direction:step.direction,descend:step.descend,shore,portal,ownedSupports,recentlyPlaced,protectedBlock});}
 function budget(s,step,plan,nextIndex){const u=s.used,category=step.descend?'down':'flat';if(u[category]>=CAPS[category]||u.feet>=CAPS.feet||u.digs+plan.dig.length>CAPS.digs||u.nativeDigAttempts+plan.dig.length>CAPS.nativeDigAttempts||u.outboundEdges>=CAPS.outboundEdges||u.totalEdges+1+nextIndex>CAPS.totalEdges||u.knownEdges+nextIndex>CAPS.knownEdges||u.returnEdges+nextIndex>CAPS.returnEdges)return'projection_budget_or_return_reserve';return null;}
 const oreSafety=geometry.oreSafety;
 function projectStep(state, currentOverlay, step, plan, provenance) {
  const projected = cloneLedger(state);
  const overlay = new Map(currentOverlay);
  for (const p of plan.dig) {
   const b = snapshotRead(p, currentOverlay);
   const cell = key(p);
   if (!geometry.full(b) || !geometry.futureRockAllowed(b) || projected.protectedFloors.has(cell)
     || ownedSupports.has(cell) || recentlyPlaced(p) || protectedBlock(b)) return null;
   const air = { name: 'air', position: p.clone(), boundingBox: 'empty', shapes: [], diggable: true, stateId: 0 };
   overlay.set(cell, { block: air, provenance });
   projected.open.add(cell);
  }
  const stance = plan.target.clone();
  projected.route.push(stance.clone());
  projected.routeIndex = projected.route.length - 1;
  projected.routeFeet.add(key(stance));
  projected.protectedFloors.add(key(stance.offset(0, -1, 0)));
  // These are projected costs. Only the executor can credit an actual edge or dig.
  projected.used[step.descend ? 'down' : 'flat']++;
  projected.used.feet++;
  projected.used.digs += plan.dig.length;
  projected.used.nativeDigAttempts += plan.dig.length;
  projected.used.outboundEdges++;
  projected.used.totalEdges++;
  return { projected, overlay, stance };
 }
 function targetVisible(state, stance, overlay) {
  const view = { blockAt: q => snapshotRead(q, overlay), companionProtectBlock: protectedBlock,
   companionPlacedRecently: recentlyPlaced };
  const targetKey = key(target);
  if (state.protectedFloors.has(targetKey) || ownedSupports.has(targetKey) || target.distanceTo(portal || shore) > 96) return false;
  // Each target face centre lies at most 0.5 blocks closer than the block centre.
  if (stance.offset(.5, 1.62, .5).distanceTo(target.offset(.5, .5, .5)) > 5) return false;
  const failure = oreSafety(view, target, state, 'before');
  if (failure) return unknown(failure) ? null : false;
  return geometry.targetVisible(view.blockAt, stance, target);
 }
 function recordTargetVisibility(row, state, stance, overlay, secondAttemptKey) {
  const visible = targetVisible(state, stance, overlay);
  if (visible === null) row.targetVisibilityUncertain = true;
  if (visible === true) {
   row.targetWitness = { target: key(target), stance: key(stance), steps: 1 };
   if (secondAttemptKey !== undefined) {
    row.targetWitness.steps = 2;
    row.targetWitness.secondAttemptKey = secondAttemptKey;
   }
  }
  return visible;
 }
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
  const projection = projectStep(ledger, new Map(), step, first, 'planned_first_dig_future_air');
  if (!projection) { row.classification = 'unknown_first_projection_changed'; continue; }
  const { projected: s, overlay, stance: next } = projection;
  row.plannedFrom = key(next);
  row.futureAir = [...overlay.keys()];
  if (target) row.first.targetVisible = recordTargetVisibility(row, s, next, overlay);
  const ores=possibleOre(s,next,overlay);row.oreOpportunity=ores;
  const projectionCap=s.used.feet>=CAPS.feet||s.used.digs>=CAPS.digs||s.used.nativeDigAttempts>=CAPS.nativeDigAttempts||s.used.totalEdges+1+s.route.length>CAPS.totalEdges;
  let uncertain=ores.unknown||projectionCap,hasNext=false;row.projectionBudgetUncertain=projectionCap;
  // Keep the original continuation score as a fallback. Only moves the goal
  // could actually propose from this next stance may witness the selected ore.
  const witnessModes = target
   ? new Set(excavationDirections(next, target, { used: s.used, visited: s.routeFeet }).map(mode => mode.attemptKey))
   : null;
  for (const descend of [true, false]) for (let direction = 0; direction < DIRS.length; direction++) {
   const mode = { direction, descend };
   const nextStance = next.offset(DIRS[direction][0], descend ? -1 : 0, DIRS[direction][1]);
   const attemptKey = `${direction}:${descend ? 'down' : 'flat'}`;
   if (s.routeFeet.has(key(nextStance))) {
    row.second.push({ attemptKey, classification: 'known_route_not_new_outward', target: key(nextStance),
     ...(witnessModes ? { eligibleForTargetWitness: false } : {}) });
    continue;
   }
   const plan = geometryQuery(s, next, mode, overlay, true);
   const outcome = { attemptKey, target: key(nextStance), ok: plan.ok, reason: plan.reason || null, dig: (plan.dig || []).map(key) };
   if (witnessModes) outcome.eligibleForTargetWitness = witnessModes.has(attemptKey);
   row.second.push(outcome);
   if (!plan.ok) {
    outcome.classification = unknown(plan.reason) ? 'unknown_geometry' : 'stable_geometry_refused_this_query';
    uncertain ||= unknown(plan.reason);
    continue;
   }
   if (budget(s, mode, plan, s.route.length)) {
    outcome.classification = 'unknown_budget';
    uncertain = true;
    continue;
   }
   outcome.classification = 'possible_new_outward_geometry';
   hasNext = true;
   if (outcome.eligibleForTargetWitness && !row.targetWitness) {
    const second = projectStep(s, overlay, mode, plan, 'planned_second_dig_future_air');
    if (second) outcome.targetVisible = recordTargetVisibility(row, second.projected, second.stance, second.overlay, attemptKey);
    else {
     outcome.targetVisible = null;
     row.targetVisibilityUncertain = true;
    }
   }
  }
  row.classification=ores.found.length?'possible_guard_allowed_ore_at_planned_stance':hasNext?'possible_continuation_geometry':uncertain?'unknown_continuation':'confirmed_no_new_outward_edge_here';
 }gate();}catch(e){if(!e.prototypeStop)throw e;stopReason=e.prototypeStop;const current=rows.at(-1);if(current&&!['possible_guard_allowed_ore_at_planned_stance','possible_continuation_geometry','confirmed_no_new_outward_edge_here','first_geometry_refused'].includes(current.classification))current.classification='unknown_'+stopReason;}
 const rank=r=>r.classification==='possible_guard_allowed_ore_at_planned_stance'?0:r.classification==='possible_continuation_geometry'?1:r.classification.startsWith('unknown')?2:r.classification==='confirmed_no_new_outward_edge_here'?3:4;
 const fallbackUncertain=Boolean(stopReason)||rows.some(r=>r.classification.startsWith('unknown')||r.oreOpportunity?.unknown||r.projectionBudgetUncertain||r.second.some(s=>s.classification.startsWith('unknown')));
 const rankingUncertain = fallbackUncertain || rows.some(row => row.targetVisibilityUncertain);
 const admitted=rows.filter(r=>r.first?.ok&&r.firstBudgetAdmitted!==false);
 const witnessed = stopReason ? null
  : admitted.find(row => row.targetWitness?.steps === 1) ?? admitted.find(row => row.targetWitness?.steps === 2);
 const preferred = signal?.aborted || stopReason === 'context_changed' ? null
  : witnessed || (fallbackUncertain ? admitted[0] : admitted.toSorted((a, b) => rank(a) - rank(b))[0]);
 const targetWitness = preferred && preferred === witnessed ? preferred.targetWitness : null;
 const orderPolicy = targetWitness ? 'bounded_target_visibility_rank'
  : fallbackUncertain ? 'original_first_admitted_on_uncertainty' : 'bounded_continuation_rank';
 const fingerprint=crypto.createHash('sha256').update(JSON.stringify({from:key(from),target:target?key(target):undefined,ledger:{route:ledger.route.map(key),open:[...ledger.open].sort(),protectedFloors:[...ledger.protectedFloors].sort(),used:ledger.used},reads:[...reads].sort(([a],[b])=>a.localeCompare(b)),geometrySource:geometry.source.sha256})).digest('hex');
 return{classification:'QUERY_ONLY_BOUNDED_TWO_STEP_CONTINUATION',queryOnly:true,progress:false,actualCreditDelta:0,permanentRejection:false,stopReason,rankingUncertain,orderPolicy,limits:{first:8,second:64,maxMs,maxReads},counts:{candidateSlotsRead,firstQueries,secondQueries,readCount,elapsedMs:now()-start},preferred:preferred?{direction:preferred.direction,descend:preferred.descend,classification:preferred.classification,requiresOriginalFreshActualExecution:true,...(targetWitness?{targetWitness}:{})}:null,rows,fingerprint,source:geometry.source,readEvidence:[...reads.values()],actualExecutionGatesNotEvaluated:['actualAt/onGround/centre','health/food/threat/profile','native equip/dig/readback/physics/lease/cancel joins','actual eye/LOS/ore pickup'],meaning:'Only ranks first-direction proposals. Second edges and future air are not execution receipts, route credit, cached authorization, or permanent target/edge rejection.'};
}
module.exports={rankContinuations,cloneLedger};
