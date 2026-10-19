/* global require */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { createFurnishedHouseBlueprint } = require('../vendor/server/minecraft/furnishedHouseBlueprints');
const { inspectNaturalHouseSite } = require('../vendor/server/minecraft/naturalHouseSites');
const key = p => `${p.x},${p.y},${p.z}`;
function terrain(anchor, surfaceName) {
  const edits = new Map(); let reads = 0;
  const blockAt = p => {
    reads++;
    const edit = edits.get(key(p));
    if (edit === null) return null;
    const name = edit || (p.y === anchor.y - 1 ? surfaceName : p.y < anchor.y - 1 ? 'stone' : 'air');
    return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position: new Vec3(p.x,p.y,p.z) });
  };
  return { edits, blockAt, reads: () => reads };
}
// Pure, loaded native block-shape fixtures. These do not establish live
// gravity settlement, native clearing or full construction on any world.
const origins = [{x: -1303,y: 71,z: 2047},{x: 371,y: 126,z: -1009},{x: -17,y: 19,z: -33}];
for (const surfaceName of ['red_sand', 'snow_block']) {
  for (const anchor of origins) {
    test(`loaded ${surfaceName} terrain at ${key(anchor)} keeps the original complete cottage contract`, () => {
      const f = terrain(anchor,surfaceName);
      const result = inspectNaturalHouseSite({anchor,blockAt:f.blockAt});
      assert.equal(result.valid,true); assert.deepEqual(result.anchor,anchor);
      assert.equal(result.nativePlacements,274); assert.equal(result.floorSupportCells,66);
      assert.equal(result.scaffoldBaseCells,19); assert.equal(result.foundationCount,0);
      assert.equal(f.edits.size,0); assert.ok(f.reads()<10000);
    });
  }
}
test('pale oak leaves use the same natural clearing permission as other leaves without becoming floor support', () => {
  const anchor=origins[0],f=terrain(anchor,'grass_block'),p={...anchor,x:anchor.x+2,y:anchor.y+2,z:anchor.z+2};
  f.edits.set(key(p),'pale_oak_leaves');
  const result=inspectNaturalHouseSite({anchor,blockAt:f.blockAt});
  assert.equal(result.valid,true);assert.ok(result.removals.some(q=>key(q)===key(p)));
  const floor={...p,y:anchor.y-1};f.edits.set(key(floor),'pale_oak_leaves');
  assert.equal(inspectNaturalHouseSite({anchor,blockAt:f.blockAt}).valid,false);
  assert.equal(f.edits.get(key(p)),'pale_oak_leaves');
});
test('red sand high cap, powder snow, lava, foreign containers and unknown body still deny', () => {
  const anchor=origins[1],blueprint=createFurnishedHouseBlueprint(anchor,{profile:'cottage'});
  for (const [name,position,reason] of [
    ['red_sand',{x:anchor.x+2,y:blueprint.bounds.maxY+1,z:anchor.z+2},'gravity_above_clearance'],
    ['powder_snow',{x:anchor.x+2,y:anchor.y,z:anchor.z+2},'unsafe_clearance'],
    ['lava',{x:anchor.x+2,y:anchor.y,z:anchor.z+2},'unsafe_clearance'],
    ['chest',{x:anchor.x+2,y:anchor.y,z:anchor.z+2},'foreign_site_block'],
    [null,{x:anchor.x+2,y:anchor.y,z:anchor.z+2},'unsafe_clearance'],
  ]) {
    const f=terrain(anchor,'grass_block');f.edits.set(key(position),name);
    const result=inspectNaturalHouseSite({anchor,blockAt:f.blockAt});
    assert.equal(result.valid,false);assert.equal(result.reason,reason);assert.equal(f.edits.get(key(position)),name);
  }
});
test('a thin snow layer cannot substitute the full-height natural floor at any translated origin', () => {
  for(const anchor of origins){const f=terrain(anchor,'snow');assert.equal(inspectNaturalHouseSite({anchor,blockAt:f.blockAt}).valid,false);assert.equal(f.edits.size,0);}
});
