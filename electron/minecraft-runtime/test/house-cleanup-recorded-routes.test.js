'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {recordedCleanupRoutes:routes}=require('../vendor/server/minecraft/houseCleanupRecordedRoutes');
const p=(x,y=64,z=0)=>({x,y,z}),key=p=>`${p.x},${p.y},${p.z}`;
function material(){const root=p(0),a=p(16),b=p(32),c=p(-16);const nodes={};
 for(const [pos,parent]of [[root,null],[a,key(root)],[b,key(a)],[c,key(root)]])nodes[key(pos)]={position:pos,parent};
 return {retiredCamps:[{surfaceGraphs:{birch_log:{schema:2,kind:'loaded_dry_waypoint_graph',anchor:root,order:Object.keys(nodes),nodes}}}]};}
test('cleanup can approach a recorded descendant and cross a branch while preserving its original root and edges',()=>{
 const m=material(),before=JSON.stringify(m),r=routes(m,p(-16),p(40),()=>true);
 assert.ok(r.some(c=>c.entry.x===-16&&c.targetPosition.x===32));
 assert.equal(JSON.stringify(m),before);assert.equal(r[0].kind,'surface');
});
test('cycles, unknown feet, pending physical routes and non-progressing destinations grant no route',()=>{
 const m=material(),g=m.retiredCamps[0].surfaceGraphs.birch_log;
 assert.deepEqual(routes(m,p(-16),p(40),()=>false),[]);
 g.pendingWater={};assert.deepEqual(routes(m,p(-16),p(40),()=>true),[]);delete g.pendingWater;
 g.nodes['32,64,0'].parent='32,64,0';assert.ok(routes(m,p(-16),p(40),()=>true).every(c=>c.targetPosition.x!==32));
 assert.deepEqual(routes(m,p(-16),p(1000),()=>true),[]);
});
test('only contiguous actual mining breadcrumbs can supply underground approach hints; attempted visited cells grant nothing',()=>{
 const breadcrumbs=Array.from({length:30},(_,i)=>p(i,64-i));
 const m={retiredCamps:[{quarry:{routes:{raw_iron:{visited:['999,16,0'],abandonedNavigations:[{navigation:{breadcrumbs}}]}}}}]};
 const r=routes(m,p(0),p(29,35),()=>true);assert.ok(r.length);assert.equal(r[0].kind,'mining');
 assert.equal(r[0].waypoints.at(-1).y,35);assert.equal(r[0].entry.y,64);
 breadcrumbs[12]=p(999,16);assert.deepEqual(routes(m,p(0),p(29,35),pos=>pos.x<12||pos.x===29),[]);
});

test('a distant owned cover can reuse a recorded intermediate bank before its local standing cells load',()=>{
 const root=p(0),bank=p(64),nodes={[key(root)]:{position:root,parent:null},[key(bank)]:{position:bank,parent:key(root)}};
 const m={retiredCamps:[{surfaceGraphs:{survival_food:{schema:2,kind:'loaded_dry_waypoint_graph',anchor:root,order:Object.keys(nodes),nodes}}}]};
 const result=routes(m,root,p(140),pos=>pos.x===0||pos.x===64);
 assert.ok(result.some(c=>c.entry.x===0&&c.targetPosition.x===64));
 assert.ok(result.every(c=>c.targetPosition.x!==140),'An unloaded destination is not promoted into an observed graph node');
});
