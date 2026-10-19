'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {rejoinOwnedCampRoute}=require('../vendor/server/minecraft/houseCampRejoin');
const blocked=()=>Object.assign(Error('blocked'),{code:'house_surface_dry_graph_native_no_path'});
test('a ravine return climbs in finite actual stages before retrying the old waypoint',async()=>{
 let y=52,tries=0;const records=[];
 assert.equal(await rejoinOwnedCampRoute({assertActive(){},deadline:Date.now()+10000,target:{x:0,y:65,z:0},position:()=>({x:0,y,z:0}),
  rejoin:async()=>{tries++;if(y<65)throw blocked();},recover:async()=>{y=Math.min(65,y+6);return true;},record:x=>records.push(x)}),true);
 assert.equal(tries,4);assert.equal(records.length,3);assert.ok(records.every(r=>r.oldRouteTraversalCredit===false));
});
test('failure without actual upward progress requests a fresh strategy instead of identical retries',async()=>{
 let tries=0;assert.equal(await rejoinOwnedCampRoute({assertActive(){},deadline:Date.now()+10000,target:{x:0,y:65,z:0},position:()=>({x:0,y:52,z:0}),
  rejoin:async()=>{tries++;throw blocked();},recover:async()=>true}),false);assert.equal(tries,1);
});
test('cancelled or replaced control cannot authorize a recovery dig',async()=>{
 let digs=0;await assert.rejects(rejoinOwnedCampRoute({assertActive(){},deadline:Date.now()+10000,target:{x:0,y:65,z:0},position:()=>({x:0,y:52,z:0}),
  rejoin:async()=>{throw Object.assign(Error('cancel'),{code:'movement_preempted'});},recover:async()=>{digs++;}}),{code:'movement_preempted'});assert.equal(digs,0);
});

test('native NoPath below a nearby camp gets the same checked upward recovery, without altering arrival evidence',async()=>{
 let y=63,attempts=0;
 const confirmed=await rejoinOwnedCampRoute({assertActive(){},deadline:Date.now()+10000,target:{x:0,y:66,z:0},position:()=>({x:0,y,z:0}),
  rejoin:async()=>{attempts++;if(y!==66)throw Object.assign(Error('No path to the goal!'),{name:'NoPath'});},
  recover:async()=>{y=66;return true;}});
 assert.equal(confirmed,true);assert.equal(attempts,2);
});
