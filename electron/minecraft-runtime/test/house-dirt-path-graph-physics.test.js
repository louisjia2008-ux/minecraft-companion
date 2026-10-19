'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const {createLoadedDryGraph}=require('../vendor/server/minecraft/houseSurfaceGraph'),data=require('../test-support/fixtures/formal14-path-shape-jump.json');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
test('formal14 the original native graph physically completes the recorded ascending dirt-path leg without disabling the support guard',{timeout:20000},async t=>{
 const anchor={x:303,y:67,z:-184},id='303,67,-184',target={x:320,y:75,z:-192},cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:true}},order:[id],current:id,resumeNode:id,visits:1,probes:0,blockedEdges:[],frontier:[{parent:id,target,plannedSteps:25}]};
 const f=native.exports.fixture(t,{initialPosition:new Vec3(303.5,67,-183.5),initialVelocity:new Vec3(0,-.0784000015258789,0),checkpoint:cp,worldAt:p=>{const b=data.bounds;if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;return data.palette[data.states[`${p.x},${p.y},${p.z}`]||0];}});
 const graph=createLoadedDryGraph(f.deps,{anchor,radius:384,nativeReachableHints:true,terrainRecovery:true,legTimeoutMs:12000});const result=await graph.next().catch(error=>{error.message+=' '+JSON.stringify({movement:error.observedMovement});throw error;});
 assert.equal(result.moved,true);assert.deepEqual(result.actual,target);assert.equal(graph.state().visits,2);assert.equal(f.bot.entity.onGround,true);assert.ok(f.points.length>30);assert.equal(f.waterTicks.length,0);
});
