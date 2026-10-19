'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const {createLoadedDryGraph}=require('../vendor/server/minecraft/houseSurfaceGraph');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);
native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
for(const status of ['noPath','timeout'])for(const mode of ['site','explicit-return','cancelled','foreign'])test(`native partial ${status} stops and observes only its own actual dry site landing: ${mode}`,{timeout:12000},async t=>{
 const anchor={x:0,y:3,z:0},target={x:16,y:1,z:0};
 const cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{'0,3,0':{position:anchor,parent:null,expanded:true}},order:['0,3,0'],frontier:[{parent:'0,3,0',target}],blockedEdges:[],current:'0,3,0',resumeNode:'0,3,0',visits:1,probes:0};
 const f=native.exports.fixture(t,{initialPosition:new Vec3(.5,3,.5),checkpoint:cp,worldAt:p=>p.y<=0||p.x<=0&&p.y<=2?'stone':'air'});
 let injected=false;const receipts=[];
 f.deps.onPartialSiteLanding=e=>receipts.push(e);
 // A modeled native noPath notification after REAL installed pathfinder and
 // physics have already moved. No pose, velocity, inventory or world writes.
 f.bot.on('physicsTick',()=>{if(injected||f.bot.entity.position.x<1.15)return;injected=true;
  f.bot.emit('path_update',{status,path:[{x:2.5,y:1,z:.5}]});
  if(mode==='cancelled')f.cancel();
  if(mode==='foreign')f.bot.pathfinder.setMovements(new (require('mineflayer-pathfinder').Movements)(f.bot));
 });
 const graph=createLoadedDryGraph(f.deps,{anchor,radius:384,maxNodes:256,maxEdges:8192,timeoutMs:20000,legTimeoutMs:8000,terrainRecovery:true,deferInconclusiveExplorationReplay:mode!=='explicit-return'});
 if(mode!=='site'){
  await assert.rejects(graph.next());assert.equal(graph.state().visits,1);assert.equal(receipts.length,0);return;
 }
 const result=await graph.next();assert.equal(injected,true);assert.equal(result.moved,true);
 assert.equal(f.bot.entity.onGround,true);assert.equal(result.actual.y,1);assert.notDeepEqual(result.actual,target);
 assert.equal(receipts.length,1);assert.equal(receipts[0].oldTargetReached,false);assert.equal(receipts[0].oldEdgeTraversalCredit,false);
 assert.equal(graph.state().visits,2);assert.deepEqual(graph.state().anchor,anchor);
 const node=graph.state().nodes[graph.state().current];assert.equal(node.partialNativeLanding.oldEdgeTraversalCredit,false);assert.equal(node.dryParentTrail,undefined);
 assert.ok(f.points.length>3);assert.equal(f.waterTicks.length,0);
});
test('formal35 saved cliff geometry keeps an unrelated NoPath during controlled braking out of partial-landing receipts',{timeout:12000},async t=>{
 const saved=require('../test-support/fixtures/formal35-partial-no-path-landing.json'),buf=require('node:zlib').gunzipSync(Buffer.from(saved.statesGzipBase64,'base64')),cells=new Uint16Array(buf.buffer,buf.byteOffset,buf.byteLength/2),b=saved.bounds;
 const worldAt=p=>p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ?null:saved.palette[cells[(p.x-b.minX)*(b.maxZ-b.minZ+1)*(b.maxY-b.minY+1)+(p.z-b.minZ)*(b.maxY-b.minY+1)+p.y-b.minY]];
 const anchor={x:-100,y:67,z:64},target={x:-101,y:64,z:66},key='-100,67,64',cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[key]:{position:anchor,parent:null,expanded:true}},order:[key],frontier:[{parent:key,target}],blockedEdges:[],current:key,resumeNode:key,visits:1,probes:0};
 const f=native.exports.fixture(t,{initialPosition:new Vec3(saved.start.x,saved.start.y,saved.start.z),checkpoint:cp,worldAt});
 let injected=false;const receipts=[],brakes=[];f.deps.onPartialSiteLanding=e=>receipts.push(e);f.deps.onControlledDropBrake=e=>brakes.push(e);
 f.bot.prependListener('physicsTick',()=>{if(injected||f.bot.entity.position.x> -100.3)return;injected=true;f.bot.emit('path_update',{status:'noPath',path:[{x:-100.5,y:65,z:66.5}]});});
 const graph=createLoadedDryGraph(f.deps,{anchor,radius:384,maxNodes:256,maxEdges:8192,timeoutMs:20000,legTimeoutMs:8000,terrainRecovery:true,deferInconclusiveExplorationReplay:true});
 const result=await graph.next();assert.equal(injected,true);assert.equal(result.moved,true);assert.equal(receipts.length,0);
 assert.ok(brakes.length>=1);assert.equal(f.bot.entity.onGround,true);assert.deepEqual(result.actual,target);assert.equal(graph.state().visits,2);assert.deepEqual(graph.state().anchor,anchor);
 assert.equal(graph.state().blockedEdges.some(e=>e.kind==='actual_native_no_path_landing'),false);
});
