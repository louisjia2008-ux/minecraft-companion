'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { recentre } = require('../core/actions');

function fixture() {
  const controls = []; const controller = new AbortController();
  const bot = { entity: { position: new Vec3(.75, 70, .5), onGround: true },
    blockAt: (p) => ({ position: p.floored(), name: 'basalt', boundingBox: 'block' }),
    controlState: { sneak: true }, companionSneaking: true,
    setControlState: (name, value) => controls.push({ name, value }), lookAt: async () => {} };
  return { bot, controls, controller, ctx: { signal: controller.signal } };
}

test('recentre does not start a new control pulse after cancellation during native look', async () => {
  const f = fixture(); let entered; let release;
  const started = new Promise((r) => { entered = r; });
  f.bot.lookAt = () => { entered(); return new Promise((r) => { release = r; }); };
  const task = recentre(f.bot, f.ctx);
  await started; f.controller.abort(); release();
  await assert.rejects(task, { code: 'aborted' });
  assert.equal(f.controls.some((c) => c.name === 'forward' && c.value), false);
  assert.deepEqual(f.controls.at(-2), { name: 'forward', value: false });
  assert.deepEqual(f.controls.at(-1), { name: 'sneak', value: true });
});

test('quartz alignment admission is re-read after native look before any forward pulse', async () => {
  const f = fixture(); let safe = true; let reads = 0;
  f.bot.lookAt = async () => { safe = false; };
  await recentre(f.bot, f.ctx, { accept: () => { reads += 1; return safe; } });
  assert.ok(reads >= 2);
  assert.equal(f.controls.some((c) => c.name === 'forward' && c.value), false);
});

test('a quartz alignment refusal changes no pose and issues no controls', async () => {
  const f = fixture(); const before = f.bot.entity.position.clone();
  await recentre(f.bot, f.ctx, { accept: () => false });
  assert.deepEqual(f.bot.entity.position, before);
  assert.deepEqual(f.controls, []);
});
