'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createPortalTrip } = require('../core/netherTrip');
const nether = require('../core/nether');

test('a frame begun by an earlier goal is finished by the next one, not left for a new site', async () => {
  const base = new Vec3(-24, 70, -4);
  const frame = nether.portalFrame(base, 'z');
  // Six obsidian already placed; the corners stand on stone.
  const placed = new Set(frame.cells.filter((c) => !c.corner).slice(0, 6).map((c) => c.pos.toString()));
  const corners = new Set(frame.cells.filter((c) => c.corner).map((c) => c.pos.toString()));
  const bot = {
    entity: { position: base.offset(1, 0, 1) }, game: { dimension: 'overworld' },
    registry: { blocksByName: {} }, findBlocks: () => [],
    blockAt: (p) => {
      const key = new Vec3(p.x, p.y, p.z).floored().toString();
      if (placed.has(key)) return { name: 'obsidian', boundingBox: 'block' };
      if (corners.has(key)) return { name: 'stone', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
  };
  const first = createPortalTrip({ bot, memory: {} });
  first.memory.site = { base, axis: 'z' };
  bot.companionPortalSite = first.memory.site;
  // Asked again: a new goal, a new memory, four obsidian left in the bag.
  const again = createPortalTrip({ bot, memory: {} });
  const ctx = { record() {}, signal: new AbortController().signal };
  const result = await again.toNether(ctx, { inventory: { obsidian: 4 } });
  assert.equal(result.reason, 'missing_flint_and_steel');
  assert.equal(again.memory.site.base, base);
  assert.equal(again.framePlaced(), 6 + corners.size);
});
