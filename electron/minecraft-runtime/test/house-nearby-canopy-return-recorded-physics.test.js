'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const api=require('../vendor/server/minecraft/houseSurfaceGraph'),saved=require('../test-support/fixtures/formal39-nearby-canopy-return.json');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
const buf=require('node:zlib').gunzipSync(Buffer.from(saved.statesGzipBase64,'base64')),cells=new Uint16Array(buf.buffer,buf.byteOffset,buf.byteLength/2),b=saved.bounds;
const worldAt=p=>p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ?null:saved.palette[cells[(p.x-b.minX)*(b.maxZ-b.minZ+1)*(b.maxY-b.minY+1)+(p.z-b.minZ)*(b.maxY-b.minY+1)+p.y-b.minY]];
for(const baseline of [true,false])test(`formal39 nearby loaded canopy return independently confirms short legs instead of requiring distant ancestors: baseline=${baseline}`,{timeout:30000},async t=>{
 const cp=JSON.parse(JSON.stringify(saved.graph)),f=native.exports.fixture(t,{initialPosition:new Vec3(saved.start.x,saved.start.y,saved.start.z),checkpoint:cp,worldAt});let graphAPI=api;
 if(baseline){const file=path.join(__dirname,'../vendor/server/minecraft/houseSurfaceGraph.js'),old=new Module(file,module);old.filename=file;old.paths=Module._nodeModulePaths(path.dirname(file));const text=fs.readFileSync(file,'utf8'),needle='&&vec(node.position).distanceTo(bot.entity.position)<=radius';assert.equal(text.split(needle).length,2);old._compile(text.replace(needle,'&&vec(node.position).distanceTo(bot.entity.position)>32'+needle),file);graphAPI=old.exports;}
 const graph=graphAPI.createLoadedDryGraph(f.deps,{anchor:cp.anchor,radius:384,maxNodes:256,maxEdges:8192,timeoutMs:1200000,legTimeoutMs:20000,adaptiveLocalFrontier:true,nativeReachableHints:true,terrainRecovery:true});
 // Saved MCA geometry is exact. Model only the finite long-probe UNKNOWN
 // outcome observed on the live canopy; every short leg still uses the
 // unmodified installed native planner and actual Physics movement.
 const probes=[],original=f.bot.pathfinder.getPathFromTo.bind(f.bot.pathfinder);
 f.bot.pathfinder.getPathFromTo=function*(profile,from,goal,options){
  const iterator=original(profile,from,goal,options),at=f.bot.entity.position.floored();
  const modeled=at.x===53&&at.y===72&&at.z===-104&&Object.values(cp.nodes).some(n=>n.position.x===goal.x&&n.position.y===goal.y&&n.position.z===goal.z);
  let step,last;
  for(let i=0;i<200;i++){
   step=iterator.next();if(step.value?.result)last=step.value.result;
   if(modeled){if(step.done||last?.status!=='partial')break;}
   else {probes.push({modeled:false,status:last?.status});if(step.done)return step.value;yield step.value;}
  }
  const answer={...last,status:'partial',path:(last?.path||[]).slice(0,Math.max(1,(last?.path||[]).length-1))};
  probes.push({goal:{x:goal.x,y:goal.y,z:goal.z},modeled:true,status:answer.status});for(let n=0;n<60;n++)yield {result:answer};return {result:answer};
 };
 const before=graph.state();
 if(baseline){await assert.rejects(graph.returnToAnchor({rejoinInterruptedSuffix:true}));assert.equal(graph.state().visits,before.visits);return;}
 const r=await graph.returnToAnchor({rejoinInterruptedSuffix:true});assert.equal(r.confirmed,true);assert.deepEqual(r.actual,cp.anchor);assert.equal(f.bot.entity.onGround,true);assert.equal(graph.state().visits,before.visits);assert.equal(graph.state().order.length,before.order.length);assert.equal(graph.state().current,`${cp.anchor.x},${cp.anchor.y},${cp.anchor.z}`);assert.ok(f.points.length>10);assert.equal(f.waterTicks.length,0);assert.ok(probes.some(p=>p.modeled));assert.ok(probes.some(p=>!p.modeled&&p.status==='success'));assert.ok(f.attempts.length>=2);
});
