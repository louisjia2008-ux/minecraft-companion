'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {recordedConstructionRoutes:select,confirmRecordedConstructionEntry:confirm}=require('../vendor/server/minecraft/houseRecordedConstructionRoute');
function fixture(){const a={x:0,y:64,z:0},b={x:0,y:63,z:-60},graph={schema:2,kind:'loaded_dry_waypoint_graph',anchor:a,current:'0,64,0',order:['0,64,0','0,63,-60'],nodes:{'0,64,0':{position:a,parent:null},'0,63,-60':{position:b,parent:'0,64,0',transport:{kind:'source_water_surface'}}}};return {retiredCamps:[{surfaceGraphs:{any_log:graph}}]};}
test('previous observed return transport near the house is reusable after a fresh entry connection',()=>{
 const m=fixture(),r=select(m,{x:0,y:63,z:-65},{x:4,y:64,z:0},()=>true);assert.equal(r.length,1);
 assert.throws(()=>confirm(r[0],{x:0,y:63,z:-65},true),{code:'house_construction_recorded_entry_unconfirmed'});
 const g=confirm(r[0],r[0].entry,true);assert.equal(g.current,'0,63,-60');assert.equal(m.retiredCamps[0].surfaceGraphs.any_log.current,'0,64,0');
 assert.equal(g.nodes[g.current].transport.kind,'source_water_surface');
});
test('unloaded/changed floors, broken parent chains and unfinished old water routes grant no shortcut',()=>{
 const m=fixture(),a={x:0,y:63,z:-65},d={x:4,y:64,z:0};assert.equal(select(m,a,d,()=>false).length,0);
 const g=m.retiredCamps[0].surfaceGraphs.any_log;g.pendingWater={};assert.equal(select(m,a,d,()=>true).length,0);g.pendingWater=null;
 g.nodes['0,63,-60'].parent='missing';assert.equal(select(m,a,d,()=>true).length,0);
});

test('a destroyed archived camp does not discard its surviving nearer-house transport waypoint',()=>{
 const m=fixture(),g=m.retiredCamps[0].surfaceGraphs.any_log;
 const middle={x:0,y:63,z:-20};g.nodes['0,63,-20']={position:middle,parent:'0,64,0'};g.order.push('0,63,-20');g.nodes['0,63,-60'].parent='0,63,-20';
 const routes=select(m,{x:0,y:63,z:-65},{x:4,y:64,z:0},p=>p.z!==0);
 assert.equal(routes.length,1);assert.equal(routes[0].targetNodeId,'0,63,-20');assert.equal(g.anchor.z,0);
});

test('many ancestors at one shore do not exclude a different recorded entry',()=>{
 const m=fixture(),g=m.retiredCamps[0].surfaceGraphs.any_log;
 let parent='0,64,0';
 for(let z=-1;z>=-12;z--){const id=`0,64,${z}`;g.nodes[id]={position:{x:0,y:64,z},parent};g.order.push(id);parent=id;}
 g.nodes['0,63,-60'].parent=parent;
 g.nodes['2,63,-61']={position:{x:2,y:63,z:-61},parent:'0,64,0'};g.order.push('2,63,-61');
 const routes=select(m,{x:0,y:63,z:-65},{x:4,y:64,z:0},()=>true);
 assert.ok(routes.some(r=>r.entry.x===2));
 assert.equal(new Set(routes.map(r=>`${r.entry.x},${r.entry.y},${r.entry.z}`)).size,routes.length);
});

test('an intact endpoint cannot hide a changed intermediate bank in a remembered transport chain',()=>{
 const m=fixture(),g=m.retiredCamps[0].surfaceGraphs.any_log;
 const middle={x:0,y:61,z:-40};g.nodes['0,61,-40']={position:middle,parent:'0,64,0'};g.order.push('0,61,-40');g.nodes['0,63,-60'].parent='0,61,-40';
 assert.equal(select(m,{x:0,y:63,z:-65},{x:4,y:64,z:0},p=>p.y!==61).length,0);
});

test('changed parent recovery requires a persisted successful crossing and exact fresh dry bank',()=>{
 const {canRebaseCompletedConstructionBank:can}=require('../vendor/server/minecraft/houseRecordedConstructionRoute');
 const p={x:0,y:63,z:0},s={graph:{pendingWater:{bankArrival:{position:p,nativeTraversalConfirmed:true}}}},e={code:'house_surface_dry_graph_route_changed'};
 assert.equal(can(s,e,p,true,()=>true),true);
 assert.equal(can(s,{code:'cancelled'},p,true,()=>true),false);
 assert.equal(can(s,e,{...p,z:1},true,()=>true),false);
 assert.equal(can(s,e,p,false,()=>true),false);assert.equal(can(s,e,p,true,()=>false),false);
 assert.equal(can({graph:{pendingWater:{}}},e,p,true,()=>true),false);
});
