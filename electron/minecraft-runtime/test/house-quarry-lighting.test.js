'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {lightHouseQuarry}=require('../vendor/server/minecraft/houseQuarryLighting');
function fixture(){
 const cells=new Map(),placements=[];let paused=false;
 const bot={entity:{position:new Vec3(3.5,64,.5)},inventory:{items:()=>[{name:'torch',count:8}]},
  blockAt:p=>Object.assign(Block.fromStateId(registry.blocksByName[cells.get(p.toString())||(p.y<64?'stone':'air')].defaultState),{position:p.clone()})};
 const deps={getBot:()=>bot,assertActive:()=>{if(paused)throw Object.assign(Error('paused'),{code:'paused'});},isExcluded:()=>false,
  place:async p=>{placements.push({...p});cells.set(new Vec3(p.x,p.y,p.z).toString(),'torch');}};
 const nav={routeIndex:3,breadcrumbs:[0,1,2,3].map(x=>({x,y:64,z:0}))};
 return{bot,deps,cells,placements,nav,pause:()=>{paused=true;}};
}
test('lighting uses actual loaded walked floors and confirms a real torch block',async()=>{
 const f=fixture(),result=await lightHouseQuarry(f.deps,f.nav);
 assert.equal(result.length,1);assert.equal(f.placements.length,1);
 assert.ok(f.nav.breadcrumbs.some(p=>p.x===result[0].x));
 assert.equal(f.bot.blockAt(new Vec3(result[0].x,64,0)).name,'torch');
 await lightHouseQuarry(f.deps,f.nav,result);assert.equal(f.placements.length,1,'Existing actual light prevents duplicate placement');
});
test('an attempted placement without the actual block is not lighting credit',async()=>{
 const f=fixture();f.deps.place=async()=>{};
 await assert.rejects(lightHouseQuarry(f.deps,f.nav),{code:'house_quarry_torch_unconfirmed'});
});
test('exclusions and unsupported floors never authorize torch placement',async()=>{
 const f=fixture();f.deps.isExcluded=()=>true;
 assert.deepEqual(await lightHouseQuarry(f.deps,f.nav),[]);assert.equal(f.placements.length,0);
 f.deps.isExcluded=()=>false;for(let x=0;x<3;x++)f.cells.set(new Vec3(x,63,0).toString(),'water');
 assert.deepEqual(await lightHouseQuarry(f.deps,f.nav),[]);assert.equal(f.placements.length,0);
});
test('missing inventory and cancellation do not place or save fictitious lighting',async()=>{
 const f=fixture();f.bot.inventory.items=()=>[];
 await assert.rejects(lightHouseQuarry(f.deps,f.nav),{code:'house_quarry_torches_required'});
 f.pause();await assert.rejects(lightHouseQuarry(f.deps,f.nav),{code:'paused'});assert.equal(f.placements.length,0);
});

test('lighting resupply batches a useful mining reserve and accounts for partial recipe output',()=>{
 const {quarryLightingBatch:plan}=require('../vendor/server/minecraft/houseQuarryLighting');
 assert.deepEqual(plan(0,0),{target:32,batches:8,missingFuel:8,sticks:8,smeltingPlanks:6});
 assert.equal(plan(31,0).batches,1);assert.equal(plan(31,0).missingFuel,1);
 assert.equal(plan(0,8).missingFuel,0);assert.equal(plan(32,0).batches,0);
 assert.throws(()=>plan(-1,0),TypeError);
});

test('adjacent branch actual block light avoids redundant torches, while dark or unknown light still gets lighting',async()=>{
 for(const light of [8,12,7,undefined,16]){
  const f=fixture(),read=f.bot.blockAt;
  f.bot.blockAt=p=>Object.assign(read(p),{light,skyLight:15});
  await lightHouseQuarry(f.deps,f.nav);
  assert.equal(f.placements.length,[8,12].includes(light)?0:1);
 }
 const f=fixture(),read=f.bot.blockAt;
 f.bot.blockAt=p=>Object.assign(read(p),{light:p.y===64?8:0});
 await lightHouseQuarry(f.deps,f.nav);
 assert.equal(f.placements.length,1,'A dark head cell still requires real lighting');
});
