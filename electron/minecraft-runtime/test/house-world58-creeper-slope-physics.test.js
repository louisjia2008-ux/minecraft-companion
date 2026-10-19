'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry),saved=require('../test-support/fixtures/world58-creeper-slope.json');
const buf=require('node:zlib').gunzipSync(Buffer.from(saved.statesGzipBase64,'base64')),cells=new Uint16Array(buf.buffer,buf.byteOffset,buf.byteLength/2),b=saved.bounds;
const filename=path.join(__dirname,'house-creeper-escape.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);
native._compile(source.slice(0,source.indexOf('\ntest('))+'\nmodule.exports={fixture};\n',filename);
const {createHouseCreeperEscape}=require('../vendor/server/minecraft/houseCreeperEscape');
test('saved world58 consecutive snowy descents settle the first floor before the next native retreat leg',{timeout:9000},async t=>{
 require('../vendor/server/minecraft/nativeCollisionCompatibility').installNativeCollisionCompatibility('1.21.8');
 const f=native.exports.fixture(t,{initialPosition:new Vec3(saved.start.x,saved.start.y,saved.start.z),threatPosition:new Vec3(-172.4893626972774,66,96.98563572666566),physicsMs:20});
 for(const [id,x,y,z] of [[226,-171.0543833046083,66,93.05930847000847],[260,-171.47693414887755,66,93.818968998226],[420,-182.0379048599837,66,84.49113334510733]])f.bot.entities[id]={id,name:'zombie',isValid:true,position:new Vec3(x,y,z)};
 f.bot.blockAt=q=>{const p=q.floored();if(p.x< -177||p.x> -175||p.z<98||p.z>108)return null;if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;
  const i=(p.x-b.minX)*(b.maxZ-b.minZ+1)*(b.maxY-b.minY+1)+(p.z-b.minZ)*(b.maxY-b.minY+1)+p.y-b.minY,v=saved.palette[cells[i]];
  return Object.assign(Block.fromProperties(registry.blocksByName[v.name].id,v.properties),{position:p});};
 let threatTicks=0;
 f.bot.prependListener('physicsTick',()=>{const n=Math.min(1,++threatTicks/20);
  f.creeper.position.x=-172.4893626972774+n*(-173.0809154316524+172.4893626972774);
  f.creeper.position.z=96.98563572666566+n*(98.01468846104066-96.98563572666566);
 });
 // Saved cell values and actor pose are exact; residency is explicitly
 // restricted to the recorded descent corridor. Threat interpolation is modeled.
 // Original packet/control catch-up timing is not reproduced. The prior
 // implementation can pass offline; this checks the new first-step boundary.
 // All actor motion and native path proposals use installed physics/pathfinder.
 try{const result=await createHouseCreeperEscape(f.deps).escape();assert.equal(result.confirmed,true);assert.ok(result.finalDistance>=8.5);assert.ok(result.traveled<=12);}
 catch(e){t.diagnostic(JSON.stringify({records:f.records.slice(-8),attempts:f.attempts.map(a=>({x:a.goal.x,y:a.goal.y,z:a.goal.z})),actual:f.bot.entity.position}));throw e;}
 assert.ok(f.records.some(e=>e.kind==='creeper_escape_descent_boundary'),JSON.stringify(f.records));assert.equal(Math.floor(f.bot.entity.position.y),65);t.diagnostic(JSON.stringify({actual:f.bot.entity.position,targets:f.attempts.map(a=>({x:a.goal.x,y:a.goal.y,z:a.goal.z}))}));assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.pathfinder.movements,f.profile);
});
