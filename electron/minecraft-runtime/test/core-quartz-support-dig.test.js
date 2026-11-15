'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { digBlock } = require('../core/actions');
function fixture(below, walkOnly = true) {
  let dug = false;
  const block = { name: 'nether_quartz_ore', position: new Vec3(0, 69, 0), boundingBox: 'block' };
  const bot = { entity: { position: new Vec3(0.5, 70, 0.5), onGround: true },
    pathfinder: { movements: { companionWalkOnly: walkOnly } },
    blockAt(p) {
      if (p.equals(block.position)) return dug ? { ...block, name: 'air', boundingBox: 'empty' } : block;
      if (p.equals(new Vec3(0, 68, 0))) return below && { name: below, boundingBox: below === 'air' || below === 'lava' ? 'empty' : 'block' };
      return { name: 'air', boundingBox: 'empty' };
    }, canDigBlock: () => true, dig: async () => { dug = true; }, stopDigging() {} };
  return { bot, block, wasDug: () => dug };
}
for (const below of ['air', 'lava', 'magma_block', null]) test(`quartz support excavation refuses ${below || 'unknown'} beneath its own floor`, async () => {
  const f = fixture(below);
  assert.equal((await digBlock(f.bot, {}, f.block)).reason, 'unsafe_support_dig');
  assert.equal(f.wasDug(), false);
});
test('one block down onto fresh safe stone remains a legal quartz floor excavation', async () => {
  const f = fixture('basalt');
  assert.equal((await digBlock(f.bot, {}, f.block)).ok, true);
  assert.equal(f.wasDug(), true);
});
test('quartz scope does not restrict an unrelated nearby ore block', async () => {
  const f = fixture('air'); f.bot.entity.position = new Vec3(1.5, 70, 0.5);
  assert.equal((await digBlock(f.bot, {}, f.block)).ok, true);
});
test('ordinary overworld mine descent preserves its existing contract', async () => {
  const f = fixture('air', false);
  assert.equal((await digBlock(f.bot, {}, f.block)).ok, true);
});
