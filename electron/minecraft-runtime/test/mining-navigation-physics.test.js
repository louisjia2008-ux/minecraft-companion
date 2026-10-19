/* global require, setInterval, clearInterval */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const minecraftData = require('minecraft-data')('1.21.8');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { Physics, PlayerState } = require('prismarine-physics');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { createMiningNavigator } = require('../vendor/server/minecraft/miningNavigation');

function physicalStaircase() {
  const cells = new Map();
  const controls = Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map((name) => [name, false]));
  let paused = false;
  let frozen = false;
  let ticks = 0;
  const reached = [];
  const digStarts = [];
  const bot = Object.assign(new EventEmitter(), {
    registry, version: '1.21.8', game: { dimension: 'overworld', minY: -64, height: 384 },
    entities: {}, controlState: controls, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    entity: {
      position: new Vec3(0.5, 10, 0.5), velocity: new Vec3(0, 0, 0), onGround: true,
      yaw: 0, pitch: 0, effects: {}, attributes: {}, height: 1.8, width: 0.6,
      isInWater: false, isInLava: false, isInWeb: false,
      isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false,
    },
    inventory: { items: () => [], slots: [] },
    heldItem: { name: 'iron_pickaxe', type: registry.itemsByName.iron_pickaxe.id },
    blockAt: (point) => {
      const position = point.floored();
      const name = cells.get(position.toString())
        ?? (position.y >= 10 || (position.x === 1 && position.z === 0 && position.y === 9) ? 'air' : 'stone');
      return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position });
    },
    setControlState: (name, value) => { controls[name] = value; },
    clearControlStates: () => { for (const name of Object.keys(controls)) controls[name] = false; },
    look: async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; },
  });
  const world = { getBlock: (point) => bot.blockAt(point) };
  bot.physics = Physics(minecraftData, world);
  pathfinder(bot);
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allowParkour = false;
  movements.allowSprinting = false;
  movements.maxDropDown = 2;
  movements.scafoldingBlocks = [];
  bot.pathfinder.setMovements(movements);
  bot.on('goal_reached', () => {
    reached.push({ position: bot.entity.position.clone(), onGround: bot.entity.onGround, ticks });
  });
  // Position and velocity changes are exclusively the installed vanilla
  // movement simulator's results; the fixture never assigns a goal position.
  const timer = setInterval(() => {
    if (frozen) return;
    const player = new PlayerState(bot, controls);
    bot.physics.simulatePlayer(player, world).apply(bot);
    ticks += 1;
    bot.emit('physicsTick');
  }, 5);
  const navigator = createMiningNavigator({
    getBot: () => bot,
    movementTimeoutMs: 2500,
    assertActive: () => {
      if (paused) { const error = new Error('paused'); error.code = 'paused'; throw error; }
    },
    digBlock: async (block) => {
      digStarts.push({ onGround: bot.entity.onGround, position: bot.entity.position.clone() });
      cells.set(block.position.toString(), 'air');
    },
  });
  return {
    bot, navigator, reached, digStarts,
    freeze: () => { frozen = true; },
    pause: () => { paused = true; },
    change: (name, point) => {
      const previous = bot.blockAt(point);
      cells.set(point.floored().toString(), name);
      bot.emit('blockUpdate', previous, bot.blockAt(point));
    },
    close: () => { clearInterval(timer); bot.pathfinder.setGoal(null); },
  };
}

test('an interrupted underground actor physically returns through its saved mine before any surface reconnect',async()=>{
 const f=physicalStaircase();try{
  await f.navigator.advance('east',{descend:true});await f.navigator.advance('east',{descend:true});
  const saved=f.navigator.getState(),digs=f.digStarts.length,reconciliations=[];
  const quarry={schema:1,anchor:{x:0,y:10,z:0},activeResource:'raw_iron',routes:{raw_iron:{navigation:{...saved,routeIndex:1}}}};
  const result=await require('../vendor/server/minecraft/houseInterruptedQuarryReturn').returnInterruptedHouseQuarry({
   getBot:()=>f.bot,assertActive(){},getQuarry:()=>quarry,
   saveNavigation:(name,state,facts)=>{quarry.routes[name].navigation=state;if(facts)reconciliations.push({facts,moves:state.moves});},
  });
  assert.equal(result,true);assert.equal(f.bot.entity.onGround,true);assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,10,.5))<.2);
  assert.equal(quarry.routes.raw_iron.navigation.routeIndex,0);assert.equal(f.digStarts.length,digs);
  assert.equal(reconciliations.length,1);assert.equal(reconciliations[0].moves,saved.moves);
  assert.equal(reconciliations[0].facts.newMovementCredit,false);
 }finally{f.close();}
});

