'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const filename=path.join(__dirname,'house-creeper-escape.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\ntest('))+'\nmodule.exports={fixture};\n',filename);
const {createHouseCreeperEscape}=require('../vendor/server/minecraft/houseCreeperEscape');
test('native dry corridor retreats from close creeper while staying outside farther creeper safe boundary',{timeout:6000},async t=>{
 require('../vendor/server/minecraft/nativeCollisionCompatibility').installNativeCollisionCompatibility('1.21.8');
 const f=native.exports.fixture(t,{threatPosition:new Vec3(3.5,1,.5),physicsMs:20});
 const far={id:77,name:'creeper',isValid:true,position:new Vec3(-12.5,1,8.5)};f.bot.entities[77]=far;
 f.bot.blockAt=q=>{const p=q.floored();if(Math.abs(p.x)>16||Math.abs(p.z)>16||p.y< -10||p.y>10)return null;
  const name=p.y<0?'stone':p.y===0?(p.z===0&&p.x<=1?'stone':'water'):'air';
  return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:p});};
 const before=f.bot.entity.position.distanceTo(far.position),samples=[];
 f.bot.on('physicsTick',()=>samples.push(f.bot.entity.position.distanceTo(far.position)));
 const result=await createHouseCreeperEscape(f.deps,{emergencyRetreat:true}).escape();
 assert.equal(result.confirmed,true);assert.ok(result.finalDistance>=8.5);assert.ok(result.traveled<=12);assert.equal(f.bot.entity.onGround,true);
 assert.ok(Math.min(...samples)>=8.75-.075);assert.ok(Math.min(...samples)<before-1);assert.equal(f.bot.pathfinder.movements,f.profile);
 t.diagnostic(JSON.stringify({beforeFar:before,closestFar:Math.min(...samples),actual:f.bot.entity.position,primaryDistance:result.finalDistance}));
});
