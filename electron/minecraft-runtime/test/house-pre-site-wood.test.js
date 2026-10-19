'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const {prepareHousePreSiteWood}=require('../vendor/server/minecraft/housePreSiteWood');
function fixture(mode,before=0){let count=before,owner=true,bot={_client:{},entity:{position:new Vec3(4.5,72,-3.5)}},current=bot;const saved=[],calls=[];
 return {bot,calls,saved,deps:{getBot:()=>current,countLogs:()=>count,assertActive:()=>{if(!owner)throw Object.assign(Error('paused'),{code:'paused'});},save:r=>saved.push(JSON.parse(JSON.stringify(r))),
  gather:async amount=>{calls.push(amount);if(mode!=='no_pickup')count+=amount;if(mode==='paused')owner=false;if(mode==='foreign')current={};if(mode==='client')bot._client={};}}};}
for(const before of [0,2,3,8,12])test(`pre-site startup counts only actual carried logs and never requires spawn return: before=${before}`,async()=>{
 const f=fixture('pickup',before),r=await prepareHousePreSiteWood(f.deps);assert.equal(r.confirmed,true);assert.equal(r.confirmedCount,Math.max(3,before));assert.equal(r.requiredReturnToSpawn,false);assert.deepEqual(r.actual,{x:4.5,y:72,z:-3.5});assert.deepEqual(f.calls,before<3?[3-before]:[]);assert.equal(f.saved.at(-1).confirmed,true);
});
for(const [mode,code]of [['no_pickup','house_startup_wood_unconfirmed'],['paused','paused'],['foreign','house_startup_wood_owner_changed'],['client','house_startup_wood_owner_changed']])test(`startup cannot claim ready or move into site selection after ${mode}`,async()=>{
 const f=fixture(mode);await assert.rejects(prepareHousePreSiteWood(f.deps),{code});assert.equal(f.saved.some(r=>r.confirmed),false);
});