for(const obstruction of [null,'stone','water'])test(`off-route combat displacement beyond six blocks uses a fresh checked mine connector (${obstruction})`,async()=>{
 const f=physicalStaircase();try{
  await f.navigator.advance('east',{descend:true});await f.navigator.advance('east',{descend:true});
  const saved=f.navigator.getState();
  for(let i=0;i<6;i++)await f.navigator.advance('east',{descend:true});
  const digs=f.digStarts.length,records=[];
  const quarry={anchor:{x:0,y:10,z:0},activeResource:'raw_iron',routes:{raw_iron:{navigation:saved}}};
  if(obstruction)f.change(obstruction,new Vec3(5,5,0));
  const run=()=>require('../vendor/server/minecraft/houseInterruptedQuarryReturn').returnInterruptedHouseQuarry({
   getBot:()=>f.bot,assertActive(){},getQuarry:()=>quarry,
   saveNavigation:(_name,state)=>{quarry.routes.raw_iron.navigation=state;},record:v=>records.push(v),
  });
  if(obstruction){await assert.rejects(run(),{code:'house_quarry_rejoin_unavailable'});assert.equal(quarry.routes.raw_iron.navigation.routeIndex,saved.routeIndex);}
  else{assert.equal(await run(),true);assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,10,.5))<.2);
   assert.ok(records.some(v=>v.kind==='fresh_clear_connector'&&v.moves===6));assert.equal(quarry.routes.raw_iron.navigation.routeIndex,0);}
  assert.equal(f.digStarts.length,digs,'the fresh connector must never excavate');
 }finally{f.close();}
});

test('installed pathfinder can resolve a descending GoalBlock before installed physics has landed', async () => {
  const f = physicalStaircase();
  try {
    await f.bot.pathfinder.goto(new goals.GoalBlock(1, 9, 0));
    assert.equal(f.reached.length, 1);
    assert.equal(f.reached[0].onGround, false, 'Negative control must expose the actual premature completion');
    assert.ok(f.reached[0].position.y > 9.8 && f.reached[0].position.y < 10);
    assert.ok(f.reached[0].ticks > 0, 'Movement used real physics ticks');
  } finally { f.close(); }
});

test('checked staircase movement waits for physical landing before recording progress', async () => {
  const f = physicalStaircase();
  try {
    const result = await f.navigator.advance('east', { descend: true });
    assert.equal(f.reached[0].onGround, false, 'Installed goto still resolves while falling');
    assert.equal(f.bot.entity.onGround, true, 'Navigation completes only after the physics engine lands');
    assert.equal(f.bot.entity.position.y, 9);
    assert.deepEqual(f.bot.entity.position.floored(), new Vec3(1, 9, 0));
    assert.equal(result.state.moves, 1);
    assert.equal(f.bot.listenerCount('physicsTick'), 1, 'Temporary landing guard is removed');
    await f.navigator.advance('east', { descend: true });
    assert.ok(f.digStarts.length >= 2, 'The next staircase step actually begins excavation');
    assert.ok(f.digStarts.every((dig) => dig.onGround), 'Subsequent digs start after physical landing');
    assert.equal(f.bot.entity.position.y, 8);
    assert.equal(f.bot.entity.onGround, true);
  } finally { f.close(); }
});

test('cancellation during physical landing rejects without recording an unlanded move', async () => {
  const f = physicalStaircase();
  try {
    f.bot.once('goal_reached', () => { f.freeze(); f.pause(); });
    await assert.rejects(f.navigator.advance('east', { descend: true }), (error) => error.code === 'paused');
    assert.equal(f.bot.entity.onGround, false);
    assert.equal(f.navigator.getState().moves, 0);
    assert.equal(f.bot.listenerCount('physicsTick'), 1);
  } finally { f.close(); }
});

