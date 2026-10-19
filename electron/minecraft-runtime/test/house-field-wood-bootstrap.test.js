'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{Vec3}=require('vec3');
// Execute the real host callback, with native observations replaced by a small
// dry-route fixture. Two empty local scans are not a conclusive world result.
const source=fs.readFileSync(path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),'utf8');
const start=source.indexOf('bootstrapWood: async options => {'),end=source.indexOf('\n      placeNative:',start);
const callback=source.slice(start,end).replace('bootstrapWood: ','').replace(/,\s*$/,'');
function fixture({availableOn=6,deadline,failedBatch=false,logs=3}={}){
 let items=[],queries=0,moves=0,targets=[];const position=new Vec3(8.5,66,25.5),client={},task={executionGeneration:1,materialSupply:{}};
 const bot={entity:{position},_client:client,inventory:{items:()=>items}};
 const deps={Date,Math,Boolean,Number,require:require("node:module").createRequire(path.join(__dirname,"../vendor/server/minecraftTaskAgent.js")),WEAPON_ITEM_PRIORITY:[],PICKAXE_ITEM_NAMES:[],bot,ownerTask:task,currentTask:task,currentBot:bot,
 source:{getCamp:()=>({x:8,y:66,z:25})},findInventoryItem:()=>null,getItemCountByName:n=>items.find(i=>i.name===n)?.count||0,
 checkTaskSignal:()=>{},toPlainPosition:p=>({x:p.x,y:p.y,z:p.z}),toVec3:p=>new Vec3(p.x,p.y,p.z),hasGroundedBodySupport:()=>true,naturalWalkingFoot:()=>true,
 alignHouseResourceGraphOrigin:async()=>{assert.equal(position.y,66);},
 getActiveCancellationToken:()=>({throwIfRequested(){}}),recordTaskDiagnostic:()=>{},report:()=>{},
 gatherer:{gather:async(_name,_target,options)=>{queries++;targets.push(_target);assert.ok(options.deadline<=deadline||!deadline);if(queries===availableOn){items=[{name:'oak_log',count:logs}];return;}throw Object.assign(Error('local scan empty'),{code:'house_resource_local_wood_unavailable'});}},
 exploreHouseSurfaceGraph:async(_task,_resource,_anchor,_report,options)=>{options.assertGraphActive();moves++;if(failedBatch&&moves===1)return {moved:false,reason:'finite_attempt_batch_failed'};position.x+=16;const p=position.floored(),k=`${p.x},${p.y},${p.z}`;options.graphCheckpoint.save({schema:2,kind:"loaded_dry_waypoint_graph",anchor:{..._anchor},order:[k],probes:moves,current:k,nodes:{[k]:{position:p}}});return{moved:true};}};
 const fn=Function(...Object.keys(deps),`return (${callback});`)(...Object.values(deps));return{run:()=>fn({deadline}),queries:()=>queries,moves:()=>moves,targets:()=>targets};
}
test('empty bootstrap continues the real observed graph beyond two local scans until native wood is actually acquired',async()=>{
 const f=fixture();const result=await f.run();assert.equal(result.logName,'oak_log');assert.equal(f.queries(),6);assert.equal(f.moves(),5);
});
test('field bootstrap respects the original shorter deadline and performs no exploration after it',async()=>{
 const f=fixture({availableOn:99,deadline:Date.now()-1});await assert.rejects(f.run(),{code:'house_field_wood_origin_budget_limit'});assert.equal(f.queries(),0);assert.equal(f.moves(),0);
});

test('a finite failed batch retains the same bootstrap loop and its deadline before the next actual graph advance',async()=>{
 const f=fixture({availableOn:3,failedBatch:true,deadline:Date.now()+5000});const result=await f.run();assert.equal(result.logName,'oak_log');assert.equal(f.queries(),3);assert.equal(f.moves(),2);
});

test('two actual logs finish field prerequisites so table and sword precede a third unarmed log trip',async()=>{
 const f=fixture({availableOn:1,logs:2});const result=await f.run();assert.equal(result.logName,'oak_log');assert.deepEqual(f.targets(),[2]);assert.equal(f.queries(),1);assert.equal(f.moves(),0);
});
