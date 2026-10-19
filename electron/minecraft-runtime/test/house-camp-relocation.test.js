'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {planHouseCampRelocation}=require('../vendor/server/minecraft/houseCampRelocation');
const air={name:'air',boundingBox:'empty',shapes:[]},stone={name:'stone',boundingBox:'block',shapes:[[0,0,0,1,1,1]]};
test('relocation selects a connected natural clearing without modifying terrain',()=>{
 let reads=0;const from={x:0,y:64,z:0};
 const plan=planHouseCampRelocation({from,blockAt:p=>{reads++;return p.y<64?stone:air;},excluded:p=>p.x>=2&&p.z>=2});
 assert.ok(plan);assert.equal(plan.camp.storageSites.length,8);assert.ok(reads>0);assert.deepEqual(plan.path[0],from);
 assert.ok(plan.camp.anchor.x<2||plan.camp.anchor.z<2);
 const sites=[...Object.values(plan.camp.stations),...plan.camp.storageSites];
 assert.ok(sites.every((p,i)=>sites.slice(i+1).every(q=>Math.abs(p.x-q.x)+Math.abs(p.z-q.z)>=2)));
});
test('unloaded terrain, fluids, threats and tiny islands cannot become a new camp',()=>{
 const from={x:0,y:64,z:0};
 for(const blockAt of [()=>null,()=>({...air,name:'water'}),p=>p.y<64&&Math.abs(p.x)<2&&Math.abs(p.z)<2?stone:air])assert.equal(planHouseCampRelocation({from,blockAt}),null);
 assert.equal(planHouseCampRelocation({from,blockAt:p=>p.y<64?stone:air,threatened:()=>true}),null);
});
test('a threatened origin may leave along an escape route but never become the new camp',()=>{
 const from={x:0,y:64,z:0},plan=planHouseCampRelocation({from,blockAt:p=>p.y<64?stone:air,
  threatened:p=>p.x<4,stepAllowed:p=>p.x>=0});
 assert.ok(plan);assert.ok(plan.camp.anchor.x>=5);assert.ok(plan.path.every(p=>p.x>=0));
 assert.ok([...Object.values(plan.camp.stations),...plan.camp.storageSites].every(p=>p.x>=4));
});
test('only completed relocation changes camp; old stock and routes remain archived and house progress is retained',async()=>{
 const {createHouseSelfSupplyRuntime}=require('../vendor/server/minecraft/houseSelfSupplyRuntime');
 const registry=require('minecraft-data')('1.21.8');const old={anchor:{x:0,y:68,z:0},stations:{crafting_table:{x:2,y:68,z:0}},storageSites:[]};
 const next={anchor:{x:3,y:64,z:0},stations:{crafting_table:{x:5,y:64,z:0}},storageSites:[]};
 for(const cancelled of [false,true]){
  let cp={schema:1,profile:'cottage',houseAnchor:{x:20,y:68,z:20},materialSource:'self_gathered',camp:old,ownedStations:{crafting_table:{confirmedPlaced:true}},
   storage:{chests:[{position:{x:4,y:68,z:0}}]},surfaceGraphs:{wood:{current:'old'}},quarry:{saved:'keep'},housePlaced:12};
  const original=structuredClone(cp);let repairCalls=0;
  const runtime=createHouseSelfSupplyRuntime({getBot:()=>({registry,health:20,food:20,inventory:{items:()=>[]},recipesAll:()=>[]}),assertActive(){},
   getCheckpoint:()=>cp,setCheckpoint:v=>{cp=v;},isSourceContext:()=>true,withContext:async(s,b,action)=>action(),
   relocateDestroyedCamp:async()=>{if(cancelled)throw Error('cancelled');return next;},repairCampAccess:async()=>{repairCalls++;},
   returnCamp:async()=>{throw Error('stop after relocation');}}, {profile:'cottage',anchor:cp.houseAnchor},[]);
  await assert.rejects(runtime.run({oak_log:1}),cancelled?/cancelled/:/stop after relocation/);
  if(cancelled)assert.deepEqual(cp,original);
  else{assert.deepEqual(cp.camp.anchor,next.anchor);assert.deepEqual(cp.retiredCamps[0].storage,original.storage);assert.deepEqual(cp.surfaceGraphs,{});
   assert.equal(cp.housePlaced,12);assert.deepEqual(cp.retiredCamps[0].quarry,original.quarry);assert.equal(cp.quarry,null);assert.equal(cp.storage,null);assert.equal(repairCalls,0);}
 }
});
test('an unfinished wood search resumes before another empty-handed return journey',async()=>{
 const {createHouseSelfSupplyRuntime}=require('../vendor/server/minecraft/houseSelfSupplyRuntime');
 const registry=require('minecraft-data')('1.21.8'),anchor={x:0,y:64,z:0},calls=[];
 const cp={schema:1,profile:'cottage',houseAnchor:{x:20,y:64,z:20},materialSource:'self_gathered',camp:{anchor,stations:{},storageSites:[]},ownedStations:{},
  surfaceResources:{schema:1,anchor,searches:{any_log:{attempts:1}}}};
 const runtime=createHouseSelfSupplyRuntime({getBot:()=>({registry,health:20,food:20,inventory:{items:()=>[]},recipesAll:()=>[]}),assertActive(){},
  getCheckpoint:()=>cp,isSourceContext:()=>true,withContext:async(s,b,action)=>action(),blockAt:()=>air,
  returnCamp:async()=>{calls.push('return');},bootstrapWood:async()=>{calls.push('gather');throw Error('observe resumed gather');}},
  {profile:'cottage',anchor:cp.houseAnchor},[]);
 await assert.rejects(runtime.run({oak_log:1}),/observe resumed gather/);assert.deepEqual(calls,['gather']);
});
test('field bootstrap retains actual wood and adopts a confirmed nearby camp before station preparation',async()=>{
 const {createHouseSelfSupplyRuntime}=require('../vendor/server/minecraft/houseSelfSupplyRuntime');
 const registry=require('minecraft-data')('1.21.8'),anchor={x:0,y:64,z:0},field={anchor:{x:80,y:64,z:0},stations:{crafting_table:{x:82,y:64,z:0}},storageSites:[]};
 let cp={schema:1,profile:'cottage',houseAnchor:{x:20,y:64,z:20},materialSource:'self_gathered',camp:{anchor,stations:{},storageSites:[]},ownedStations:{},
  surfaceResources:{schema:1,anchor,searches:{any_log:{attempts:1}}}},items=[];const calls=[];
 const runtime=createHouseSelfSupplyRuntime({getBot:()=>({registry,health:20,food:20,inventory:{items:()=>items},recipesAll:()=>[]}),assertActive(){},
  getCheckpoint:()=>cp,setCheckpoint:v=>{cp=v;},isSourceContext:()=>true,withContext:async(s,b,action)=>action(),blockAt:()=>air,
  returnCamp:async()=>{calls.push('return');},bootstrapWood:async()=>{calls.push('gather');items=[{name:'oak_log',count:4}];return{logName:'oak_log',plankName:'oak_planks'};},
  relocateDestroyedCamp:async(camp,request)=>{if(!request?.fieldBootstrap)return null;calls.push('actual field arrival');return field;},
  onPreparationStage:stage=>{if(stage==='crafting_table')throw Error('inspect before station');}}, {profile:'cottage',anchor:cp.houseAnchor},[]);
 await assert.rejects(runtime.run({oak_log:12}),/inspect before station/);
 assert.deepEqual(calls,['gather','actual field arrival']);assert.deepEqual(cp.camp.anchor,field.anchor);
 assert.equal(cp.retiredCamps[0].reason,'bootstrap_resources_nearby');assert.equal(cp.ownedStations.crafting_table,undefined);
 assert.equal(items[0].count,4);assert.equal(cp.surfaceResources,null);
});
