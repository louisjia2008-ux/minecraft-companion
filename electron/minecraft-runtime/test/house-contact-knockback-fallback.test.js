'use strict';
// Production contact-fallback closure, original installed Physics actor.
// Attack ACK/target removal is MODELED, not native Java kill acceptance.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const filename=path.join(__dirname,'house-surface-graph.test.js'),native=new Module(filename,module),fixtureSource=fs.readFileSync(filename,'utf8');native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(fixtureSource.slice(0,fixtureSource.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};',filename);
const source=fs.readFileSync(path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),'utf8'),start=source.indexOf('            try{await respond();}'),end=source.indexOf('            const perceivedNextRanged=',start),closure=source.slice(start,end);
for(const mode of ['contact','far','pause','low_recent','low_unrelated','low_stale'])test(`production contact navigation limit keeps bounded stationary retaliation ${mode}`,async t=>{
 const f=native.exports.fixture(t),bot=f.bot,target={id:7,name:'zombie',isValid:true,height:1.95,width:.6,position:new Vec3(mode==='far'?10.5:mode.startsWith('low_')?4.5:2.5,1,.5)};bot.entities[7]=target;
 const error=Object.assign(Error('modeled native knockback exceeded approach bound'),{code:mode.startsWith('low_')?'mining_low_health':'house_surface_ranged_limit'}),events=[];let active=mode!=='pause';
 const deps={bot,closeThreat:target,interrupt:{deadline:Date.now()+2000,shieldRaised:false},combatMemory:{lastOwnAttackAt:mode==='low_stale'?Date.now()-3000:mode.startsWith('low_')?Date.now():0,lastOwnAttackTargetId:mode==='low_unrelated'?99:7},
  respond:async()=>{throw error;},assertInterruptActive:()=>{if(!active)throw Object.assign(Error('paused'),{code:'paused'});},
  meleeReachDistance:require('../vendor/server/minecraft/combatGeometry').meleeReachDistance,
  meleeAttackReadyAt:()=>0,getObservedEntityHealth:()=>null,
  safeBotLookAt:async()=>{},physicalAttack:async e=>{assert.equal(active,true);events.push(e.id);e.isValid=false;},
  recordTaskDiagnostic:()=>{},runBotWritableAction:async(_type,_facts,fn)=>fn(),sleep:ms=>new Promise(r=>setTimeout(()=>{if(mode==='low_recent')target.position.x=2.5;r();},ms))};
 const run=Function(...Object.keys(deps),`return async()=>{${closure}};`)(...Object.values(deps));
 if(['far','low_unrelated','low_stale'].includes(mode))await assert.rejects(run(),e=>e===error);
 else if(mode==='pause')await assert.rejects(run(),{code:'paused'});
 else await run();
 assert.deepEqual(events,['contact','low_recent'].includes(mode)?[7]:[]);assert.deepEqual(bot.entity.position,new Vec3(.5,1,.5));
});
