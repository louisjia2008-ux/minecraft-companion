/* global __dirname */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { execPath } = require('node:process');
const { createFurnishedHouseBlueprint } = require('../vendor/server/minecraft/furnishedHouseBlueprints');
const { matches, effectiveBookshelves, geometryEvidence, compareManifest, renderSavedBlocks } = require('./furnished-house-audit.cjs');

const key = (p) => `${p.x},${p.y},${p.z}`;
function fixture(profile = 'cottage') {
  const blueprint = createFurnishedHouseBlueprint({ x: -17, y: -60, z: -33 }, { profile });
  const cells = new Map(blueprint.blocks.map((spec) => [key(spec.position),
    { position: spec.position, name: `minecraft:${spec.item}`, properties: Object.fromEntries(Object.entries(spec.properties || {}).map(([name, value]) => [name, String(value)])) }]));
  const get = (p) => cells.get(key(p)) || { position: p, name: 'minecraft:air', properties: {} };
  // Hinge is chosen by vanilla from neighbors/click location rather than
  // prescribed by the production manifest; both halves must still agree.
  for (const p of [blueprint.furniture.door.lower, blueprint.furniture.door.upper]) cells.get(key(p)).properties.hinge = 'left';
  return { blueprint, cells, get };
}
test('independent geometry accepts the complete static cottage, including both door and bed halves', () => {
  const f = fixture();
  const evidence = geometryEvidence(f.get, f.blueprint);
  assert.equal(evidence.bed.confirmed, true); assert.equal(evidence.door.confirmed, true);
  assert.equal(evidence.chest.confirmed, true); assert.equal(evidence.furnace.confirmed, true);
  assert.equal(evidence.craftingTable.confirmed, true);
  assert.deepEqual(evidence.floorHoles, []); assert.deepEqual(evidence.roofHoles, []); assert.deepEqual(evidence.wallHoles, []);
  assert.equal(evidence.route.every((cell) => cell.clear), true);
  assert.deepEqual(compareManifest(f.get, f.blueprint), []);
});
test('same-name wrong-facing furniture and a missing server-derived half are rejected', () => {
  const f = fixture();
  f.cells.get(key(f.blueprint.furniture.chest)).properties.facing = 'east';
  f.cells.delete(key(f.blueprint.furniture.bed.head));
  f.cells.get(key(f.blueprint.furniture.door.upper)).properties.hinge = 'right';
  const evidence = geometryEvidence(f.get, f.blueprint);
  assert.equal(evidence.chest.confirmed, false); assert.equal(evidence.bed.confirmed, false); assert.equal(evidence.door.confirmed, false);
  assert.equal(compareManifest(f.get, f.blueprint).length, 2);
});
test('interior roof gaps and blocked two-block entrance path cannot pass a manifest-looking exterior', () => {
  const f = fixture(); const a = f.blueprint.anchor;
  const roof = f.blueprint.blocks.find((cell) => cell.phase === 'roof' && cell.position.x === a.x + 2 && cell.position.z === a.z + 4);
  f.cells.delete(key(roof.position));
  f.cells.set(key({ x: a.x + 3, y: a.y + 2, z: a.z + 1 }), { name: 'minecraft:oak_planks', properties: {} });
  const evidence = geometryEvidence(f.get, f.blueprint);
  assert.equal(evidence.roofHoles.length, 1); assert.equal(evidence.route.every((cell) => cell.clear), false);
});
test('official two-height 5x5 provider rule counts 15 regular bookshelves with an entrance gap', () => {
  const f = fixture('enchanting_library');
  const evidence = effectiveBookshelves(f.get, f.blueprint.furniture.enchantingTable);
  assert.equal(evidence.candidates.length, 15); assert.equal(evidence.effectiveCount, 15);
  const geometry = geometryEvidence(f.get, f.blueprint);
  assert.equal(geometry.enchanting.effectiveCount, 15);
});
test('a torch in the transmitter gap and a chiseled bookshelf cannot fake level-30 power', () => {
  const f = fixture('enchanting_library'); const t = f.blueprint.furniture.enchantingTable;
  f.cells.set(key({ x: t.x + 1, y: t.y, z: t.z }), { name: 'minecraft:torch', properties: {} });
  const bookshelf = f.blueprint.furniture.bookshelves.find((p) => p.x === t.x - 2 && p.z === t.z);
  f.cells.set(key(bookshelf), { name: 'minecraft:chiseled_bookshelf', properties: {} });
  const evidence = effectiveBookshelves(f.get, t);
  assert.equal(evidence.candidates.length, 14); assert.ok(evidence.effectiveCount < 14);
});
test('visualization draws only supplied saved cells and labels its actual-data provenance', () => {
  const f = fixture();
  const one = [{ position: f.blueprint.anchor, name: 'minecraft:cobblestone', properties: {} }];
  const svg = renderSavedBlocks(one, f.blueprint);
  assert.equal((svg.match(/<polygon /g) || []).length, 6);
  assert.match(svg, /Actual Anvil blocks/);
  assert.match(svg, /No planned blocks rendered/);
  assert.equal((renderSavedBlocks([], f.blueprint).match(/<polygon /g) || []).length, 0);
});
test('persistent state normalization permits string NBT states but never guesses an absent block', () => {
  assert.equal(matches({ name: 'minecraft:oak_door', properties: { open: 'false' } }, 'oak_door', { open: false }), true);
  assert.equal(matches(null, 'air'), false);
  assert.equal(matches({ name: 'minecraft:oak_stairs', properties: { facing: 'west' } }, 'oak_stairs', { facing: 'east' }), false);
});
test('rejecting an existing run directory preserves every byte of its historical events', () => {
  const installation = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-house-existing-'));
  try {
    const run = path.join(installation, 'worlds', 'existing'); fs.mkdirSync(run, { recursive: true });
    const eventFile = path.join(run, 'events.jsonl'); const original = '{"historical":"do not modify"}\n';
    fs.writeFileSync(eventFile, original);
    const child = spawnSync(execPath, [path.join(__dirname, 'real-furnished-house-server.cjs'),
      '--accept-eula', '--installation', installation, '--run-name', 'existing'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 1); assert.match(child.stderr, /Never overwrite an existing world/);
    assert.equal(fs.readFileSync(eventFile, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(run), ['events.jsonl']);
  } finally { fs.rmSync(installation, { recursive: true }); }
});
