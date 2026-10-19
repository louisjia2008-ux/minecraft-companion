'use strict';
// Closed-world static diagnostics only. Original pure site checker and native
// registry shapes; never guide a bot, mutate world/actor or start Java.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = '.';
const candidate = path.join(root, '.minecraft-local-test/runtime-candidates/house-self23-map-safe-trails-unique-seed-20261014');
const run = path.join(root, '.minecraft-local-test/worlds/natural-public-cottage-self-16');
const output = process.argv[2] || path.join(root, '.minecraft-local-test/evidence/estate-20261013/whole16-natural-site-readonly-diagnosis-01.json');
if (fs.existsSync(output)) throw new Error('Refusing to overwrite diagnostics');
const req = require('node:module').createRequire(path.join(candidate, 'package.json'));
const { Vec3 } = req('vec3'), registry = req('prismarine-registry')('1.21.8'), Block = req('prismarine-block')(registry);
const audit = req('./test-support/natural-world-audit.cjs');
const { inspectNaturalHouseSite, chooseLoadedNaturalHouseSite } = req('./vendor/server/minecraft/naturalHouseSites');
const { classifyMiningBlock } = req('./vendor/server/minecraft/miningNavigation');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const key = p => `${p.x},${p.y},${p.z}`, counter = () => Object.create(null), increment = (out, name) => { out[name] = (out[name] || 0) + 1; };
const sourceFile = path.join(candidate, 'vendor/server/minecraft/naturalHouseSites.js');
const engineFile = path.join(candidate, 'vendor/server/minecraftTaskAgent.js');
const events = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const result = JSON.parse(fs.readFileSync(path.join(run, 'result.json')));
const diagnostics = fs.readFileSync(path.join(run, 'deskpet-data/minecraft-agent/diagnostics/task-1-mv81gj7g.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const startedAt = Date.parse(result.startedAt), stepStart = diagnostics.find(e => e.event === 'step_started').at - startedAt;
const failureAt = diagnostics.find(e => e.event === 'task_error_classified').at - startedAt;
const p = result.initial.clientPosition, origin = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
const actualColumns = new Set(events.filter(e => e.type === 'native_chunk_column_load' && e.loadedColumnPresent === true && e.elapsedMs <= stepStart).map(e => `${e.chunkX},${e.chunkZ}`));
const chunks = new Map(), cells = new Map(), originalHashes = new Map(), unknownChunks = [], reads = new Set();
const overrides = new Map(), reverseAfterFailure = events.filter(e => e.type === 'block_update' && e.elapsedMs > failureAt).reverse();
// Original classifier ignores most properties. A pre-change default property
// cannot be assumed when it affects classification, so use UNKNOWN for those.
for (const e of reverseAfterFailure) overrides.set(key(e.position), ['air', 'cave_air', 'void_air', 'dirt', 'stone', 'sand', 'gravel', 'red_sand'].includes(e.from) ? { name: e.from, properties: {} } : { unknown: true, name: e.from });
function nativeAt(point, mode = 'final', track = true) {
  const v = new Vec3(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z)), id = key(v), location = audit.blockLocation(v);
  if (track) reads.add(id);
  if (!actualColumns.has(`${location.chunkX},${location.chunkZ}`)) return null;
  const chunk = chunks.get(`${location.chunkX},${location.chunkZ}`); if (!chunk) return null;
  let value = cells.get(id);
  if (!value) {
    const section = chunk.sections.find(s => s.Y === location.sectionY);
    value = section ? audit.decodeSectionBlock(section, v) : { name: 'minecraft:air', properties: {}, absentAirSection: true };
    cells.set(id, value);
  }
  if (mode === 'failure_time' && overrides.has(id)) { value = overrides.get(id); if (value.unknown) return null; }
  const name = value.name.replace(/^minecraft:/, ''); if (!registry.blocksByName[name]) throw new Error('Unknown saved registry block: ' + name);
  const b = Block.fromProperties(registry.blocksByName[name].id, value.properties || {}, 0); b.position = v; return b;
}
function summarize(selection, mode) {
  const reasons = counter(), blocks = counter(), samples = {}, valid = selection.valid === true;
  for (const rejection of selection.rejected || []) {
    const detail = inspectNaturalHouseSite({ anchor: rejection.anchor, profile: 'cottage', blockAt: p => nativeAt(p, mode) });
    increment(reasons, detail.reason); increment(blocks, `${detail.reason}:${detail.block || 'UNKNOWN'}`);
    if ((samples[detail.reason] ||= []).length < 3) samples[detail.reason].push({ diagnosticOnlyAnchor: rejection.anchor, detail });
  }
  return { valid, inspected: selection.inspected, reason: selection.reason, reasons, firstRejectedBlocks: blocks, samples };
}
(async () => {
  for (const id of actualColumns) {
    const [chunkX, chunkZ] = id.split(',').map(Number), p = { x: chunkX * 16, y: 64, z: chunkZ * 16 }, loc = audit.blockLocation(p);
    const region = path.join(run, 'world/region', `r.${loc.regionX}.${loc.regionZ}.mca`);
    if (fs.existsSync(region) && !originalHashes.has(region)) originalHashes.set(region, hash(region));
    try { chunks.set(id, (await audit.readRegionChunk(path.join(run, 'world'), p)).chunk); }
    catch (error) { unknownChunks.push({ chunk: id, reason: error.message }); }
  }
  const original = chooseLoadedNaturalHouseSite({ origin, profile: 'cottage', blockAt: p => nativeAt(p) });
  const finalReplay = summarize(original, 'final');
  const changedTouched = [...reads].filter(id => overrides.has(id));
  const historical = chooseLoadedNaturalHouseSite({ origin, profile: 'cottage', blockAt: p => nativeAt(p, 'failure_time') });
  const historicalReplay = summarize(historical, 'failure_time');
  // Diagnose finite range/height constraints only. No selected coordinates are
  // exported or converted to a native navigation goal.
  const expanded = chooseLoadedNaturalHouseSite({ origin, profile: 'cottage', radius: 48, limit: 8192, blockAt: p => nativeAt(p) });
  const expandedSummary = { valid: expanded.valid, inspected: expanded.inspected, reason: expanded.reason || null,
    firstFailureReasons: (expanded.rejected || []).reduce((out, e) => { increment(out, e.reason); return out; }, counter()),
    selectedPosition: 'WITHHELD_DIAGNOSTIC_NOT_ACTUAL_ARRIVAL' };
  const surface = counter(); let surfaceUnknown = 0, surfaceFound = 0;
  for (let x = origin.x - 24; x <= origin.x + 24; x += 4) for (let z = origin.z - 24; z <= origin.z + 24; z += 4) {
    let height = null;
    for (let y = 110; y >= 40; y--) {
      const b = nativeAt({ x, y, z }, 'final', false);
      if (!b) { surfaceUnknown++; break; }
      if (b.boundingBox === 'block' && !/_(?:leaves|log)$/.test(b.name) && !classifyMiningBlock(b).hazard) { height = y + 1; increment(surface, height); surfaceFound++; break; }
    }
  }
  const body = [];
  for (let x = Math.floor(p.x - .3 + 1e-8); x <= Math.floor(p.x + .3 - 1e-8); x++) for (let z = Math.floor(p.z - .3 + 1e-8); z <= Math.floor(p.z + .3 - 1e-8); z++) for (let y = 63; y <= 65; y++) {
    const position = { x, y, z }, b = nativeAt(position); body.push({ position, name: b?.name || null, shapes: b?.shapes || null, classification: classifyMiningBlock(b) });
  }
  const frames = events.filter(e => e.position && typeof e.onGround === 'boolean' && e.elapsedMs <= failureAt);
  const report = { schema: 1, scope: 'READ_ONLY_CLOSED_WORLD_NATIVE_SHAPE_CLASSIFIER_DIAGNOSTIC_NOT_LIVE_ARRIVAL_OR_GUIDANCE',
    seed: result.seed, initial: result.initial, actorOrigin: origin, observedActorFrames: { count: frames.length, first: frames[0] || null, last: frames.at(-1) || null },
    timing: { stepStartMs: stepStart, classifiedFailureMs: failureAt, selectionUpperBoundMs: failureAt - stepStart },
    originalExceptionDetails: { actualSelectedInspected: 'UNKNOWN_NOT_SERIALIZED', actualRejectedReasonDistribution: 'UNKNOWN_NOT_SERIALIZED', sourceThrowsInspectedAndRejected: true },
    sourceHashes: { siteChecker: hash(sourceFile), engine: hash(engineFile) },
    loaded: { observedColumnsAtStepStart: actualColumns.size, columnsAddedDuringStep: events.filter(e => e.type === 'native_chunk_column_load' && e.elapsedMs > stepStart && e.elapsedMs <= failureAt).length, savedFullColumnsDecoded: chunks.size, unknownChunks },
    originalPolicy: { offsetsRadius: 24, offsetSpacing: 4, heightOffsets: [0, 1, -1, 2, -2], candidateLimit: 1024, groundedFloorAndScaffold: 'All full original floor/scaffold cells at one plane; original complete entrance/body/roof clearance required' },
    savedFinalMaskedReplay: finalReplay, failureTimeReplayConservative: historicalReplay,
    historicalViewLimit: 'Column-presence mask is observed native data. Per-block original views and before-properties were not archived; reconstructed MCA with conservative reverse after-failure block events is static diagnosis, never a verified exact original query stream.',
    afterFailureChangedCellsTouchedByFinalReplay: changedTouched.map(id => ({ position: id, override: overrides.get(id) })),
    diagnosticExpandedRadius48SameHeightPolicy: expandedSummary,
    sampledTerrainStandingHeights: { range: '49x49 around original spawn, 4 block sample spacing; saved final native shapes; not safe building anchors', histogram: surface, sampled: surfaceFound, unknown: surfaceUnknown, originalAnchorHeights: [62, 63, 64, 65, 66] },
    savedSpawnBodyAndFloorClassification: body,
    nextDesignEvidence: ['Do not loosen original footprint, scaffold, entrance, hazard, foreign/UNKNOWN or high gravity guards.', 'When original local search fails, a distinct pre-material siteSearch must physically explore actual loaded safe nodes, re-run original full inspector from each actually arrived node, and preserve a real return route. Its checkpoint must not fabricate or initialize materialSupply.', 'Surface-height adaptation must come from actual supported movement/loaded cells; static expanded-radius results are not navigation coordinates or actual safe arrivals.', 'Retain original task/lease/generation/cancel/watchdog and full independent camp inspection; no biome/seed filtering or fixed coordinate hints.'],
    noMutations: { Java: true, world: true, actor: true, runtime: true, offlineCoordinatesSentToBot: false } };
  report.readonlyRegionHashes = Object.fromEntries([...originalHashes].map(([file, before]) => { const after = hash(file); if (before !== after) throw new Error('Saved region changed'); return [file, { before, after, unchanged: true }]; }));
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, sha256: hash(output), loadedColumns: actualColumns.size, finalReplay, historicalReplay,
    expanded: expandedSummary, heightHistogram: surface, changedTouched, readonlyRegions: originalHashes.size }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
