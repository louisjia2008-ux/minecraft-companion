'use strict';
// Production consume closures + installed native inventory/health plugins.
// Physical preemption and server ACKs are explicitly MODELED, not Java proof.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const filename=path.join(__dirname,'house-resource-gatherer-progress-retry.test.js'),m=new Module(filename,module),fsource=fs.readFileSync(filename,'utf8');m.filename=filename;m.paths=Module._nodeModulePaths(__dirname);m._compile(fsource.slice(0,fsource.indexOf('\ntest('))+'\nmodule.exports={fixture};',filename);
const source=fs.readFileSync(path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),'utf8'),start=source.indexOf('  function physicalConsume('),end=source.indexOf('  function stopBotActions(',start),closure=source.slice(start,end);
for(const mode of ['same_owner','replacement_owner','revoked_while_waiting'])test(`native eating settlement prevents overlapping retry ${mode}`,async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1800000000000});t.after(()=>t.mock.timers.reset());
 const f=m.exports.fixture({name:'rotten_flesh'}),bot=f.bot;require('mineflayer/lib/plugins/health')(bot,{respawn:false});f.slot(1,'rotten_flesh');
 f.client.emit('update_health',{health:12,food:16,foodSaturation:0});const calls=[];f.client.write=(type,data)=>{if(type==='use_item')calls.push({type,data});};
 const task={executionGeneration:1},token={},context={task},foodConsumptionFlights=new WeakMap();let lease={},actions=0,leaseActive=true;
 const deps={foodConsumptionFlights,ensureBotReady:()=>bot,currentBot:bot,currentTask:task,getExecutionContext:()=>context,getActiveCancellationToken:()=>token,getCurrentMovementLease:()=>lease,
 checkTaskSignal:()=>{},ensureMovementLeaseActive:()=>{if(!leaseActive)throw Object.assign(Error('movement_preempted'),{code:'movement_preempted'});},isBotConnectionWritable:()=>true,createAbortError:code=>Object.assign(Error(code),{code}),
 findInventoryItem:names=>bot.inventory.items().find(i=>names.includes(i.name)),equipInventoryItem:async()=>{},sleep:ms=>new Promise(r=>setTimeout(r,ms)),DEFAULT_EQUIP_TIMEOUT_MS:6000,
 runBotWritableAction:async(_type,_meta,fn)=>fn(),runPhysicalAction:(_kind,_primitive,operation)=>{const pending=Promise.resolve().then(()=>operation(()=>{}));if(++actions===1)return Promise.race([pending,new Promise((_,r)=>setTimeout(()=>r(Object.assign(Error('modeled defense preemption'),{code:'movement_preempted'})),20))]);return pending;}};
 const consume=Function(...Object.keys(deps),`${closure};return physicalConsume;`)(...Object.values(deps));
 const advance=async ms=>{for(let x=0;x<ms;x+=10){t.mock.timers.tick(10);for(let k=0;k<30;k++)await Promise.resolve();}};
 let firstError;consume('rotten_flesh','rotten_flesh').catch(e=>{firstError=e;});await advance(150);assert.equal(firstError?.code,'movement_preempted');assert.equal(calls.length,1);
 if(mode==='replacement_owner')lease={};
 let secondError,completed=false;Promise.resolve().then(()=>consume('rotten_flesh','rotten_flesh')).then(()=>{completed=true;},e=>{secondError=e;});await advance(200);
 if(mode==='replacement_owner'){assert.equal(secondError?.code,'food_consumption_busy');assert.equal(calls.length,1);}
 else {assert.equal(secondError,undefined);assert.equal(completed,false);assert.equal(calls.length,1,'old native eating task must settle before another use_item');}
 if(mode==='revoked_while_waiting')leaseActive=false;
 // Native inventory settles its old task from a MODELED server use-status ACK.
 f.client.emit('entity_status',{entityId:bot.entity.id,entityStatus:9});await advance(150);
 if(mode==='revoked_while_waiting'){assert.equal(secondError?.code,'movement_preempted');assert.equal(calls.length,1);}
 if(mode==='same_owner'){
  assert.equal(calls.length,2);f.slot(0,'rotten_flesh');f.client.emit('update_health',{health:12,food:20,foodSaturation:0});f.client.emit('entity_status',{entityId:bot.entity.id,entityStatus:9});await advance(100);
  assert.equal(secondError,undefined);assert.equal(completed,true);assert.equal(bot.food,20);
 }
 await advance(4500);
});

for(const mode of ['late_slot','missing_slot','revoked'])test(`native meal waits for actual slot reduction ${mode}`,async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1800000000000});t.after(()=>t.mock.timers.reset());
 const f=m.exports.fixture({name:'rabbit'}),bot=f.bot;require('mineflayer/lib/plugins/health')(bot,{respawn:false});f.slot(1,'rabbit');f.client.emit('update_health',{health:12,food:16,foodSaturation:0});let calls=0,active=true;
 f.client.write=type=>{if(type==='use_item')calls++;};const task={executionGeneration:1},token={},lease={},context={task};
 const deps={foodConsumptionFlights:new WeakMap(),ensureBotReady:()=>bot,currentBot:bot,currentTask:task,getExecutionContext:()=>context,getActiveCancellationToken:()=>token,getCurrentMovementLease:()=>lease,
 checkTaskSignal:()=>{if(!active)throw Object.assign(Error('paused'),{code:'paused'});},ensureMovementLeaseActive:()=>{},isBotConnectionWritable:()=>true,createAbortError:code=>Object.assign(Error(code),{code}),
 findInventoryItem:names=>bot.inventory.items().find(i=>names.includes(i.name)),equipInventoryItem:async()=>{},sleep:ms=>new Promise(r=>setTimeout(r,ms)),DEFAULT_EQUIP_TIMEOUT_MS:6000,
 runBotWritableAction:async(_t,_m,fn)=>fn(),runPhysicalAction:(_k,_p,op)=>op(()=>{})};
 const consume=Function(...Object.keys(deps),`${closure};return physicalConsume;`)(...Object.values(deps));
 const advance=async ms=>{for(let x=0;x<ms;x+=10){t.mock.timers.tick(10);for(let k=0;k<30;k++)await Promise.resolve();}};
 let done=false,error;consume('rabbit','rabbit').then(()=>{done=true;},e=>{error=e;});await advance(150);assert.equal(calls,1);
 f.client.emit('entity_status',{entityId:bot.entity.id,entityStatus:9});f.client.emit('update_health',{health:12,food:19,foodSaturation:1.8});await advance(100);
 assert.equal(done,false,'food packet alone must not release stale remaining food');assert.equal(error,undefined);
 if(mode==='revoked')active=false;
 if(mode!=='missing_slot')f.slot(0,'rabbit');await advance(mode==='missing_slot'?4100:100);
 if(mode==='late_slot'){assert.equal(done,true);assert.equal(error,undefined);assert.equal(bot.inventory.items().some(i=>i.name==='rabbit'),false);}
 else {assert.equal(done,false);assert.ok(error);if(mode==='revoked')assert.equal(error.code,'paused');}
 assert.equal(calls,1);
});
