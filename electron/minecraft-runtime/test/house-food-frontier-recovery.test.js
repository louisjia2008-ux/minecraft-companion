'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {advanceFoodFrontier}=require('../vendor/server/minecraft/houseFoodSearch');
function fixture(code){let atRoot=false,rejoins=0;const calls=[];
 const deps={anchor:{x:0,y:64,z:0},assertActive(){},getPosition:()=>atRoot?{x:0,y:64,z:0}:{x:50,y:64,z:0},
  getCheckpoint:()=>({current:'0,64,0'}),savePath(){},returnToRoot:async()=>{calls.push('actual_return');atRoot=true;},
  rejoin:async()=>{calls.push('rejoin');if(++rejoins===1&&code)throw Object.assign(Error('interrupted outside approach'),{code});assert.equal(atRoot,true);},
  explore:async()=>{calls.push('explore');return {moved:true};}};
 return{deps,calls};}
for(const code of ['house_surface_dry_graph_transport_origin','house_surface_dry_graph_probe_inconclusive'])test(`interrupted food transport ${code} first regains its actual root then reruns the same strict reconciler`,async()=>{
 const f=fixture(code);assert.equal(await advanceFoodFrontier(f.deps),true);
 assert.deepEqual(f.calls,['rejoin','actual_return','rejoin','explore']);
});
test('an unsuccessful independent return or another UNKNOWN reconciliation never grants exploration',async()=>{
 const f=fixture('house_surface_dry_graph_probe_inconclusive');f.deps.returnToRoot=async()=>{throw Object.assign(Error('fresh root not proven'),{code:'root_unknown'});};
 await assert.rejects(advanceFoodFrontier(f.deps),{code:'root_unknown'});assert.deepEqual(f.calls,['rejoin']);
 const g=fixture('house_surface_dry_graph_probe_inconclusive');g.deps.rejoin=async()=>{g.calls.push('rejoin');throw Object.assign(Error('still unknown'),{code:'house_surface_dry_graph_probe_inconclusive'});};
 await assert.rejects(advanceFoodFrontier(g.deps),{code:'house_surface_dry_graph_probe_inconclusive'});
 assert.deepEqual(g.calls,['rejoin','actual_return','rejoin']);
});
test('pause and unrelated movement failures never acquire a root return or food exploration',async()=>{
 for(const code of ['paused','cancelled','movement_preempted','house_surface_water_hostile_retreat']){
  const f=fixture(code);await assert.rejects(advanceFoodFrontier(f.deps),{code});assert.deepEqual(f.calls,['rejoin']);
 }
});
