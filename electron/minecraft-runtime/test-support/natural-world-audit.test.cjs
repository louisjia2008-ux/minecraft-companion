/* global Buffer, __dirname */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');
const nbt = require('prismarine-nbt');
const { longToBigInt, blockLocation, decodeSectionBlock, readAnvilBlock, classifyLavaChanges,
  automaticDescentEvidence, frozenSourceEvidence, requestedTargetEvidence, observedLava } = require('./natural-world-audit.cjs');
const { createHeuristicPlanner } = require('../vendor/server/minecraft/commandPlanner');
const { createMinecraftActionRegistry } = require('../vendor/server/action/actionRegistry');

function pair(value) {
  const word = BigInt.asUintN(64, value);
  return [Number(BigInt.asIntN(32, word >> 32n)), Number(BigInt.asIntN(32, word & 0xffffffffn))];
}
function section(size, bits) {
  return { Y: -4, block_states: { palette: Array.from({ length: size }, (_, index) => ({ Name: `test:block_${index}` })),
    data: Array.from({ length: Math.ceil(4096 / Math.floor(64 / bits)) }, () => [0, 0]) } };
}

test('NBT signed 64-bit words preserve exact seed and negative storage words', () => {
  assert.equal(longToBigInt([-1833979199, 1364512627]), -7876880679884763277n);
  assert.equal(longToBigInt([-1, -1]), -1n);
  assert.equal(longToBigInt([-2147483648, 0]), -(1n << 63n));
  assert.equal(longToBigInt([2147483647, -1]), (1n << 63n) - 1n);
  assert.throws(() => longToBigInt(9007199254740992), /imprecise/);
});

test('negative chunk, region, section and local coordinates use floor, not truncation', () => {
  assert.deepEqual(blockLocation({ x: -1, y: -49, z: -513 }), { chunkX: -1, chunkZ: -33,
    regionX: -1, regionZ: -2, regionIndex: 1023, sectionY: -4, localX: 15, localY: 15, localZ: 15 });
  assert.equal(blockLocation({ x: -512, y: -64, z: 0 }).regionIndex, 0);
  assert.throws(() => blockLocation({ x: 0, y: -65, z: 0 }), /height/);
  assert.throws(() => blockLocation({ x: 0.5, y: 0, z: 0 }), /exact integer/);
});

test('five-bit disk palettes pad each word and decode the last negative-Y cell', () => {
  const data = section(17, 5);
  // Twelve five-bit values fit each word. The remaining top four bits are
  // padding and deliberately set, so a continuous bitstream decoder fails.
  data.block_states.data[0] = pair((15n << 60n) | (16n << 55n));
  data.block_states.data[1] = pair(3n | (7n << 5n));
  data.block_states.data[341] = pair(16n << 15n); // 4095 = 341*12 + 3
  assert.equal(decodeSectionBlock(data, { x: 11, y: -64, z: 0 }).name, 'test:block_16');
  assert.equal(decodeSectionBlock(data, { x: 12, y: -64, z: 0 }).name, 'test:block_3');
  assert.equal(decodeSectionBlock(data, { x: 13, y: -64, z: 0 }).name, 'test:block_7');
  assert.equal(decodeSectionBlock(data, { x: -1, y: -49, z: -1 }).name, 'test:block_16');
});

test('four-bit signed words and six/seven-bit padded word boundaries decode', () => {
  const four = section(16, 4);
  four.block_states.data[255] = pair(15n << 60n);
  assert.equal(decodeSectionBlock(four, { x: -1, y: -49, z: -1 }).name, 'test:block_15');
  const six = section(33, 6);
  six.block_states.data[1] = pair(32n);
  assert.equal(decodeSectionBlock(six, { x: 10, y: -64, z: 0 }).name, 'test:block_32');
  const seven = section(65, 7);
  seven.block_states.data[1] = pair(64n);
  assert.equal(decodeSectionBlock(seven, { x: 9, y: -64, z: 0 }).name, 'test:block_64');
});

test('singleton/absent air sections and corrupt multi-entry storage are distinct', () => {
  assert.equal(decodeSectionBlock({ Y: -4, block_states: { palette: [{ Name: 'minecraft:lava', Properties: { level: '0' } }] } },
    { x: 0, y: -64, z: 0 }).name, 'minecraft:lava');
  assert.equal(decodeSectionBlock({ Y: -4 }, { x: 0, y: -64, z: 0 }).defaultAir, true);
  const invalid = section(17, 5);
  invalid.block_states.data[0] = pair(31n);
  assert.throws(() => decodeSectionBlock(invalid, { x: 0, y: -64, z: 0 }), /out of bounds/);
  invalid.block_states.data.pop();
  assert.throws(() => decodeSectionBlock(invalid, { x: 0, y: -64, z: 0 }), /data length/);
});

