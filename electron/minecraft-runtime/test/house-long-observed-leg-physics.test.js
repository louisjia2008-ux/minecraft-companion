'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished')).replace("bot.emit('physicsTick');},10)","bot.emit('physicsTick');},50)")+'\nmodule.exports={fixture};\n',filename);
const graphFile=path.resolve(__dirname,'../vendor/server/minecraft/houseSurfaceGraph.js'),fixed=require(graphFile),old=new Module(graphFile,module);old.filename=graphFile;old.paths=Module._nodeModulePaths(path.dirname(graphFile));old._compile(fs.readFileSync(graphFile,'utf8').replace('adjacent?visitStartedAt+legTimeoutMs:Infinity','adjacent?visitStartedAt+Math.min(legTimeoutMs,15000):Infinity'),graphFile);
for(const baseline of [true,false])test(`an observed adjacent coordinate reached by a long native detour keeps its configured finite leg budget: baseline=${baseline}`,{timeout:26000},async t=>{
 const anchor={x:0,y:1,z:16},start={x:0,y:1,z:0},cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{'0,1,16':{position:anchor,parent:null,expanded:true},'0,1,0':{position:start,parent:'0,1,16',expanded:true}},order:['0,1,16','0,1,0'],current:'0,1,0',resumeNode:'0,1,0',visits:2,probes:0,frontier:[],blockedEdges:[]};
 const f=native.exports.fixture(t,{initialPosition:new Vec3(.5,1,.5),checkpoint:cp,worldAt:p=>p.y<1&&p.x>=0&&p.x<=28&&p.z>=0&&p.z<=16&&(p.z===0||p.z===16||p.x===28)?'stone':'air'});
 const graph=(baseline?old.exports:fixed).createLoadedDryGraph(f.deps,{anchor,radius:384,nativeReachableHints:true,legTimeoutMs:22000}),started=Date.now();
 const running=graph.travelToObservedNode({exactPosition:anchor});
 if(baseline){await assert.rejects(running,{code:'dry_graph_leg_timeout'});assert.ok(Date.now()-started>=14000);assert.notDeepEqual(f.bot.entity.position.floored(),new Vec3(0,1,16));}
 else{const r=await running;assert.equal(r.confirmed,true);assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,1,16));assert.equal(f.bot.entity.onGround,true);assert.ok(Date.now()-started>15000);assert.equal(graph.state().visits,2);}
});
