'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { setupChunks, expectedOreCells, validateResponse, runSetup } = require('../tools/scenario-setup.cjs');
const { runOnce, mulberry32 } = require('../tools/run-scenarios.cjs');
const { SCENARIOS } = require('../scenarios/index.cjs');
const { createOutputBuffer } = require('../scenarios/serverOutput.cjs');

test('setup preloads every iron fixture chunk including the original unloaded eastern veins', () => {
  const scenario = SCENARIOS['branch-mine-iron-flat'];
  const setup = scenario.setup({ username: 'Test', run: 0, rng: mulberry32(101), difficulty: 'peaceful' });
  const chunks = setupChunks(setup.commands);
  const cells = expectedOreCells(setup.commands, scenario.serverProperties);
  assert.equal(setup.commands.filter((c) => /iron_ore$/.test(c)).length, 40);
  assert.ok(cells.length > 280, `expected complete veins, got ${cells.length} cells`);
  assert.ok(cells.some((p) => p.x > 96));
  for (const p of cells) assert.ok(chunks.some((c) => c.x === Math.floor(p.x / 16) && c.z === Math.floor(p.z / 16)));
});

test('final fixture map preserves ore overlap, replace filters and later overwrites', () => {
  const properties = { 'generator-settings': JSON.stringify({ layers: [{ block: 'minecraft:deepslate', height: 128 }] }) };
  const cells = expectedOreCells(['fill 0 0 0 1 0 1 deepslate_redstone_ore replace deepslate',
    'fill 0 0 0 1 0 1 deepslate_diamond_ore replace deepslate', 'setblock 1 0 1 lava'], properties);
  assert.equal(cells.length, 3); assert.ok(cells.every((p) => p.block === 'deepslate_redstone_ore'));
});

test('setup refuses explicit errors, unknown feedback and missing targets even with a list barrier', () => {
  assert.doesNotThrow(() => validateResponse('advancement revoke Test only minecraft_companion:fishing_catch',
    "Couldn't revoke advancement minecraft_companion:fishing_catch from Test as they don't have it"));
  for (const response of ['That position is not loaded\nThere are 1 players online',
    'Unknown or incomplete command', 'Too many blocks in the specified area', 'There are 1 players online']) {
    assert.throws(() => validateResponse('fill 0 0 0 1 1 1 iron_ore', response));
  }
  assert.throws(() => validateResponse('tp Test 0 64 0', 'No entity was found'));
  for (const response of ['Successfully filled 8 block(s)', 'No blocks were filled']) {
    assert.doesNotThrow(() => validateResponse('fill 0 0 0 1 1 1 iron_ore', response));
  }
  assert.doesNotThrow(() => validateResponse('kill @e[type=item]', 'No entity was found'));
});

function fakeServer({ unloaded = false, corruptOre = false } = {}) {
  const commands = [];
  return { commands,
    async execute(command) {
      commands.push(command);
      if (command.includes('forceload')) return 'Marked chunk [0, 0] to be force loaded';
      if (command.startsWith('gamemode')) return 'There are 1 players online';
      return unloaded ? 'That position is not loaded' : 'Successfully filled 8 block(s)';
    },
    async query(command, pattern) {
      commands.push(command);
      return (command.includes('playerGameType') ? 'Test has the following entity data: 0'
        : command.includes('if block') && corruptOre ? 'Test failed' : 'Test passed').match(pattern);
    } };
}

test('checked setup retains every response and independently rejects corrupt ore readback', async () => {
  const setup = { commands: ['gamemode survival Test', 'fill 0 0 0 1 1 1 iron_ore'] };
  const events = []; const server = fakeServer();
  const result = await runSetup({ server, setup, properties: {}, write: (type, data) => events.push({ type, ...data }) });
  assert.equal(result.distribution.iron_ore, 8);
  assert.equal(events.filter((e) => e.type === 'setup_command').length, 2);
  assert.ok(server.commands[0].includes('forceload add'));
  await assert.rejects(runSetup({ server: fakeServer({ unloaded: true }), setup, properties: {} }), /setup_command_failed/);
  await assert.rejects(runSetup({ server: fakeServer({ corruptOre: true }), setup, properties: {} }), /setup_ore_readback_failed/);
});

