'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectHouseCampReturnTrace } = require('../vendor/server/minecraft/houseCampReturnTrace');
const anchor = { x: -130, y: 63, z: -137 };
function fixture() {
  const path = [anchor, { x: -140, y: 64, z: -117 }, { x: -139, y: 64, z: -118 }];
  return { supply: { camp: { anchor }, surfaceResources: { anchor, searches: {
    birch_log: { observedPath: [anchor] }, oak_log: { observedPath: path },
  } } }, graph: { current: '-130,63,-137', nodes: { '-130,63,-137': {} } }, path };
}
test('food detour can select the actual oak suffix when stale active graph only knows camp', () => {
  const f = fixture(); const result = selectHouseCampReturnTrace(f.supply, f.graph, { x: -168, y: 68, z: -128 });
  assert.deepEqual(result, f.path); assert.notEqual(result, f.path);
  assert.equal(f.graph.current, '-130,63,-137'); assert.equal(Object.keys(f.graph.nodes).length, 1);
});
for (const invalid of ['retired_anchor', 'other_transport', 'non_integer', 'off_root', 'too_far']) {
  test(`return trace rejects ${invalid} without changing observations`, () => {
    const f = fixture(); let actual = { x: -168, y: 68, z: -128 };
    if (invalid === 'retired_anchor') f.supply.surfaceResources.anchor = { ...anchor, x: 0 };
    if (invalid === 'other_transport') f.graph.nodes['-140,64,-117'] = { transport: { type: 'water' } };
    if (invalid === 'non_integer') f.path[1] = { x: NaN, y: 64, z: -117 };
    if (invalid === 'off_root') f.graph.current = '-140,64,-117';
    if (invalid === 'too_far') actual = { x: 0, y: 64, z: 0 };
    assert.equal(selectHouseCampReturnTrace(f.supply, f.graph, actual), null);
  });
}

test('workshop return never borrows a spawn-food graph with another anchor or pending water route',()=>{
 const {selectHouseCampGraph}=require('../vendor/server/minecraft/houseCampReturnTrace');
 const graph=p=>({schema:2,kind:'loaded_dry_waypoint_graph',anchor:p,current:`${p.x},${p.y},${p.z}`,order:[`${p.x},${p.y},${p.z}`],nodes:{[`${p.x},${p.y},${p.z}`]:{position:p}}});
 const supply={surfaceGraphs:{survival_food:graph({x:0,y:63,z:0}),oak_log:graph(anchor)}};
 supply.surfaceGraphs.survival_food.pendingWater={unconfirmed:true};
 const before=JSON.stringify(supply);
 assert.equal(selectHouseCampGraph(supply,anchor,'survival_food'),'oak_log');
 assert.equal(selectHouseCampGraph(supply,anchor,'oak_log'),'oak_log');
 assert.equal(JSON.stringify(supply),before,'Selecting a graph grants no crossing or arrival credit');
 delete supply.surfaceGraphs.oak_log.nodes[`${anchor.x},${anchor.y},${anchor.z}`];
 assert.equal(selectHouseCampGraph(supply,anchor,'survival_food'),null);
});

test('a long food detour selects observed natural feet for bounded fresh rejoin rather than discarding the route outside32m',()=>{
 const {campReturnRejoinTargets:targets}=require('../vendor/server/minecraft/houseCampReturnTrace');
 const actual={x:-292,y:64,z:-84},near={x:-269,y:67,z:-36},far={x:-129,y:63,z:-117};
 const r=targets([far,near,{...near},{x:-268,y:67,z:-36},{x:NaN,y:64,z:0}],actual,p=>p.x!==-268);
 assert.deepEqual(r,[near]);assert.ok(Math.hypot(near.x-actual.x,near.z-actual.z)>32);
 assert.deepEqual(targets([near],actual,()=>false),[]);
 assert.deepEqual(targets(Array(4097).fill(near),actual,()=>true),[]);
});
