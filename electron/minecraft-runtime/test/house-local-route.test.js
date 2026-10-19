'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry),{Vec3}=require('vec3');
const {planHouseLocalRoute,isHouseFoodApproachRouteFailure}=require('../vendor/server/minecraft/houseLocalRoute');
test('native food-follow timeout permits a fresh local route while cancellation and foreign ownership never do',()=>{
 assert.equal(isHouseFoodApproachRouteFailure(Error('Promise timed out.')),true);
 assert.equal(isHouseFoodApproachRouteFailure({code:'NoPath'}),true);
 for(const code of ['paused','cancelled','movement_preempted','house_shore_owner_changed','connection_lost'])
  assert.equal(isHouseFoodApproachRouteFailure({code,message:'Promise timed out.'}),false);
 assert.equal(isHouseFoodApproachRouteFailure(Error('network broke')),false);
});
function fixture(at){return {blockAt:p=>{p=new Vec3(p.x,p.y,p.z).floored();const name=at(p);return name===null?null:Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:p});},from:{x:0,y:1,z:0},goal:{x:8,y:1,z:0},canDig:()=>true};}
test('loaded clear detour is preferred over breaking a wall',()=>{const f=fixture(p=>p.y<1?'stone':p.x===1&&Math.abs(p.z)<1&&p.y<=2?'dirt':'air'),r=planHouseLocalRoute(f);assert.ok(r);assert.equal(r.digs,0);assert.ok(r.path.some(s=>s.direction.z!==0));assert.equal(r.actualMovementConfirmed,false);});
test('local escape can walk on a sand column only with its actual loaded stable base',()=>{
 const f=fixture(p=>p.y===0?'sand':p.y<0?'stone':'air');
 assert.ok(planHouseLocalRoute(f));
 for(const base of ['water','air',null]){
  const blocked=fixture(p=>p.y===0?'sand':p.y<0?base:'air');
  assert.equal(planHouseLocalRoute(blocked),null);
 }
});
test('a narrow soil passage can be planned when no clear bypass exists',()=>{const f=fixture(p=>p.y<1?'stone':p.z!==0?'bedrock':p.x===1&&p.y<=2?'dirt':'air'),r=planHouseLocalRoute(f);assert.ok(r);assert.equal(r.digs,1);assert.equal(r.path[0].direction.x,1);assert.equal(r.path[0].ascend,true);});
for(const name of ['lava','water',null])test(`no route can borrow ${name||'unknown'} support`,()=>{const f=fixture(p=>p.x===0&&p.z===0&&p.y===0?'stone':p.y===0?name:p.y<0?'bedrock':'air');assert.equal(planHouseLocalRoute(f),null);});
test('protected soil and unavailable harvesting permission cannot authorize digging',()=>{const f=fixture(p=>p.y<1?'stone':p.z!==0?'bedrock':p.x===1&&p.y<=2?'dirt':'air');assert.equal(planHouseLocalRoute({...f,canDig:()=>false}),null);assert.equal(planHouseLocalRoute({...f,protectedPosition:p=>p.x===1}),null);});

test('returning to higher ground plans a real upward staircase and never descends deeper',()=>{
 const f=fixture(p=>p.x===0&&p.z===0&&(p.y===1||p.y===2)?'air':p.y<4?'stone':'air');f.goal={x:8,y:4,z:0};const r=planHouseLocalRoute(f);assert.ok(r);assert.ok(r.position.y>f.from.y);assert.equal(r.path.some(s=>s.descend),false);assert.ok(r.digs>0&&r.digs<=8);
});

for(const name of ['andesite','granite','diorite','copper_ore','deepslate_iron_ore'])test(`escape can cut harvestable natural ${name} without permission to cut protected floors`,()=>{
 const f=fixture(p=>p.y<1?'stone':p.z!==0?'bedrock':p.x===1&&p.y<=2?name:'air');
 assert.ok(planHouseLocalRoute(f));
 assert.equal(planHouseLocalRoute({...f,canDig:()=>false}),null);
 assert.equal(planHouseLocalRoute({...f,protectedPosition:p=>p.x===1}),null);
});

test('escaping a pit may gain real elevation away from the goal before returning toward it',()=>{
 const f=fixture(p=>p.z!==0&&p.y>=1?'bedrock':p.x<0&&p.y<=8?'stone':p.x===0&&p.y<1?'stone':'air');
 f.goal={x:100,y:8,z:0};const route=planHouseLocalRoute(f);assert.ok(route);
 assert.ok(route.position.y>f.from.y);assert.ok(route.position.x<0);
 assert.ok(route.digs>0&&route.digs<=8);assert.equal(route.actualMovementConfirmed,false);
});

test('a level destination can cross a two-step dry hill without digging it flat',()=>{
 const f=fixture(p=>p.z!==0?'bedrock':p.y<(p.x>=2?3:p.x===1?2:1)?'stone':'air');
 const route=planHouseLocalRoute({...f,canDig:()=>false});assert.ok(route);
 assert.ok(route.position.y>=3);assert.equal(route.digs,0);assert.ok(route.position.x>=2);
});

test('historical protected floor coordinates are not a prohibition on walking through current air',()=>{
 const f=fixture(p=>p.y<1?'stone':'air');
 const route=planHouseLocalRoute({...f,protectedPosition:()=>true,canDig:()=>false});
 assert.ok(route);assert.equal(route.digs,0);
});

test('formal10 recorded terrain cannot plan a descent through its own earlier return floor',()=>{
 const terrain=require('../test-support/fixtures/formal10-camp-return.json'),{inspectMiningStep}=require('../vendor/server/minecraft/miningNavigation');
 const protectedKeys=new Set(terrain.priorFloors.map(p=>`${p.x},${p.y},${p.z}`));
 const blockAt=p=>{const q=new Vec3(p.x,p.y,p.z).floored(),b=terrain.bounds;if(q.x<b.minX||q.x>b.maxX||q.y<b.minY||q.y>b.maxY||q.z<b.minZ||q.z>b.maxZ)return null;const s=terrain.states[`${q.x},${q.y},${q.z}`]||{name:'air',properties:{}};return Object.assign(Block.fromProperties(registry.blocksByName[s.name].id,s.properties,0),{position:q});};
 const route=planHouseLocalRoute({blockAt,from:terrain.from,goal:terrain.goal,protectedPosition:p=>protectedKeys.has(`${p.x},${p.y},${p.z}`),canDig:()=>true,maxDigs:18});
 assert.ok(route,'Recorded slope must still have a finite safe local alternative');
 let from=terrain.from;const floors=new Set([`${from.x},${from.y-1},${from.z}`]);
 for(const step of route.path){const inspected=inspectMiningStep({blockAt,from,direction:step.direction,ascend:step.ascend,descend:step.descend,minY:-64,maxY:319,allowLeafSupport:true,allowCeilingClearance:true,allowStableGravitySupport:true});assert.ok(inspected.ok);assert.ok(inspected.clearance.every(p=>!floors.has(`${p.x},${p.y},${p.z}`)),'A future step must not excavate an earlier route floor');from=inspected.target;floors.add(`${from.x},${from.y-1},${from.z}`);}
});
