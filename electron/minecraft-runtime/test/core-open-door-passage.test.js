'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Move = require('mineflayer-pathfinder/lib/move');
const { GoalBlock } = require('mineflayer-pathfinder/lib/goals');
const { configureMovements, createCompanion } = require('../core/companion');
const { installOpenDoorPassage, uninstallOpenDoorPassage } = require('../core/openDoorPassage');
const { fixture, nativeBody, registry } = require('./core-open-door-fixture');

for(const facing of ['north','east','south','west'])for(const hinge of ['left','right'])for(const reverse of [false,true]){
 test(`open protected door ${facing}/${hinge} ${reverse?'outside->home':'home->outside'}`,()=>{
  const f=fixture(facing,hinge,{reverse});const lower=f.at(f.world(0)),upper=f.at(f.world(0,0,1));
  const before=JSON.stringify([lower,upper]);const r=f.plan();assert.equal(r.status,'success');
  assert.equal(r.path.some(p=>p.x===0&&p.y===0&&p.z===0),true);
  assert.equal(r.path.flatMap(p=>p.toBreak).length,0);assert.equal(r.path.flatMap(p=>p.toPlace).length,0);
  assert.equal(JSON.stringify([lower,upper]),before,'actual native Block objects and shapes unchanged');
  assert.equal(f.movements.blocksCantBreak.has(registry.blocksByName.oak_door.id),true);
  assert.equal(f.movements.exclusionBreak(f.at(f.world(0,1))),100);
  const native=f.bot.pathfinder.getPathTo(f.movements,new GoalBlock(f.end.x,f.end.y,f.end.z),1000);
  assert.equal(native.status,'success');
  assert.equal(native.path.every(p=>p.y===0),true,'native postProcessPath must not lift the doorway onto door panel');
  assert.equal(native.path.some(p=>p.x===.5&&p.y===0&&p.z===.5),true,'door waypoint stays on floor centre');
  assert.equal(JSON.stringify([lower,upper]),before,'native getPathTo also preserves actual blocks/shapes');
 });
}
for(const [name,options] of Object.entries({closed:{open:false},missingUpper:{missingUpper:true},unknownUpper:{unknownUpper:true},inconsistentUpper:{inconsistentUpper:true},centreCollision:{centreCollision:true},wrongPlane:{wrongPlane:true}})){
 test(`reject ${name}`,()=>{const f=fixture('north','left',options);const r=f.plan();assert.equal(r.status,'noPath');});
}
for(const facing of ['north','east','south','west']){
 test(`reject ${facing} sideways/diagonal exit from door`,()=>{
  const f=fixture(facing,'left',{crossRoom:true});const from=new Move(0,0,0,0,0);const neighbors=f.movements.getNeighbors(from);
  const normal=facing==='north'||facing==='south'?'z':'x';
  assert.equal(neighbors.some(n=>n.y!==0||Math.abs(n.x)+Math.abs(n.z)!==1||(normal==='z'?n.x!==0:n.z!==0)),false);
  assert.equal(neighbors.length,2);
  for(const u of [-1,1]) for(const v of [-1,1]) {
   const diagonalStart=f.world(u,v);const ns=f.movements.getNeighbors(new Move(diagonalStart.x,0,diagonalStart.z,0,0));
   assert.equal(ns.some(n=>n.x===0&&n.y===0&&n.z===0),false,'no diagonal entry');
  }
 });
}

test('20 create/dispose cycles restore the exact native getter and leave no adapter listener', async () => {
  const f = fixture();
  uninstallOpenDoorPassage(f.bot, f.movements);
  const physicsListeners = f.bot.listenerCount('physicsTick');
  for (let i = 0; i < 20; i++) {
    const companion = createCompanion({ bot: f.bot, tickMs: 1000000 });
    const profile = f.bot.pathfinder.movements;
    try {
      assert.equal(f.bot.listenerCount('path_update'), 1, 'exactly one owned path repair listener');
    } finally { await companion.dispose(); }
    assert.equal(f.bot.pathfinder.getPathFromTo, f.nativeGetter, 'no old movements closure remains in getter chain');
    assert.equal(f.bot.listenerCount('path_update'), 0);
    assert.equal(f.bot.listenerCount('physicsTick'), physicsListeners);
    assert.equal(profile.getBlock, require('mineflayer-pathfinder').Movements.prototype.getBlock);
  }
});

test('20 reconfigurations replace old adapters and repeat install of one profile is idempotent', () => {
  const f = fixture(); let previous = f.movements;
  for (let i = 0; i < 20; i++) {
    const profile = configureMovements(f.bot);
    assert.equal(previous.getBlock, require('mineflayer-pathfinder').Movements.prototype.getBlock);
    const getter = f.bot.pathfinder.getPathFromTo, block = profile.getBlock;
    installOpenDoorPassage(f.bot, profile);
    assert.equal(f.bot.pathfinder.getPathFromTo, getter);
    assert.equal(profile.getBlock, block);
    assert.equal(f.bot.listenerCount('path_update'), 1);
    previous = profile;
  }
  assert.equal(typeof uninstallOpenDoorPassage, 'function');
  uninstallOpenDoorPassage(f.bot, previous);
  assert.equal(f.bot.pathfinder.getPathFromTo, f.nativeGetter);
  assert.equal(f.bot.listenerCount('path_update'), 0);
});

