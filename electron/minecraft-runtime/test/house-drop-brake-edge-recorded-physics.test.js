'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const api=require('../vendor/server/minecraft/houseSurfaceGraph'),saved=require('../test-support/fixtures/formal34-drop-brake-edge.json');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);
native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
const bytes=require('node:zlib').gunzipSync(Buffer.from(saved.statesGzipBase64,'base64')),states=new Uint16Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/2),b=saved.bounds,dy=b.maxY-b.minY+1,dz=b.maxZ-b.minZ+1;
const worldAt=p=>p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ?null:saved.palette[states[(p.x-b.minX)*dz*dy+(p.z-b.minZ)*dy+(p.y-b.minY)]];
for(const baseline of [true,false])test(`formal34 original native descent aligns its real supported braking edge within the same leg: baseline=${baseline}`,{timeout:25000},async t=>{
 const cp=JSON.parse(JSON.stringify(saved.graph)),from=cp.current;cp.frontier=[{parent:from,target:saved.target,plannedSteps:64}];cp.resumeNode=from;cp.nodes[from].expanded=true;
 const f=native.exports.fixture(t,{initialPosition:new Vec3(saved.start.x,saved.start.y,saved.start.z),initialVelocity:new Vec3(saved.velocity.x,saved.velocity.y,saved.velocity.z),checkpoint:cp,worldAt});
 let graphAPI=api;
 if(baseline){const file=path.join(__dirname,'../vendor/server/minecraft/houseSurfaceGraph.js'),old=new Module(file,module);old.filename=file;old.paths=Module._nodeModulePaths(path.dirname(file));
  const text=fs.readFileSync(file,'utf8'),needle='if(terrainRecovery&&hasGroundedBodySupport(bot)&&!naturalWalkingFoot(bot,bot.entity.position.floored()))';assert.ok(text.includes(needle));
  old._compile(text.replace(needle,'if(false&&hasGroundedBodySupport(bot)&&!naturalWalkingFoot(bot,bot.entity.position.floored()))'),file);graphAPI=old.exports;}
 const aligned=[],brakes=[];f.deps.onGroundedDropAlignment=e=>{if(e.aligned===true)aligned.push(e);};f.deps.onControlledDropBrake=e=>brakes.push(e);
 const graph=graphAPI.createLoadedDryGraph(f.deps,{anchor:cp.anchor,radius:384,maxNodes:256,maxEdges:8192,timeoutMs:1200000,legTimeoutMs:20000,adaptiveLocalFrontier:true,nativeReachableHints:true,terrainRecovery:true});
 const before=graph.state();
 if(baseline){await assert.rejects(graph.next(),{code:'dry_graph_drop_brake_unconfirmed'});assert.equal(graph.state().visits,before.visits);return;}
 const result=await graph.next();assert.equal(result.moved,true);assert.deepEqual(result.actual,saved.target);assert.equal(f.bot.entity.onGround,true);
 assert.ok(aligned.length>=1);assert.ok(brakes.length>=1);assert.ok(aligned.every(e=>e.graphNodeCredit===false&&e.positionOrVelocityWritten===false&&e.before.distanceTo(e.actual)<=1));
 assert.ok(aligned.every(e=>brakes.some(b=>b.originalDeadline===e.originalDeadline)));
 assert.equal(graph.state().visits,before.visits+1);assert.equal(graph.state().order.length,before.order.length+1);assert.deepEqual(graph.state().anchor,before.anchor);
 assert.ok(f.points.length>10);assert.equal(f.waterTicks.length,0);
});
