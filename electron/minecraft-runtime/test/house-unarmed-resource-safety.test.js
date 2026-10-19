'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3'),registry=require('prismarine-registry')('1.21.8');
const {unarmedResourceTargetSafe}=require('../vendor/server/minecraft/houseUnarmedResourceSafety');
for(const [name,radius]of [['creeper',17],['zombie',12],['stray',24],['skeleton',24]])test(`unarmed work target stays outside observed ${name} envelope`,()=>{
 const enemy={id:2,name,isValid:true,position:new Vec3(.5,64,.5),metadata:[]},bot={registry,entities:{2:enemy},entity:{id:1,position:new Vec3(-2,64,.5)}};
 assert.equal(unarmedResourceTargetSafe(bot,{x:radius-1,y:67,z:0}),false);assert.equal(unarmedResourceTargetSafe(bot,{x:radius,y:67,z:0}),true);
 enemy.isValid=false;assert.equal(unarmedResourceTargetSafe(bot,{x:1,y:67,z:0}),true);enemy.isValid=true;
 enemy.metadata[registry.entitiesByName[name].metadataKeys.indexOf('health')]=0;assert.equal(unarmedResourceTargetSafe(bot,{x:1,y:67,z:0}),true);
});
