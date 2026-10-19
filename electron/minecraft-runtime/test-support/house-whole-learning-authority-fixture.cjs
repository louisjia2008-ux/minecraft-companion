/* global require */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { createHouseWholeAcceptance, hash } = require('../vendor/server/minecraft/houseWholeAcceptance');
const { createMinecraftActionRegistry } = require('../vendor/server/action/actionRegistry');
const registry = createMinecraftActionRegistry();
const copy = value => JSON.parse(JSON.stringify(value));
const profiles = [['build_furnished_house', 'cottage'], ['build_furnished_house', 'enchanting_library'],
  ['build_estate', 'medieval_castle'], ['build_estate', 'riverside_villa']];
function script(index = 0, revision = 0) {
  const [capabilityId, profile] = profiles[index];
  const raw = registry.buildHeuristicTaskPlan(capabilityId, { profile, useNearbySupplyChests: false });
  const plan = { mode: 'task', intent: raw.intent, goal: `${raw.goal} revision ${revision}`,
    steps: raw.steps.map(step => ({ skill: step.skill, args: copy(step.args) })) };
  const binding = { capabilityId, profile, materialSource: 'self_gathered', sourceHash: 'a'.repeat(64),
    versionHash: hash(plan), gameVersion: '1.21.8' };
  return { plan, binding };
}
const contractFor = binding => ({ furniture: { beds: ['bed0','bed1'], workbenches: ['table0'], chests: ['chest0','chest1'], furnaces: ['furnace0','furnace1'] }, routes: ['entrance','camp'], farmPlots: binding.capabilityId === 'build_estate' ? ['plot0','plot1'] : [] });
const cycles = (key, extra) => contractFor({}).furniture[key].map(id => ({id,...extra}));
const details = (name, binding) => ({
  original_contract: ['original_contract_readback', { planHash: binding.versionHash, profile: binding.profile,
    materialSource: 'self_gathered', originalGoalPreserved: true }],
  structure: ['native_block_readback', { blockCount: 100, ownedPlacedBlocks: 100, missingBlocks: 0,
    stateMismatches: 0, clearanceViolations: 0, remainingOwnedScaffolds: 0 }],
  material_provenance: ['native_material_ledger', { acquiredCount: 200, externalInputCount: 0,
    gatherPickupDebitsVerified: true, craftSmeltDebitsVerified: true, ownedStorageVerified: true,
    nutritionSourceVerified: true, toolProgressionVerified: true, allRequiredMaterialsReconciled: true }],
  bed: ['native_bed_cycle', { cycles: cycles('beds',{enteredSleep:true,serverOccupiedConfirmed:true,actualWakeConfirmed:true,timeCommands:0}) }],
  workbench: ['native_craft', { cycles: cycles('workbenches',{ownedStation:true,inputDebit:true,outputCredit:true,closedInventoryReadback:true}) }],
  chest: ['native_container_roundtrip', { cycles: cycles('chests',{ownedStation:true,depositDebit:true,withdrawCredit:true,reopenedReadback:true,closedInventoryReadback:true}) }],
  furnace: ['native_smelt', { cycles: cycles('furnaces',{ownedStation:true,inputDebit:true,fuelDebit:true,outputCredit:true,closedInventoryReadback:true}) }],
  natural_enchantment_30: ['native_enchantment', { effectiveBookshelves: 15, requiredLevel: 30,
    levelBefore: 30, levelAfter: 27, pointsBefore:1395, optionIndex:2, lapisBefore: 3, lapisAfter: 0, xpGrantCount: 0, externalXpCount: 0,
    xpOriginLedgerVerified: true, enchantedOutputNBTVerified: true, sourceItemCraftVerified: true, serverPersistedNBTVerified:true }],
  natural_farm_cycle: ['native_crop_cycle', { tickMode: 'normal', fertilizerUses: 0, timeCommands: 0,
    farmlandMoisture:7,seedReserveBefore:8,seedReserveAfter:8,noSupplementarySeedWithinCycle:true,
    cycles:['plot0','plot1'].map(plotId=>({plotId,ageMature:7,ageAfterReplant:0,seedConsumedForReplant:1,wheatCollected:1,harvestInventoryReadback:true,replantServerReadback:true,boneMealUsed:0})) }],
  permanent_return: ['native_physical_readback',{routes:['entrance','camp'].map(id=>({id,outAndBackConfirmed:true,noTeleport:true})),returnedToOwnedCamp:true,actualDryGroundedCamp:true,finalInventoryReadback:true}],
  routes: ['native_physical_readback', { walkedOrObserved: true, noTeleport: true }],
  riverbank: ['native_physical_readback', { walkedOrObserved: true, noTeleport: true }],
  dock: ['native_physical_readback', { walkedOrObserved: true, noTeleport: true }],
}[name]);

