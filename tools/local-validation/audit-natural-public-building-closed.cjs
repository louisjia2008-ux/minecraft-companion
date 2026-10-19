'use strict';
// Read-only closeout of a known, normally stopped public natural-building run.
// Writes only a new evidence report outside the run and immutable candidate.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node audit-natural-public-building-closed.cjs --run-dir ABS --manifest ABS --expected-manifest-sha SHA256 --runner ABS --node-exit 0|1 --report ABS [--private-root ABS] [--extra-source-baseline ABS]');
  process.exit(0);
}
const known = new Set(['--run-dir', '--manifest', '--expected-manifest-sha', '--runner', '--node-exit', '--report', '--private-root', '--extra-source-baseline']);
const values = {};
for (let i = 0; i < args.length; i += 2) {
  assert.ok(known.has(args[i]) && args[i + 1] !== undefined, `Unsupported/missing argument ${args[i]}`);
  assert.equal(values[args[i]], undefined, 'Duplicate argument');
  values[args[i]] = args[i + 1];
}
for (const name of ['--run-dir', '--manifest', '--expected-manifest-sha', '--runner', '--node-exit', '--report']) assert.ok(values[name], `${name} required`);
assert.match(values['--expected-manifest-sha'], /^[a-f0-9]{64}$/);
assert.ok(['0', '1'].includes(values['--node-exit']), 'Supply actual observed Node exit, not task status');
const run = path.resolve(values['--run-dir']);
const world = path.join(run, 'world');
const manifestPath = path.resolve(values['--manifest']);
const reportPath = path.resolve(values['--report']);
const runner = path.resolve(values['--runner']);
const load = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = load(manifestPath);
const candidate = path.resolve(manifest.candidate);
const contained = (child, parent) => child === parent || child.startsWith(parent + path.sep);
assert.ok(!contained(reportPath, run) && !contained(reportPath, candidate), 'Report must be outside source/run/world trees');
assert.ok(!fs.existsSync(reportPath), 'Refusing to overwrite evidence');
assert.ok(fs.existsSync(path.dirname(reportPath)), 'Report parent must already exist');
const req = createRequire(path.join(candidate, 'package.json'));
const report = {
  schema: 1, createdAt: new Date().toISOString(), readOnly: true,
  runDirectory: run, immutableCandidate: candidate,
  originalNodeExitCode: Number(values['--node-exit']),
  nodeExitEvidence: 'Actual caller-observed exit supplied explicitly; not inferred from saved task.',
  checks: {}, publicWholeHouseAcceptance: false,
  scope: 'Independent stopped-source, lifecycle, native/private snapshots, NBT, saved MCA, console and event closeout. No Java start, command submission, source/world/result edit, or resource-coordinate injection.'
};
const check = (name, passed, evidence) => {
  report.checks[name] = { passed: passed === true, evidence };
  return passed === true;
};
function tree(dir, prefix = '') {
  return Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => {
    const f = path.join(dir, e.name), name = path.join(prefix, e.name);
    return e.isDirectory() ? Object.entries(tree(f, name)) : e.isFile() ? [[name, hash(f)]] : [];
  }));
}
const stock = items => items.reduce((out, i) => { out[i.name] = (out[i.name] || 0) + i.count; return out; }, {});
const sameStock = (a, b) => JSON.stringify(Object.entries(stock(a)).sort()) === JSON.stringify(Object.entries(stock(b)).sort());
const parseLines = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const key = p => `${p.x},${p.y},${p.z}`;
const isAir = b => ['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'].includes(b?.name);

