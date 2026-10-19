'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const parent=fs.readFileSync(path.join(__dirname,'natural-public-building-acceptance-v6.cjs'),'utf8');
const source=fs.readFileSync(path.join(__dirname,'natural-public-building-acceptance-v6-site-observer.cjs'),'utf8');
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex'),copy=x=>JSON.parse(JSON.stringify(x));
const markerA='// SITE_OBSERVER_REVISION_1_BEGIN\n',markerB='// SITE_OBSERVER_REVISION_1_END\n';
const helper=source.slice(source.indexOf(markerA)+markerA.length,source.indexOf(markerB));
const observe=vm.runInNewContext(helper+'\nsiteSearchObservation');
const projected=x=>copy(observe(x));
const functionSource=(text,name,next)=>text.slice(text.indexOf('function '+name+'('),text.indexOf(next,text.indexOf('function '+name+'('))).trim();
const taskEvidence=vm.runInNewContext(functionSource(source,'taskEvidence','// SITE_OBSERVER_REVISION_1_BEGIN')+'\ntaskEvidence',{clone:copy});
function freeze(x){if(x&&typeof x==='object'){Object.freeze(x);for(const v of Object.values(x))freeze(v);}return x;}
function fixture(){return{schema:1,kind:'loaded_natural_house_site_search',profile:'cottage',start:{x:0,y:64,z:0},startedAt:1000,deadline:1201000,creatorGeneration:3,budgetGeneration:3,
  checkedNodes:['0,64,0'],diagnostics:{reads:5678,inspected:865,advances:1,rejections:{foreign_site_block:324,unsupported_natural_floor:238,unsafe_floor:166}},
  graph:{schema:2,kind:'loaded_dry_waypoint_graph',order:['0,64,0','16,65,0'],nodes:{'0,64,0':{position:{x:0,y:64,z:0},parent:null},'16,65,0':{position:{x:16,y:65,z:0},parent:'0,64,0'}},
    current:'16,65,0',resumeNode:'16,65,0',probes:87,visits:2,frontier:[],blockedEdges:[],pendingWater:{originNode:'16,65,0',reverse:false,edge:{unknownLargePayload:'not copied'}},
    pendingDryTrail:{kind:'actual_dry_trail_prefix',originNode:'0,64,0',targetNode:'16,65,0',confirmedPrefix:[{},{}]}},
  reservation:{schema:1,kind:'actual_loaded_house_site_and_camp',profile:'cottage',houseAnchor:{x:32,y:65,z:0},camp:{anchor:{x:16,y:65,z:0},stations:{furnace:{},crafting_table:{}},storageSites:Array(8).fill({})},campNodeId:'16,65,0',confirmedAt:2400,houseDigest:'a'.repeat(64),campDigest:'b'.repeat(64)}};}