test('cleanup preserves foreign getter/movement/listener and stale cleanup cannot remove a newer profile', () => {
  const f = fixture(), old = f.movements;
  const owned = f.bot.pathfinder.getPathFromTo, block = old.getBlock;
  const foreign = function * (...args) { yield * owned.apply(this, args); };
  const foreignBlock = function (...args) { return block.apply(this, args); };
  const foreignListener = () => {};
  f.bot.pathfinder.getPathFromTo = foreign; old.getBlock = foreignBlock;
  f.bot.on('path_update', foreignListener);
  assert.equal(typeof uninstallOpenDoorPassage, 'function');
  uninstallOpenDoorPassage(f.bot, old);
  assert.equal(f.bot.pathfinder.getPathFromTo, foreign); assert.equal(old.getBlock, foreignBlock);
  assert.deepEqual(f.bot.listeners('path_update'), [foreignListener]);
  const current = configureMovements(f.bot), currentGetter = f.bot.pathfinder.getPathFromTo;
  uninstallOpenDoorPassage(f.bot, old);
  assert.equal(f.bot.pathfinder.getPathFromTo, currentGetter); assert.equal(f.bot.listenerCount('path_update'), 2);
  uninstallOpenDoorPassage(f.bot, current);
  assert.equal(f.bot.pathfinder.getPathFromTo, foreign);
  assert.deepEqual(f.bot.listeners('path_update'), [foreignListener]);
  f.bot.removeListener('path_update', foreignListener);
});


for (const [facing,hinge] of [['north','left'],['east','right']]) test(`native goto follower repairs a real partial AStar continuation and physically crosses ${facing}/${hinge}`, async t => {
  const f=fixture(facing,hinge),{bot,PlayerState}=nativeBody(f),AStar=require('mineflayer-pathfinder/lib/astar');
  const before=JSON.stringify([f.at(f.world(0)),f.at(f.world(0,0,1))]);
  let forced=false, getterCalls=0, reached=false;
  const compute=AStar.prototype.compute, getter=bot.pathfinder.getPathFromTo;
  // Deterministic time-slice scheduling only: let the original search expand
  // one real node, then end that first slice. No path/result is fabricated.
  AStar.prototype.compute=function(){
    if(forced)return compute.call(this);
    forced=true; const context=this, profile=this.movements, neighbors=profile.getNeighbors, tick=this.tickTimeout;
    profile.getNeighbors=function(...args){const value=neighbors.apply(this,args);context.tickTimeout=-1;return value;};
    try{return compute.call(this);}finally{profile.getNeighbors=neighbors;context.tickTimeout=tick;}
  };
  bot.pathfinder.getPathFromTo=function*(...args){getterCalls++;yield*getter.apply(this,args);};
  t.after(()=>{AStar.prototype.compute=compute;bot.pathfinder.setGoal(null);uninstallOpenDoorPassage(bot,f.movements);});
  const updates=[];
  bot.on('path_update',result=>{updates.push({status:result.status,path:result.path.map(p=>({x:p.x,y:p.y,z:p.z}))});});
  bot.on('goal_reached',()=>{reached=true;});
  const going=bot.pathfinder.goto(new GoalBlock(f.end.x,f.end.y,f.end.z));going.catch(()=>{});
  for(let tick=0;tick<160&&!reached;tick++){
    bot.physics.simulatePlayer(new PlayerState(bot,bot.controlState),{getBlock:bot.blockAt}).apply(bot);
    bot.emit('physicsTick');await new Promise(setImmediate);
    if(updates.length>=2){
      const door=updates[1].path.find(p=>Math.floor(p.x)===0&&Math.floor(p.z)===0);
      assert.ok(door,'native continued path includes the doorway '+JSON.stringify(updates));
      assert.equal(door.y,0,'postprocessed partial continuation must remain at floor');
    }
  }
  assert.equal(updates[0].status,'partial');assert.equal(updates[1].status,'success');
  assert.equal(getterCalls,1,'second compute is the native follower bypass, not another wrapped getPathTo');
  assert.equal(reached,true,'actual native physics must cross the real door geometry');
  assert.equal(new GoalBlock(f.end.x,f.end.y,f.end.z).isEnd(bot.entity.position.floored()),true);
  await going;
  reached=false;
  const returning=bot.pathfinder.goto(new GoalBlock(f.start.x,f.start.y,f.start.z));returning.catch(()=>{});
  for(let tick=0;tick<160&&!reached;tick++){
    bot.physics.simulatePlayer(new PlayerState(bot,bot.controlState),{getBlock:bot.blockAt}).apply(bot);
    bot.emit('physicsTick');await new Promise(setImmediate);
  }
  assert.equal(reached,true,'native physics also crosses back through the doorway');
  assert.equal(new GoalBlock(f.start.x,f.start.y,f.start.z).isEnd(bot.entity.position.floored()),true);
  await returning;
  assert.equal(getterCalls,2,'one initial getter per independent goto; partial continuation bypass remains proven');
  assert.equal(JSON.stringify([f.at(f.world(0)),f.at(f.world(0,0,1))]),before,'world door blocks and shapes remain unchanged');
});

test('death and respawn stop the path goal so it is not walked in another dimension', async () => {
  const f = fixture();
  const companion = createCompanion({ bot: f.bot, tickMs: 1000000 });
  try {
    for (const event of ['death', 'respawn']) {
      f.bot.pathfinder.setGoal(new GoalBlock(414, 64, -429));
      f.bot.setControlState?.('forward', true);
      f.bot.emit(event);
      assert.equal(f.bot.pathfinder.goal, null, `${event} clears the goal`);
      if (f.bot.controlState) assert.equal(f.bot.controlState.forward, false);
    }
  } finally { await companion.dispose(); }
  assert.equal(f.bot.listenerCount('respawn'), 0);
});
