'use strict';
// Authorized narrow integration against exact frozen22 parents. No Java,
// world, historical candidate, source supplier, provenance, or runner writes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const workspace = '.';
const runtime = path.join(workspace, 'personal-ai-deskpet-electron-work/electron/minecraft-runtime');
const frozenV2 = path.join(workspace, '.minecraft-local-test/evidence/estate-20261013/natural-xp-host-private-frozen-v2');
const proposal = path.join(workspace, '.minecraft-local-test/module-candidates/natural-xp-production-port-plan-20261014/proposal/vendor/server/minecraft');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const engineFile = path.join(runtime, 'vendor/server/minecraftTaskAgent.js');
const builderFile = path.join(runtime, 'vendor/server/minecraft/furnishedHouseBuilder.js');
const beforeEngine = fs.readFileSync(engineFile, 'utf8'), beforeBuilder = fs.readFileSync(builderFile, 'utf8');
if (sha(beforeEngine) !== '8727d7831b490fef8cf32d38b117531272717e9e3cc34fcf436445beeb76661c'
  || sha(beforeBuilder) !== '0eb71e0e0866447633922a8ee7f32d5e1ec0557e982fdb388c45a3b6218b3929') throw new Error('Exact frozen22 engine/builder parent changed');
let engine = beforeEngine;
function replaceOnce(old, next) {
  if (engine.split(old).length !== 2) throw new Error(`Engine integration marker count changed: ${old.slice(0, 100)}`);
  engine = engine.replace(old, next);
}
replaceOnce('const LEGACY_AGENT_DATA_DIR = ', `const { createNaturalHouseXPHost, isOwnedNaturalHouseXPCancel, getNaturalXPProtectedPositions } = require("./minecraft/houseNaturalXPHost");
const { isSelfGatheredLibraryFinish, readNaturalXPStageBudget } = require("./minecraft/houseNaturalXPStagePolicy");

const LEGACY_AGENT_DATA_DIR = `);
replaceOnce('  const houseCampGroundedTraces = new WeakMap();', '  const houseCampGroundedTraces = new WeakMap();\n  const naturalXPStepWatchdogFrames = new WeakMap();');
replaceOnce('      if (step?.args?.expedition === true && getResourceLearningKey(step.args?.block) === "diamond") {', `      if (isSelfGatheredLibraryFinish(currentTask, step)) {
        profile.hardTimeoutMs = 4 * 60 * 60 * 1000;
        profile.idleTimeoutMs = 30000;
        profile.continuous = false;
        profile.label = "自采高级屋：有限自然经验与附魔收尾";
      }
      if (step?.args?.expedition === true && getResourceLearningKey(step.args?.block) === "diamond") {`);
replaceOnce(`    const startedAt = Date.now();
    const startupGraceMs = profile.continuous === true`, `    const startedAt = Date.now();
    const stepContext = getExecutionContext() || {};
    const naturalXPFrame = {
      task, step, stepIndex: task.currentStepIndex, bot: currentBot, client: currentBot?._client,
      token: stepContext.token || task.cancellationToken, lease: getCurrentMovementLease(), generation: executionGeneration,
      startedAt, hardTimeoutMs: profile.hardTimeoutMs, deadline: startedAt + profile.hardTimeoutMs,
    };
    naturalXPStepWatchdogFrames.set(task, naturalXPFrame);
    const startupGraceMs = profile.continuous === true`);
replaceOnce(`    try {
      return await runner();
    } finally {
      if (task && isCurrentRun()) {`, `    try {
      return await runner();
    } finally {
      if (naturalXPStepWatchdogFrames.get(task) === naturalXPFrame) naturalXPStepWatchdogFrames.delete(task);
      if (task && isCurrentRun()) {`);
replaceOnce(`    const task = context.task || currentTask;
    return Object.values(task?.materialSupply?.surfaceGraphs || {}).some(graph =>`, `    const task = context.task || currentTask;
    if (getNaturalXPProtectedPositions(task?.materialSupply?.naturalXPHost).some(p => p.x === position.x && p.y === position.y && p.z === position.z)) return true;
    return Object.values(task?.materialSupply?.surfaceGraphs || {}).some(graph =>`);
