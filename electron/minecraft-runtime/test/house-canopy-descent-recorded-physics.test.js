'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
const terrain=require('../test-support/fixtures/formal19-canopy-descent.json'),{createLoadedDryGraph}=require('../vendor/server/minecraft/houseSurfaceGraph');
test('formal19 original swamp canopy physically descends five feet to loaded dry grass without requiring a reverse route',{timeout:12000},async t=>{
 const anchor={x:-16,y:68,z:-42},id='-16,68,-42',target={x:-20,y:63,z:-43},cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:true}},order:[id],current:id,resumeNode:id,visits:1,probes:0,frontier:[{parent:id,target}],blockedEdges:[]};
 const f=native.exports.fixture(t,{initialPosition:new Vec3(-15.5,68,-41.5),checkpoint:cp,worldAt:p=>{const b=terrain.bounds;if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;return terrain.palette[terrain.states[`${p.x},${p.y},${p.z}`]||0];}});
 const graph=createLoadedDryGraph(f.deps,{anchor,radius:384,nativeReachableHints:true,terrainRecovery:true,legTimeoutMs:6000});
 graph.movements.maxDropDown=5;
 const search=f.bot.pathfinder.getPathFromTo(graph.movements,f.bot.entity.position,new(require('mineflayer-pathfinder').goals.GoalBlock)(target.x,target.y,target.z),{timeout:1000,tickTimeout:10});
 let old;for(let n=0;n<100;n++){const next=search.next();old=next.value?.result;if(next.done||old?.status!=='partial')break;}
 assert.equal(old.status,'noPath','Original floor-bottom budget wrongly rejects the real five-foot dry descent');
 assert.deepEqual(f.bot.entity.position,new Vec3(-15.5,68,-41.5));
 graph.movements.maxDropDown=6;const r=await graph.next();
 assert.equal(r.moved,true,JSON.stringify(r));assert.deepEqual(r.actual,target);assert.equal(f.bot.entity.onGround,true);assert.equal(graph.state().visits,2);assert.ok(f.points.some(p=>p.y<67&&p.y>63));assert.equal(f.waterTicks.length,0);
});
