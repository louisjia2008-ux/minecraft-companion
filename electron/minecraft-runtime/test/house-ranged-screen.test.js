'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {planRangedScreen}=require('../vendor/server/minecraft/houseRangedScreen');
const {rangedCoverConfirmed}=require('../vendor/server/minecraft/houseRangedCover');
function fixture(position=new Vec3(.5,66,.5)){
 const cells=new Map(),key=p=>`${p.x},${p.y},${p.z}`;
 const blockAt=p=>{const q=new Vec3(p.x,p.y,p.z).floored(),name=cells.has(key(q))?cells.get(key(q)):(q.y<66?'stone':'air');return name===null?null:Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:q});};
 const bot={entity:{position},blockAt};return {cells,key,bot,position,blockAt,inventory:{dirt:8,cobblestone:8}};
}
for(const [x,z]of [[10,.5],[10,10],[-10,.5],[.5,-10]])test(`two-high minimal screen receives cover credit only after actual native walls: ${x},${z}`,()=>{
 const f=fixture(),threats=[{name:'skeleton',height:1.99,position:new Vec3(x,66,z)}];
 const p=planRangedScreen({...f,threats});assert.ok(p);assert.equal(p.fullEnclosure,false);assert.equal(p.actualProtectionConfirmed,false);
 assert.equal(rangedCoverConfirmed(f.bot,f.position,threats),false);
 for(const s of p.blocks)f.cells.set(f.key(s.position),s.item);
 assert.equal(rangedCoverConfirmed(f.bot,f.position,threats),true);assert.ok(p.blocks.length<=4);
});
test('eight carried blocks can block three observed shooters without requiring a whole enclosure',()=>{
 const f=fixture();f.inventory={dirt:8};const threats=[[10,.5],[-10,.5],[.5,10]].map(([x,z])=>({name:'skeleton',position:new Vec3(x,66,z)}));
 const p=planRangedScreen({...f,threats});assert.ok(p);assert.ok(p.blocks.length<=8);
 for(const s of p.blocks)f.cells.set(f.key(s.position),s.item);
 assert.equal(rangedCoverConfirmed(f.bot,f.position,threats),true);
});
for(const name of ['water','gravel',null])test(`a hazardous or unknown construction ring cannot become cover: ${name}`,()=>{
 const f=fixture(),threats=[{name:'skeleton',position:new Vec3(10,66,.5)}];
 for(let x=-2;x<=2;x++)for(let z=-2;z<=2;z++)f.cells.set(`${x},65,${z}`,name);
 assert.equal(planRangedScreen({...f,threats}),null);
});
test('protected construction and insufficient actual stock do not authorize a screen',()=>{
 const f=fixture(),threats=[{name:'skeleton',position:new Vec3(10,66,.5)}];
 assert.equal(planRangedScreen({...f,threats,excluded:()=>true}),null);
 assert.equal(planRangedScreen({...f,threats,inventory:{dirt:1}}),null);
});

test('formal29 saved terrain can use actual carried wood for a screen; the deep cave creeper cannot veto the surface shooter',{timeout:3000},()=>{
 const recorded=require('../test-support/fixtures/formal29-wood-ranged-screen.json');
 const {loadedCoverThreats}=require('../vendor/server/minecraft/houseRangedScreen');
 const cells=new Map(recorded.cells.map(c=>[`${c.position.x},${c.position.y},${c.position.z}`,c]));
 const blockAt=p=>{const q=new Vec3(p.x,p.y,p.z).floored(),c=cells.get(`${q.x},${q.y},${q.z}`);if(!c)return null;return Object.assign(Block.fromProperties(registry.blocksByName[c.name.replace('minecraft:','')].id,c.properties||{},0),{position:q});};
 const position=new Vec3(recorded.position.x,recorded.position.y,recorded.position.z);
 const bot={registry,entity:{position},blockAt,entities:Object.fromEntries(recorded.threats.map(e=>[e.id,{...e,type:'mob',isValid:true,height:1.99,position:new Vec3(e.position.x,e.position.y,e.position.z)}]))};
 const threats=loadedCoverThreats(bot);assert.deepEqual(threats.map(e=>e.id),[2278]);
 assert.equal(planRangedScreen({position,threats,blockAt,inventory:{dirt:0,cobblestone:0}}),null);
 const plan=planRangedScreen({position,threats,blockAt,inventory:recorded.inventory});assert.ok(plan);
 assert.ok(plan.blocks.length>=2&&plan.blocks.length<=4);const stock={...recorded.inventory};
 assert.equal(rangedCoverConfirmed(bot,position,threats),false);
 for(const spec of plan.blocks){assert.ok(stock[spec.item]>0);stock[spec.item]--;cells.set(`${spec.position.x},${spec.position.y},${spec.position.z}`,{position:spec.position,name:'minecraft:'+spec.item,properties:{}});}
 // MODELED placements into saved terrain; fresh native shape ray checks only,
 // never Java placement ACK or live cover/cleanup acceptance credit.
 assert.equal(rangedCoverConfirmed(bot,position,threats),true);
 const near={id:3,name:'zombie',isValid:true,position:position.offset(3,0,0)};bot.entities[3]=near;
 assert.ok(loadedCoverThreats(bot).includes(near));assert.equal(planRangedScreen({position,threats:loadedCoverThreats(bot),blockAt,inventory:recorded.inventory}),null);
});
test('non-full construction items and one carried plank never grant an unbuildable screen',()=>{
 const f=fixture(),threats=[{name:'skeleton',position:new Vec3(10,66,.5)}];
 for(const inventory of [{spruce_planks:1},{sand:64},{gravel:64},{chest:64},{oak_leaves:64},{stick:64}])
  assert.equal(planRangedScreen({...f,threats,inventory}),null);
});

test('a distant walking mob cannot veto a native shooter screen, while contact and blast threats still do',()=>{
 const {loadedCoverThreats}=require('../vendor/server/minecraft/houseRangedScreen'),f=fixture();
 f.bot.registry=registry;const shooter={id:1,name:'skeleton',position:f.position.offset(10,0,0)},spider={id:2,name:'spider',position:f.position.offset(-12,0,0)},creeper={id:3,name:'creeper',position:f.position.offset(0,0,12)};
 f.bot.entities={1:shooter,2:spider,3:creeper};
 assert.deepEqual(loadedCoverThreats(f.bot).map(e=>e.id),[1]);
 assert.ok(planRangedScreen({...f,threats:loadedCoverThreats(f.bot)}));
 spider.position=f.position.offset(-3,0,0);assert.ok(loadedCoverThreats(f.bot).includes(spider));
 assert.equal(planRangedScreen({...f,threats:loadedCoverThreats(f.bot)}),null);
 creeper.position=f.position.offset(0,0,8);assert.ok(loadedCoverThreats(f.bot).includes(creeper));
});
