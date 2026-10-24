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
 assert.equal(result.confirmed,true);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.pathfinder.goal,null);assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,1,.5))>.1);assert.equal(f.attempts.length,calls,'Recovery only observes; it never submits another movement');assert.equal(JSON.stringify(f.checkpoint().anchor),oldAnchor);
 const after=f.checkpoint(),actual=f.bot.entity.position.floored(),actualPoint={x:actual.x,y:actual.y,z:actual.z},actualId=`${actual.x},${actual.y},${actual.z}`,created=!before.nodes[actualId];
 assert.equal(after.current,actualId);assert.equal(after.resumeNode,actualId);assert.deepEqual(result.actual,actualPoint);
 // A short native leg can move within its original cell and coast to rest
 // there. Observing that existing node must not manufacture another visit or
 // replace its original evidence with a new-node landing receipt.
 assert.equal(result.created,created);assert.equal(after.visits,before.visits+(created?1:0));assert.equal(after.order.length,before.order.length+(created?1:0));assert.equal(Object.keys(after.nodes).length,Object.keys(before.nodes).length+(created?1:0));
 assert.deepEqual(after.order,created?[...before.order,actualId]:before.order);for(const id of before.order)assert.deepEqual(after.nodes[id],before.nodes[id]);
 assert.equal(records.length,1);assert.deepEqual(records[0].actual,actualPoint);assert.equal(records[0].oldGoalAccepted,false);assert.equal(records[0].oldEdgeTraversalCredit,false);
 if(created){assert.deepEqual(after.nodes[after.current].timedOutLegLanding,records[0]);assert.equal(after.nodes[after.current].parent,error.observedDryLeg.fromNode);}
 else {assert.deepEqual(after.nodes[after.current],before.nodes[after.current]);assert.deepEqual(after.order,before.order);}
 assert.ok(!after.frontier.some(e=>e.parent===error.observedDryLeg.fromNode&&JSON.stringify(e.target)===JSON.stringify(error.observedDryLeg.target)));
});
function stillFixture(t){const anchor={x:0,y:1,z:0},cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{'0,1,0':{position:anchor,parent:null,expanded:true}},order:['0,1,0'],current:'0,1,0',resumeNode:'0,1,0',visits:1,probes:1,frontier:[],blockedEdges:[]};const f=native.exports.fixture(t,{checkpoint:cp});const error=Object.assign(Error('expired'),{code:'dry_graph_leg_timeout',observedDryLeg:{fromNode:'0,1,0',from:'0,1,0',target:{x:16,y:1,z:0},deadline:Date.now()-10}});return {...f,error};}
for(const mode of ['hazardError','paused','searchDeadline','pendingWater','pendingTrail','staleReceipt','lateCPWrite','movingMotor'])test(`expired site recovery refuses ${mode}`,{timeout:3000},async t=>{
 const f=stillFixture(t);let saves=0;if(mode==='hazardError')f.error.code='dry_graph_airshaft';if(mode==='paused')f.cancel();if(mode==='pendingWater')f.checkpoint().pendingWater={};if(mode==='pendingTrail')f.checkpoint().pendingDryTrail={};if(mode==='staleReceipt')f.error.observedDryLeg.deadline-=2000;
 let reads=0;const work=recoverTimedOutSiteLeg({...f.deps,getCP:()=>{const cp=f.checkpoint();if(mode==='lateCPWrite'&&++reads>1)return {...cp,probes:2};return cp;},saveCP:()=>saves++,isMotorIdle:()=>mode!=='movingMotor'},f.error,{deadline:Date.now()+(mode==='searchDeadline'?-1:mode==='movingMotor'?40:2000)});
 if(mode==='paused')await assert.rejects(work,{code:'cancelled'});else assert.equal((await work).confirmed,false);assert.equal(saves,0);assert.equal(f.attempts.length,0);
});

// Deterministic observation branches use a real loaded/grounded native body
// configured once at fixture creation. They prove no movement or old-edge
// credit; the 80ms test above separately exercises actual native expiry.
for(const mode of ['existing_origin','existing_other','new_actual_node'])test(`expired site observation preserves exact existing/new checkpoint contract: ${mode}`,{timeout:3000},async t=>{
 const anchor={x:0,y:1,z:0},other={x:1,y:1,z:0},target={x:16,y:1,z:0};
 const retained={parent:'0,1,0',target:{x:0,y:1,z:16}};
 const cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,
  nodes:{'0,1,0':{position:anchor,parent:null,expanded:true}},order:['0,1,0'],current:'0,1,0',resumeNode:'0,1,0',visits:1,probes:1,
  frontier:[{parent:'0,1,0',target},retained],blockedEdges:[]};
 if(mode==='existing_other'){cp.nodes['1,1,0']={position:other,parent:'0,1,0',expanded:true};cp.order.push('1,1,0');cp.visits++;}
 const f=native.exports.fixture(t,{checkpoint:cp,initialPosition:new Vec3(mode==='existing_origin'?.75:1.5,1,.5)});
 const before=JSON.parse(JSON.stringify(cp)),records=[],position=f.bot.entity.position.clone();let saves=0;
 const error=Object.assign(Error('expired observation fixture'),{code:'dry_graph_leg_timeout',observedDryLeg:{fromNode:'0,1,0',from:'0,1,0',target,deadline:Date.now()-10}});
 const result=await recoverTimedOutSiteLeg({...f.deps,getCP:f.checkpoint,saveCP:value=>{saves++;f.deps.setCheckpoint(value);},isMotorIdle:()=>true,record:value=>records.push(value)},error,{deadline:Date.now()+2000});
 const after=f.checkpoint(),created=mode==='new_actual_node',id=mode==='existing_origin'?'0,1,0':'1,1,0';
 assert.equal(created,!before.nodes[id]);assert.equal(Object.keys(after.nodes).length,Object.keys(before.nodes).length+(created?1:0));
 assert.deepEqual(result,{confirmed:true,actual:mode==='existing_origin'?anchor:other,created});assert.equal(saves,1);
 assert.equal(after.current,id);assert.equal(after.resumeNode,id);assert.deepEqual(after.anchor,before.anchor);assert.equal(after.probes,before.probes);
 assert.equal(after.visits,before.visits+(created?1:0));assert.deepEqual(after.order,created?[...before.order,id]:before.order);
 for(const oldId of before.order)assert.deepEqual(after.nodes[oldId],before.nodes[oldId],'Existing nodes keep their original parent, expansion and evidence');
 assert.equal(records.length,1);assert.equal(records[0].oldGoalAccepted,false);assert.equal(records[0].oldEdgeTraversalCredit,false);
 assert.deepEqual(records[0].actual,result.actual);assert.deepEqual(records[0].abandonedTarget,target);assert.equal(records[0].nativeMotorDrained,true);
 if(created){assert.deepEqual(after.nodes[id].timedOutLegLanding,records[0]);assert.equal(after.nodes[id].parent,'0,1,0');assert.equal(after.nodes[id].expanded,false);}
 else assert.equal(Object.hasOwn(after.nodes[id],'timedOutLegLanding'),false,'Re-observation does not invent a new-node receipt');
 assert.deepEqual(after.frontier,[retained]);assert.equal(after.blockedEdges.length,1);assert.equal(after.blockedEdges[0].actualMovementConfirmed,false);assert.equal(after.blockedEdges[0].actualLandingConfirmed,true);
 assert.equal(f.attempts.length,0);assert.deepEqual(f.bot.entity.position,position);assert.equal(f.bot.pathfinder.goal,null);
});
