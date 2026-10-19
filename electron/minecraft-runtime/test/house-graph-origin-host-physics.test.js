'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const filename=path.join(__dirname,'mining-combat-coordination.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);
native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf("\ntest('a grounded self-supply camp"))+'\nmodule.exports={fixture};\n',filename);
for(const excluded of [false,true])test(`production graph origin aligns a native supported edge through its shared bounds guard: excluded=${excluded}`,{timeout:5000},async t=>{
 const f=native.exports.fixture(t,{interrupt:false,startPosition:{x:.1,y:1,z:.5},worldAt:p=>Object.assign(Block.fromStateId(registry.blocksByName[p.y<=0&&p.x<0?'stone':'air'].defaultState),{position:p})});
 f.task.intent='build_furnished_house';f.task.materialSupply={materialSource:'self_gathered'};
 const bounds=excluded?[{minX:-2,maxX:0,minY:1,maxY:1,minZ:-1,maxZ:1}]:[];
 const run=f.agent.__testAlignHouseResourceGraphOrigin(Date.now()+2000,bounds);
 if(excluded){await assert.rejects(run,{code:'house_graph_origin_unconfirmed'});assert.equal(f.attempts.length,0);return;}
 await run;assert.equal(f.bot.entity.position.floored().x,-1);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.inventory.items()[0].name,'stone_sword');
 assert.ok(f.attempts.length>0);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});
