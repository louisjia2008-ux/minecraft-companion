'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const filename=path.join(__dirname,'mining-combat-coordination.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);
native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf("\ntest('a grounded self-supply camp"))+'\nmodule.exports={fixture};\n',filename);
const spec={id:'modeled-prior-native-placement',item:'dirt',position:{x:48,y:1,z:0}};
// This fixture tests a real48m owned approach, not exhaustive exploration of
// an infinitely loaded plane. Outside this loaded strip remains UNKNOWN.
const inLoadedStrip=p=>p.x>=-2&&p.x<=52&&p.z>=-3&&p.z<=3;
const cleanupWorld=p=>!inLoadedStrip(p)?null:Object.assign(Block.fromStateId(registry.blocksByName[p.y<=0?'stone':p.x===48&&p.y===1&&p.z===0?'dirt':'air'].defaultState),{position:p});
test('cleanup fixture preserves its48m native route and cover while outside columns stay unknown',()=>{
 const {Vec3}=require('vec3');
 for(let x=0;x<=48;x++)assert.equal(cleanupWorld(new Vec3(x,0,0)).stateId,registry.blocksByName.stone.defaultState);
 assert.equal(cleanupWorld(new Vec3(48,1,0)).stateId,registry.blocksByName.dirt.defaultState);
 for(const [x,z] of [[-2,-3],[-2,3],[52,-3],[52,3]])assert.equal(cleanupWorld(new Vec3(x,1,z)).name,'air');
 for(const [x,z] of [[-3,0],[53,0],[0,-4],[0,4],[48,-4],[48,4]])assert.equal(cleanupWorld(new Vec3(x,1,z)),null);
});

function setup(t){const f=native.exports.fixture(t,{interrupt:false,worldAt:cleanupWorld});
 let leftLoadedStrip=false;f.bot.on('physicsTick',()=>{if(!inLoadedStrip(f.bot.entity.position.floored()))leftLoadedStrip=true;});
 f.leftLoadedStrip=()=>leftLoadedStrip;
 f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';f.task.materialSupply={materialSource:'self_gathered',defensiveCoverBlocks:[spec]};return f;}
test('owned far combat cover gets a fresh native approach after respawn without receiving removal or old-route credit',{timeout:12000},async t=>{
 const f=setup(t);const arrived=await f.agent.__testWithHouseResourceWork(()=>f.agent.__testApproachOwnedCombatCover(spec,Date.now()+10000));
 assert.equal(f.leftLoadedStrip(),false);assert.ok(f.attempts.length>0);assert.ok(f.attempts.every(inLoadedStrip));
 assert.equal(arrived,true);assert.ok(f.bot.entity.position.distanceTo(new(require('vec3').Vec3)(48,1,0))<5);
 assert.ok(f.task.materialSupply.combatCleanupFreshApproach.graph.visits>1);assert.equal(f.task.materialSupply.defensiveCoverBlocks.length,1);
 assert.equal(f.bot.blockAt(new(require('vec3').Vec3)(48,1,0)).name,'dirt');assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});
for(const mode of ['foreign','deadline','pause'])test(`far cleanup approach cannot create movement from ${mode}`,async t=>{
 const f=setup(t);if(mode==='pause')f.task.cancellationToken.pause();
 await assert.rejects(f.agent.__testWithHouseResourceWork(()=>f.agent.__testApproachOwnedCombatCover(mode==='foreign'?{...spec,item:'cobblestone'}:spec,Date.now()+(mode==='deadline'?-1:1000))));
 assert.equal(f.attempts.length,0);assert.equal(f.task.materialSupply.combatCleanupFreshApproach,undefined);
});
