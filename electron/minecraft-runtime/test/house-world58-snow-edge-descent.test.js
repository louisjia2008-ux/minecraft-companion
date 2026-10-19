'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const terrain=require('../test-support/fixtures/formal58-run99-supported-snow-edge.json'),{inspectNativeStaleGroundDescent}=require('../vendor/server/minecraft/houseCreeperEscape');
for(const hazard of [null,'water','lava','air'])test(`world58 run100 native snowy descending stride with landing=${hazard||'saved ground'}`,t=>{
 const f=native.exports.fixture(t,{initialPosition:new Vec3(-183.31497854544736,68,66.49952284081485),initialVelocity:new Vec3(-.13959994073632065,-.0784000015258789,4.259347735101142e-18),worldAt:p=>{
  if(hazard&&p.y===66&&p.x<=-184)return hazard;
  const id=terrain.states[`${p.x},${p.y},${p.z}`];return id===undefined?null:terrain.palette[id];
 }});
 // Initial saved pose/velocity only; this helper observes original Physics on
 // a separate PlayerState and never applies predictions to the real actor.
 f.bot.entity.yaw=Math.PI/2;f.bot.controlState.forward=true;f.bot.controlState.sprint=true;
 const before=f.bot.entity.position.clone(),velocity=f.bot.entity.velocity.clone(),controls={...f.bot.controlState};
 const facts=inspectNativeStaleGroundDescent(f.bot,{tick:17,lastGrounded:{position:{x:-183.05930099831124,y:68,z:66.49952284081485},tick:16,contacts:[{position:{x:-183,y:67,z:66},name:'grass_block',stateId:8,top:68}]}});
 assert.equal(facts.accepted,hazard===null);assert.equal(facts.predictionApplied,false);assert.equal(facts.actualGrounded,false);assert.deepEqual(f.bot.entity.position,before);assert.deepEqual(f.bot.entity.velocity,velocity);assert.deepEqual(f.bot.controlState,controls);
 if(!hazard){assert.equal(facts.predictions.at(-1).onGround,true);assert.equal(facts.predictions.at(-1).position.y,67);assert.ok(facts.predictions.at(-1).position.x< -184.3);}
});

for(const hazard of [null,'water','lava','air'])test(`world131 actual descending support above single snow layer: ${hazard||'saved terrain'}`,async t=>{
 const terrain=require('../test-support/fixtures/formal58-run131-native-descent.json');
 const f=native.exports.fixture(t,{initialPosition:new Vec3(-176.3368710383208,69,51.50000000000046),initialVelocity:new Vec3(-.15301981882312268,-.0784000015258789,6.800287095889572e-15),worldAt:p=>{
  if(hazard&&p.x<=-177&&p.y===67)return hazard;
  const id=terrain.states[`${p.x},${p.y},${p.z}`];return id===undefined?null:terrain.palette[id];
 }});
 f.bot.entity.yaw=Math.PI/2;f.bot.controlState.forward=true;f.bot.controlState.sprint=true;
 const facts=inspectNativeStaleGroundDescent(f.bot,{observeStoppedInput:true,tick:12,lastGrounded:{position:{x:-176.05661495989017,y:69,z:51.50000000000045},tick:11,contacts:[{position:{x:-176,y:68,z:51},name:'grass_block',stateId:8,top:69}]}});
 assert.equal(facts.accepted,hazard===null);assert.equal(facts.predictionApplied,false);
 if(!hazard){
  assert.equal(facts.brakeRequired,true);assert.equal(f.bot.controlState.forward,true);
  f.bot.clearControlStates();const until=Date.now()+1000;
  while(Date.now()<until&&!(f.bot.entity.onGround&&f.bot.entity.position.y===68))await new Promise(r=>setTimeout(r,5));
  assert.equal(f.bot.entity.position.y,68);assert.equal(f.bot.entity.onGround,true);
  assert.ok(f.bot.entity.position.x>-177.3);assert.equal(f.bot.entity.isInWater,false);
 }
});
for(const hazard of [null,'water','lava','UNKNOWN'])test(`world146 native descending stride onto ice over contained water: ${hazard||'saved ice'}`,t=>{
 const terrain=require('../test-support/fixtures/formal58-run146-ice-descent.json');
 const f=native.exports.fixture(t,{initialPosition:new Vec3(-142.46984852498926,64,46.500267013670786),initialVelocity:new Vec3(.15310921189636462,-.0784000015258789,-2.0400861287668715e-14),worldAt:p=>{
  if(hazard&&p.x>=-143&&p.y===62)return hazard==='UNKNOWN'?null:hazard;
  const i=terrain.states[`${p.x},${p.y},${p.z}`];return i===undefined?null:terrain.palette[i];
 }});f.bot.entity.yaw=-Math.PI/2;f.bot.controlState.forward=true;f.bot.controlState.sprint=true;
 const before=f.bot.entity.position.clone(),facts=inspectNativeStaleGroundDescent(f.bot,{tick:13,lastGrounded:{position:{x:-142.75026832699726,y:64,z:46.50026701367082},tick:12,contacts:[{position:{x:-144,y:63,z:46},name:'sand',stateId:118,top:64}]}});
 assert.equal(facts.accepted,!hazard);assert.equal(facts.predictionApplied,false);assert.deepEqual(f.bot.entity.position,before);if(!hazard)assert.equal(facts.predictions.at(-1).position.y,63);
});
