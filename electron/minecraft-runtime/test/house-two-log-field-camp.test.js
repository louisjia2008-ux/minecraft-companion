'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const main=path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),host=fs.readFileSync(main,'utf8'),start=host.indexOf('      relocateDestroyedCamp:async(camp,request={})=>{'),end=host.indexOf('\n      repairCampAccess:',start),callback=host.slice(start,end).replace('      relocateDestroyedCamp:','').replace(/,\s*$/,'');
const {naturalWalkingFoot,hasGroundedBodySupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
for(const units of [7,8,12])test(`full production field-camp callback accepts table-and-sword prerequisites at ${units} actual plank units`,async t=>{
 const f=native.exports.fixture(t);f.bot.inventory.items=()=>[{name:'spruce_planks',count:units}];
 const records=[],deps={bot:f.bot,checkTaskSignal:()=>{},isThreateningMobEntity:()=>false,isHouseRangedThreatEntity:()=>false,
  toVec3:p=>new Vec3(p.x,p.y,p.z),toPlainPosition:p=>({x:p.x,y:p.y,z:p.z}),findInventoryItem:()=>null,WEAPON_ITEM_PRIORITY:[],PICKAXE_ITEM_NAMES:[],
  at:p=>f.bot.blockAt(new Vec3(p.x,p.y,p.z)),safeSurfaceFoot:p=>naturalWalkingFoot(f.bot,p),hasGroundedBodySupport,
  activeHouseSurfaceWater:null,constructionBounds:[],inBounds:()=>false,ownerTask:{},recordTaskDiagnostic:(_t,event,facts)=>records.push({event,facts}),
  classifyMiningBlock:require('../vendor/server/minecraft/miningNavigation').classifyMiningBlock,require:Module.createRequire(main),
  createMiningNavigator:require('../vendor/server/minecraft/miningNavigation').createMiningNavigator,miningPathfinderGoto:g=>f.bot.pathfinder.goto(g)};
 const run=Function(...Object.keys(deps),`return (${callback});`)(...Object.values(deps));
 const camp={anchor:{x:100,y:1,z:0},stations:{crafting_table:{x:102,y:1,z:0},furnace:{x:100,y:1,z:2}},storageSites:[]},result=await run(camp,{fieldBootstrap:true});
 if(units<8)assert.equal(result,null);
 else{assert.ok(result);assert.ok(f.bot.entity.position.distanceTo(new Vec3(result.anchor.x,result.anchor.y,result.anchor.z))<2);assert.equal(result.storageSites.length,8);assert.ok(records.some(r=>r.event==='house_camp_relocated'));assert.equal(f.bot.entity.onGround,true);}
});
