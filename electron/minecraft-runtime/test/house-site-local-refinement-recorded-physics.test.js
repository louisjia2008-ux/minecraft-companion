'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const api=require('../vendor/server/minecraft/houseSurfaceGraph'),saved=require('../test-support/fixtures/formal31-site-local-refinement.json');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);
native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
const bytes=require('node:zlib').gunzipSync(Buffer.from(saved.statesGzipBase64,'base64'));
const states=new Uint16Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/2),b=saved.bounds,dy=b.maxY-b.minY+1,dz=b.maxZ-b.minZ+1;
const worldAt=p=>p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ?null:saved.palette[states[(p.x-b.minX)*dz*dy+(p.z-b.minZ)*dy+(p.y-b.minY)]];
for(const baseline of [true,false])test(`formal31 saved one-way site graph tries its untested one-meter ring without claiming spawn return: baseline=${baseline}`,{timeout:15000},async t=>{
 const recordedAt=saved.graph.blockedEdges.at(-1).retryAfter-120000+5;
 t.mock.timers.enable({apis:['Date'],now:recordedAt});
 const checkpoint=JSON.parse(JSON.stringify(saved.graph)),current=checkpoint.current;
 // Replay the recorded deferral clock, graph and actual support/pose. No
 // node, inventory, floor, parent or live-world timing credit is fabricated.
 const f=native.exports.fixture(t,{initialPosition:new Vec3(saved.actual.x,saved.actual.y,saved.actual.z),checkpoint,worldAt});
 let graphAPI=api;
 if(baseline){
  const file=path.join(__dirname,'../vendor/server/minecraft/houseSurfaceGraph.js'),old=new Module(file,module);old.filename=file;old.paths=Module._nodeModulePaths(path.dirname(file));
  const text=fs.readFileSync(file,'utf8'),needle='return deferInconclusiveExplorationReplay && Array.isArray(node?.localFrontierObservation?.testedRanges)';
  assert.ok(text.includes(needle));
  // This historical baseline predates both current-node refinement and the
  // later older-node revisit fallback. Disable both only in this in-memory
  // comparison; the fixed runtime must retain both recovery paths.
  const older='&&(!state.nodes[id].expanded||deferInconclusiveExplorationReplay&&adaptiveLocalFrontier\n              &&(!state.nodes[id].localFrontierExpanded||needsSiteLocalRefinement(state.nodes[id])))';
  assert.ok(text.includes(older));old._compile(text.replace(needle,'return false && Array.isArray(node?.localFrontierObservation?.testedRanges)').replace(older,'&&!state.nodes[id].expanded'),file);graphAPI=old.exports;
 }
 const graph=graphAPI.createLoadedDryGraph(f.deps,{anchor:checkpoint.anchor,radius:384,maxNodes:256,maxEdges:8192,timeoutMs:1200000,legTimeoutMs:5000,adaptiveLocalFrontier:true,nativeReachableHints:true,terrainRecovery:true,deferInconclusiveExplorationReplay:true});
 const before=graph.state();let result;
 for(let attempt=0;attempt<12;attempt++){result=await graph.next();if(result.moved)break;if(graph.state().probes===before.probes)break;}
 if(baseline){assert.equal(result.moved,false);assert.equal(graph.state().visits,before.visits);return;}
 assert.equal(result.moved,true);assert.equal(graph.state().visits,before.visits+1);assert.equal(graph.state().order.length,before.order.length+1);
 assert.notEqual(graph.state().current,current);assert.equal(f.bot.entity.onGround,true);assert.ok(f.points.length>1);
 assert.deepEqual(graph.state().anchor,checkpoint.anchor);assert.ok(graph.state().nodes[current].localFrontierObservation.testedRanges.includes(1));
 assert.ok(f.attempts.every(p=>p.x!==261||p.y!==66||p.z!==41),'An unreachable spawn receives no movement command');
 // Explicit return remains a separate strict operation; unobserved terrain
 // cannot acquire arrival credit because site exploration found another step.
 await assert.rejects(graph.returnToAnchor());assert.deepEqual(graph.state().anchor,checkpoint.anchor);
});
