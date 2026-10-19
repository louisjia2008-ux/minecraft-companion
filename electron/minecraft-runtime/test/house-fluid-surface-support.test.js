/* global require, __dirname */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {Vec3}=require('vec3'),registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry),Item=require('prismarine-item')(registry);
const {inspectFluidSurfaceSupport}=require('../vendor/server/minecraft/houseFluidResources');
const {createHouseFluidMaterialProvider}=require('../vendor/server/minecraft/houseFluidNativeBridge');
const {createHouseMaterialRecipes}=require('../vendor/server/minecraft/houseMaterialRecipes');
const {classifyMiningBlock}=require('../vendor/server/minecraft/miningNavigation');
const {hasGroundedBodySupport}=require('../vendor/server/minecraft/houseSurfaceGraph');

// Reuse only the original fixtures, without registering their test cases.
// They use installed native Physics/pathfinder/inventory/bucket packets and
// explicitly modeled voxel/slot ACKs. This is not a live resource receipt.
function loadFixture(name){
 const filename=path.join(__dirname,name),source=fs.readFileSync(filename,'utf8'),end=source.indexOf('\ntest(');
 assert.ok(end>0);const loaded=new Module.Module(filename,module);loaded.filename=filename;loaded.paths=Module.Module._nodeModulePaths(__dirname);
 loaded._compile(source.slice(0,end)+'\nmodule.exports={fixture};\n',filename);return loaded.exports.fixture;
}
const fixture=loadFixture('house-fluid-resources.test.js'),bridgeFixture=loadFixture('house-fluid-native-bridge.test.js');
const block=(name,p)=>Object.assign(Block.fromProperties(registry.blocksByName[name].id,{},0),{position:p});

for(const name of ['sand','red_sand','gravel'])test(`pure full ${name} floor needs an original loaded stable base without relaxing mining classification`,()=>{
 const floor=new Vec3(0,63,0),proof=inspectFluidSurfaceSupport(p=>block(p.y===63?name:'stone',p),floor);
 assert.equal(proof.safe,true);assert.deepEqual(proof.positions,[{x:0,y:63,z:0},{x:0,y:62,z:0}]);
 assert.equal(classifyMiningBlock(block(name,floor)).support,false);assert.equal(classifyMiningBlock(block(name,floor)).diggable,false);
});

for(const kind of ['floating','unknown','too_deep','other_gravity'])test(`pure surface support rejects ${kind} without any movement permission`,()=>{
 const floor=new Vec3(0,63,0),read=p=>kind==='unknown'&&p.y===62?null:block(kind==='other_gravity'?'anvil':kind==='floating'&&p.y===62?'air':'sand',p);
 const proof=inspectFluidSurfaceSupport(read,floor);assert.equal(proof.safe,false);assert.ok(proof.positions.length<=9);
 if(kind==='unknown')assert.equal(proof.reason,'unloaded_floor');
});

test('native sand camp and sand walking step gather water and protect the actual full support chain',{timeout:15000},async t=>{
 const f=fixture(t);for(const x of [0,1])f.update(new Vec3(x,63,0),'sand');f.update(new Vec3(4,63,0),'water',{level:0});
 await f.provider.gatherWater(1,{anchor:f.anchor});assert.equal(f.stock().water_bucket,1);assert.equal(f.uses.length,1);
 assert.equal(hasGroundedBodySupport(f.bot),true);assert.ok(f.bot.entity.position.floored().equals(new Vec3(0,64,0)));
 const protectedIds=new Set(f.checkpoint().protectedPositions.map(p=>`${p.x},${p.y},${p.z}`));
 for(const id of ['0,63,0','0,62,0','1,63,0','1,62,0'])assert.ok(protectedIds.has(id),id);
});

test('original bridge also walks over a supported sand floor using original native goto/Physics',{timeout:5000},async t=>{
 const f=bridgeFixture(t);f.block('sand',new Vec3(1,63,0));
 await f.run(()=>f.bridge.moveTo({x:1,y:64,z:0},f.ctx));
 assert.equal(hasGroundedBodySupport(f.bot),true);assert.ok(f.bot.entity.position.floored().equals(new Vec3(1,64,0)));
});

test('native refill water on a loaded supported sand riverbed confirms the same real bucket/slot transaction',{timeout:15000},async t=>{
 const f=fixture(t,{persistSource:true}),p=new Vec3(2,63,0);for(const q of [p,p.offset(1,0,0),p.offset(0,0,1)])f.update(q,'water',{level:0});
 f.update(p.offset(0,-1,0),'sand');await f.provider.gatherWater(1,{anchor:f.anchor});
 assert.equal(f.stock().water_bucket,1);assert.equal(f.uses.length,1);assert.equal(f.checkpoint().confirmedWater[0].mayRefill,true);
 assert.equal(f.checkpoint().confirmedWater[0].sourceStillPresent,true);
});

