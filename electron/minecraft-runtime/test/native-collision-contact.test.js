'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const AABB=require('prismarine-physics/lib/aabb');
const {installNativeCollisionCompatibility}=require('../vendor/server/minecraft/nativeCollisionCompatibility');
test('world58 decimal boundary cannot bypass a contacting solid block',()=>{
 const ice=new AABB(-105,62,31,-104,63,32),body=new AABB(-104.8,62.47344756075968,32.3-.3,-104.2,64.27344756075968,32.3+.3);
 assert.ok(body.minZ<32&&32-body.minZ<1e-12);assert.equal(ice.computeOffsetZ(body,-.014),-.014);assert.equal(ice.intersects(body),true);
 assert.equal(installNativeCollisionCompatibility('1.21.7'),false);assert.equal(installNativeCollisionCompatibility('1.21.8'),true);
 assert.equal(ice.computeOffsetZ(body,-.014),0);assert.equal(ice.intersects(body),false);
 // Query correction never changes the actual actor bounds or block geometry.
 assert.equal(body.minZ,32.3-.3);assert.equal(ice.maxZ,32);
 assert.equal(installNativeCollisionCompatibility('1.21.8'),true);
});
test('real solid overlap, clearance, and normal approach clipping retain native semantics',()=>{
 installNativeCollisionCompatibility('1.21.8');const solid=new AABB(0,0,0,1,1,1);
 assert.equal(solid.intersects(new AABB(.999,0,0,2,1,1)),true);
 assert.equal(solid.intersects(new AABB(1.001,0,0,2,1,1)),false);
 assert.equal(solid.computeOffsetX(new AABB(1.1,0,0,2,1,1),-.2),-0.10000000000000009);
 assert.equal(solid.computeOffsetX(new AABB(1.1,2,0,2,3,1),-.2),-.2);
 assert.equal(solid.computeOffsetY(new AABB(0,1-1e-14,0,1,2,1),-.1),0);
});
