'use strict';
// Static saved-world qualification only. No live actor, movement, Java, world
// edits, hints, native API replacement, or planned-arrival credit.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const workspace = '.';
const frozen = path.join(workspace, '.minecraft-local-test/runtime-candidates/house-self22-recorded-return-input-recovery-20261014');
const run = path.join(workspace, '.minecraft-local-test/worlds/natural-public-cottage-self-14');
const output = process.argv[2] || path.join(workspace, '.minecraft-local-test/evidence/estate-20261013/whole14-saved-wood-stance-qualification-01.json');
if (fs.existsSync(output)) throw new Error('Refusing to overwrite saved qualification');
const req = require('node:module').createRequire(path.join(frozen, 'package.json'));
const { Vec3 } = req('vec3');
const registry = req('prismarine-registry')('1.21.8');
const Block = req('prismarine-block')(registry);
const WorldSync = req('prismarine-world/src/worldsync');
const { Movements, goals } = req('mineflayer-pathfinder');
const AStar = req('mineflayer-pathfinder/lib/astar');
const Move = req('mineflayer-pathfinder/lib/move');
const audit = req('./test-support/natural-world-audit.cjs');
const sourceFile = path.join(frozen, 'vendor/server/minecraftTaskAgent.js');
const source = fs.readFileSync(sourceFile, 'utf8');
const acorn = require(path.join(workspace, 'personal-ai-deskpet-electron-work/electron/node_modules/acorn'));
const ast = acorn.parse(source, { ecmaVersion: 'latest' }), named = new Map(); let hazards;
function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'FunctionDeclaration') named.set(node.id.name, node);
  if (node.type === 'VariableDeclarator' && node.id?.name === 'SURFACE_HAZARDS') hazards = node.init;
  for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value);
}
walk(ast);
const hash = bytes => crypto.createHash('sha256').update(typeof bytes === 'string' || Buffer.isBuffer(bytes)
  ? bytes : JSON.stringify(bytes, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).digest('hex');
const actorPosition = new Vec3(85.33229118175082, 70, -483.5000000000008);
const chunks = new Map(), cells = new Map(), regionHashes = new Map(); let unknownReads = 0;
const key = p => `${p.x},${p.y},${p.z}`;
const bot = Object.assign(new EventEmitter(), { registry, version: '1.21.8', entity: { position: actorPosition, onGround: true, width: .6, height: 1.8, eyeHeight: 1.62 },
  game: { minY: -64, height: 384 }, inventory: { items: () => [] }, entities: {},
  supportFeature: name => registry.supportFeature(name), blockAt: raw => {
    const p = raw.floored(), l = audit.blockLocation({ x: p.x, y: p.y, z: p.z }), chunk = chunks.get(`${l.chunkX},${l.chunkZ}`);
    if (!chunk || chunk.unknown) { unknownReads++; return null; }
    let cell = cells.get(key(p));
    if (!cell) {
      const section = chunk.sections.find(entry => entry.Y === l.sectionY);
      cell = section ? audit.decodeSectionBlock(section, { x: p.x, y: p.y, z: p.z }) : { name: 'minecraft:air', properties: {} };
      cells.set(key(p), cell);
    }
    const type = registry.blocksByName[cell.name.replace(/^minecraft:/, '')];
    if (!type) { unknownReads++; return null; }
    // Return a fresh native Block. Native raycast may add face/intersect to its
    // result; it never mutates the saved chunk/canonical decoded cell cache.
    const block = Block.fromProperties(type.id, cell.properties || {}, 0); block.position = p; return block;
  } });
bot.world = new WorldSync(null); bot.world.getBlock = bot.blockAt;
const names = ['placementIntersectsPlayer', 'furnishedHouseStandingSafely', 'furnishedHouseDigAvoidsSupport', 'furnishedHouseStanceCandidates', 'configureFurnishedHouseDoorTraversal'];
const declarations = names.map(name => { const node = named.get(name); if (!node) throw new Error(`Missing pure source helper ${name}`); return source.slice(node.start, node.end); });
const pure = vm.runInNewContext(`const SURFACE_HAZARDS=${source.slice(hazards.start, hazards.end)};\n${declarations.join('\n')}\n({${names.join(',')},SURFACE_HAZARDS})`,
  { ensureBotReady: () => bot, toVec3: p => p instanceof Vec3 ? p : new Vec3(p.x, p.y, p.z), Vec3,
    furnishedDoorMovements: new WeakSet(), furnishedDoorPathAdapters: new WeakMap() });
function canDigFrom(target, feet) {
  if (!pure.furnishedHouseDigAvoidsSupport(target, feet)) return false;
  const eye = feet.offset(0, 1.62, 0), delta = target.offset(.5, .5, .5).minus(eye);
  if (delta.norm() > 4.5) return false;
  return bot.world.raycast(eye, delta.normalize(), 4.5)?.position?.equals(target) === true;
}
function profile() {
  const movements = pure.configureFurnishedHouseDoorTraversal(new Movements(bot));
  movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.allowFreeMotion = false;
  movements.allowSprinting = false; movements.canOpenDoors = true; movements.maxDropDown = 2; movements.infiniteLiquidDropdownDistance = false;
  movements.scafoldingBlocks = [];
  for (const name of pure.SURFACE_HAZARDS) { const id = registry.blocksByName[name]?.id; if (id != null) movements.blocksToAvoid.add(id); }
  movements.exclusionAreasStep.push(block => block?.position && [-1, 0, 1].every(dy => {
    const nearby = bot.blockAt(block.position.offset(0, dy, 0)); return nearby && !pure.SURFACE_HAZARDS.has(nearby.name) && nearby.getProperties?.().waterlogged !== true;
  }) ? 0 : 100);
  return movements;
}
function probe(goal, timeout = 500) {
  const p = actorPosition.floored(), search = new AStar(new Move(p.x, p.y, p.z, 0, 0), profile(), goal, timeout, 40, 32);
  let result, slices = 0;
  do { result = search.compute(); slices++; } while (result.status === 'partial' && slices < 64);
  return { status: result.status, pathLength: result.path.length, endpoint: result.path.at(-1)
    ? { x: result.path.at(-1).x, y: result.path.at(-1).y, z: result.path.at(-1).z }
    : result.status === 'success' ? { x: p.x, y: p.y, z: p.z } : null,
    terminalKind: result.path.length ? 'planned_path_endpoint' : result.status === 'success' ? 'existing_static_origin' : 'no_confirmed_static_endpoint',
    visited: result.visitedNodes, elapsedMs: result.time, slices, digOrPlaceSteps: result.path.filter(move => move.toBreak.length || move.toPlace.length).length };
}
(async () => {
  for (let chunkX = 4; chunkX <= 6; chunkX++) for (let chunkZ = -32; chunkZ <= -29; chunkZ++) {
    const p = { x: chunkX * 16, y: 70, z: chunkZ * 16 }, l = audit.blockLocation(p), file = path.join(run, 'world/region', `r.${l.regionX}.${l.regionZ}.mca`);
    if (fs.existsSync(file) && !regionHashes.has(file)) regionHashes.set(file, hash(fs.readFileSync(file)));
    try { chunks.set(`${chunkX},${chunkZ}`, (await audit.readRegionChunk(path.join(run, 'world'), p)).chunk); }
    catch (error) { chunks.set(`${chunkX},${chunkZ}`, { unknown: error.message }); }
  }
  const beforeActor = hash(bot.entity), beforeChunks = hash([...chunks]);
  const tree = [];
  for (let x = 81; x <= 86; x++) for (let y = 69; y <= 76; y++) {
    const block = bot.blockAt(new Vec3(x, y, -484));
    if (block && /log|leaves/.test(block.name)) tree.push({ position: { x, y, z: -484 }, name: block.name });
  }
  const targets = [new Vec3(82, 70, -484), new Vec3(82, 69, -484), new Vec3(83, 74, -484), new Vec3(83, 75, -484), new Vec3(84, 75, -484), new Vec3(85, 75, -484)];
  const results = [];
  for (const target of targets) {
    const block = bot.blockAt(target), safe = pure.furnishedHouseStanceCandidates(target, feet => canDigFrom(target, feet));
    const qualified = [];
    for (const { position: feet } of safe.slice(0, 12)) {
      const goal = new goals.GoalBlock(Math.floor(feet.x), Math.ceil(feet.y - 1e-6), Math.floor(feet.z));
      const result = probe(goal);
      qualified.push({ relativeToTarget: { x: feet.x - target.x, y: feet.y - target.y, z: feet.z - target.z }, nativeStaticProbe: result,
        endpointSafe: result.endpoint && pure.furnishedHouseStandingSafely(new Vec3(result.endpoint.x + .5, result.endpoint.y, result.endpoint.z + .5)),
        endpointDigSafe: result.endpoint && canDigFrom(target, new Vec3(result.endpoint.x + .5, result.endpoint.y, result.endpoint.z + .5)) });
      if (result.status === 'success') break;
    }
    const oldProbe = probe(new goals.GoalLookAtBlock(target, bot.world, { reach: 4.5 }));
    const endpointFeet = oldProbe.endpoint ? new Vec3(oldProbe.endpoint.x + .5, oldProbe.endpoint.y, oldProbe.endpoint.z + .5)
      : oldProbe.status === 'success' ? actorPosition : null;
    const atopTarget = target.offset(.5, 1, .5);
    const targetSupportNode = new Move(target.x, target.y + 1, target.z, 0, 0);
    const unsafeGoalEndpointQualification = { nativeGoalIsEnd: new goals.GoalLookAtBlock(target, bot.world, { reach: 4.5 }).isEnd(targetSupportNode),
      bodyStandingSafe: pure.furnishedHouseStandingSafely(atopTarget), avoidsTargetSupport: pure.furnishedHouseDigAvoidsSupport(target, atopTarget),
      canDigFrom: canDigFrom(target, atopTarget), liveChosenEndpoint: 'UNKNOWN_not_claimed', actualArrival: 'NOT_RUN' };
    results.push({ target: { x: target.x, y: target.y, z: target.z }, savedNativeName: block?.name || 'UNKNOWN',
      currentActorStandingSafe: pure.furnishedHouseStandingSafely(actorPosition), currentActorDigSafe: canDigFrom(target, actorPosition),
      geometryQualifiedStanceCount: safe.length, qualifiedStaticProbes: qualified,
      unsafeGoalEndpointQualification,
      nativeGoalLookAtBlock: { ...oldProbe, endpointStandingSafe: endpointFeet && pure.furnishedHouseStandingSafely(endpointFeet),
        endpointAvoidsTargetSupport: endpointFeet && pure.furnishedHouseDigAvoidsSupport(target, endpointFeet), endpointCanDigFrom: endpointFeet && canDigFrom(target, endpointFeet) },
      actualArrival: 'NOT_RUN', liveCandidateEligibility: 'UNKNOWN_until_fresh_loaded_owner_bounds_and_native_readback' });
  }
  const unchanged = [...regionHashes].every(([file, value]) => hash(fs.readFileSync(file)) === value);
  const report = { schema: 1, status: 'SAVED_MCA_NATIVE_STATIC_STANCE_QUALIFICATION_ONLY', sourceEngineSHA256: hash(source),
    sourceHelpers: names, inputRegionHashes: Object.fromEntries(regionHashes), actorPosition: { x: actorPosition.x, y: actorPosition.y, z: actorPosition.z },
    savedFullChunks: [...chunks.values()].filter(chunk => !chunk.unknown).length, savedUnknownChunks: [...chunks.values()].filter(chunk => chunk.unknown).length,
    unknownCellReads: unknownReads, tree, results, actualArrival: 'NOT_RUN', actualDig: 'NOT_RUN', dynamicEntities: 'UNKNOWN',
    noLiveActorOrJava: true, noActorOrWorldWrites: true, noHintsOrCoordinateGuidanceInjected: true, regionBytesUnchanged: unchanged,
    modelActorUnchanged: hash(bot.entity) === beforeActor, modelSavedChunksUnchanged: hash([...chunks]) === beforeChunks,
    previousQualificationLimit: '01 mistakenly treated stance records as Vec3, producing invalid NaN probe goals;02 corrected the record position but did not project the implicit origin endpoint for a zero-path native success. Both prior reports are retained; use03 for native qualification. Pure stance eligibility itself was34 bottom/0high in all runs.',
    scope: 'Native A* and native world raycast on final saved blocks with exact existing pure stance/dig predicates at a recorded historical actor pose. This final world may differ from its earlier live moment. Planned poses or zero-path origin qualification do not prove physical arrival, fresh native visibility, or inventory pickup.' };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
  console.log(JSON.stringify({ output, sha256: hash(fs.readFileSync(output)), chunks: report.savedFullChunks, unknownChunks: report.savedUnknownChunks,
    regionBytesUnchanged: unchanged, modelActorUnchanged: report.modelActorUnchanged, results: results.map(result => ({ target: result.target, savedName: result.savedNativeName,
      stanceCount: result.geometryQualifiedStanceCount, staticSafePath: result.qualifiedStaticProbes.some(entry => entry.nativeStaticProbe.status === 'success' && entry.endpointSafe && entry.endpointDigSafe),
      oldGoalStatus: result.nativeGoalLookAtBlock.status, oldGoalEndpointUsesTargetSupport: result.nativeGoalLookAtBlock.endpointAvoidsTargetSupport === false })) }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