test('a new lava exposure during physical landing rejects before recording the move', async () => {
  const f = physicalStaircase();
  try {
    f.bot.once('goal_reached', () => { f.freeze(); f.change('lava', new Vec3(2, 9, 0)); });
    await assert.rejects(f.navigator.advance('east', { descend: true }), (error) => error.code === 'MINING_FLUID');
    assert.equal(f.bot.entity.onGround, false);
    assert.equal(f.navigator.getState().moves, 0);
    assert.equal(f.bot.pathfinder.goal, null);
  } finally { f.close(); }
});

test('missing landing confirmation has a bounded explicit movement timeout', async () => {
  const f = physicalStaircase();
  try {
    f.bot.once('goal_reached', () => { f.freeze(); });
    await assert.rejects(f.navigator.advance('east', { descend: true }), (error) => error.code === 'MINING_MOVEMENT_TIMEOUT');
    assert.equal(f.navigator.getState().moves, 0);
    assert.equal(f.bot.entity.onGround, false);
    assert.equal(f.bot.pathfinder.goal, null);
    assert.equal(f.bot.listenerCount('physicsTick'), 1);
  } finally { f.close(); }
});

test('a mine already returned to entry cannot capture a nearby surface respawn below camp',async()=>{
 const position=new Vec3(-86.5,65,-13.5),quarry={anchor:{x:-104,y:69,z:-19},activeResource:'raw_iron',routes:{raw_iron:{navigation:{
  breadcrumbs:[{x:-104,y:69,z:-19},{x:-96,y:61,z:-16},{x:-90,y:55,z:-16}],routeIndex:0}}}};
 let writes=0;
 const result=await require('../vendor/server/minecraft/houseInterruptedQuarryReturn').returnInterruptedHouseQuarry({
  getBot:()=>({entity:{position}}),getQuarry:()=>quarry,assertActive(){},waitGround:()=>{writes++;},saveNavigation:()=>{writes++;}});
 assert.equal(result,false);assert.equal(writes,0);assert.deepEqual(position,new Vec3(-86.5,65,-13.5));
});

test('a distant surface valley below camp is not captured by an old underground route',async()=>{
 const position=new Vec3(-169.01,63,-83.88),quarry={anchor:{x:-176,y:65,z:-34},activeResource:'raw_iron',routes:{raw_iron:{navigation:{breadcrumbs:[{x:-176,y:65,z:-34},{x:-175,y:64,z:-34},{x:-175,y:63,z:-33}],routeIndex:2}}}};
 let waits=0,writes=0;
 const result=await require('../vendor/server/minecraft/houseInterruptedQuarryReturn').returnInterruptedHouseQuarry({getBot:()=>({entity:{position}}),getQuarry:()=>quarry,assertActive(){},waitGround:()=>{waits++;},saveNavigation:()=>{writes++;}});
 assert.equal(result,false);assert.equal(waits,0);assert.equal(writes,0);assert.deepEqual(position,new Vec3(-169.01,63,-83.88));
});

test('mine return removes only recorded self-built cover blocking its next live step',async()=>{
 const f=physicalStaircase();try{
  await f.navigator.advance('east',{descend:true});await f.navigator.advance('east',{descend:true});
  const navigation=f.navigator.getState(),p={x:1,y:9,z:0};f.change('dirt',new Vec3(p.x,p.y,p.z));
  const quarry={anchor:{x:0,y:10,z:0},activeResource:'raw_iron',routes:{raw_iron:{navigation}}};let removed=0;
  assert.equal(await require('../vendor/server/minecraft/houseInterruptedQuarryReturn').returnInterruptedHouseQuarry({
   getBot:()=>f.bot,assertActive(){},getQuarry:()=>quarry,getOwnedCover:()=>[{position:p,item:'dirt'}],
   clearOwnedCover:async s=>{removed++;f.change('air',new Vec3(s.position.x,s.position.y,s.position.z));},
   saveNavigation:(_n,s)=>{quarry.routes.raw_iron.navigation=s;}
  }),true);assert.equal(removed,1);assert.equal(quarry.routes.raw_iron.navigation.routeIndex,0);
 }finally{f.close();}
});

