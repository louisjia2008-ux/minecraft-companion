'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const {createLoadedDryGraph}=require('../vendor/server/minecraft/houseSurfaceGraph'),saved=require('../test-support/fixtures/formal32-fresh-camp-graph-reconcile.json');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);
native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
const bytes=require('node:zlib').gunzipSync(Buffer.from(saved.statesGzipBase64,'base64')),states=new Uint16Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/2),b=saved.bounds,dy=b.maxY-b.minY+1,dz=b.maxZ-b.minZ+1;
const recorded=p=>p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ?null:saved.palette[states[(p.x-b.minX)*dz*dy+(p.z-b.minZ)*dy+(p.y-b.minY)]];
for(const mode of ['actual_arrival','missing_floor','unknown_floor','fluid_floor','pause','foreign'])test(`formal32 fresh camp arrival reconciles only a freshly validated known graph node: ${mode}`,async t=>{
 const checkpoint=JSON.parse(JSON.stringify(saved.graph)),root=checkpoint.anchor,id=`${root.x},${root.y},${root.z}`;
 const f=native.exports.fixture(t,{initialPosition:new Vec3(saved.actual.x,saved.actual.y,saved.actual.z),checkpoint,worldAt:p=>{
  if(p.x===root.x&&p.y===root.y-1&&p.z===root.z){if(mode==='missing_floor')return 'air';if(mode==='unknown_floor')return null;if(mode==='fluid_floor')return 'water';}
  return recorded(p);
 }});
 if(mode==='pause')f.cancel();if(mode==='foreign')f.deps.isMovementOwner=()=>false;
 const graph=createLoadedDryGraph(f.deps,{anchor:root,radius:384,maxNodes:256,maxEdges:8192,terrainRecovery:true});
 const before=graph.state();assert.notEqual(before.current,id);
 if(mode!=='actual_arrival'){
  await assert.rejects(graph.returnToAnchor({returnToCurrentOnly:true,rejoinInterruptedSuffix:true}));
  assert.equal(graph.state().current,before.current);assert.equal(graph.state().visits,before.visits);assert.equal(f.attempts.length,0);return;
 }
 // Recorded Java arrival is fixture initialization only, not a new live run.
 // The real graph API validates it; no manual cursor/pose edits are performed.
 const receipt=await graph.returnToAnchor({returnToCurrentOnly:true,rejoinInterruptedSuffix:true});
 assert.equal(receipt.confirmed,true);assert.equal(receipt.current,id);assert.equal(graph.state().current,id);
 assert.equal(graph.state().visits,before.visits);assert.deepEqual(graph.state().order,before.order);assert.deepEqual(graph.state().nodes,before.nodes);
 assert.equal(graph.state().resumeNode,before.resumeNode);assert.equal(f.attempts.length,0);assert.deepEqual(graph.state().anchor,before.anchor);
});
