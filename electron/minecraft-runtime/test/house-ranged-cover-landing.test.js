'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const {seekHouseRangedCover}=require('../vendor/server/minecraft/houseRangedCover');
for(const paused of [false,true])test(`covered airborne actor must actually land before the old task regains control: paused=${paused}`,{timeout:3000},async t=>{
 const f=native.exports.fixture(t,{initialPosition:new Vec3(.5,1.42,.5),initialVelocity:new Vec3(0,-.155,0),worldAt:p=>p.y<1||p.x===4&&p.y<=4&&Math.abs(p.z)<=2?'stone':'air'});
 f.bot.entity.onGround=false;f.bot.entities[2]={id:2,name:'skeleton',isValid:true,height:1.99,position:new Vec3(8.5,1,.5)};
 let checks=0;const promise=seekHouseRangedCover({getBot:()=>f.bot,assertActive:()=>{if(paused&&++checks>1)throw Object.assign(Error('paused'),{code:'paused'});},goto:()=>{throw Error('no extra goal while landing');}},{deadline:Date.now()+1000});
 if(paused)await assert.rejects(promise,{code:'paused'});
 else{const result=await promise;assert.equal(result.covered,true);assert.equal(result.actualGrounded,true);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.position.y,1);assert.ok(f.points.length>0);}
 assert.equal(f.attempts.length,0);
});
