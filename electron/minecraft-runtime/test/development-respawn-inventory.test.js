'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),registry=require('prismarine-registry')('1.21.8'),Item=require('prismarine-item')(registry);
const {createDevelopmentRespawnInventory}=require('../vendor/server/minecraft/developmentRespawnInventory');
function nativeBot(){
 const client=new EventEmitter(),writes=[];client.write=(name,data)=>writes.push({name,data});
 const bot=Object.assign(new EventEmitter(),{version:'1.21.8',registry,_client:client,QUICK_BAR_START:36,entity:{id:1,position:new Vec3(.5,64,.5),yaw:0,pitch:0,equipment:Array(6).fill(null)},game:{gameMode:'survival'},supportFeature:n=>registry.supportFeature(n),lookAt:async()=>{},swingArm:()=>{}});
 require('mineflayer/lib/plugins/inventory')(bot,{hideErrors:true});require('mineflayer/lib/plugins/health')(bot,{respawn:true});bot.quickBarSlot=0;
 return {bot,client,writes};
}
test('native death/respawn can retain ghost window0; private runner reconnects once without assigning inventory or world state',()=>{
 const first=nativeBot();let bot=first.bot,task={taskId:'house'},reconnects=0;const records=[];
 const boundary=createDevelopmentRespawnInventory({getBot:()=>bot,getTask:()=>task,canReconnect:()=>true,reconnect:b=>{assert.equal(b,bot);reconnects++;},record:(kind,facts)=>records.push({kind,facts})});
 boundary.attach(bot);boundary.beforeClaim('task','house');
 first.client.emit('update_health',{health:20,food:20,foodSaturation:5});
 first.client.emit('set_slot',{windowId:0,slot:36,stateId:1,item:Item.toNotch(new Item(registry.itemsByName.stone_sword.id,1))});
 first.client.emit('update_health',{health:0,food:16,foodSaturation:0});
 assert.ok(first.writes.some(p=>p.name==='client_command'));
 first.client.emit('respawn',{});first.client.emit('update_health',{health:20,food:20,foodSaturation:5});
 assert.equal(bot.inventory.items()[0].name,'stone_sword','Installed client still has pre-death cache without fresh window_items');
 assert.throws(()=>boundary.beforeClaim('task','house:development-survival'),{code:'house_respawn_inventory_unconfirmed'});
 assert.equal(reconnects,1);assert.equal(bot.inventory.items()[0].name,'stone_sword','Boundary must not forge inventory ACKs or edit slots');
 assert.throws(()=>boundary.beforeClaim('task','house:development-survival'),{code:'house_respawn_inventory_unconfirmed'});assert.equal(reconnects,1);
 const next=nativeBot();bot=next.bot;boundary.attach(bot);next.client.emit('update_health',{health:20,food:20,foodSaturation:5});
 assert.doesNotThrow(()=>boundary.beforeClaim('task','house:development-survival'));assert.deepEqual(bot.inventory.items(),[]);assert.equal(reconnects,1);boundary.detach();
 assert.ok(records.some(e=>e.kind==='development_death_inventory_unconfirmed'));
});
test('unrelated gameplay and foreign manual control cannot be disconnected by the private compatibility boundary',()=>{
 const f=nativeBot();let reconnects=0;const task={taskId:'house'};
 const boundary=createDevelopmentRespawnInventory({getBot:()=>f.bot,getTask:()=>task,canReconnect:()=>false,reconnect:()=>{reconnects++;}});
 boundary.attach(f.bot);f.client.emit('update_health',{health:20,food:20,foodSaturation:5});f.client.emit('update_health',{health:0,food:16,foodSaturation:0});f.client.emit('update_health',{health:20,food:20,foodSaturation:5});
 boundary.beforeClaim('manual','human');assert.equal(reconnects,0);
 boundary.beforeClaim('task','house:development-survival');f.bot.emit('death');
 assert.throws(()=>boundary.beforeClaim('task','house:development-survival'),{code:'house_respawn_inventory_unconfirmed'});assert.equal(reconnects,0);boundary.detach();
});
