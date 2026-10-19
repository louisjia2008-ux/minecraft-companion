'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const {createLoadedDryGraph}=require('../vendor/server/minecraft/houseSurfaceGraph');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
test('the outward field graph physically returns to its distant unloaded camp through freshly loaded parent legs',{timeout:20000},async t=>{
 const anchor={x:0,y:1,z:0},nodes={},order=[];
 for(let x=0;x<=160;x+=16){const id=`${x},1,0`;nodes[id]={position:{x,y:1,z:0},parent:x?`${x-16},1,0`:null,expanded:true};order.push(id);}
 let actor;const cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes,order,current:order.at(-1),resumeNode:order.at(-1),visits:order.length,probes:0,frontier:[],blockedEdges:[]};
 const f=native.exports.fixture(t,{initialPosition:new Vec3(160.5,1,.5),checkpoint:cp,worldAt:p=>actor&&Math.abs(p.x-actor.entity.position.x)>48?null:p.y<1?'stone':'air'});actor=f.bot;
 assert.equal(actor.blockAt(new Vec3(0,0,0)),null);
 const graph=createLoadedDryGraph(f.deps,{anchor,radius:384,nativeReachableHints:true,terrainRecovery:true,legTimeoutMs:5000}),r=await graph.returnToAnchor({rejoinInterruptedSuffix:true});
 assert.equal(r.confirmed,true);assert.deepEqual(actor.entity.position.floored(),new Vec3(0,1,0));assert.equal(actor.entity.onGround,true);assert.equal(graph.state().visits,order.length);assert.ok(f.points.length>300);assert.equal(f.waterTicks.length,0);
});
