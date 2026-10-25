'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const filename=path.join(__dirname,'mining-combat-coordination.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);
native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf("\ntest('a grounded self-supply camp"))+'\nmodule.exports={fixture};\n',filename);
const {runNativePhysicsClock}=require('../test-support/native-physics-clock.cjs');
for(const displaced of [false,true])test(`healthy empty survivor reaches its own stock workshop without old optional return: displaced=${displaced}`,{timeout:12000},async t=>{
 // Couple native Physics ticks to logical deadlines, not host scheduler load.
 let f;
 await runNativePhysicsClock(t,async()=>{
 const camp={x:48,y:1,z:0},table={x:50,y:1,z:0},box={x:48,y:1,z:2};
 f=native.exports.fixture(t,{interrupt:false,worldAt:p=>Object.assign(Block.fromStateId(registry.blocksByName[p.y<=0?'stone':p.x===50&&p.y===1&&p.z===0?'crafting_table':p.x===48&&p.y===1&&p.z===2?'chest':'air'].defaultState),{position:p})});
 f.bot._client.write=()=>{};f.bot.inventory.items=()=>[];f.bot.inventory.count=()=>0;f.bot.heldItem=null;
 const graph={schema:2,kind:'loaded_dry_waypoint_graph',anchor:camp,step:16,radius:384,nodes:{'48,1,0':{position:camp,parent:null,expanded:true}},order:['48,1,0'],current:'48,1,0',resumeNode:'48,1,0',visits:1,probes:0,frontier:[],blockedEdges:[]};
 f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';
 f.task.materialSupply={schema:1,profile:'cottage',materialSource:'self_gathered',houseAnchor:{x:100,y:1,z:100},camp:{anchor:camp,stations:{crafting_table:table},storageSites:[]},
  ownedStations:{crafting_table:{position:table,confirmedPlaced:true}},storage:{schema:1,kind:'house_owned_storage',storageId:'fixture-current-owned',chests:[{position:box,item:'chest',confirmedPlaced:true,emptyAuthorized:true,usableStock:{spruce_log:3},stock:{spruce_log:3}}]},
  surfaceGraphs:{any_log:graph},surfaceResources:{schema:1,anchor:camp,searches:{any_log:{observedPath:[camp,{x:47,y:1,z:0}]}}}};
 if(displaced){
  const anchor={x:0,y:1,z:0};f.task.materialSupply.currentCampApproach={target:camp,anchor,graph:{...graph,anchor,
    nodes:{'0,1,0':{position:anchor,parent:null,expanded:true}},order:['0,1,0'],current:'0,1,0',resumeNode:'0,1,0'}};
  await f.agent.__testHouseSurfacePathfinderGoto(new(require('mineflayer-pathfinder').goals.GoalBlock)(3,1,0),2000);
 }
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testReturnCurrentHouseCamp());
 if(displaced){assert.equal(f.task.materialSupply.currentCampApproach.graphSegments.length,1);
  assert.deepEqual(f.task.materialSupply.currentCampApproach.graphSegments[0].graph.order,['0,1,0']);
  assert.equal(f.task.materialSupply.currentCampApproach.graphSegments[0].oldTraversalCredit,false);}

 assert.deepEqual(f.bot.entity.position.floored(),new(require('vec3').Vec3)(48,1,0));assert.equal(f.bot.entity.onGround,true);
 assert.equal(f.task.materialSupply.surfaceGraphs.any_log.visits,1);assert.equal(f.task.materialSupply.currentCampApproach.graph.visits>1,true);
 assert.equal(f.bot.inventory.items().length,0);assert.equal(f.task.materialSupply.storage.chests[0].usableStock.spruce_log,3);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 },{maximumMs:12000,stepMs:20,stop:()=>{f?.task.cancellationToken.cancel();f?.bot.pathfinder.setGoal(null);f?.bot.clearControlStates();}});
});