test('server absolute output offsets remain usable when a long run truncates its log buffer', () => {
  const output = createOutputBuffer({ limit: 100, retained: 40 });
  output.append('old Test failed\n' + 'x'.repeat(70));
  const start = output.offset();
  output.append('y'.repeat(30) + '\nTest passed\n');
  assert.ok(output.offset() > 100);
  assert.match(output.textFrom(start), /Test passed/);
  assert.doesNotMatch(output.textFrom(start), /Test failed/);
  const next = output.offset(); output.append('Test failed\n');
  assert.equal(output.textFrom(next), 'Test failed\n');
});

test('setup failure closes its JSONL and removes packet listeners without starting a companion', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-setup-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = new EventEmitter();
  const result = await runOnce({ scenario: { setup: () => ({ commands: ['fill 0 0 0 1 1 1 iron_ore'] }), serverProperties: {} },
    server: fakeServer({ unloaded: true }), bot: { _client: client }, username: 'Test', run: 0, seed: 1,
    difficulty: 'peaceful', runDir: dir, lifecycle: 'fresh', traceInventory: false });
  assert.equal(result.pass, false); assert.match(result.reason, /setup_command_failed/);
  assert.equal(client.eventNames().length, 0);
  assert.ok(fs.readFileSync(path.join(dir, 'run-01.jsonl'), 'utf8').includes('"type":"setup"'));
});

function runtimeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bot = new EventEmitter();
  Object.assign(bot, { _client: new EventEmitter(), waitForChunksToLoad: async () => {},
    health: 20, inventory: { items: () => [], slots: [] } });
  const input = { bot, runDir: dir, username: 'Test', run: 0, seed: 1, difficulty: 'peaceful',
    lifecycle: 'fresh', traceInventory: false, settleMs: 0, hookIntervalMs: 5,
    server: { execute: async () => {}, query: async () => [] } };
  return { dir, bot, input };
}

test('timeout joins an in-flight hook before disposing or verifying and exposes the aborted signal', async (t) => {
  const { input } = runtimeFixture(t); const order = [];
  const result = await runOnce({ ...input, companionFactory: () => ({ dispose: async () => order.push('dispose') }),
    scenario: { setup: () => ({ commands: [] }), timeoutMs: 20, start: async () => ({}),
      async onTick({ signal }) { order.push('hook_start'); await sleep(40); assert.equal(signal.aborted, true); order.push('hook_end'); },
      async verify() { order.push('verify'); return { pass: true }; } } });
  assert.deepEqual(order, ['hook_start', 'hook_end', 'dispose', 'verify']);
  assert.equal(result.pass, false); assert.equal(result.timedOut, true); assert.equal(result.serverPass, true);
});

test('cleanup continues after dispose errors and emits the final failing result after all cleanup', async (t) => {
  const { input, dir, bot } = runtimeFixture(t); let released = false;
  const result = await runOnce({ ...input, companionFactory: () => ({ async dispose() { throw new Error('dispose failed'); } }),
    scenario: { setup: () => ({ commands: [] }), timeoutMs: 5, start: async () => ({}),
      dispose: () => { released = true; }, verify: async () => ({ pass: true }) } });
  assert.equal(result.pass, false); assert.equal(released, true);
  assert.ok(result.harnessFailures.some((s) => s.includes('cleanup:dispose failed')));
  const events = fs.readFileSync(path.join(dir, 'run-01.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'result'); assert.equal(events.at(-1).pass, false);
  assert.equal(bot.listenerCount('death'), 0);
});

test('an error path waits for pending inventory readback before closing its event file', async (t) => {
  const { input, dir } = runtimeFixture(t);
  input.server.query = async () => { await sleep(30); return ['has the following entity data: []']; };
  let emit;
  const result = await runOnce({ ...input, traceInventory: true,
    companionFactory: ({ onEvent }) => { emit = onEvent; return { dispose: async () => {} }; },
    scenario: { setup: () => ({ commands: [] }), start: async () => { emit({ type: 'diagnostic', reason: 'missing_ingredients' }); throw new Error('start failed'); } } });
  assert.equal(result.pass, false);
  const events = fs.readFileSync(path.join(dir, 'run-01.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.find((event) => event.type === 'server_inventory'));
  assert.equal(events.at(-1).type, 'result');
});
