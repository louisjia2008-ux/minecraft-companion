'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
const saved=require('../test-support/fixtures/formal52-startup-frontier.json'),buf=require('node:zlib').gunzipSync(Buffer.from(saved.statesGzipBase64,'base64')),cells=new Uint16Array(buf.buffer,buf.byteOffset,buf.byteLength/2),b=saved.bounds;
// Original pathfinder/physics on saved MCA. Only leaf-dig acknowledgements
// are modeled dependency replies; no live server acceptance is claimed.
const {createLoadedDryGraph}=require('../vendor/server/minecraft/houseSurfaceGraph'),{settleNativeGoto}=require('../vendor/server/minecraft/houseNativeGotoSettlement');
function fixture(t){const overlay=new Map(),p=saved.start,f=native.exports.fixture(t,{initialPosition:new Vec3(p.x,p.y,p.z),worldAt:p=>overlay.has(p.toString())?overlay.get(p.toString()):p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ?null:saved.palette[cells[(p.x-b.minX)*(b.maxZ-b.minZ+1)*(b.maxY-b.minY+1)+(p.z-b.minZ)*(b.maxY-b.minY+1)+p.y-b.minY]]});
 f.deps.canDigPassageBlock=block=>block.name.endsWith('_leaves');f.deps.digPassageBlock=async block=>{overlay.set(block.position.toString(),'air');};
 f.deps.actualnativegoto=(goal,profile,budget)=>settleNativeGoto({...f.deps,isExpectedStop:budget.isExpectedNativeStop},{goal,deadline:budget.deadline});return f;}
test('formal52 actual startup canopy can advance through a separately proven guarded native frontier',{timeout:14000},async t=>{
 const f=fixture(t),anchor={x:-2,y:82,z:7},graph=createLoadedDryGraph(f.deps,{anchor,nativeReachableHints:true,adaptiveLocalFrontier:true,terrainRecovery:true,legTimeoutMs:8000});
 const r=await graph.next();assert.equal(r.moved,true);assert.equal(graph.state().visits,2);assert.equal(f.bot.entity.onGround,true);assert.ok(f.points.length>3);assert.equal(f.waterTicks.length,0);assert.deepEqual(graph.state().anchor,anchor);assert.equal(f.bot.inventory.items().length,0,'A new standing point never credits wood');
});
test('startup frontier owner cancellation cannot credit a new native observation',{timeout:5000},async t=>{const f=fixture(t),graph=createLoadedDryGraph(f.deps,{anchor:{x:-2,y:82,z:7},nativeReachableHints:true,adaptiveLocalFrontier:true,terrainRecovery:true,legTimeoutMs:3000});f.cancel();await assert.rejects(graph.next(),{code:'cancelled'});assert.equal(f.attempts.length,0);assert.equal(graph.state().visits,0);});
