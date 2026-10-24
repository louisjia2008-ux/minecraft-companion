'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { digBlock } = require('../core/actions');
const { gatherOne } = require('../core/skills');

test('all goals refuse direct digging of a confirmed home block', async () => {
  let reads = 0;
  const block = { name: 'cobblestone', position: new Vec3(0, 0, 0) };
  const bot = { companionProtectBlock: (b) => b === block, blockAt() { reads += 1; } };
  assert.deepEqual(await digBlock(bot, {}, block), { ok: false, reason: 'protected_home' });
  assert.equal(reads, 0);
});

test('material gathering excludes protected home blocks before choosing a target', async () => {
  const position = new Vec3(1, 1, 1);
  const bot = { entity: { position: new Vec3(0, 1, 0) }, registry: { blocksByName: { cobblestone: { name: 'cobblestone', id: 1 } } },
    findBlocks: () => [position], blockAt: () => ({ name: 'cobblestone', position }),
    companionProtectBlock: () => true };
  const result = await gatherOne(bot, {}, { blocks: (n) => n === 'cobblestone', dropMatch: () => true,
    blacklist: { has: () => false } });
  assert.deepEqual(result, { ok: false, reason: 'no_target_in_range' });
});
