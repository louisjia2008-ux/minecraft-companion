'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),registry=require('prismarine-registry')('1.21.8');
const {isHostileMobEntity,isThreateningMobEntity}=require('../vendor/server/minecraft/entitySemantics');
test('nearby neutral enderman family remains distinguishable from an actual provoked threat',()=>{
 const e={name:'enderman',type:'hostile',metadata:[]},keys=registry.entitiesByName.enderman.metadataKeys;
 assert.equal(isHostileMobEntity(e,registry),true);assert.equal(isThreateningMobEntity(e,registry),false);
 for(const name of ['creepy','stared_at']){e.metadata[keys.indexOf(name)]=true;assert.equal(isThreateningMobEntity(e,registry),true);e.metadata[keys.indexOf(name)]=false;assert.equal(isThreateningMobEntity(e,registry),false);}
 assert.equal(isThreateningMobEntity({name:'zombie',type:'hostile'},registry),true);
 assert.equal(isThreateningMobEntity({name:'cow',type:'animal'},registry),false);
});

test('installed registry mob type still identifies phantom and other hostile categories',()=>{
 assert.equal(registry.entitiesByName.phantom.type,'mob');
 assert.equal(isThreateningMobEntity({name:'phantom',type:'mob'},registry),true);
 assert.equal(isThreateningMobEntity({name:'bogged',type:'mob'},registry),true);
 assert.equal(isThreateningMobEntity({name:'cow',type:'mob'},registry),false);
});

const {recordObservedSelfAggressor,isObservedSelfAggressor}=require('../vendor/server/minecraft/entitySemantics');
test('only the same native self-hurt source can promote a neutral mob, not its cub, player, projectile or stale connection',()=>{
 const self={id:1,name:'player'},bear={id:497,name:'polar_bear',type:'mob'},cub={id:498,name:'polar_bear',type:'mob'};
 const bot={entity:self,entities:{497:bear,498:cub},_client:{},registry};
 assert.equal(isThreateningMobEntity(bear,registry),false);assert.equal(isThreateningMobEntity(cub,registry),false);
 assert.equal(recordObservedSelfAggressor(bot,cub,bear),false);
 assert.equal(recordObservedSelfAggressor(bot,self,{...bear}),false);
 assert.equal(recordObservedSelfAggressor(bot,self,bear),true);
 assert.equal(isThreateningMobEntity(bear,registry),true);assert.equal(isHostileMobEntity(bear,registry),false);
 assert.equal(isThreateningMobEntity(cub,registry),false);
 for(const source of [{id:3,name:'player',type:'player'},{id:4,name:'arrow',type:'other'}]){
  bot.entities[source.id]=source;assert.equal(recordObservedSelfAggressor(bot,self,source),false);
 }
 bot._client={};assert.equal(isObservedSelfAggressor(bear),false);assert.equal(isThreateningMobEntity(bear,registry),false);
});

test('a native aggressor proof expires without another self-damage event and cannot transfer to a reused entity ID',t=>{
 t.mock.timers.enable({apis:['Date'],now:1000});
 const self={id:1},bear={id:497,name:'polar_bear',type:'animal'},bot={entity:self,entities:{497:bear},_client:{},registry};
 assert.equal(recordObservedSelfAggressor(bot,self,bear),true);assert.equal(isObservedSelfAggressor(bear),true);
 t.mock.timers.tick(15000);assert.equal(isObservedSelfAggressor(bear),false);
 assert.equal(recordObservedSelfAggressor(bot,self,bear),true);
 bot.entities[497]={...bear};assert.equal(isObservedSelfAggressor(bear),false);assert.equal(isObservedSelfAggressor(bot.entities[497]),false);
});
