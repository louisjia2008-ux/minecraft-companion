'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{Vec3}=require('vec3');
const {hasHouseResourceSight}=require('../vendor/server/minecraft/houseResourceVisibility'),{createHouseResourceReach}=require('../vendor/server/minecraft/houseResourceReach'),saved=require('../test-support/fixtures/formal42-resource-visibility.json');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry),WorldSync=require('prismarine-world/src/worldsync'),buf=require('node:zlib').gunzipSync(Buffer.from(saved.statesGzipBase64,'base64')),cells=new Uint16Array(buf.buffer,buf.byteOffset,buf.byteLength/2),b=saved.bounds;
const installed=fs.readFileSync(require.resolve('mineflayer/lib/plugins/blocks'),'utf8'),code=installed.slice(installed.indexOf('  function canSeeBlock (block)'),installed.indexOf("\n  bot._client.on('unload_chunk'"));assert.ok(code.startsWith('  function canSeeBlock'));
function fixture(mode){let active=true;const overlay=new Map(),read=[];
 const blockAt=raw=>{const p=raw.floored();read.push(p);if(overlay.has(p.toString()))return overlay.get(p.toString());if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;
 const s=saved.palette[cells[(p.x-b.minX)*(b.maxZ-b.minZ+1)*(b.maxY-b.minY+1)+(p.z-b.minZ)*(b.maxY-b.minY+1)+p.y-b.minY]];return Object.assign(Block.fromProperties(registry.blocksByName[s.name].id,s.properties,0),{position:p});};
 const bot={_client:{},game:{dimension:'overworld'},entity:{position:new Vec3(saved.start.x,saved.start.y,saved.start.z),eyeHeight:1.62},blockAt,canDigBlock:()=>mode!=='out_of_reach'};
 bot.world={getBlock:blockAt,raycast(...args){return WorldSync.prototype.raycast.call(this,...args);}};
 bot.canSeeBlock=new Function('bot',code+'\nreturn canSeeBlock;')(bot);
 const target=blockAt(new Vec3(saved.target.x,saved.target.y,saved.target.z)),p=new Vec3(-523,65,-46);
 if(mode==='unknown')overlay.set(p.toString(),null);
 if(mode==='wall'||mode==='leaves'||mode==='water')overlay.set(p.toString(),Object.assign(Block.fromStateId(registry.blocksByName[mode==='wall'?'stone':mode==='leaves'?'birch_leaves':'water'].defaultState),{position:p}));
 const assertActive=()=>{if(!active)throw Object.assign(Error('paused'),{code:'paused'});};
 if(mode==='paused'){const prior=bot.blockAt;bot.blockAt=p=>{const r=prior(p);active=false;return r;};bot.world.getBlock=bot.blockAt;}
 return {bot,target,read,assertActive};
}
test('formal42 exact saved MCA proves installed corner-distance ray ends before unobstructed birch but full fresh shape ray hits it',()=>{
 const f=fixture(),facts=[];assert.equal(f.bot.canSeeBlock(f.target),null);assert.equal(f.bot.canDigBlock(f.target),true);
 assert.equal(hasHouseResourceSight(f.bot,f.target,{assertActive:f.assertActive,onRecovered:e=>facts.push(e)}),true);assert.equal(facts.length,1);assert.ok(facts[0].hitDistance<4.5);assert.equal(facts[0].movementOrMaterialCredit,false);assert.equal(facts[0].actualFirstShapeHitConfirmed,true);assert.ok(facts[0].readCount<=32);
});
test('formal42 unchanged reachable resource no longer requests a futile movement when native visibility alone is short',async()=>{
 const f=fixture();let movement=0,recovered=0;
 const reach=createHouseResourceReach({getBot:()=>f.bot,captureActive:()=>f.assertActive,avoidsSupport:()=>true,standingSafely:()=>true,onVisibilityRecovered:()=>recovered++,moveToBlock:async()=>{movement++;throw Error('Unnecessary approach');}});
 await reach(f.target);assert.equal(movement,0);assert.ok(recovered>=1);assert.equal(f.bot.canSeeBlock(f.target),null);
});
for(const mode of ['unknown','wall','leaves','water','out_of_reach'])test(`resource geometry fallback does not erase obstruction or reach constraints: ${mode}`,()=>{
 const f=fixture(mode);assert.equal(hasHouseResourceSight(f.bot,f.target,{assertActive:f.assertActive}),false);
});
test('resource geometry read cannot survive a pause/owner revocation',()=>{const f=fixture('paused');assert.throws(()=>hasHouseResourceSight(f.bot,f.target,{assertActive:f.assertActive}),{code:'paused'});});
test('actual ray visibility cannot grant permission to remove current support',async()=>{
 const f=fixture();const reach=createHouseResourceReach({getBot:()=>f.bot,captureActive:()=>f.assertActive,avoidsSupport:()=>false,standingSafely:()=>true,moveToBlock:async()=>{throw Object.assign(Error('No path'),{name:'NoPath'});}});
 await assert.rejects(reach(f.target),{name:'NoPath'});
});