// Explicit pure contract fixture. Simulated receipts never touch production or
// claim that a real native Minecraft task passed.
function fixture(t, policy = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-cap-ledger-v2-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'ledger.json');
  const key = randomBytes(32); // Host-held test key, never written or printed.
  let clock = 1000; let count = 0; let sourceHash = 'a'.repeat(64); let writeFailure = false; let anchor = null;
  const contexts = new Map(); const owners = new Set(); const overrides = new Map();
  const options = { filename, now: () => clock,
    seal: payload => createHmac('sha256', key).update(payload).digest('hex'),
    verifySeal: (payload, seal) => { const actual = Buffer.from(createHmac('sha256', key).update(payload).digest('hex'));
      const supplied = Buffer.from(String(seal)); return actual.length === supplied.length && timingSafeEqual(actual, supplied); },
    readAnchor: () => anchor && copy(anchor), writeAnchor: value => { anchor = copy(value); },
    contractFor,
    allowedActionIds: registry.listActions().map(action => action.actionId),
    validatePlan: plan => plan.steps.every(step => registry.validateStep(step).valid),
    getRuntime: () => ({ sourceHash, materialSource: 'self_gathered', gameVersion: '1.21.8' }),
    isCurrent: reference => owners.has(reference), runContext: reference => contexts.get(reference),
    verifyArtifact: (artifact, authority, expected) => {
      try {
        const bytes = fs.readFileSync(path.join(directory, artifact.id));
        const body = JSON.parse(bytes);
        return { digestMatches: hash(bytes.toString()) === artifact.digest,
          evidenceMatches: body.authority === authority && hash(body) === hash(expected) };
      } catch (_) { return { digestMatches: false, evidenceMatches: false }; }
    },
    nativeVerifier: async request => {
      const override = overrides.get(request.reference);
      const checks = Object.fromEntries(request.requiredChecks.map(name => {
        const [method, value] = details(name, request.binding);
        return [name, { passed: true, method, eventIds: [`${request.runId}:${name}`], digest: hash(value),
          observedAt: clock, details: value }];
      }));
      const common = { schema:2,taskId:request.taskId,runId:request.runId,generation:request.generation,worldId:request.worldId,
        sourceDigest:request.sourceDigest,profile:request.binding.profile,materialSource:'self_gathered',contractDigest:hash(request.contract),
        bindingHash: request.bindingHash, planHash: request.binding.versionHash, observedAt: clock };
      const client = { ...common, authority: 'native_client', checks };
      const server = { ...common, authority: 'saved_server', facts: { normalServerSave: true,
        savedWorldMatches: true, savedInventoryMatches: true, naturalWorldUnmodified: true,
        functionalStateConfirmed:true,seedCommitmentVerified:true,runtimeHashesMatch:true,savedPositionMatches:true,
        serverStopped:true,serverExitCode:0,sourceDigest:request.sourceDigest,planHash:request.binding.versionHash } };
      const result = { client, ...(contexts.get(request.reference).worldOrigin === 'committed_random_normal' ? { server } : {}) };
      if (override) await override(result, request);
      for (const witness of Object.values(result.client.checks || {})) if (witness && typeof witness === 'object') {
        witness.digest = hash({ method: witness.method, eventIds: witness.eventIds,
          observedAt: witness.observedAt, details: witness.details });
      }
      for (const receipt of Object.values(result)) {
        const artifactId = `${request.runId}-${receipt.authority}.json`;
        const text = JSON.stringify(receipt); fs.writeFileSync(path.join(directory, artifactId), text, { mode: 0o600 });
        receipt.artifact = { id: artifactId, digest: hash(text) };
      }
      return result;
    },
    minimumHouseGrade: policy.minimumHouseGrade,
    writeAtomic: (file, text) => {
      if (writeFailure) throw new Error('simulated write failure');
      const temp = `${file}.testtmp`; fs.writeFileSync(temp, text, { mode: 0o600 }); fs.renameSync(temp, file);
    },
  };
  let system = createHouseWholeAcceptance(options);
  function begin(target = script(), patch = {}) {
    system.authority.register(target.binding, target.plan);
    const reference = {};
    contexts.set(reference, { sourceDigest:target.binding.sourceHash,planHash:target.binding.versionHash,profile:target.binding.profile,materialSource:'self_gathered',
      taskId:`task-${count+1}`,runId: `host-run-${++count}`, worldId: 'world-real-id', generation: count,
      mode: 'normal_live', entrypoint: 'whole_public', gameMode: 'survival', worldOrigin:'committed_random_normal',difficulty:'normal',
      initialInventory: [], initialEquipment: [], initialExperience: { level: 0, totalPoints: 0 },
      interventions: [], forbiddenMutations: [], ...patch });
    owners.add(reference); const handle = system.authority.begin(target.binding, reference);
    return { target, reference, handle };
  }
  async function publish(target = script(), patch = {}) {
    const run = begin(target, patch); const result = await system.authority.validate(run.handle);
    assert.equal(result.accepted, true); system.authority.publish(target.binding); return run;
  }
  return { get system() { return system; }, options, directory, filename, contexts, owners, overrides,
    begin, publish, advance: () => { clock += 100; }, setSource: value => { sourceHash = value; },
    failWrites: () => { writeFailure = true; }, restart: () => { system = createHouseWholeAcceptance(options); return system; } };
}


module.exports={fixture,script,registry,copy};