replaceOnce('            allowNativeCancel: (bot, name, data) => isOwnedFluidNativeCancel(bot, name, data) || isOwnedHouseNativeDigCancel(bot, name, data),',
  '            allowNativeCancel: (bot, name, data) => isOwnedFluidNativeCancel(bot, name, data) || isOwnedHouseNativeDigCancel(bot, name, data) || isOwnedNaturalHouseXPCancel(bot, name, data),');
const glue = fs.readFileSync(path.join(frozenV2, 'deskpet-natural-xp-host-engine-glue-v2.txt'), 'utf8').trimEnd();
replaceOnce(`    return source;
  }

  function remainingHouseToolDurability(item) {`, `    source.runXPAtCamp = action => runAtHouseCamp({ resource: "cactus" }, action);
    source.returnXPCamp = returnHouseCamp;
    return source;
  }

${glue}

  function remainingHouseToolDurability(item) {`);
replaceOnce(`    if (step.args?.phase === "prepare_materials") return builder.run(step.args);
    return withFurnishedHouseMovements(() => builder.run(step.args));`, `    if (step.args?.phase === "prepare_materials") return builder.run(step.args);
    return withFurnishedHouseMovements(async () => {
      const result = await builder.run(step.args);
      if (isSelfGatheredLibraryFinish(ownerTask, step)) {
        // Uses the existing native furniture checks without crediting final verify.
        await builder.verifyFurniture(); checkTaskSignal();
        const saved = ownerTask.stepCheckpoint.furnishedHouse;
        await finishNaturalHouseXP(ownerTask, createFurnishedHouseBlueprint(saved.anchor, { profile: saved.sourceProfile }));
      }
      return result;
    });`);
replaceOnce('      verifyFurniture: adapter.verifyFurniture, verifyRoutes: adapter.verifyRoutes,', `      verifyFurniture: async (actualBlueprint) => {
        const checks = await adapter.verifyFurniture(actualBlueprint); checkTaskSignal();
        if (!useExternalSupply && originalArgs.materialSource === "self_gathered") await finishNaturalHouseXP(ownerTask, actualBlueprint);
        return checks;
      }, verifyRoutes: adapter.verifyRoutes,`);
if (beforeBuilder.split('  return { run };').length !== 2) throw new Error('Builder export marker changed');
const builder = beforeBuilder.replace('  return { run };', '  return { run, verifyFurniture };');
const newFiles = fs.readdirSync(proposal).filter(name => name.endsWith('.js')).map(name => ({
  file: path.join(runtime, 'vendor/server/minecraft', name),
  source: fs.readFileSync(path.join(proposal, name), 'utf8')
    .replace('// Proposal only: relative dependency port of the pinned native XP host.\n// Actual production entry, current-source integration, and world acceptance remain pending.', '// Relative native XP host. All world actions retain captured source ownership.\n// Natural XP and whole-building acceptance require independent actual evidence.')
    .replace('// Proposal only: level/progress successor; preserves the older production pool.', '// Level/progress successor; preserves the older production pool.')
    .replace('// Proposal only: relative dependency port, with original native crop core unchanged.', '// Relative native crop provider, with the original guarded crop core preserved.')
    .replace('// Proposal only: relative dependency port of the original native enchant core.', '// Relative dependency port of the original guarded native enchant core.'),
}));
if (newFiles.length !== 5 || newFiles.some(entry => fs.existsSync(entry.file))) throw new Error('New five-module namespace already occupied or incomplete');
// Perform all parent/marker validation before the first authorized source write.
for (const entry of newFiles) fs.writeFileSync(entry.file, entry.source, { flag: 'wx' });
fs.writeFileSync(engineFile, engine);
fs.writeFileSync(builderFile, builder);
console.log(JSON.stringify({ engineSHA256: sha(engine), builderSHA256: sha(builder),
  newModules: newFiles.map(entry => ({ file: entry.file, sha256: sha(entry.source) })),
  selfSupplyModified: false, provenanceModified: false, javaStarted: false }));
