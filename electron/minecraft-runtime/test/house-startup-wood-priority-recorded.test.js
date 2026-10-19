'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{Vec3}=require('vec3');
const saved=require('../test-support/fixtures/formal44-startup-tree.json'),{prioritizeStartupWood}=require('../vendor/server/minecraft/housePreSiteWood'),{clearHouseResourceSight}=require('../vendor/server/minecraft/houseResourceSight');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry),WorldSync=require('prismarine-world/src/worldsync'),buf=require('node:zlib').gunzipSync(Buffer.from(saved.statesGzipBase64,'base64')),cells=new Uint16Array(buf.buffer,buf.byteOffset,buf.byteLength/2),b=saved.bounds;
const installed=fs.readFileSync(require.resolve('mineflayer/lib/plugins/blocks'),'utf8'),code=installed.slice(installed.indexOf('  function canSeeBlock (block)'),installed.indexOf("\n  bot._client.on('unload_chunk'"));
function fixture(){const overlay=new Map(),digs=[],position=new Vec3(saved.start.x,saved.start.y,saved.start.z);let owner=true;
 const blockAt=raw=>{const p=raw.floored();if(overlay.has(p.toString()))return overlay.get(p.toString());if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;const v=saved.palette[cells[(p.x-b.minX)*(b.maxZ-b.minZ+1)*(b.maxY-b.minY+1)+(p.z-b.minZ)*(b.maxY-b.minY+1)+p.y-b.minY]];return Object.assign(Block.fromProperties(registry.blocksByName[v.name].id,v.properties,0),{position:p});};
 const bot={_client:{},game:{dimension:'overworld'},entity:{position,eyeHeight:1.62,width:.6,height:1.8,onGround:true,isInWater:false,isInLava:false},blockAt,canDigBlock:block=>block?.diggable&&block.position.offset(.5,.5,.5).distanceTo(position.offset(0,1.65,0))<=5.1};
 bot.world={getBlock:blockAt,raycast(...args){return WorldSync.prototype.raycast.call(this,...args);}};bot.canSeeBlock=new Function('bot',code+'\nreturn canSeeBlock;')(bot);
 const avoids=p=>!(position.x+.3>p.x&&position.x-.3<p.x+1&&position.z+.3>p.z&&position.z-.3<p.z+1&&position.y+.1>p.y&&position.y-.1<p.y+1);
 const deps={assertActive:()=>{if(!owner)throw Object.assign(Error('paused'),{code:'paused'});},standingSafely:()=>true,avoidsSupport:avoids,excluded:()=>false};
 return {bot,deps,overlay,digs,candidate:blockAt(new Vec3(-90,108,-63)),revoke:()=>{owner=false;},clear:target=>clearHouseResourceSight({getBot:()=>bot,assertActive:deps.assertActive,standingSafely:deps.standingSafely,canClear:l=>avoids(l.position),dig:async leaf=>{digs.push(leaf.position.clone());overlay.set(leaf.position.toString(),Object.assign(Block.fromStateId(0),{position:leaf.position}));}},target)};
}
test('formal44 loaded canopy startup prioritizes a currently leaf-reachable trunk and clears at most two real ray leaves before movement',async()=>{
 const f=fixture(),far=Object.assign(Block.fromStateId(registry.blocksByName.dark_oak_log.defaultState),{position:new Vec3(-103,100,-75)}),ranked=prioritizeStartupWood(f.bot,[far,f.candidate],f.deps);
 assert.equal(ranked[0],f.candidate);const cleared=await f.clear(ranked[0]);assert.ok(cleared>0&&cleared<=2);assert.equal(f.bot.canSeeBlock(f.candidate),true);assert.ok(f.digs.every(p=>f.deps.avoidsSupport(p)));assert.equal(f.bot.blockAt(f.candidate.position).name,'dark_oak_log');
 assert.equal(f.bot.blockAt(new Vec3(-90,109,-64)).name,'dark_oak_leaves','The actual feet support remains untouched');
});
test('startup candidate ranking cannot authorize a current support target',()=>{
 const f=fixture(),support=f.bot.blockAt(new Vec3(-90,109,-64));const list=prioritizeStartupWood(f.bot,[support,f.candidate],f.deps);assert.equal(list[0],f.candidate);assert.equal(f.digs.length,0);
});
test('a pause while ranking produces no leaf dig or movement authorization',()=>{const f=fixture();f.revoke();assert.throws(()=>prioritizeStartupWood(f.bot,[f.candidate],f.deps),{code:'paused'});assert.equal(f.digs.length,0);});