(async () => {
  const lifecycle = load(path.join(run, 'server-lifecycle.json'));
  report.lifecycle = lifecycle;
  check('normalOwnedServerClose', lifecycle.normal === true && lifecycle.forced === false && lifecycle.code === 0 && lifecycle.signal == null && lifecycle.serverClosed === true && Number.isSafeInteger(lifecycle.pid), lifecycle);
  let pidState = 'UNKNOWN';
  if (Number.isSafeInteger(lifecycle.pid) && lifecycle.pid > 0) {
    try { process.kill(lifecycle.pid, 0); pidState = 'PRESENT'; }
    catch (e) { pidState = e.code === 'ESRCH' ? 'ABSENT' : `UNKNOWN:${e.code || e.message}`; }
  }
  report.ownedJavaPidState = pidState;
  check('ownedJavaPidAbsent', pidState === 'ABSENT', pidState);
  if (!report.checks.normalOwnedServerClose.passed || pidState !== 'ABSENT') {
    report.status = 'BLOCKED_NOT_CONFIRMED_CLOSED';
    report.limit = 'Permission errors remain UNKNOWN. No world or source audit while ownership lifecycle is unresolved.';
    return;
  }
  const before = { candidate: tree(candidate), run: tree(run), world: tree(world), manifest: hash(manifestPath) };
  report.source = { immutableManifestSha256: before.manifest, immutableFileCount: Object.keys(manifest.files).length, immutableHashes: before.candidate };
  check('manifestMatchesFrozenAnchor', before.manifest === values['--expected-manifest-sha'], { actual: before.manifest, expected: values['--expected-manifest-sha'] });
  check('allImmutableFilesMatch', Object.keys(before.candidate).length === Object.keys(manifest.files).length && Object.entries(manifest.files).every(([name, expected]) => before.candidate[name] === expected), Object.keys(before.candidate).length);
  const result = load(path.join(run, 'result.json'));
  const outcome = load(path.join(run, 'task-outcome-before-cleanup.json'));
  const events = parseLines(path.join(run, 'events.jsonl'));
  const diagnosticsPath = outcome?.diagnostics?.tracePath;
  if (diagnosticsPath) assert.ok(contained(path.resolve(diagnosticsPath), run), 'Diagnostic path must belong to this known run');
  const diagnostics = diagnosticsPath && fs.existsSync(diagnosticsPath) ? parseLines(diagnosticsPath) : [];
  check('runStartEndHashesEqual', JSON.stringify(result.sourceHashes?.started) === JSON.stringify(result.sourceHashes?.ended) && !!result.sourceHashes?.started, result.sourceHashes);
  const execution = {};
  const nativeChecks = {}, privateChecks = {};
  for (const [name, expected] of Object.entries(result.sourceHashes?.started || {})) {
    assert.ok(!path.isAbsolute(name) && !name.split(/[\\/]/).includes('..'), 'Invalid snapshot path');
    const snapshot = path.join(run, 'execution-source-snapshot', name), actual = hash(snapshot);
    execution[name] = actual;
    check(`snapshot:${name}`, actual === expected, { expected, actual });
    if (name.startsWith('native/')) {
      const nativePath = req.resolve(name.slice(7, -3)), current = hash(nativePath);
      nativeChecks[name] = { path: nativePath, sha256: current };
      check(`native:${name}`, current === expected, nativeChecks[name]);
    } else if (name.startsWith('private/')) {
      const privatePath = name === 'private/natural-public-building-acceptance.cjs' ? runner : path.join(path.resolve(values['--private-root'] || '/private/tmp'), path.basename(name));
      const current = fs.existsSync(privatePath) ? hash(privatePath) : null;
      privateChecks[name] = { path: privatePath, sha256: current, absent: current == null };
      check(`private:${name}`, current === expected, privateChecks[name]);
    } else check(`immutableSnapshot:${name}`, manifest.files[name] === actual, { expected: manifest.files[name], actual });
  }
  report.source.executionSnapshotCount = Object.keys(execution).length;
  report.source.nativeChecks = nativeChecks;
  report.source.privateChecks = privateChecks;
  if (values['--extra-source-baseline']) {
    const p = path.resolve(values['--extra-source-baseline']), b = load(p), current = {};
    for (const [file, expected] of Object.entries(b.files)) { current[file] = hash(file); check(`additionalSource:${file}`, current[file] === expected, { expected, actual: current[file] }); }
    report.source.additionalSourceBaseline = { path: p, sha256: hash(p), fileCount: Object.keys(current).length, files: current };
  }
  const audit = req('./test-support/natural-world-audit.cjs');
  const nbt = req('prismarine-nbt');
  const metadata = await audit.readLevelMetadata(world);
  const players = fs.readdirSync(path.join(world, 'playerdata')).filter(n => n.endsWith('.dat'));
  assert.equal(players.length, 1, 'Exactly one natural Survival player required');
  const player = nbt.simplify((await nbt.parse(fs.readFileSync(path.join(world, 'playerdata', players[0])))).parsed);
  const savedInventory = (player.Inventory || []).map(i => ({ name: i.id.replace(/^minecraft:/, ''), count: i.count, slot: i.Slot, components: i.components || i.tag || null }));
  const final = result.finalReadback;
  assert.ok(final?.clientPosition && final.serverPosition && final.clientInventory && final.serverInventory, 'Final authoritative readback required');
  const positionDifference = Math.hypot(...player.Pos.map((n, i) => n - final.serverPosition[['x', 'y', 'z'][i]]));
  const clientServerPositionDifference = Math.hypot(...['x', 'y', 'z'].map(k => final.clientPosition[k] - final.serverPosition[k]));
  check('savedClientServerInventoryMatch', sameStock(savedInventory, final.clientInventory) && sameStock(final.clientInventory, final.serverInventory), { saved: savedInventory, client: final.clientInventory, server: final.serverInventory });
  check('savedClientServerPositionMatch', positionDifference <= 0.15 && clientServerPositionDifference <= 0.15, { saved: player.Pos, client: final.clientPosition, server: final.serverPosition, positionDifference, clientServerPositionDifference });
  const xp = final.clientExperience || final.experienceReadback?.clientExperience;
  check('savedExperienceMatches', !!xp && player.XpLevel === xp.level && player.XpTotal === xp.points && Math.abs(player.XpP - xp.progress) <= 1e-6, { saved: { level: player.XpLevel, total: player.XpTotal, progress: player.XpP }, client: xp });
  check('savedNaturalMetadata', metadata.gameType === 0 && metadata.difficulty === 2 && metadata.generator === 'minecraft:noise' && metadata.seed === '6239290801279771110' && ['doMobSpawning', 'doDaylightCycle', 'doWeatherCycle', 'naturalRegeneration'].every(n => metadata.gameRules[n] === 'true') && metadata.gameRules.keepInventory === 'false' && player.playerGameType === 0, metadata);
  report.metadata = metadata;
  report.savedPlayer = { position: player.Pos, inventory: savedInventory, health: player.Health, food: player.foodLevel, saturation: player.foodSaturationLevel, air: player.Air, experience: { level: player.XpLevel, total: player.XpTotal, progress: player.XpP }, onGround: player.OnGround, gameType: player.playerGameType, positionDifference };
  const commands = events.filter(e => e.type === 'server_command');
  const allowed = /^(?:seed|difficulty|gamerule (?:doMobSpawning|doDaylightCycle|doWeatherCycle|keepInventory|naturalRegeneration)|data get entity DeskPetSelfBuild (?:Inventory|Pos|XpLevel|XpTotal|XpP)|stop)$/;
  check('onlyReadonlyConsoleAndOwnedStop', commands.every(e => allowed.test(e.command)) && commands.filter(e => e.duringExecution === true).length === 0 && commands.filter(e => e.command === 'stop').length === 1, { commands, duringExecution: commands.filter(e => e.duringExecution === true).length });
  check('resultLifecycleAgrees', JSON.stringify(result.stopped) === JSON.stringify(lifecycle), result.stopped);
  for (const type of ['public_task_execution_ended', 'all_native_execution_ended', 'server_exit', 'server_closed']) check(`chronology:${type}`, events.some(e => e.type === type), events.filter(e => e.type === type));
  const chunks = new Map();
  async function savedBlock(p) {
    const l = audit.blockLocation(p), id = `${l.chunkX},${l.chunkZ}`;
    if (!chunks.has(id)) chunks.set(id, (await audit.readRegionChunk(world, p)).chunk);
    const section = chunks.get(id).sections.find(s => s.Y === l.sectionY);
    return section ? audit.decodeSectionBlock(section, p) : { name: 'minecraft:air', properties: {}, absentAirSection: true };
  }
  const isEstate = ['medieval_castle', 'riverside_villa'].includes(result.profile);
  const house = outcome?.stepCheckpoint?.[isEstate ? 'estate' : 'furnishedHouse'];
  if (house?.anchor && house?.verificationSummary) {
    const make = isEstate ? req('./vendor/server/minecraft/estateBlueprints').createEstateBlueprint : req('./vendor/server/minecraft/furnishedHouseBlueprints').createFurnishedHouseBlueprint;
    const blueprint = make(house.anchor, { profile: result.profile }), cells = new Map();
    for (const entry of [...blueprint.blocks, ...blueprint.clearance, ...blueprint.scaffold]) cells.set(key(entry.position), await savedBlock(entry.position));
    const { compareManifest } = req('./test-support/furnished-house-audit.cjs');
    const mismatches = compareManifest(p => cells.get(key(p)), blueprint);
    const clearance = blueprint.clearance.filter(c => !isAir(cells.get(key(c.position))));
    const scaffold = blueprint.scaffold.filter(c => !isAir(cells.get(key(c.position))));
    report.savedStructure = { anchor: house.anchor, mismatches, clearance, scaffold };
    check('savedWholeStructureMatches', mismatches.length === 0 && clearance.length === 0 && scaffold.length === 0, report.savedStructure);
    if (isEstate) {
      const plots = [];
      for (const plot of blueprint.farms) {
        const water = await savedBlock(plot.water), soil = await Promise.all(plot.soil.map(savedBlock)), crops = await Promise.all(plot.crops.map(c => savedBlock(c.position)));
        plots.push({ id: plot.id, water, soil, crops, confirmed: water.name === 'minecraft:water' && Number(water.properties.level) === 0 && soil.length === 24 && soil.every(b => b.name === 'minecraft:farmland' && Number(b.properties.moisture) === 7) && crops.length === 24 && crops.every(b => b.name === 'minecraft:wheat') });
      }
      report.savedFarms = plots;
      check('savedFarmGeometryMatches', plots.length === 2 && plots.every(p => p.confirmed), plots);
    }
  } else report.savedStructure = { status: 'NOT_BUILT_OR_NOT_VERIFIED', anchor: house?.anchor || null };
  const camp = outcome?.materialSupply?.camp?.anchor;
  const campDistance = camp ? Math.hypot(...player.Pos.map((n, i) => n - camp[['x', 'y', 'z'][i]])) : null;
  const outbound = events.filter(e => e.type === 'native_outbound' && e.name === 'block_dig');
  report.terminal = { status: outcome.status, error: outcome.error, elapsedMs: result.elapsedMs, stepIndex: outcome.currentStepIndex, camp, campDistance, finalReturnedCamp: campDistance == null ? 'UNKNOWN' : campDistance < 1, nativeDigStart: outbound.filter(e => e.packet.status === 0).length, nativeDigFinish: outbound.filter(e => e.packet.status === 2).length, completedDigs: events.filter(e => e.type === 'digging_completed').length, materialEvidence: result.materialEvidence };
  report.observation = { selfHurtCount: events.filter(e => e.type === 'entity_hurt' && e.self === true).length, hurtIdentity: 'Individual attackers require direct raw correlation; nearby mobs do not prove cause.', deaths: events.filter(e => e.type === 'death').length, positionCorrections: events.filter(e => e.type === 'native_position_correction'), classifiedErrors: diagnostics.filter(d => d.event === 'task_error_classified'), guardFailures: diagnostics.filter(d => d.event === 'house_surface_guard_failure'), healthPackets: events.filter(e => e.type === 'health_packet'), nativeStages: events.filter(e => e.type === 'native_verification_stage'), nativeUse: result.nativeUse || null };
  const delivered = new Set(), resident = new Set();
  let headers = 0, loads = 0, unloads = 0, errors = 0;
  for (const e of events) {
    const id = `${e.chunkX},${e.chunkZ}`;
    if (e.type === 'native_map_chunk_header') { headers++; delivered.add(id); }
    if (e.type === 'native_chunk_column_load') { loads++; resident.add(id); }
    if (e.type === 'native_chunk_column_unload') { unloads++; resident.delete(id); }
    if (e.type === 'chunk_observation_error') errors++;
  }
  report.chunkObservations = { headers, loads, unloads, errors, deliveredUnique: delivered.size, finalResident: resident.size, scope: 'Event-key replay; header delivery does not grant decoded residency.' };
  report.criteria = result.criteria || null;
  report.unmetCriteria = result.unmetCriteria || null;
  report.initial = result.initial;
  report.verificationStages = result.verificationStages;
  report.originalResultAcceptance = result.publicBuildingAcceptancePassed === true;
  report.originalEvidence = Object.fromEntries(['result.json', 'events.jsonl', 'task-outcome-before-cleanup.json', 'server-lifecycle.json', 'server.log', 'independent-natural-public-building-audit.json'].filter(n => fs.existsSync(path.join(run, n))).map(n => [n, hash(path.join(run, n))]));
  check('immutableTreeUnchangedByAudit', JSON.stringify(tree(candidate)) === JSON.stringify(before.candidate), Object.keys(before.candidate).length);
  check('originalRunBytesUnchangedByAudit', JSON.stringify(tree(run)) === JSON.stringify(before.run), Object.keys(before.run).length);
  check('originalWorldBytesUnchangedByAudit', JSON.stringify(tree(world)) === JSON.stringify(before.world), Object.keys(before.world).length);
  check('manifestUnchangedByAudit', hash(manifestPath) === before.manifest, before.manifest);
  report.worldFilesHashed = Object.keys(before.world).length;
  report.worldHashes = before.world;
  report.originalRunFilesHashed = Object.keys(before.run).length;
  report.integrityPassed = Object.values(report.checks).every(c => c.passed === true);
  // Keep this closeout distinct from actual building acceptance and production learning receipts.
  report.publicWholeHouseAcceptance = report.integrityPassed && report.originalNodeExitCode === 0 && report.originalResultAcceptance && Object.values(result.criteria || {}).length > 0 && Object.values(result.criteria || {}).every(v => v === true) && outcome.status === 'completed' && report.observation.deaths === 0 && report.checks.savedWholeStructureMatches?.passed === true;
  report.status = !report.integrityPassed ? 'INTEGRITY_FAIL' : report.publicWholeHouseAcceptance ? 'CLOSED_RESULT_PASS_INDEPENDENT_SOURCE_NBT_MCA_RECHECK' : 'CLOSED_FAIL_PRESERVED';
  report.limits = ['Native stage results and packet observations are retained; this auditor does not create native use or whole-learning issuer receipts.', 'Poststop MCA/NBT are final state, not historical movement facts.', 'No arbitrary-seed guarantee. Absent/non-full MCA chunks remain errors rather than guessed air.'];
})().catch(error => {
  report.status = 'AUDIT_ERROR';
  report.error = { code: error.code || null, message: error.message, stack: error.stack };
}).finally(() => {
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ path: reportPath, sha256: hash(reportPath), status: report.status, integrityPassed: report.integrityPassed === true, publicWholeHouseAcceptance: report.publicWholeHouseAcceptance === true, ownedJavaPidState: report.ownedJavaPidState, failedChecks: Object.entries(report.checks).filter(([, c]) => !c.passed).map(([n]) => n), error: report.error || null }));
  if (!['CLOSED_FAIL_PRESERVED', 'CLOSED_RESULT_PASS_INDEPENDENT_SOURCE_NBT_MCA_RECHECK'].includes(report.status)) process.exitCode = 1;
});
