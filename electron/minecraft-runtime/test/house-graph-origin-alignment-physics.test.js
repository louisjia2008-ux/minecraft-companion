'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3'),{Movements}=require('mineflayer-pathfinder');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
const terrain=require('../test-support/fixtures/formal26-supported-edge-origin.json'),{alignHouseGraphOrigin}=require('../vendor/server/minecraft/houseGraphOriginAlignment'),{createLoadedDryGraph,naturalWalkingFoot,hasGroundedBodySupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
function fixture(t,replacement){const f=native.exports.fixture(t,{initialPosition:new Vec3(165.14158363373596,55,185.48068002803348),worldAt:p=>{const b=terrain.bounds;if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;if(replacement!==undefined&&p.x===164&&p.y===54&&p.z===185)return replacement;return terrain.palette[terrain.states[`${p.x},${p.y},${p.z}`]||0];}});const profile=new Movements(f.bot);Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allowSprinting:false,allow1by1towers:false,allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false});profile.getMoveDiagonal=()=>{};f.bot.pathfinder.setMovements(profile);return f;}
test('formal26 original supported AABB edge physically aligns with its real support before any integer graph root is registered',{timeout:6000},async t=>{
 const f=fixture(t),before=f.bot.entity.position.clone();assert.equal(hasGroundedBodySupport(f.bot),true);assert.equal(naturalWalkingFoot(f.bot,before.floored()),false);
 const old=createLoadedDryGraph(f.deps,{anchor:{x:165,y:55,z:185}});await assert.rejects(old.next(),{code:'dry_graph_not_on_surface'});assert.equal(old.state().visits,0);
 const r=await alignHouseGraphOrigin({getBot:()=>f.bot,assertActive:()=>{},goto:g=>f.bot.pathfinder.goto(g)},{deadline:Date.now()+3000});
 assert.equal(r.aligned,true);assert.equal(r.graphNodeCredit,false);assert.equal(r.positionOrVelocityWritten,false);assert.ok(f.bot.entity.position.distanceTo(before)>0);assert.deepEqual(f.bot.entity.position.floored(),new Vec3(164,55,185));assert.equal(f.bot.entity.onGround,true);assert.equal(naturalWalkingFoot(f.bot,f.bot.entity.position.floored()),true);
 const graph=createLoadedDryGraph(f.deps,{anchor:{x:164,y:55,z:185}}),registered=await graph.returnToAnchor();assert.equal(registered.confirmed,true);assert.equal(graph.state().visits,1);assert.ok(f.points.length>0);
});
for(const replacement of [null,'water','lava','air','stone_slab'])test(`graph-origin alignment refuses changed contact ${replacement} before issuing any goto`,async t=>{
 const f=fixture(t,replacement);await assert.rejects(alignHouseGraphOrigin({getBot:()=>f.bot,assertActive:()=>{},goto:g=>f.bot.pathfinder.goto(g)},{deadline:Date.now()+1000}));assert.equal(f.attempts.length,0);
});
test('a foreign or paused origin cannot borrow the old grounded contact',async t=>{const f=fixture(t);await assert.rejects(alignHouseGraphOrigin({getBot:()=>f.bot,assertActive:()=>{throw Object.assign(Error('paused'),{code:'paused'});},goto:g=>f.bot.pathfinder.goto(g)},{deadline:Date.now()+1000}),{code:'paused'});assert.equal(f.attempts.length,0);});
test('a replacement profile and goal after actual alignment are preserved instead of borrowing the old result',{timeout:5000},async t=>{
 const f=fixture(t);let replacement,goal;
 await assert.rejects(alignHouseGraphOrigin({getBot:()=>f.bot,assertActive:()=>{},goto:async g=>{await f.bot.pathfinder.goto(g);replacement=new Movements(f.bot);goal=new(require('mineflayer-pathfinder').goals.GoalBlock)(170,55,185);f.bot.pathfinder.setMovements(replacement);f.bot.pathfinder.setGoal(goal);}},{deadline:Date.now()+2000}),{code:'house_graph_origin_preempted'});
 assert.equal(f.bot.pathfinder.movements,replacement);assert.equal(f.bot.pathfinder.goal,goal);
});
test('saved world58 run99 snow-edge contact physically aligns without writing actor state',{timeout:6000},async t=>{
 const terrain=require('../test-support/fixtures/formal58-run99-supported-snow-edge.json');
 const f=native.exports.fixture(t,{initialPosition:new Vec3(-183.16817215118326,68,66.49926627760705),worldAt:p=>{const id=terrain.states[`${p.x},${p.y},${p.z}`];return id===undefined?null:terrain.palette[id];}});
 const profile=new Movements(f.bot);Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allowSprinting:false,allow1by1towers:false,allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false});profile.getMoveDiagonal=()=>{};
 const policy=require('../vendor/server/minecraft/houseSurfaceGraph').createSurfaceHazardEdgePolicy(f.bot);profile.exclusionAreasStep.push(b=>policy(b.position)?0:Infinity);f.bot.pathfinder.setMovements(profile);
 assert.equal(hasGroundedBodySupport(f.bot),true);assert.equal(naturalWalkingFoot(f.bot,f.bot.entity.position.floored()),false);
 const result=await alignHouseGraphOrigin({getBot:()=>f.bot,assertActive:()=>{},goto:g=>f.bot.pathfinder.goto(g)},{deadline:Date.now()+3000});
 assert.equal(result.aligned,true);assert.equal(result.graphNodeCredit,false);assert.equal(result.positionOrVelocityWritten,false);assert.deepEqual(f.bot.entity.position.floored(),new Vec3(-183,68,66));assert.ok(f.points.length>0);assert.equal(f.bot.entity.onGround,true);
});
