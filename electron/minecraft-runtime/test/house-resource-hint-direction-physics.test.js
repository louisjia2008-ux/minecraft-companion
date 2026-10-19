'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {createLoadedDryGraph}=require('../vendor/server/minecraft/houseSurfaceGraph');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);
native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
for(const legacy of [false,true])test(`hint-only failed east search cannot erase untested native west exploration: legacy=${legacy}`,{timeout:6000},async t=>{
 const anchor={x:0,y:1,z:0};const node={position:anchor,parent:null,expanded:true};
 if(legacy){node.resourceLocalFrontierExpanded=true;node.localFrontierExpanded=true;node.localFrontierObservation={testedRanges:[8,4,2,1],domain:'NATIVE_PLAN_ONLY',actualMovementConfirmed:false};}
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{'0,1,0':node},order:['0,1,0'],frontier:[],blockedEdges:[],current:'0,1,0',resumeNode:'0,1,0',visits:1,probes:7};
 const f=native.exports.fixture(t,{checkpoint,worldAt:p=>p.z===0&&p.x>=-2&&p.x<=0&&p.y<=0?'stone':'air'});
 f.deps.getObservedResourceTarget=()=>({kind:'native_loaded_block_observation',position:{x:20,y:1,z:0},lastValidatedAt:Date.now()});
 const graph=createLoadedDryGraph(f.deps,{anchor,radius:384,maxNodes:256,maxEdges:8192,timeoutMs:10000,legTimeoutMs:3000,adaptiveLocalFrontier:true,deferInconclusiveExplorationReplay:true});
 const result=await graph.next();assert.equal(result.moved,true);assert.equal(result.actual.x,-2);assert.equal(f.bot.entity.onGround,true);
 assert.ok(graph.state().probes>=7);const origin=graph.state().nodes['0,1,0'];assert.equal(origin.localFrontierObservation.directionCoverage,'all_eight');
 if(legacy)assert.deepEqual(origin.legacyHintLocalFrontierObservation.testedRanges,[8,4,2,1]);else assert.equal(origin.resourceLocalFrontierObservation.directionCoverage,'hint_only');
});