test('support removal after native rotation is rechecked before a replenishable-source bucket packet',{timeout:15000},async t=>{
 const p=new Vec3(2,63,0),f=fixture(t,{persistSource:true,mutateBeforeUse:({update})=>update(p.offset(0,-2,0),'air')});
 for(const q of [p,p.offset(1,0,0),p.offset(0,0,1)])f.update(q,'water',{level:0});f.update(p.offset(0,-1,0),'sand');
 const protectedNeighbors=[{minX:3,maxX:3,minY:63,maxY:63,minZ:0,maxZ:0},{minX:2,maxX:2,minY:63,maxY:63,minZ:1,maxZ:1}];
 await assert.rejects(f.provider.gatherWater(1,{anchor:f.anchor,excludeBounds:protectedNeighbors}));assert.equal(f.uses.length,0);assert.equal(f.stock().water_bucket||0,0);
});

test('known gravity above reachable obsidian cannot reach a dig callback or material credit',{timeout:15000},async t=>{
 const geometry=new Map();for(let x=-4;x<=5;x++)for(let z=-4;z<=4;z++)for(let y=61;y<=68;y++)geometry.set(`${x},${y},${z}`,{name:y<=62?'stone':'air',properties:{}});
 const f=fixture(t,{geometry,anchor:{x:0,y:63,z:0},waterCount:1}),p=new Vec3(2,64,0);
 f.update(p.offset(0,-1,0),'stone');f.update(p,'obsidian');f.update(p.offset(0,1,0),'sand');
 await assert.rejects(f.provider.gatherObsidian(1,{anchor:f.anchor}),e=>e.code==='house_fluid_no_safe_source');
 assert.equal(f.digs.length,0);assert.equal(f.stock().obsidian||0,0);assert.equal(f.checkpoint().lastGather,undefined);
});

test('a protected real standing support remains forbidden as a natural lava plug after camp/walking role changes',{timeout:15000},async t=>{
 const f=fixture(t,{waterCount:1}),lava=new Vec3(3,64,0),plug=new Vec3(2,64,0);
 f.update(lava,'lava',{level:0});for(const q of [new Vec3(1,64,0),new Vec3(2,64,1),new Vec3(2,64,-1),new Vec3(4,64,0),new Vec3(3,64,1),new Vec3(3,64,-1)])f.update(q,'stone');f.update(plug,'stone');
 await assert.rejects(f.provider.gatherObsidian(1,{anchor:f.anchor,protectedPositions:[{x:2,y:64,z:0}]}),e=>e.code==='house_fluid_no_safe_source');
 assert.equal(f.digs.length,0);assert.equal(f.uses.length,0);assert.equal(f.stock().obsidian||0,0);
});

function initialSlots(f,counts){
 const slots=Array.from({length:46},()=>Item.toNotch(null));let slot=36;
 for(const [name,count]of Object.entries(counts))slots[slot++]=Item.toNotch(new Item(registry.itemsByName[name].id,count));
 f.bot._client.emit('window_items',{windowId:0,stateId:1,items:slots,carriedItem:null});
}
function materialDeps(f,source,task,createProvider){
 const active=()=>f.token.throwIfRequested(),unused=()=>assert.fail('preparation sampler cannot enter native obsidian action');
 return{getBot:()=>f.bot,captureOwner:()=>({token:f.token}),assertOwner:active,isOwnerCurrent:()=>!f.token.pauseRequested&&!f.token.cancelled,
  isOwnerContext:()=>true,sourceGuardSupportsOwnedCancel:true,runPhysicalAction:unused,abortOwner:()=>f.token.pause(),withMovements:unused,
  restoreMovements:unused,goto:unused,waitGround:unused,guardNative:(_owner,_ctx,action)=>action(),equipNative:unused,ownerTask:task,source,
  returnHouseCamp:async p=>{active();assert.ok(f.bot.entity.position.floored().equals(new Vec3(p.x,p.y,p.z)));},createProvider};
}