test('blocked mine connector can use an explicitly owned local excavation and still requires actual native rejoin',{timeout:15000},async()=>{
 const f=physicalStaircase();try{
  await f.navigator.advance('east',{descend:true});await f.navigator.advance('east',{descend:true});const saved=f.navigator.getState();
  for(let i=0;i<6;i++)await f.navigator.advance('east',{descend:true});
  f.change('stone',new Vec3(5,5,0));let recoveries=0;const records=[];
  const quarry={anchor:{x:0,y:10,z:0},activeResource:'raw_iron',routes:{raw_iron:{navigation:saved}}};
  const returned=await require('../vendor/server/minecraft/houseInterruptedQuarryReturn').returnInterruptedHouseQuarry({
   getBot:()=>f.bot,assertActive(){},getQuarry:()=>quarry,
   recoverLocal:async()=>{recoveries++;for(let i=0;i<3;i++)await f.navigator.advance('west',{ascend:true});return true;},
   saveNavigation:(_name,value)=>{quarry.routes.raw_iron.navigation=value;},record:facts=>records.push(facts),
  });
  assert.equal(returned,true);assert.equal(recoveries,1);assert.equal(f.bot.blockAt(new Vec3(5,5,0)).name,'air');
  assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,10,.5))<.2);
  assert.ok(records.some(r=>r.kind==='local_rejoin_recovery'&&r.oldRouteTraversalCredit===false));
 }finally{f.close();}
});

test('a failed local mine reconnect tries distinct fresh-supported original nodes, not the same missing floor',{timeout:15000},async()=>{
 const f=physicalStaircase();try{
  await f.navigator.advance('east',{descend:true});await f.navigator.advance('east',{descend:true});const saved=f.navigator.getState();
  for(let i=0;i<6;i++)await f.navigator.advance('east',{descend:true});
  f.change('stone',new Vec3(5,5,0));f.change('air',new Vec3(2,7,0));const attempted=[];
  const quarry={anchor:{x:0,y:10,z:0},activeResource:'raw_iron',routes:{raw_iron:{navigation:saved}}};
  await assert.rejects(require('../vendor/server/minecraft/houseInterruptedQuarryReturn').returnInterruptedHouseQuarry({
   getBot:()=>f.bot,assertActive(){},getQuarry:()=>quarry,
   recoverLocal:async target=>{attempted.push(target);return false;},
   saveNavigation:()=>{throw Error('Unconfirmed connector cannot change original route');},
  }),{code:'house_quarry_rejoin_unavailable'});
  assert.equal(attempted.length,2);assert.equal(new Set(attempted.map(p=>`${p.x},${p.y},${p.z}`)).size,2);
  assert.ok(attempted.every(p=>p.x!==2));assert.equal(quarry.routes.raw_iron.navigation.routeIndex,saved.routeIndex);
 }finally{f.close();}
});

test('world136 delayed checked-step cleanup cannot stop a replacement native goal on the same profile',{timeout:6000},async()=>{
 const f=physicalStaircase();let release,entered;const held=new Promise(r=>{release=r;}),waiting=new Promise(r=>{entered=r;});
 try{
  f.bot.blockAt=p=>Object.assign(Block.fromStateId(registry.blocksByName[p.y<10?'stone':'air'].defaultState),{position:p.floored()});
  const profile=new Movements(f.bot);Object.assign(profile,{canDig:false,allowParkour:false,allowSprinting:false,allowFreeMotion:false,allow1by1towers:false,maxDropDown:2,infiniteLiquidDropdownDistance:false,scafoldingBlocks:[]});f.bot.pathfinder.setMovements(profile);
  const nav=createMiningNavigator({getBot:()=>f.bot,preserveMovements:true,movementTimeoutMs:2500,settleOwnedDefense:async()=>{entered();await held;}});
  const previous=nav.advance('east');previous.catch(()=>{});await waiting;
  const goal=new goals.GoalBlock(-4,10,0),replacement=f.bot.pathfinder.goto(goal);replacement.catch(()=>{});
  release();await previous;
  assert.equal(f.bot.pathfinder.goal,goal);assert.equal(f.bot.pathfinder.movements,profile);
  await replacement;assert.equal(f.bot.entity.position.floored().equals(new Vec3(-4,10,0)),true);
 }finally{release();f.close();}
});
