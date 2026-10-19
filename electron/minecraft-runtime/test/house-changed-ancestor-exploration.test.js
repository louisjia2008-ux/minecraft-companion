'use strict';
// A historical parent loses its floor; the actor is still actually grounded
// at its recorded child. Native Physics/pathfinder, modeled terrain change.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const {createLoadedDryGraph}=require('../vendor/server/minecraft/houseSurfaceGraph');
for(const mode of ['exploration','explicit_return'])test(`world159 changed ancestor floor preserves safe actual descendant: ${mode}`,{timeout:8000},async t=>{
 const anchor={x:0,y:1,z:0},a='0,1,0',b='2,1,0',checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,step:16,radius:384,
  nodes:{[a]:{position:anchor,parent:null,expanded:true},[b]:{position:{x:2,y:1,z:0},parent:a,expanded:true}},order:[a,b],current:b,resumeNode:a,visits:2,probes:0,blockedEdges:[],frontier:[{parent:a,target:{x:-16,y:1,z:0}}]};
 const f=native.exports.fixture(t,{initialPosition:new Vec3(2.5,1,.5),initialVelocity:new Vec3(0,-.0784000015258789,0),checkpoint,worldAt:p=>p.y<0?'stone':p.y===0?(p.x===0&&p.z===0?'air':'stone'):'air'});
 const graph=createLoadedDryGraph(f.deps,{anchor,adaptiveLocalFrontier:true,preferActualLocalFrontier:true,nativeReachableHints:true,deferInconclusiveExplorationReplay:true,terrainRecovery:true});
 if(mode==='explicit_return'){await assert.rejects(graph.returnToAnchor({anchor}),{code:'dry_graph_route_changed'});assert.equal(f.checkpoint().current,b);assert.equal(f.checkpoint().visits,2);return;}
 const result=await graph.next();assert.equal(result.moved,true);const cp=f.checkpoint();assert.ok(cp.nodes[a].terrainUnavailable);assert.equal(cp.nodes[b].terrainUnavailable,undefined);assert.equal(cp.nodes[b].parent,a);assert.ok(cp.order.includes(a)&&cp.order.includes(b));assert.equal(cp.visits,cp.order.length);assert.ok(cp.nodes[cp.current]);assert.notEqual(cp.current,a);assert.ok(f.points.length);
 assert.ok(cp.blockedEdges.some(e=>e.kind==='terrain_changed_exploration_branch'&&e.targetNode===a));
});