test('obsidian entry prepares actual native water through the original recipe coordinator before outer provider runs, retaining only held obsidian',{timeout:15000},async t=>{
 const f=fixture(t),task={materialSupply:{quarry:{originalRoute:true}}},requests=[],contexts=[];
 initialSlots(f,{diamond_pickaxe:1,bucket:1,obsidian:2});f.update(new Vec3(2,63,0),'water',{level:0});
 require('mineflayer/lib/plugins/craft')(f.bot);
 f.deps.getCP=()=>task.materialSupply.fluid;f.deps.saveCP=cp=>{task.materialSupply={...task.materialSupply,fluid:cp};};
 const recipes=createHouseMaterialRecipes({registry,recipesAll:(...args)=>f.bot.recipesAll(...args),getItemCount:name=>f.stock()[name]||0,
  assertActive:()=>f.token.throwIfRequested(),acquireRaw:async(name,count,ctx)=>{contexts.push({name,requirements:ctx.requirements});assert.equal(name,'water_bucket');ctx.assertActive();await f.provider.gatherWater(count,{anchor:f.anchor});ctx.assertActive();}});
 const source={getCamp:()=>f.anchor,ensure:async goals=>{requests.push(goals);return recipes.ensure(goals);}},stop=Object.assign(new Error('sample before outer obsidian action'),{code:'OFFLINE_PREPARED_SAMPLE'});
 const provider=createHouseFluidMaterialProvider(materialDeps(f,source,task,cfg=>({gatherObsidian:async()=>{
  assert.equal(f.stock().water_bucket,1);assert.equal(f.stock().obsidian,2);assert.equal(cfg.getCP().confirmedWater.length,1);throw stop;
 }})));
 await assert.rejects(provider.acquireRaw('obsidian',1,{anchor:f.anchor,assertActive:()=>f.token.throwIfRequested(),requirements:{enchanting_table:1}}),e=>e===stop);
 assert.deepEqual(requests,[{water_bucket:1,obsidian:2}]);assert.deepEqual(contexts,[{name:'water_bucket',requirements:{water_bucket:1,obsidian:2}}]);
 assert.equal(f.uses.length,1);assert.equal(f.stock().obsidian,2);assert.equal(task.materialSupply.quarry.originalRoute,true);
 assert.equal(task.materialSupply.fluid.confirmedWater.length,1);
});

test('already held water bucket enters no supply callback and cannot fabricate additional obsidian',{timeout:5000},async t=>{
 const f=fixture(t,{waterCount:1}),task={materialSupply:{}},source={getCamp:()=>f.anchor,ensure:async()=>assert.fail('already held water needs no ensure')};
 await f.bot.waitForTicks(2);
 const stop=Object.assign(new Error('no raw grant'),{code:'OFFLINE_PREPARED_SAMPLE'});
 const provider=createHouseFluidMaterialProvider(materialDeps(f,source,task,()=>({gatherObsidian:async()=>{throw stop;}})));
 await assert.rejects(provider.acquireRaw('obsidian',1,{anchor:f.anchor,assertActive:()=>f.token.throwIfRequested()}),e=>e===stop);
 assert.equal(f.stock().obsidian||0,0);assert.equal(f.uses.length,0);
});

test('pause during water supply blocks capacity and the outer provider before any new raw action',{timeout:5000},async t=>{
 const f=fixture(t),task={materialSupply:{}},source={getCamp:()=>f.anchor,ensure:async()=>f.token.pause()};let calls=0;
 await f.bot.waitForTicks(2);
 const provider=createHouseFluidMaterialProvider({...materialDeps(f,source,task,()=>({gatherObsidian:async()=>{calls++;}})),prepareCapacity:async()=>{calls++;}});
 await assert.rejects(provider.acquireRaw('obsidian',1,{anchor:f.anchor,assertActive:()=>f.token.throwIfRequested()}));
 assert.equal(calls,0);assert.equal(f.uses.length,0);assert.equal(f.stock().obsidian||0,0);
});

for(const boundary of ['water_supply','capacity'])test(`an expired caller phase after ${boundary} cannot enter a new camp or provider action under a still current owner`,{timeout:5000},async t=>{
 const f=fixture(t,{waterCount:boundary==='capacity'?1:0}),task={materialSupply:{}},expired=Object.assign(new Error('caller phase expired'),{code:'house_phase_budget_expired'});
 await f.bot.waitForTicks(2);let phaseOpen=true,newActions=0;
 const source={getCamp:()=>f.anchor,ensure:async()=>{assert.equal(boundary,'water_supply');phaseOpen=false;}};
 const deps=materialDeps(f,source,task,()=>({gatherObsidian:async()=>{newActions++;}}));
 const provider=createHouseFluidMaterialProvider({...deps,prepareCapacity:async()=>{assert.equal(boundary,'capacity');phaseOpen=false;},returnHouseCamp:async()=>{newActions++;}});
 await assert.rejects(provider.acquireRaw('obsidian',1,{anchor:f.anchor,assertActive:()=>{f.token.throwIfRequested();if(!phaseOpen)throw expired;}}),e=>e===expired);
 assert.equal(newActions,0);assert.equal(f.uses.length,0);assert.equal(f.stock().obsidian||0,0);assert.equal(f.token.pauseRequested,false);
});
