'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const saved=require('../test-support/fixtures/world58-ice-shore.json'),raw=require('node:zlib').gunzipSync(Buffer.from(saved.statesGzipBase64,'base64')),cells=new Uint16Array(raw.buffer,raw.byteOffset,raw.byteLength/2),b=saved.bounds;
const filename=path.join(__dirname,'house-emergency-shore-native.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);
native._compile(source.slice(0,source.indexOf('\nfor(const threat')).replace('},5);','},20);').replace('new Vec3(-63.5,62.2,20.5)',`new Vec3(${saved.start.x},${saved.start.y},${saved.start.z})`)+'\nmodule.exports={fixture};\n',filename);
const {escapeEmergencyShore}=require('../vendor/server/minecraft/houseEmergencyShore');
test('saved world58 ice-lip swimmer floats through native physics before actual bank arrival',{timeout:16000},async t=>{
 require('../vendor/server/minecraft/nativeCollisionCompatibility').installNativeCollisionCompatibility('1.21.8');
 const f=native.exports.fixture(t);f.bot.entity.isInWater=false;
 f.bot.blockAt=q=>{const p=q.floored();if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;
  const index=(p.x-b.minX)*(b.maxZ-b.minZ+1)*(b.maxY-b.minY+1)+(p.z-b.minZ)*(b.maxY-b.minY+1)+p.y-b.minY,v=saved.palette[cells[index]];
  return Object.assign(Block.fromProperties(registry.blocksByName[v.name].id,v.properties),{position:p});};
 const ticks=[];f.bot.on('physicsTick',()=>{if(ticks.length<30)ticks.push({p:f.bot.entity.position.clone(),v:f.bot.entity.velocity.clone(),c:{...f.bot.controlState},w:f.bot.entity.isInWater});});
 try{assert.equal(await escapeEmergencyShore(f.deps),true);}catch(e){t.diagnostic(JSON.stringify({ticks,records:f.records,plans:f.plans.slice(0,5),position:f.bot.entity.position}));throw e;}
 assert.ok(f.records.some(r=>r.kind==='house_emergency_shore_floated'));assert.ok(f.records.some(r=>r.kind==='house_emergency_shore_confirmed'));assert.equal(f.bot.entity.onGround,true);
 assert.equal(f.bot.pathfinder.movements,f.previous);assert.equal(f.bot.controlState.jump,false);
});