test('pure site summary retains full counters and actual registered-node/current/pending observations without modifying CP',()=>{
  const f=freeze(fixture()),before=hash(f),r=projected(f);
  assert.equal(r.checkedNodesCount,1);assert.deepEqual(r.diagnostics.rejections,f.diagnostics.rejections);assert.equal(r.diagnostics.reads,5678);assert.equal(r.diagnostics.inspected,865);
  assert.equal(r.graph.actualRegisteredNodeCount,2);assert.equal(r.graph.current,'16,65,0');assert.equal(r.graph.currentRegistered,true);assert.equal(r.graph.probes,87);
  assert.equal(r.graph.pendingWater.present,true);assert.equal(r.graph.pendingDryTrail.confirmedPrefixCount,2);assert.equal(r.reservation.stationCount,2);assert.equal(r.reservation.storageSiteCount,8);
  assert.equal(r.proofDomain,'CHECKPOINT_OBSERVATION_ONLY');assert.equal(hash(f),before);assert.notEqual(r.reservation,f.reservation);
});
test('complete final task evidence includes independent whole siteSearch rather than a bounded summary',()=>{
  const f=fixture();f.checkedNodes=Array.from({length:25},(_,i)=>`${i},64,0`);f.extraCompleteEvidence={nativeSource:'originalCP'};
  const original=freeze({taskId:'original',status:'paused',siteSearch:f,materialSupply:{existing:true},logs:[]}),before=hash(original),r=taskEvidence(original);
  assert.deepEqual(r.siteSearch,f);assert.equal(r.siteSearch.checkedNodes.length,25);assert.deepEqual(r.materialSupply,{existing:true});assert.equal(hash(original),before);
});
test('summary bounds list copies while preserving exact total counts and explicit truncation',()=>{
  const f=fixture();f.checkedNodes=Array.from({length:256},(_,i)=>`${i},64,0`);f.diagnostics.rejections=Object.fromEntries(Array.from({length:100},(_,i)=>['reason_'+i,i]));
  const r=projected(f);assert.equal(r.checkedNodesCount,256);assert.equal(r.checkedNodesSample.length,16);assert.equal(r.checkedNodesTruncated,true);
  assert.equal(r.diagnostics.rejectionReasonCount,100);assert.equal(Object.keys(r.diagnostics.rejections).length,64);assert.equal(r.diagnostics.rejectionsTruncated,true);
  assert.ok(JSON.stringify(r).length<7000);assert.equal(taskEvidence({siteSearch:f}).siteSearch.diagnostics.rejections.reason_99,99);
});
for(const kind of ['missing_order','bad_position','duplicate_order','oversize_order','foreign_schema'])test('unknown graph registration remains unknown: '+kind,()=>{
  const f=fixture();if(kind==='missing_order')delete f.graph.order;if(kind==='bad_position')f.graph.nodes['16,65,0'].position=null;
  if(kind==='duplicate_order')f.graph.order.push('0,64,0');if(kind==='oversize_order')f.graph.order=Array(257).fill('0,64,0');if(kind==='foreign_schema')f.graph.schema=99;
  assert.equal(projected(f).graph.actualRegisteredNodeCount,null);
});
test('projection does not inspect world functions, packet payload or non-site property getters',()=>{
  let queries=0;const f=fixture();for(const key of ['blockAt','getColumn','chunkData','bot','inventory','nativeAPI'])Object.defineProperty(f,key,{enumerable:false,get(){queries++;throw Error('not observation data');}});
  assert.equal(projected(f).graph.actualRegisteredNodeCount,2);assert.equal(queries,0);
});
test('malformed or throwing observations cannot throw into the existing snapshot/task poll',()=>{
  assert.equal(projected(null),null);const f=fixture();Object.defineProperty(f,'diagnostics',{get(){throw Error('CP read failed');}});assert.doesNotThrow(()=>observe(f));assert.equal(projected(f).diagnostics.reads,null);
  const g=fixture();Object.defineProperty(g.checkedNodes,0,{get(){throw Error('array observation failed');}});assert.doesNotThrow(()=>observe(g));assert.equal(projected(g).observationError,'Site checkpoint projection unavailable');
  g.checkedNodes=[];g.reservation.houseDigest=Symbol('unknown');assert.doesNotThrow(()=>observe(g));assert.equal(projected(g).reservation.houseDigest,null);
});
test('exact snapshot and console append bounded site evidence without changing the previous actor/world observation',()=>{
  function run(text,isNew){const events=[],consoleEvents=[],original={siteSearch:freeze(fixture()),status:'running',progressText:'original native search'},actor={entity:{position:{x:.5,y:64,z:.5},velocity:{x:0,y:0,z:0},onGround:true},health:20,food:20,foodSaturation:5,pathfinder:{isMoving:()=>false,goal:null}};
    const before=hash({task:original,actor}),sandbox={bot:actor,agent:{__testGetReconnectTask:()=>original},task:null,publicPlanSnapshot:{},profiles:{cottage:{intent:'build_furnished_house'}},profile:'cottage',mode:'test',startedAt:1000,lastReport:0,lastSignature:'',Date:{now:()=>3000},
      clone:copy,json:JSON.stringify,record:(type,data)=>events.push({type,data:copy(data)}),console:{log:data=>consoleEvents.push(JSON.parse(data))},nativeMotionEvidence:()=>({yaw:0}),position:copy,inventory:()=>[],counts:()=>({}),stateFor:()=>null,goalEvidence:()=>null};
    vm.runInNewContext((isNew?helper+'\n':'')+functionSource(text,'snapshot','function checkWaiters')+'\nsnapshot(true);',sandbox);
    assert.equal(hash({task:original,actor}),before);return{snapshot:events[0].data,console:consoleEvents[0]};}
  const old=run(parent,false),current=run(source,true);assert.equal(current.snapshot.siteSearch.diagnostics.inspected,865);assert.equal(current.console.siteSearch.graph.probes,87);
  delete current.snapshot.siteSearch;delete current.console.siteSearch;assert.deepEqual(current,old);
});
test('removing only declared observer additions restores exact sealed v6 bytes and every old guard/grader/action',()=>{
  let restored=source;const start=restored.indexOf(markerA),end=restored.indexOf(markerB)+markerB.length;assert.ok(start>=0&&end>start);restored=restored.slice(0,start)+restored.slice(end);
  const additions=['    siteSearch: value.siteSearch,\n','    siteSearch: siteSearchObservation(task?.siteSearch),\n','      siteSearch: data.siteSearch,\n'];
  for(const line of additions){assert.equal(restored.split(line).length-1,1);restored=restored.replace(line,'');}
  assert.equal(restored.split('observerRevision:5,siteObserverRevision:1,runnerRevision:6').length-1,1);restored=restored.replace('observerRevision:5,siteObserverRevision:1,runnerRevision:6','observerRevision:5,runnerRevision:6');
  assert.equal(restored.split('observerRevision: 5, siteObserverRevision:1, runnerRevision:6').length-1,2);restored=restored.split('observerRevision: 5, siteObserverRevision:1, runnerRevision:6').join('observerRevision: 5, runnerRevision:6');
  assert.equal(restored,parent);assert.equal(hash(restored),'401495bcb9106dcb67deb333982b698594267e994cf014ae6d1017c3e064a7ba');
});
