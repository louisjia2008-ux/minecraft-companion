'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {createExcavation}=require('../core/quartzExcavation'),{inspectStep}=require('../core/mining'),{NEVER_BREAK}=require('../core/nether');
function continuationFixture(){
 const cells=new Map([['-2,-1,1','air'],['-1,-1,-2','air'],['0,0,8','nether_portal']]),shore=new Vec3(0,0,0),portal=new Vec3(0,0,8),memory={},calls=[];
 const key=p=>`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
 const bot={entity:{position:new Vec3(.5,0,.5),onGround:true},health:20,game:{dimension:'the_nether'},
  blockAt:p=>{p=p.floored();const name=cells.get(key(p))||(p.y<0?'basalt':'air'),b=Block.fromStateId(registry.blocksByName[name].defaultState);b.position=p;return b;},
  pathfinder:{movements:{companionWalkOnly:true,canDig:false,allowParkour:false,allow1by1towers:false,maxDropDown:1,scafoldingBlocks:[]},setGoal:()=>calls.push('setGoal')},clearControlStates:()=>calls.push('clear'),dig:()=>{calls.push('dig');throw Error('No native I/O in query');}};
 const engine=createExcavation({bot,memory,shore,portal,inspectStep,Vec3,actions:{},makeGoal:()=>{throw Error('No movement in query');},foodCount:()=>4,threatened:()=>false,neverBreak:NEVER_BREAK});
 const ctx={signal:new AbortController().signal,record:()=>{}},candidates=[{direction:2,descend:true},{direction:2,descend:false}];
 return{cells,shore,portal,memory,calls,bot,engine,ctx,candidates};
}
test('actual-shore query prefers flat continuation over the original first-admitted down dead end',()=>{
 const f=continuationFixture();const out=f.engine.proposeDirections?.(f.ctx,{candidates:f.candidates})||{preferred:f.candidates[0]};
 assert.equal(out.preferred.descend,false);
});
test('read-only query does not initialize actual ledger or move body/call native actions',()=>{
 const f=continuationFixture(),position=f.bot.entity.position.clone();f.engine.proposeDirections?.(f.ctx,{candidates:f.candidates});
 assert.equal(f.memory.quartzExcavation,undefined);assert.deepEqual(f.bot.entity.position,position);assert.deepEqual(f.calls,[]);
});
test('query on a nonactual shore cannot invent a future body admission',()=>{
 const f=continuationFixture();f.bot.entity.onGround=false;const out=f.engine.proposeDirections?.(f.ctx,{candidates:f.candidates})||{preferred:null};
 assert.equal(out.preferred,null);assert.equal(f.memory.quartzExcavation,undefined);assert.deepEqual(f.calls,[]);
});
module.exports={continuationFixture};

const {rankContinuations}=require('../core/quartzExcavationContinuation');
const shared=require('../core/quartzExcavationGeometry'),{oreSafetyFailure}=require('../core/quartzExcavationTarget');
const geometry={...shared,Vec3,oreSafety:oreSafetyFailure,source:{sha256:'shared_geometry_test'},
 futureRockAllowed:b=>shared.ROCK.has(b?.name)&&!NEVER_BREAK.includes(b?.name)&&b?.diggable!==false,
 query:({readBlock,ledger,from,direction,descend,shore,portal,ownedSupports=new Set(),recentlyPlaced=()=>false,protectedBlock=()=>false})=>shared.inspectExcavationGeometry({read:readBlock,ledger,from,dir:direction,descend,Vec3,inspectStep,banned:new Set(NEVER_BREAK),bounds:p=>p.distanceTo(portal||shore)<=96,
  protectedCell:(s,p)=>s.protectedFloors.has(shared.key(p))||ownedSupports.has(shared.key(p))||protectedBlock(readBlock(p))||recentlyPlaced(p)})};
const key=p=>`${p.x},${p.y},${p.z}`,full=(name,p)=>({name,position:p.clone(),boundingBox:'block',shapes:[[0,0,0,1,1,1]],diggable:true,stateId:name==='basalt'?1:2}),air=p=>({name:'air',position:p.clone(),boundingBox:'empty',shapes:[],diggable:true,stateId:0});
function fixture(){
 const shore=new Vec3(0,0,0),portal=new Vec3(0,0,8),cells=new Map(),ledger={surfaceY:0,route:[shore.clone()],routeIndex:0,routeFeet:new Set(['0,0,0']),protectedFloors:new Set(['0,-1,0']),open:new Set(),digCells:new Set(),confirmedDigCells:new Set(),confirmedDigCredit:0,used:{down:0,flat:0,feet:0,digs:0,nativeDigAttempts:0,outboundEdges:0,returnEdges:0,knownEdges:0,totalEdges:0,diamondRock:0}};
 const readBlock=p=>cells.has(key(p))?cells.get(key(p)):p.y<0?full('basalt',p):air(p);
 const candidates=[{direction:2,descend:true},{direction:2,descend:false}];
 // At the first west-down landing, its west and north surroundings below
 // surface are unconfirmed cave; west-flat at surface retains continuations.
 for(const [x,y,z]of[[-2,-1,1],[-1,-1,-2]])cells.set(`${x},${y},${z}`,air(new Vec3(x,y,z)));
 return{geometry,readBlock,ledger,from:shore,shore,portal,candidates,cells,ownedSupports:new Set(),maxMs:1000};
}
const snap=f=>JSON.stringify({ledger:f.ledger,sets:[...['routeFeet','protectedFloors','open','digCells','confirmedDigCells'].map(k=>[k,[...f.ledger[k]]])],cells:[...f.cells]});
test('bounded continuation prefers a safe flat entrance over a local no-outward down branch',()=>{const f=fixture(),out=rankContinuations(f);assert.equal(out.preferred?.descend,false);});
test('planning leaves actual ledger, cells and credit unchanged',()=>{const f=fixture(),before=snap(f);const out=rankContinuations(f);assert.equal(snap(f),before);assert.equal(out.queryOnly,true);assert.equal(out.progress,false);});
test('pure geometry retains original protected shore floor refusal after the actual down edge',()=>{const f=fixture(),s={...f.ledger,route:[f.shore,new Vec3(-1,-1,0)],routeFeet:new Set(['0,0,0','-1,-1,0']),protectedFloors:new Set(['0,-1,0','-1,-2,0']),open:new Set(['-1,-1,0'])};const from=s.route[1];const r=geometry.query({...f,ledger:s,from,direction:0,descend:false,readBlock:p=>key(p)==='-1,-1,0'?air(p):f.readBlock(p)});assert.equal(r.ok,false);assert.equal(r.reason,'forbidden_obstacle');});

test('future air contains only first admitted planned dig cells',()=>{const f=fixture(),out=rankContinuations(f),allowed=new Set(out.rows.flatMap(r=>r.futureAir||[]));for(const e of out.readEvidence.filter(e=>e.provenance==='planned_first_dig_future_air'))assert.ok(allowed.has(e.cell));assert.equal(f.ledger.open.size,0);assert.equal(f.ledger.confirmedDigCredit,0);});
test('unchanged oreSafety retains a possible guard-allowed nearby ore even without outward edges',()=>{const f=fixture();f.candidates=f.candidates.slice(0,1);f.cells.set('-2,-2,0',full('nether_quartz_ore',new Vec3(-2,-2,0)));const out=rankContinuations(f);assert.equal(out.rows[0].classification,'possible_guard_allowed_ore_at_planned_stance');assert.deepEqual(out.rows[0].oreOpportunity.found,['-2,-2,0']);assert.equal(out.actualCreditDelta,0);});
test('local ore envelope unknown cannot become a confirmed outward dead end',()=>{const f=fixture();f.candidates=f.candidates.slice(0,1);f.cells.set('3,0,0',null);const out=rankContinuations(f);assert.equal(out.rows[0].classification,'unknown_continuation');assert.equal(out.rows[0].permanentRejection,false);});
test('projection at final64th foot is budget-uncertain rather than permanent dead end',()=>{const f=fixture();f.candidates=f.candidates.slice(0,1);f.ledger.used.feet=63;const before=snap(f),out=rankContinuations(f);assert.equal(out.rows[0].classification,'unknown_continuation');assert.equal(out.rows[0].projectionBudgetUncertain,true);assert.equal(snap(f),before);});
test('already aborted query produces no preferred direction and zero reads',()=>{const f=fixture(),controller=new AbortController();controller.abort();const out=rankContinuations({...f,signal:controller.signal});assert.equal(out.stopReason,'aborted');assert.equal(out.preferred,null);assert.equal(out.counts.readCount,0);});
test('abort during reads leaves ledger unchanged and no preference',()=>{const f=fixture(),before=snap(f),controller=new AbortController();let n=0;const read=f.readBlock;f.readBlock=p=>{if(++n===7)controller.abort('fixture');return read(p);};const out=rankContinuations({...f,signal:controller.signal});assert.equal(out.stopReason,'aborted');assert.equal(out.preferred,null);assert.equal(snap(f),before);});
test('changed snapshot context is unknown and clears any planned preference',()=>{const f=fixture();let n=0;const out=rankContinuations({...f,contextCurrent:()=>++n<10});assert.equal(out.stopReason,'context_changed');assert.equal(out.preferred,null);assert.ok(out.rows.every(r=>!r.permanentRejection));});
test('finite deterministic deadline never produces a permanent dead-end verdict',()=>{const f=fixture();let clock=0;const out=rankContinuations({...f,maxMs:8,now:()=>clock++});assert.equal(out.stopReason,'deadline');assert.ok(out.rows.every(r=>!r.permanentRejection&&r.classification!=='confirmed_no_new_outward_edge_here'));assert.ok(out.counts.readCount<20);});
test('finite read budget remains explicit unknown',()=>{const out=rankContinuations({...fixture(),maxReads:5});assert.equal(out.stopReason,'read_budget');assert.ok(out.rows.every(r=>!r.permanentRejection));});
test('durable bridge support cannot be projected into future air',()=>{const f=fixture();f.candidates=f.candidates.slice(0,1);f.ownedSupports.add('-1,-1,0');const out=rankContinuations(f);assert.equal(out.rows[0].first.reason,'forbidden_obstacle');assert.equal(out.rows[0].classification,'first_geometry_refused');assert.equal(out.readEvidence.some(e=>e.provenance==='planned_first_dig_future_air'),false);});
test('lava and unknown first dig cells are never overlaid as air',()=>{for(const block of[null,full('lava',new Vec3(-1,-1,0))]){const f=fixture();f.candidates=f.candidates.slice(0,1);f.cells.set('-1,-1,0',block);const out=rankContinuations(f);assert.equal(out.rows[0].first.ok,false);assert.equal(out.readEvidence.some(e=>e.provenance==='planned_first_dig_future_air'),false);}});
test('queries are limited to original8 unique first modes and at most64 second modes',()=>{const f=fixture();f.candidates=Array.from({length:100},(_,i)=>({direction:i%4,descend:i%8<4}));const out=rankContinuations(f);assert.ok(out.counts.firstQueries<=8);assert.ok(out.counts.secondQueries<=64);assert.ok(out.counts.readCount<=20000);});
test('an input bot or execution callback is never accessed',()=>{const f=fixture();Object.defineProperty(f,'bot',{get(){throw Error('Must not access a real bot');}});f.advance=()=>{throw Error('No execution');};const out=rankContinuations(f);assert.equal(out.progress,false);assert.equal(out.actualCreditDelta,0);});
test('a local changed cave is reevaluated on the next query without a permanent dead-end cache',()=>{const f=fixture();f.candidates=f.candidates.slice(0,1);const before=rankContinuations(f);assert.equal(before.rows[0].classification,'confirmed_no_new_outward_edge_here');f.cells.clear();const after=rankContinuations(f);assert.equal(after.rows[0].classification,'possible_continuation_geometry');assert.notEqual(after.fingerprint,before.fingerprint);});
test('spent16down cap is not reset or refunded to prefer another down proposal',()=>{const f=fixture();f.ledger.used.down=16;const before=snap(f),out=rankContinuations(f);assert.equal(out.rows[0].classification,'unknown_budget');assert.equal(out.preferred.descend,false);assert.equal(snap(f),before);});
test('pure geometry explicitly excludes only the actual-pose gate and grants no actual execution',()=>{const source=require('node:fs').readFileSync(require.resolve('../core/quartzExcavation'),'utf8');assert.match(source,/function outer[\s\S]*?if \(!actualAt\(from\)\) return fail\('not_at_confirmed_front'\);\s*return inspectExcavationGeometry/);const out=rankContinuations(fixture());assert.equal(out.preferred.requiresOriginalFreshActualExecution,true);assert.ok(out.actualExecutionGatesNotEvaluated.includes('actualAt/onGround/centre'));});
test('v2 reads only original first8 slots even for gigantic repeated or invalid input',()=>{for(const invalid of[false,true]){const f=fixture(),raw=new Array(1000000),access=[];for(let i=0;i<8;i++)raw[i]=invalid?null:{direction:2,descend:true};const candidates=new Proxy(raw,{get(a,k,r){if(typeof k==='string'&&/^\d+$/.test(k)){access.push(Number(k));if(Number(k)>=8)throw Error('candidate input beyond first8');}return Reflect.get(a,k,r);}});const out=rankContinuations({...f,candidates});assert.ok(access.length<=8);assert.ok(access.every(i=>i<8));assert.ok(out.counts.candidateSlotsRead<=8);}});
test('v2 any related unknown at early or late local ore read preserves original first admitted direction',()=>{for(const q of['3,0,0','-5,0,0']){const f=fixture();f.cells.set(q,null);const out=rankContinuations(f);assert.equal(out.rankingUncertain,true);assert.equal(out.orderPolicy,'original_first_admitted_on_uncertainty');assert.equal(out.preferred.direction,2);assert.equal(out.preferred.descend,true);assert.ok(out.rows.every(r=>!r.permanentRejection));}});
test('v2 projection budget uncertainty preserves original down instead of known flat rank',()=>{const f=fixture();f.ledger.used.feet=63;const out=rankContinuations(f);assert.equal(out.rankingUncertain,true);assert.equal(out.preferred.descend,true);assert.equal(out.orderPolicy,'original_first_admitted_on_uncertainty');});
test('v2 deadline during candidate slot build is gated and returns no preference',()=>{const f=fixture();let n=0;const out=rankContinuations({...f,candidates:new Array(1000000).fill(null),maxMs:2,now:()=>n++});assert.equal(out.stopReason,'deadline');assert.equal(out.preferred,null);assert.ok(out.counts.candidateSlotsRead<=8);});
test('v2 mid-query deadline falls back to first actually admitted proposal rather than partial ranking',()=>{const f=fixture();let n=0;const out=rankContinuations({...f,maxMs:2,now:()=>n++*.001});assert.equal(out.stopReason,'deadline');const first=out.rows.find(r=>r.first?.ok);assert.ok(first);assert.equal(out.preferred?.direction,first.direction);assert.equal(out.preferred?.descend,first.descend);assert.equal(out.orderPolicy,'original_first_admitted_on_uncertainty');});
test('v2 possible local ore keeps opportunity without any dig or extra credit',()=>{const f=fixture();f.cells.set('-2,-2,0',full('nether_quartz_ore',new Vec3(-2,-2,0)));f.cells.set('3,0,0',null);const before=snap(f),out=rankContinuations(f);assert.equal(out.rows[0].classification,'possible_guard_allowed_ore_at_planned_stance');assert.equal(out.rankingUncertain,true);assert.equal(out.preferred.descend,true);assert.equal(out.actualCreditDelta,0);assert.equal(snap(f),before);});
test('v2 final completion gate rejects a context invalidated by the last read callback',()=>{const original=fixture();let expected=0;rankContinuations({...original,readBlock:p=>{expected++;return original.readBlock(p);}});const f=fixture();let n=0,current=true;const read=f.readBlock;const out=rankContinuations({...f,contextCurrent:()=>current,readBlock:p=>{const b=read(p);if(++n===expected)current=false;return b;}});assert.equal(out.stopReason,'context_changed');assert.equal(out.preferred,null);});
test('proposal fingerprint rejection is consumed and a fresh query can proceed without refunding or native I/O',async()=>{
 const f=continuationFixture();f.engine.proposeDirections(f.ctx,{candidates:f.candidates});f.cells.set('3,0,0','basalt');
 const stale=await f.engine.advance(f.ctx,{direction:2,descend:false});assert.equal(stale.reason,'direction_proposal_changed');assert.equal(f.memory.quartzExcavation,undefined);assert.equal(f.calls.includes('dig'),false);
 f.engine.proposeDirections(f.ctx,{candidates:f.candidates});const current=await f.engine.advance(f.ctx,{direction:2,descend:false});
 assert.notEqual(current.reason,'direction_proposal_changed');assert.equal(f.memory.quartzExcavation.used.digs,0);assert.equal(f.calls.includes('dig'),false);
});
