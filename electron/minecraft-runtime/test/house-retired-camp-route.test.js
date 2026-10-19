'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {selectRetiredCampRoute}=require('../vendor/server/minecraft/houseRetiredCampRoute');
test('a loaded blast crater rejects an archived camp while unloaded terrain remains unknown',()=>{
 const {retiredCampKnownUnusable}=require('../vendor/server/minecraft/houseRetiredCampRoute');
 const camp={anchor:{x:-138,y:63,z:-147}};
 const air={name:'air',boundingBox:'empty',shapes:[]};
 assert.equal(retiredCampKnownUnusable(camp,()=>air),true);
 assert.equal(retiredCampKnownUnusable(camp,()=>null),false);
 assert.equal(retiredCampKnownUnusable(camp,p=>p.y===62?{name:'stone',boundingBox:'block',shapes:[[0,0,0,1,1,1]]}:air),false);
});
function fixture(){
 const root={x:0,y:64,z:0},entry={x:0,y:64,z:16},end={x:0,y:64,z:96},camp={x:8,y:64,z:104};
 const nodes=Object.fromEntries([root,entry,end].map(p=>[`${p.x},${p.y},${p.z}`,{position:p}]));
 nodes['0,64,96'].transport={kind:'source_water_surface',route:{fixture:'typed crossing retained'}};
 const graph={anchor:root,current:'0,64,96',order:Object.keys(nodes),nodes};
 const supply={camp:{anchor:camp},retiredCamps:[{camp:{anchor:root},surfaceGraphs:{any_log:graph},
  surfaceResources:{searches:{any_log:{observedPath:[root,entry,end,{x:8,y:64,z:100}]}}}}]};
 return {supply,graph,actual:{x:0,y:64,z:20}};
}
test('archived route selection retains typed water and chooses only an actually local entry',()=>{
 const f=fixture(),before=JSON.stringify(f.supply),r=selectRetiredCampRoute(f.supply,f.actual,()=>true);
 assert.deepEqual(r.entry,{x:0,y:64,z:16});assert.deepEqual(r.target,{x:0,y:64,z:96});
 assert.equal(r.graph.nodes['0,64,96'].transport.kind,'source_water_surface');
 assert.deepEqual(r.suffix,[{x:8,y:64,z:100}]);assert.equal(JSON.stringify(f.supply),before);
});
test('rejoining prefers an available forward node rather than returning to the obsolete camp root',()=>{
 const f=fixture();f.actual={x:0,y:64,z:0};
 assert.deepEqual(selectRetiredCampRoute(f.supply,f.actual,()=>true).entry,{x:0,y:64,z:16});
 f.graph.nodes['0,64,16'].terrainUnavailable=true;
 assert.deepEqual(selectRetiredCampRoute(f.supply,f.actual,()=>true).entry,{x:0,y:64,z:0});
});
test('archived reconnect uses the same bounded32m fresh connector as normal graph recovery',()=>{
 const f=fixture();f.actual={x:-10,y:64,z:-10};
 assert.deepEqual(selectRetiredCampRoute(f.supply,f.actual,()=>true).entry,{x:0,y:64,z:16});
});
for(const reason of ['pending_water','pending_dry','foreign_anchor','far_camp','no_local_support','missing_target_trace'])test(`archived recovery refuses ${reason}`,()=>{
 const f=fixture();let safe=()=>true;
 if(reason==='pending_water')f.graph.pendingWater={originNode:'0,64,0'};
 if(reason==='pending_dry')f.graph.pendingDryTrail={};
 if(reason==='foreign_anchor')f.graph.anchor={x:1,y:64,z:0};
 if(reason==='far_camp')f.supply.camp.anchor={x:300,y:64,z:300};
 if(reason==='no_local_support')safe=()=>false;
 if(reason==='missing_target_trace')f.supply.retiredCamps[0].surfaceResources.searches.any_log.observedPath.splice(2,1);
 assert.equal(selectRetiredCampRoute(f.supply,f.actual,safe),null);
});

test('respawn return selects the observed field graph including typed water without mutating it',()=>{
 const {selectFieldCampReturn}=require('../vendor/server/minecraft/houseRetiredCampRoute');
 const f=fixture();f.graph.schema=2;f.graph.kind='loaded_dry_waypoint_graph';
 f.graph.nodes['0,64,0'].parent=null;f.graph.nodes['0,64,16'].parent='0,64,0';f.graph.nodes['0,64,96'].parent='0,64,16';
 f.supply.fieldWoodSearch={graph:f.graph};const before=JSON.stringify(f.supply);
 const route=selectFieldCampReturn(f.supply,f.actual,()=>true);
 assert.deepEqual(route.entry,{x:0,y:64,z:16});assert.deepEqual(route.target,{x:0,y:64,z:96});
 assert.equal(route.graph.nodes['0,64,96'].transport.kind,'source_water_surface');assert.equal(JSON.stringify(f.supply),before);
 for(const invalid of ['pendingWater','pendingDryTrail','cycle','distantCamp','unsafeEntry']){
  const s=JSON.parse(before);if(invalid==='cycle')s.fieldWoodSearch.graph.nodes['0,64,16'].parent='0,64,96';
  else if(invalid==='distantCamp')s.camp.anchor.z=180;
  else if(invalid!=='unsafeEntry')s.fieldWoodSearch.graph[invalid]={unfinished:true};
  assert.equal(selectFieldCampReturn(s,f.actual,()=>invalid!=='unsafeEntry'),null,invalid);
 }
});

test('an actually reached field entry sets only the replay copy cursor and never credits an unvisited pose',()=>{
 const {fieldCampReturnCheckpoint}=require('../vendor/server/minecraft/houseRetiredCampRoute');
 const f=fixture(),before=JSON.stringify(f.graph);f.graph.visits=3;
 const route={entry:{x:0,y:64,z:16},graph:f.graph};const copy=fieldCampReturnCheckpoint(route,{...route.entry});
 assert.equal(copy.current,'0,64,16');assert.equal(copy.resumeNode,'0,64,16');assert.equal(copy.visits,3);
 assert.equal(f.graph.current,'0,64,96');assert.equal(copy.nodes['0,64,96'].transport.kind,'source_water_surface');
 assert.throws(()=>fieldCampReturnCheckpoint(route,{x:1,y:64,z:16}),{code:'house_camp_recovery_entry_unconfirmed'});
 assert.equal(JSON.parse(before).current,f.graph.current);
});

test('formal15 first-wood return selects the actual camp root of the original outward field graph',()=>{
 const {selectFieldCampReturn,fieldCampReturnCheckpoint}=require('../vendor/server/minecraft/houseRetiredCampRoute');
 const supply=require('../test-support/fixtures/formal15-field-return-graph.json'),before=JSON.stringify(supply);
 const actual={x:145,y:69,z:117},r=selectFieldCampReturn(supply,actual,()=>true);
 assert.ok(r,'The observed outward tree-search graph must not fall through to an unrelated direct camp goto');
 assert.deepEqual(r.entry,{x:151,y:65,z:97});assert.deepEqual(r.target,supply.camp.anchor);
 assert.equal(fieldCampReturnCheckpoint(r,r.entry).current,'151,65,97');
 assert.equal(JSON.stringify(supply),before);
 const changed=JSON.parse(before);changed.fieldWoodSearch.graph.nodes['139,65,87'].parent='151,65,97';
 assert.equal(selectFieldCampReturn(changed,actual,()=>true),null,'Cycles cannot establish a return chain');
 assert.equal(selectFieldCampReturn(supply,actual,()=>false),null,'An unavailable loaded entry cannot receive route credit');
});
