'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {meleeReachDistance}=require('../vendor/server/minecraft/combatGeometry');
const p={position:{x:0,y:68,z:0},eyeHeight:1.62};
test('a jumping or wide spider is judged by actual eye-to-hitbox reach, never just foot separation',()=>{
 assert.ok(meleeReachDistance(p,{position:{x:3.2,y:69,z:0},width:1.4,height:.9})<3);
 assert.ok(meleeReachDistance(p,{position:{x:4,y:68,z:0},width:1.4,height:.9})>3);
 assert.ok(meleeReachDistance(p,{position:{x:0,y:75,z:0},width:1.4,height:.9})>3);
});
test('unknown and malformed entity geometry cannot grant reach',()=>{
 assert.equal(meleeReachDistance(p,{position:{x:NaN,y:68,z:0}}),Infinity);
 assert.equal(meleeReachDistance(p,{position:{x:4,y:68,z:0},width:100}),Infinity);
});

test('contact and main defense share the actual sent packet clock and weapon cooldown',()=>{
 const {meleeAttackReadyAt}=require('../vendor/server/minecraft/combatGeometry');
 assert.equal(meleeAttackReadyAt(1000,'stone_sword'),1650);
 assert.equal(meleeAttackReadyAt(1000,'stone_axe'),2100);
 assert.equal(meleeAttackReadyAt(1000,null),1260);
 assert.equal(meleeAttackReadyAt(1000,'dirt'),1260);
});

test('knockback target retention expires and never masks immediate contact or an out-of-range old target',()=>{
 const {retainMeleeTargetAfterKnockback:retain}=require('../vendor/server/minecraft/combatGeometry');
 const target={id:2,position:{x:4,y:68,z:0},width:.6,height:1.8};
 const rival={id:3,position:{x:-2.4,y:68,z:0},width:.6,height:1.8};
 const memory={lastOwnAttackTargetId:2,lastOwnAttackAt:1000};
 assert.equal(retain(p,target,rival,memory,1600),true);
 assert.equal(retain(p,target,rival,memory,2000),false);
 assert.equal(retain(p,target,{...rival,position:{x:-1,y:68,z:0}},memory,1600),false);
 assert.equal(retain(p,{...target,position:{x:5,y:68,z:0}},rival,memory,1600),false);
 assert.equal(retain(p,target,rival,{...memory,lastOwnAttackTargetId:3},1600),false);
});
