'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {spawnSync}=require('node:child_process');
const {Vec3}=require('vec3'),registry=require('prismarine-registry')('1.21.8');
const windows=require('prismarine-windows')('1.21.8');
const {withNativeWindowActivation}=require('../vendor/server/minecraft/nativeWindowActivation');
function nativeBot(){
 const client=new EventEmitter(),writes=[];
 const bot=Object.assign(new EventEmitter(),{version:'1.21.8',registry,_client:client,QUICK_BAR_START:36,entity:{id:1,position:new Vec3(.5,64,.5),yaw:0,pitch:0,equipment:Array(6).fill(null)},game:{gameMode:'survival'},supportFeature:n=>registry.supportFeature(n),lookAt:async()=>{},swingArm:()=>{}});
 client.write=(name,data)=>writes.push({name,data});
 require('mineflayer/lib/plugins/inventory')(bot,{hideErrors:true});require('mineflayer/lib/plugins/furnace')(bot);require('mineflayer/lib/plugins/chest')(bot);require('mineflayer/lib/plugins/craft')(bot);bot.quickBarSlot=0;
 const block=require('prismarine-block')(registry).fromStateId(registry.blocksByName.furnace.defaultState);block.position=new Vec3(1,64,0);return {bot,client,writes,block};
}
test('installed native openBlock drops its activation rejection and terminates an unprotected Node process',()=>{
 const script=`const {EventEmitter}=require('node:events'),{Vec3}=require('vec3'),registry=require('prismarine-registry')('1.21.8');${nativeBot.toString()};const f=nativeBot();f.client.write=()=>{throw Object.assign(Error('movement_preempted'),{code:'movement_preempted'})};f.bot.openFurnace(f.block).catch(()=>{});`;
 const result=spawnSync(process.execPath,['-e',script],{cwd:process.cwd(),encoding:'utf8',timeout:5000});
 assert.equal(result.status,1);assert.match(result.stderr,/movement_preempted/);
});
for(const kind of ['container','furnace'])test(`native ${kind} activation failure rejects its owner promptly with no late window listener or packet`,async()=>{
 const f=nativeBot(),original=f.bot.activateBlock;if(kind==='container'){f.block=require('prismarine-block')(registry).fromStateId(registry.blocksByName.chest.defaultState);f.block.position=new Vec3(1,64,0);}const foreign=()=>{};f.bot.on('windowOpen',foreign);
 const error=Object.assign(Error('movement_preempted'),{code:'movement_preempted'});f.client.write=()=>{throw error;};
 await assert.rejects(withNativeWindowActivation(f.bot,()=>kind==='furnace'?f.bot.openFurnace(f.block):f.bot.openContainer(f.block)),e=>e===error);
 assert.equal(f.bot.activateBlock,original);assert.deepEqual(f.bot.listeners('windowOpen'),[foreign]);assert.equal(f.writes.length,0);
});
test('successful native furnace retains original window extension and sends exactly one activation',async()=>{
 const f=nativeBot(),original=f.bot.activateBlock;
 f.client.write=(name,data)=>{f.writes.push({name,data});if(name==='block_place')queueMicrotask(()=>f.bot.emit('windowOpen',windows.createWindow(1,'minecraft:furnace','Furnace',3)));};
 const opened=await withNativeWindowActivation(f.bot,()=>f.bot.openFurnace(f.block));
 assert.equal(opened.type,'minecraft:furnace');assert.equal(typeof opened.putInput,'function');assert.equal(typeof opened.close,'function');
 assert.equal(f.writes.filter(w=>w.name==='block_place').length,1);assert.equal(f.bot.activateBlock,original);
});


test('native workbench crafting also propagates its discarded activation rejection before any inventory mutation',async()=>{
 const f=nativeBot(),original=f.bot.activateBlock,error=Object.assign(Error('movement_preempted'),{code:'movement_preempted'});
 f.client.write=()=>{throw error;};
 const recipe=require('prismarine-recipe')(registry).Recipe.find(registry.itemsByName.stone_pickaxe.id,null)[0];
 await assert.rejects(withNativeWindowActivation(f.bot,()=>f.bot.craft(recipe,1,f.block)),e=>e===error);
 assert.equal(f.bot.activateBlock,original);assert.equal(f.bot.listenerCount('windowOpen'),0);assert.equal(f.writes.length,0);
});