function writeFixture(directory, compression, external = false, chunkX = -1) {
  const value = { DataVersion: nbt.int(4440), Status: nbt.string('minecraft:full'), xPos: nbt.int(chunkX), zPos: nbt.int(-33),
    LastUpdate: nbt.long([0, 1234]), sections: nbt.list(nbt.comp([{ Y: nbt.byte(-4),
      block_states: nbt.comp({ palette: nbt.list(nbt.comp([{ Name: nbt.string('minecraft:deepslate_diamond_ore') }])) }) }])) };
  const payload = nbt.writeUncompressed(nbt.comp(value));
  const compressed = compression === 1 ? zlib.gzipSync(payload) : compression === 2 ? zlib.deflateSync(payload) : payload;
  const region = Buffer.alloc(12288);
  region.writeUInt32BE((2 << 8) | 1, 1023 * 4);
  region.writeUInt32BE(12345, 4096 + 1023 * 4);
  region.writeUInt32BE(external ? 1 : compressed.length + 1, 8192);
  region[8196] = compression | (external ? 0x80 : 0);
  if (!external) compressed.copy(region, 8197);
  fs.mkdirSync(path.join(directory, 'region'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'region', 'r.-1.-2.mca'), region);
  if (external) fs.writeFileSync(path.join(directory, 'region', 'c.-1.-33.mcc'), compressed);
}

test('Anvil header + real NBT parser reads negative coordinates with gzip/zlib/raw and external chunks', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-anvil-audit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const compression of [1, 2, 3]) {
    writeFixture(directory, compression);
    const block = await readAnvilBlock(directory, { x: -1, y: -49, z: -513 });
    assert.equal(block.name, 'minecraft:deepslate_diamond_ore');
    assert.equal(block.sectionY, -4);
    assert.equal(block.regionTimestamp, 12345);
    assert.equal(block.lastUpdate, '1234');
  }
  writeFixture(directory, 2, true);
  assert.equal((await readAnvilBlock(directory, { x: -1, y: -49, z: -513 })).name, 'minecraft:deepslate_diamond_ore');
});

test('missing chunks, unsupported compression and wrong chunk addresses fail without guessing air', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-anvil-audit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeFixture(directory, 2);
  await assert.rejects(readAnvilBlock(directory, { x: -17, y: -49, z: -513 }), /not present/);
  writeFixture(directory, 4);
  await assert.rejects(readAnvilBlock(directory, { x: -1, y: -49, z: -513 }), /Unsupported Anvil compression/);
  writeFixture(directory, 2, false, -2);
  await assert.rejects(readAnvilBlock(directory, { x: -1, y: -49, z: -513 }), /chunk X/);
});

test('natural lava transformations are retained separately from real same-cell dig/place actions', () => {
  const position = { x: 168, y: -55, z: 77 };
  const events = [{ type: 'snapshot', elapsedMs: 1000, position: { x: 109, y: 64, z: 163 } },
    { type: 'block_update', elapsedMs: 1001, position, from: 'lava', to: 'obsidian' }];
  let changes = classifyLavaChanges(events);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].classification, 'remote_environment_change_no_agent_dig_correlation');
  assert.equal(changes[0].matchingDigs.length, 0);
  changes = classifyLavaChanges([...events, { type: 'digging_completed', elapsedMs: 1002, position }]);
  assert.equal(changes[0].classification, 'completed_agent_action_correlated');
  changes = classifyLavaChanges([...events, { type: 'block_placed', elapsedMs: 1002, position }]);
  assert.equal(changes[0].matchingPlacements.length, 1);
  changes = classifyLavaChanges([...events, { type: 'digging_completed', elapsedMs: 7002, position }]);
  assert.equal(changes[0].matchingDigs.length, 0);
});

