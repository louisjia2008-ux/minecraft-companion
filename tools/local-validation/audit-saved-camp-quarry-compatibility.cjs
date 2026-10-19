'use strict';
// Offline geometry only. Output intentionally omits all new candidate/resource coordinates.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict'), vm = require('node:vm');
const root = './.minecraft-local-test';
const candidate = path.join(root, 'runtime-candidates/house-self19-observed-resource-memory-20261014');
const run = path.join(root, 'worlds/natural-public-cottage-self-11');
const out = process.argv[2]; assert.ok(out && path.isAbsolute(out) && !fs.existsSync(out));
assert.ok(!out.startsWith(run + '/') && !out.startsWith(candidate + '/'));
const req = require('node:module').createRequire(path.join(candidate, 'package.json'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function tree(dir, prefix = '') { return Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => e.isDirectory() ? Object.entries(tree(path.join(dir, e.name), path.join(prefix, e.name))) : e.isFile() ? [[path.join(prefix, e.name), hash(path.join(dir, e.name))]] : [])); }
const sourceFile = path.join(candidate, 'vendor/server/minecraftTaskAgent.js'), source = fs.readFileSync(sourceFile, 'utf8');
const acorn = require('electron/node_modules/acorn'), ast = acorn.parse(source, { ecmaVersion: 'latest' });
const named = new Map(); let hazardNode;
function visit(node) { if (!node || typeof node !== 'object') return; if (node.type === 'FunctionDeclaration') named.set(node.id.name, node); if (node.type === 'VariableDeclarator' && node.id?.name === 'SURFACE_HAZARDS') hazardNode = node; for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value); }
visit(ast);
const { Vec3 } = req('vec3'), registry = req('prismarine-registry')('1.21.8'), Block = req('prismarine-block')(registry);
const { classifyMiningBlock } = req('./vendor/server/minecraft/miningNavigation');
const audit = req('./test-support/natural-world-audit.cjs');
const loaded = new Map(), chunks = new Map(), unknown = new Map();
const key = p => `${p.x},${p.y},${p.z}`;
const at = p => loaded.get(key(p)) || null;
const context = { ensureBotReady: () => ({ blockAt: at }), toVec3: p => p && new Vec3(p.x, p.y, p.z) };
const extracted = ['houseConstructionMaterialBounds', 'isPassableBlock', 'isSafeSupportBlock', 'safeSurfaceFoot'].map(name => { const n = named.get(name); assert.ok(n); return source.slice(n.start, n.end); });
assert.ok(hazardNode);
const pure = vm.runInNewContext(`${extracted.join('\n')}\nconst SURFACE_HAZARDS=${source.slice(hazardNode.init.start, hazardNode.init.end)}; ({houseConstructionMaterialBounds,safeSurfaceFoot})`, context, { timeout: 1000 });
const result = JSON.parse(fs.readFileSync(path.join(run, 'result.json'), 'utf8'));
const outcome = JSON.parse(fs.readFileSync(path.join(run, 'task-outcome-before-cleanup.json'), 'utf8'));
const blueprint = req('./vendor/server/minecraft/furnishedHouseBlueprints').createFurnishedHouseBlueprint(outcome.materialSupply.houseAnchor, { profile: 'cottage' });
const bound = pure.houseConstructionMaterialBounds(blueprint);
const inBounds = p => p.x >= bound.minX && p.x <= bound.maxX && p.y >= bound.minY && p.y <= bound.maxY && p.z >= bound.minZ && p.z <= bound.maxZ;
const points = [];
for (const x of [bound.minX - 8, bound.maxX + 8]) for (let z = bound.minZ - 8; z <= bound.maxZ + 8; z += 4) points.push({ x, z });
for (const z of [bound.minZ - 8, bound.maxZ + 8]) for (let x = bound.minX - 8; x <= bound.maxX + 8; x += 4) points.push({ x, z });
const initial = result.initial.clientPosition;
points.sort((a, b) => Math.hypot(a.x - initial.x, a.z - initial.z) - Math.hypot(b.x - initial.x, b.z - initial.z));
const nearY = Math.floor(initial.y);
async function read(p) {
  if (loaded.has(key(p)) || unknown.has(key(p))) return;
  const l = audit.blockLocation(p), chunkId = `${l.chunkX},${l.chunkZ}`;
  if (!chunks.has(chunkId)) {
    try { chunks.set(chunkId, (await audit.readRegionChunk(path.join(run, 'world'), p)).chunk); }
    catch (e) { chunks.set(chunkId, { unknown: e.message }); }
  }
  const chunk = chunks.get(chunkId);
  if (chunk.unknown) { unknown.set(key(p), chunk.unknown); return; }
  const section = chunk.sections.find(s => s.Y === l.sectionY);
  const cell = section ? audit.decodeSectionBlock(section, p) : { name: 'minecraft:air', properties: {} };
  const type = registry.blocksByName[cell.name.replace(/^minecraft:/, '')];
  if (!type) { unknown.set(key(p), 'Unknown saved block type'); return; }
  const block = Block.fromProperties(type.id, cell.properties || {}, 0); block.position = new Vec3(p.x, p.y, p.z); loaded.set(key(p), block);
}
async function site(x, z, y, quarryCompatible = false) {
  for (let dy = 0; dy <= 12; dy++) for (const offset of dy ? [dy, -dy] : [0]) {
    const p = { x, y: y + offset, z };
    if (inBounds(p)) continue;
    await Promise.all([read(p), read({ ...p, y: p.y + 1 }), read({ ...p, y: p.y - 1 })]);
    if ([at(p), at({ ...p, y: p.y + 1 })].every(b => ['air', 'cave_air', 'void_air'].includes(b?.name)) && pure.safeSurfaceFoot(new Vec3(p.x, p.y, p.z)) && (!quarryCompatible || classifyMiningBlock(at({ ...p, y: p.y - 1 })).support)) return p;
  }
  return null;
}
async function stations(anchor) {
  const candidates = [];
  for (let radius = 2; radius <= 8; radius += 2) for (const [dx, dz] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius], [radius, radius], [-radius, radius], [radius, -radius], [-radius, -radius]]) {
    const p = await site(anchor.x + dx, anchor.z + dz, anchor.y);
    if (p && candidates.every(q => p.x !== q.x || p.z !== q.z)) candidates.push(p);
  }
  return candidates.length;
}
(async () => {
  const before = { world: tree(path.join(run, 'world')), run: tree(run), candidate: tree(candidate) };
  const supports = {}, compatibleSupports = {}, stats = { boundaryEntries: points.length, uniqueBoundaryColumns: new Set(points.map(p => `${p.x},${p.z}`)).size, originalSafeAnchors: 0, originalSafeAnchorsWithTenStations: 0, originalChosenSurfacesQuarryCompatible: 0, originalChosenSurfacesCompatibleWithTenStations: 0, compatiblePolicyAnchors: 0, compatiblePolicyAnchorsWithTenStations: 0 };
  let originalFirstSupport = null, originalFirstStations = null, originalFirstCompatible = null, compatibleFirstSupport = null, compatibleFirstStations = null;
  for (const p of points) {
    const original = await site(p.x, p.z, nearY);
    if (original) {
      stats.originalSafeAnchors++; const support = at({ ...original, y: original.y - 1 }); supports[support.name] = (supports[support.name] || 0) + 1;
      const count = await stations(original), compatible = classifyMiningBlock(support).support;
      if (count >= 10) { stats.originalSafeAnchorsWithTenStations++; if (originalFirstSupport == null) { originalFirstSupport = support.name; originalFirstStations = count; originalFirstCompatible = compatible; } }
      if (compatible) { stats.originalChosenSurfacesQuarryCompatible++; if (count >= 10) stats.originalChosenSurfacesCompatibleWithTenStations++; }
    }
    const compatible = await site(p.x, p.z, nearY, true);
    if (compatible) {
      stats.compatiblePolicyAnchors++; const support = at({ ...compatible, y: compatible.y - 1 }); compatibleSupports[support.name] = (compatibleSupports[support.name] || 0) + 1;
      const count = await stations(compatible);
      if (count >= 10) { stats.compatiblePolicyAnchorsWithTenStations++; if (compatibleFirstSupport == null) { compatibleFirstSupport = support.name; compatibleFirstStations = count; } }
    }
  }
  assert.deepEqual(tree(path.join(run, 'world')), before.world); assert.deepEqual(tree(run), before.run); assert.deepEqual(tree(candidate), before.candidate);
  const report = { schema: 1, readOnly: true, status: 'SAVED_MCA_GEOMETRY_ONLY', source: { engineSha256: hash(sourceFile), quarrySha256: hash(path.join(candidate, 'vendor/server/minecraft/houseQuarry.js')), miningClassificationSha256: hash(path.join(candidate, 'vendor/server/minecraft/miningNavigation.js')) }, ...stats, supportTypes: supports, compatibleSupportTypes: compatibleSupports, firstOriginalPolicy: { support: originalFirstSupport, stationCount: originalFirstStations, quarryCompatible: originalFirstCompatible == null ? 'UNKNOWN' : originalFirstCompatible }, firstCompatiblePolicy: { support: compatibleFirstSupport, stationCount: compatibleFirstStations }, savedFullChunkReads: [...chunks.values()].filter(c => !c.unknown).length, unknownChunkCount: [...chunks.values()].filter(c => c.unknown).length, unknownCellCount: unknown.size, originalRunUnchanged: true, originalWorldUnchanged: true, immutableCandidateUnchanged: true, coordinatesEmitted: false, conclusions: ['This evaluates the exact original candidate19 safeSurfaceFoot and construction bounds, then original chooseCamp perimeter/dy/station enumeration over saved whole11 MCA.', 'All candidate/new camp/tree coordinates omitted. Nothing supplied to the actor. World may differ in a future live run; no native reachability or quarry trajectory acceptance is granted.', 'If compatiblePolicyAnchorsWithTenStations is zero, a support-only camp filter is insufficient on this saved world. Unread/non-full chunks remain UNKNOWN.'] };
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ path: out, sha256: hash(out), ...report }));
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
