'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const {createLoadedDryGraph}=require('../vendor/server/minecraft/houseSurfaceGraph');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);
native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
const terrain=require('../test-support/fixtures/formal11-directed-site.json');
// Offline read-only recorded Java terrain; installed native movement/physics,
// one original graph owner. This does not count as a new survival acceptance.
test('formal11 recorded lower site graph escapes its directed parent replay loop through an actual fresh native frontier',{timeout:20000},async t=>{
 const f=native.exports.fixture(t,{initialPosition:new Vec3(terrain.actual.x,terrain.actual.y,terrain.actual.z),checkpoint:terrain.graph,worldAt:p=>{
  const b=terrain.bounds;if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;
  return terrain.palette[terrain.states[`${p.x},${p.y},${p.z}`]||0];
 }}),graph=createLoadedDryGraph(f.deps,{anchor:terrain.graph.anchor,radius:384,nativeReachableHints:true,terrainRecovery:true,legTimeoutMs:5000});
 const before=graph.state(),result=await graph.next();
 assert.equal(result.moved,true);assert.equal(graph.state().visits,before.visits+1);assert.equal(graph.state().order.length,before.order.length+1);
 assert.notEqual(graph.state().current,'8,77,8');assert.equal(f.bot.entity.onGround,true);assert.ok(f.points.length>5);
 assert.ok(f.attempts.every(p=>p.x!==8||p.y!==77||p.z!==8),'An unreachable high spawn never receives a movement command');
 assert.equal(graph.state().anchor.x,8);assert.equal(graph.state().anchor.y,77);assert.equal(graph.state().anchor.z,8);
});