test('automatic descent independently needs initial base, connected route, deep snapshots and real digs', () => {
  const base = { x: 0, y: 64, z: 0 };
  const route = Array.from({ length: 10 }, (_, index) => ({ x: index, y: 64 - index, z: 0 }));
  const result = { base, criteria: { actualAutomaticDescent: true }, task: { diamondExpedition: { navigation: { breadcrumbs: route } } } };
  const start = { elapsedMs: 10 };
  const end = { elapsedMs: 1000 };
  const observations = [{ type: 'snapshot', elapsedMs: 11, position: base, checkpoint: { base } },
    { type: 'snapshot', elapsedMs: 500, position: { x: 8.5, y: 56, z: 0.5 }, checkpoint: { base } },
    { type: 'digging_completed', elapsedMs: 600, position: { x: 9, y: 56, z: 0 }, playerPosition: { x: 8.5, y: 56, z: 0.5 } }];
  assert.equal(automaticDescentEvidence(result, observations, start, end).confirmed, true);
  assert.equal(automaticDescentEvidence(result, observations.slice(0, 1), start, end).confirmed, false);
  assert.equal(automaticDescentEvidence(result, observations.slice(0, 2), start, end).confirmed, false);
  result.task.diamondExpedition.navigation.breadcrumbs = [base, route[9]];
  assert.equal(automaticDescentEvidence(result, observations, start, end).confirmed, false);
});

test('freeze claims require all six critical valid hashes and match immutable run_started evidence', () => {
  const started = { sourceHashes: {} };
  const result = { sourceHashes: { started: { 'runtime.js': 'a'.repeat(64) }, ended: { 'runtime.js': 'a'.repeat(64) } } };
  started.sourceHashes = { ...result.sourceHashes.started };
  assert.equal(frozenSourceEvidence(result, started).confirmed, false);
  const required = frozenSourceEvidence(result, started).requiredKeys;
  assert.ok(required.includes('vendor/server/minecraftTaskAgent.js'), 'The physical task engine is minecraftTaskAgent.js');
  result.sourceHashes.started = Object.fromEntries(required.map((key) => [key, 'a'.repeat(64)]));
  result.sourceHashes.ended = { ...result.sourceHashes.started };
  started.sourceHashes = { ...result.sourceHashes.started };
  assert.equal(frozenSourceEvidence(result, started).confirmed, true);
  started.sourceHashes['runtime.js'] = 'b'.repeat(64);
  assert.equal(frozenSourceEvidence(result, started).confirmed, false);
});

function lavaFixture() {
  const start = { x: 0, y: 64, z: 0 };
  const level = { x: 1, y: 64, z: 0 };
  const down = { x: 2, y: 63, z: 0 };
  const hazard = { type: 'hazard_observation', elapsedMs: 1000, reason: '目标方块相邻 lava，不能开挖',
    playerPosition: { x: 0.5, y: 64, z: 0.5 }, heading: 0, searchSteps: 10,
    nearbyLava: [{ x: 0, y: 62, z: 0 }], navigation: { routeIndex: 0, routeLength: 1,
      currentRoutePosition: start, lastRoutePositions: [start] } };
  const after = { type: 'snapshot', elapsedMs: 71_000, position: { x: 2.5, y: 63, z: 0.5 },
    checkpoint: { phase: 'descend_diamond', heading: 0, searchSteps: 12, navigation: {
      routeIndex: 2, routeLength: 3, currentRoutePosition: down, lastRoutePositions: [start, level, down] } } };
  return { hazard, after };
}
function harnessLavaEvidence(events) {
  const source = fs.readFileSync(path.join(__dirname, 'real-natural-diamond-server.cjs'), 'utf8');
  const start = source.indexOf('function checkedLavaDetour(');
  const end = source.indexOf('\nfunction lavaChangeEvidence(', start);
  assert.ok(start >= 0 && end > start, 'Exercise the actual harness functions without starting a server');
  const context = vm.createContext({ events, hazardObservations: events.filter((event) => event.type === 'hazard_observation'),
    key: (point) => `${point.x},${point.y},${point.z}` });
  return vm.runInContext(source.slice(start, end) + ';lavaEvidence()', context);
}
function bothLavaCalculations(events) { return [harnessLavaEvidence(events), observedLava(events)]; }

test('real same-heading level-then-down checked movement passes independent lava calculations', () => {
  const { hazard, after } = lavaFixture();
  for (const episodes of bothLavaCalculations([hazard, after])) {
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].confirmed, true);
    const detour = episodes[0].subsequentDetour || episodes[0].detour;
    assert.equal(detour.heading, hazard.heading);
    assert.equal(detour.checkedRoute.length, 3);
    assert.ok(detour.movedDistance >= 0.75);
  }
});

test('lava text, heading changes and growing counters cannot pass without real checked displacement', () => {
  const { hazard, after } = lavaFixture();
  after.checkpoint.heading = 1;
  after.position = { ...hazard.playerPosition };
  for (const episodes of bothLavaCalculations([hazard, after])) assert.equal(episodes[0].confirmed, false);
  for (const episodes of bothLavaCalculations([hazard])) assert.equal(episodes[0].confirmed, false);
});

