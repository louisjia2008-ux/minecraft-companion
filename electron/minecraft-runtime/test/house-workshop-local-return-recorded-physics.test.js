'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const r=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(r),saved=require('../test-support/fixtures/world58-local-workshop-return.json'),b=saved.bounds,raw=require('node:zlib').gunzipSync(Buffer.from(saved.statesGzipBase64,'base64')),cells=new Uint16Array(raw.buffer,raw.byteOffset,raw.byteLength/2);
const filename=path.join(__dirname,'mining-combat-coordination.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf("\ntest('a grounded self-supply camp"))+'\nmodule.exports={fixture};\n',filename);
test('world58 native workshop return descends from actual tree stance without replaying optional old positions',{timeout:15000},async t=>{
 const overlay=new Map(),f=native.exports.fixture(t,{interrupt:false,startPosition:saved.actualFrom,worldAt:p=>{
  if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;
  const s=overlay.get(p.toString())||saved.palette[cells[((p.x-b.minX)*(b.maxZ-b.minZ+1)+p.z-b.minZ)*(b.maxY-b.minY+1)+p.y-b.minY]];
  return Object.assign(Block.fromProperties(r.blocksByName[s.name].id,s.properties,0),{position:p});
 }});
 f.bot._client.write=()=>{};const kit=['stone_sword','stone_pickaxe'].map(name=>({name,type:r.itemsByName[name].id,count:1,metadata:0}));f.bot.inventory.items=()=>kit;f.bot.inventory.count=id=>kit.filter(i=>i.type===id).length;
 f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';f.task.materialSupply={schema:1,profile:'cottage',materialSource:'self_gathered',houseAnchor:{x:-176,y:65,z:175},camp:{anchor:saved.camp,stations:{crafting_table:{x:-234,y:63,z:-10},furnace:{x:-238,y:63,z:-10}},storageSites:[]},ownedStations:{crafting_table:{position:{x:-234,y:63,z:-10},confirmedPlaced:true},furnace:{position:{x:-238,y:63,z:-10},confirmedPlaced:true}},surfaceGraphs:{}};
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testReturnCurrentHouseCamp({resource:'spruce_log',via:saved.oldResourceTrace}));
 assert.deepEqual({...f.bot.entity.position.floored()},saved.camp);assert.equal(f.bot.entity.onGround,true);assert.deepEqual(f.bot.inventory.items(),kit);assert.deepEqual(f.task.materialSupply.surfaceGraphs,{});
 assert.ok(!f.attempts.some(a=>a.x===saved.oldResourceTrace[1].x&&a.y===saved.oldResourceTrace[1].y&&a.z===saved.oldResourceTrace[1].z),'An optional old resource stance is not a fixed return obligation');
});
