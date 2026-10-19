'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
const {createLoadedDryGraph}=require('../vendor/server/minecraft/houseSurfaceGraph'),{recoverTimedOutSiteLeg}=require('../vendor/server/minecraft/houseSiteTimeoutRecovery');
// Native pathfinder+physics, deliberately shortened original leg budget. No
// pose/velocity/world mutation, and no server or full-workflow claim.
test('an expired native site leg can yield a fresh actual dry observation after its old motor is idle',{timeout:5000},async t=>{
 const f=native.exports.fixture(t),anchor={x:0,y:1,z:0},graph=createLoadedDryGraph(f.deps,{anchor,terrainRecovery:true,legTimeoutMs:80});let error;
 try{await graph.next();assert.fail('leg must expire');}catch(e){error=e;assert.equal(e.code,'dry_graph_leg_timeout');}
 const before=f.checkpoint(),oldAnchor=JSON.stringify(before.anchor),records=[],calls=f.attempts.length;
 const result=await recoverTimedOutSiteLeg({...f.deps,getCP:f.checkpoint,saveCP:f.deps.setCheckpoint,isMotorIdle:()=>true,record:v=>records.push(v)},error,{deadline:Date.now()+3000});
 assert.equal(result.confirmed,true);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.pathfinder.goal,null);assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,1,.5))>.1);assert.equal(f.attempts.length,calls,'Recovery only observes; it never submits another movement');assert.equal(JSON.stringify(f.checkpoint().anchor),oldAnchor);assert.equal(f.checkpoint().nodes[f.checkpoint().current].timedOutLegLanding.oldGoalAccepted,false);assert.equal(records[0].oldEdgeTraversalCredit,false);
 assert.ok(!f.checkpoint().frontier.some(e=>e.parent===error.observedDryLeg.fromNode&&JSON.stringify(e.target)===JSON.stringify(error.observedDryLeg.target)));
});
function stillFixture(t){const anchor={x:0,y:1,z:0},cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{'0,1,0':{position:anchor,parent:null,expanded:true}},order:['0,1,0'],current:'0,1,0',resumeNode:'0,1,0',visits:1,probes:1,frontier:[],blockedEdges:[]};const f=native.exports.fixture(t,{checkpoint:cp});const error=Object.assign(Error('expired'),{code:'dry_graph_leg_timeout',observedDryLeg:{fromNode:'0,1,0',from:'0,1,0',target:{x:16,y:1,z:0},deadline:Date.now()-10}});return {...f,error};}
for(const mode of ['hazardError','paused','searchDeadline','pendingWater','pendingTrail','staleReceipt','lateCPWrite','movingMotor'])test(`expired site recovery refuses ${mode}`,{timeout:3000},async t=>{
 const f=stillFixture(t);let saves=0;if(mode==='hazardError')f.error.code='dry_graph_airshaft';if(mode==='paused')f.cancel();if(mode==='pendingWater')f.checkpoint().pendingWater={};if(mode==='pendingTrail')f.checkpoint().pendingDryTrail={};if(mode==='staleReceipt')f.error.observedDryLeg.deadline-=2000;
 let reads=0;const work=recoverTimedOutSiteLeg({...f.deps,getCP:()=>{const cp=f.checkpoint();if(mode==='lateCPWrite'&&++reads>1)return {...cp,probes:2};return cp;},saveCP:()=>saves++,isMotorIdle:()=>mode!=='movingMotor'},f.error,{deadline:Date.now()+(mode==='searchDeadline'?-1:mode==='movingMotor'?40:2000)});
 if(mode==='paused')await assert.rejects(work,{code:'cancelled'});else assert.equal((await work).confirmed,false);assert.equal(saves,0);assert.equal(f.attempts.length,0);
});