test('lava detours reject broken routes, later unrelated movement, missing lava reason and distant cells', () => {
  for (const transform of [
    ({ after }) => { after.checkpoint.navigation.lastRoutePositions[1].x = 10; },
    ({ after }) => { after.elapsedMs = 122_000; },
    ({ hazard }) => { hazard.reason = '附近有水'; },
  ]) {
    const fixture = lavaFixture(); transform(fixture);
    for (const episodes of bothLavaCalculations([fixture.hazard, fixture.after])) assert.equal(episodes[0].confirmed, false);
  }
  const fixture = lavaFixture(); fixture.hazard.nearbyLava = [{ x: 100, y: -53, z: 100 }];
  for (const episodes of bothLavaCalculations([fixture.hazard, fixture.after])) assert.equal(episodes.length, 0);
});

test('lava association stops at resupply or observed retreat before later valid-looking steps', () => {
  const { hazard, after } = lavaFixture();
  const interrupted = { type: 'snapshot', elapsedMs: 10_000, checkpoint: { phase: 'resupply_food' } };
  for (const episodes of bothLavaCalculations([hazard, interrupted, after])) assert.equal(episodes[0].confirmed, false);
  hazard.navigation.routeIndex = 1;
  const retreat = { type: 'snapshot', elapsedMs: 10_000, checkpoint: { phase: 'descend_diamond', navigation: { routeIndex: 0 } } };
  for (const episodes of bothLavaCalculations([hazard, retreat, after])) assert.equal(episodes[0].confirmed, false);
});

function harnessQuantityFunctions() {
  const source = fs.readFileSync(path.join(__dirname, 'real-natural-diamond-server.cjs'), 'utf8');
  const start = source.indexOf('function parseRequestedDiamondCount(');
  const end = source.indexOf('\nconst args =', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(source.slice(start, end) + ';({parseRequestedDiamondCount,targetCountEvidence})', { assert });
}

test('optional diamond quantities default to one, accept 8/16/64 and reject invalid bounded inputs', () => {
  const { parseRequestedDiamondCount } = harnessQuantityFunctions();
  assert.equal(parseRequestedDiamondCount(), 1);
  for (const count of [1, 8, 16, 64]) assert.equal(parseRequestedDiamondCount(String(count)), count);
  for (const invalid of [0, -1, 65, 256, 1.5, '', 'NaN', 'Infinity', 'abc']) {
    assert.throws(() => parseRequestedDiamondCount(invalid), /integer from 1 to 64/);
  }
});

test('the actual production public planner preserves default/8/16/64 expedition quantities', () => {
  const planner = createHeuristicPlanner({ actionRegistry: createMinecraftActionRegistry(), getLearnedSearchRadius: (_name, base) => base });
  const { targetCountEvidence } = harnessQuantityFunctions();
  for (const count of [1, 8, 16, 64]) {
    const command = count === 1 ? '从零开始挖到钻石' : `从零开始挖到 ${count} 个钻石`;
    const plan = planner(command);
    assert.equal(plan.intent, 'mine_diamond_resource');
    assert.equal(plan.steps[0].args.count, count);
    assert.equal(plan.steps[0].args.expedition, true);
    const task = { plan, diamondExpedition: { targetCount: count } };
    assert.equal(targetCountEvidence(task, count).verification, 'CONFIRMED');
    assert.equal(requestedTargetEvidence({ requestedDiamondCount: count, task }, { command, requestedDiamondCount: count }).confirmed, true);
  }
});

test('requested quantities remain UNKNOWN before planning and mismatched plan/executor counts cannot confirm', () => {
  const { targetCountEvidence } = harnessQuantityFunctions();
  assert.equal(targetCountEvidence(null, 16).verification, 'UNKNOWN');
  assert.equal(requestedTargetEvidence({ requestedDiamondCount: 16 }, { command: '从零开始挖到 16 个钻石', requestedDiamondCount: 16 }).verification, 'UNKNOWN');
  const task = { plan: { steps: [{ skill: 'mine_resource', args: { block: 'diamond', count: 8 } }] }, diamondExpedition: { targetCount: 8 } };
  assert.equal(targetCountEvidence(task, 16).verification, 'MISMATCH');
  assert.equal(requestedTargetEvidence({ requestedDiamondCount: 16, task }, { command: '从零开始挖到 16 个钻石', requestedDiamondCount: 16 }).confirmed, false);
});
