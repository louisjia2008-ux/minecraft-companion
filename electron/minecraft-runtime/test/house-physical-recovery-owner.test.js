'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{goals}=require('mineflayer-pathfinder');
const filename=path.join(__dirname,'mining-combat-coordination.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf("\ntest('a grounded self-supply camp"))+'\nmodule.exports={fixture};\n',filename);
test('a stale path recovery cannot stop a newer operation; detached current recovery retains captured no-dig profile',{timeout:5000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false});f.task.intent='build_furnished_house';f.task.materialSupply={materialSource:'self_gathered'};let stops=0;f.bot.stopDigging=()=>{stops++;};
 await f.agent.__testWithHouseResourceWork(async()=>{
  const profile=f.bot.pathfinder.movements,old=f.agent.__testCreatePhysicalAction('move','old_path'),current=f.agent.__testCreatePhysicalAction('act','current_dig');
  assert.equal(profile.canDig,false);assert.equal(await f.agent.__testRecoverPhysicalAction(old),false);assert.equal(stops,0);assert.equal(f.bot.pathfinder.movements,profile);
  assert.equal(await f.agent.__testRecoverPhysicalAction(current),true);assert.ok(stops>0);assert.equal(f.bot.pathfinder.movements,profile);assert.equal(profile.canDig,false);
  await f.agent.__testHouseSurfacePathfinderGoto(new goals.GoalBlock(3,1,0),2000);assert.equal(f.bot.entity.position.floored().x,3);assert.equal(f.bot.entity.onGround,true);
 });
 const defaults=f.bot.pathfinder.movements;assert.equal(defaults.canDig,false);assert.deepEqual(defaults.scafoldingBlocks,[]);assert.ok(defaults.blocksCantBreak.has(f.bot.registry.blocksByName.ice.id));assert.ok(defaults.blocksCantBreak.has(f.bot.registry.blocksByName.frosted_ice.id));
});
