'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
const saved=require('../test-support/fixtures/formal57-resource-current-frontier.json'),buf=require('node:zlib').gunzipSync(Buffer.from(saved.statesGzipBase64,'base64')),cells=new Uint16Array(buf.buffer,buf.byteOffset,buf.byteLength/2),b=saved.bounds;
const {createLoadedDryGraph}=require('../vendor/server/minecraft/houseSurfaceGraph'),{settleNativeGoto}=require('../vendor/server/minecraft/houseNativeGotoSettlement');
function fixture(t){const cp=JSON.parse(JSON.stringify(saved.checkpoint)),f=native.exports.fixture(t,{checkpoint:cp,initialPosition:new Vec3(saved.start.x,saved.start.y,saved.start.z),worldAt:p=>{
 const inTile=p.x>=b.minX&&p.x<=b.maxX&&p.y>=b.minY&&p.y<=b.maxY&&p.z>=b.minZ&&p.z<=b.maxZ,index=inTile?cells[(p.x-b.minX)*(b.maxZ-b.minZ+1)*(b.maxY-b.minY+1)+(p.z-b.minZ)*(b.maxY-b.minY+1)+p.y-b.minY]:saved.extra[`${p.x},${p.y},${p.z}`];return index===undefined?null:saved.palette[index];
 }}),original=f.bot.pathfinder.getPathFromTo.bind(f.bot.pathfinder);let oldProbes=0;
 // Formal57's older-node probes stayed partial/UNKNOWN. Model that timing
 // only; every newly selected unvisited endpoint is independently native-probed.
 f.bot.pathfinder.getPathFromTo=function*(profile,from,goal,options){if(cp.nodes[`${goal.x},${goal.y},${goal.z}`]&&`${goal.x},${goal.y},${goal.z}`!==cp.current){oldProbes++;for(let i=0;i<512;i++)yield {result:{status:'partial',path:[]}};return {result:{status:'partial',path:[]}};}return yield* original(profile,from,goal,options);};
 f.deps.actualnativegoto=(goal,profile,budget)=>settleNativeGoto({...f.deps,isExpectedStop:budget.isExpectedNativeStop,allowPendingTimeout:budget.isExpectedNativeTimeout},{goal,deadline:budget.deadline});return {...f,cp,oldProbes:()=>oldProbes};}
for(const fixed of [false,true])test(`formal57 actual current node must inspect its local rings before retrying older unknown branches: fixed=${fixed}`,{timeout:18000},async t=>{
 const f=fixture(t),graph=createLoadedDryGraph(f.deps,{anchor:f.cp.anchor,maxEdges:8192,maxNodes:256,adaptiveLocalFrontier:true,nativeReachableHints:true,terrainRecovery:true,preferActualLocalFrontier:fixed,legTimeoutMs:8000});
 const running=graph.next();
 if(fixed){const r=await running;assert.equal(r.moved,true);assert.equal(graph.state().visits,f.cp.visits+1);assert.equal(f.bot.entity.onGround,true);assert.ok(f.points.length>3);assert.equal(f.bot.inventory.items().length,0);assert.equal(f.oldProbes(),0);t.diagnostic(JSON.stringify({fixed,actual:r.actual,visits:graph.state().visits,oldProbes:f.oldProbes(),attempts:f.attempts.length}));}
 else{await assert.rejects(running,{code:'dry_graph_probe_inconclusive'});assert.equal(graph.state().visits,f.cp.visits);assert.ok(f.oldProbes()>0);assert.equal(f.attempts.length,0);assert.equal(graph.state().nodes[f.cp.current].localFrontierObservation,undefined);}
 assert.deepEqual(graph.state().anchor,f.cp.anchor);
});

for(const pause of [false,true])test(`a freshly cleared two-cell passage becomes a separately probed current frontier: pause=${pause}`,{timeout:6000},async t=>{
 const anchor={x:8,y:1,z:0},id='0,1,0',root='8,1,0',cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[root]:{position:anchor,parent:null,expanded:true},[id]:{position:{x:0,y:1,z:0},parent:root,expanded:true}},order:[root,id],current:id,resumeNode:id,visits:2,probes:0,frontier:[{parent:root,target:{x:24,y:1,z:0},plannedSteps:16}],blockedEdges:[]},overlay=new Map(),digs=[];
 const f=native.exports.fixture(t,{checkpoint:cp,worldAt:p=>overlay.get(p.toString())||(p.y<1?'stone':p.y<=2&&(Math.abs(p.x)===1||Math.abs(p.z)===1)?'stone':'air')});
 f.deps.canDigPassageBlock=b=>b.name==='stone';f.deps.digPassageBlock=async b=>{digs.push(b.position.clone());overlay.set(b.position.toString(),'air');if(pause)f.cancel();};
 const graph=createLoadedDryGraph(f.deps,{anchor,adaptiveLocalFrontier:true,preferActualLocalFrontier:true,terrainRecovery:true,legTimeoutMs:4000});
 if(pause){await assert.rejects(graph.next(),{code:'cancelled'});assert.equal(digs.length,1);assert.equal(graph.state().visits,2);assert.equal(f.attempts.length,0);}
 else{const r=await graph.next();assert.equal(r.moved,true);assert.deepEqual(r.actual,{x:1,y:1,z:0});assert.equal(digs.length,2);assert.equal(graph.state().visits,3);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.blockAt(new Vec3(1,0,0)).name,'stone');assert.ok(digs.every(p=>p.y>0));}
});

test('unfinished short local probes get a bounded fresh native plan before UNKNOWN becomes a dead end',{timeout:6000},async t=>{
 const f=native.exports.fixture(t),original=f.bot.pathfinder.getPathFromTo.bind(f.bot.pathfinder);let retries=0;
 f.bot.pathfinder.getPathFromTo=function*(profile,from,goal,options){if(options.timeout<=100)return {result:{status:'timeout',path:[]}};retries++;return yield* original(profile,from,goal,options);};
 const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0},adaptiveLocalFrontier:true,preferActualLocalFrontier:true,legTimeoutMs:3000});
 const result=await graph.next();assert.equal(result.moved,true);assert.ok(retries>0&&retries<=6);assert.equal(f.bot.entity.onGround,true);assert.equal(graph.state().visits,2);
});
