/* global require */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { createHouseWholeAcceptance, getHouseWholePlanDigest, bindingHash, hash, endOperationFor } = require('../vendor/server/minecraft/houseWholeAcceptance');
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

test('absence of trusted persistence and verifier adapters defaults to unknown and closed', () => {
  const ledger = createHouseWholeAcceptance();
  assert.equal(ledger.query.health(), 'authority_unavailable');
  assert.equal(ledger.query.resolve(script().binding), null);
  assert.equal(ledger.query.endGate().allowed, false);
  assert.throws(() => ledger.authority.register(script().binding, script().plan), /untrusted/);
});

test('the exact validated JSON script and sealed evidence survive restart and are selected for the next call', async t => {
  const state = fixture(t); const target = script(); await state.publish(target);
  const before = state.system.query.resolve(target.binding);
  assert.equal(before.eligible, true); assert.deepEqual(before.plan, target.plan);
  const persisted = JSON.parse(fs.readFileSync(state.filename, 'utf8'));
  assert.equal(typeof persisted.seal, 'string'); assert.equal(JSON.parse(persisted.payload).schema, 2);
  state.restart(); const after = state.system.query.resolve(target.binding);
  assert.equal(state.system.query.health(), 'ready');
  assert.deepEqual(after.plan, target.plan); assert.equal(after.binding.versionHash, target.binding.versionHash);
  assert.deepEqual(after.lastSuccessfulValidation, before.lastSuccessfulValidation);
  assert.equal(after.grade,'native_server','Whole publication requires actual host-issued saved-world evidence');
});

test('a failed new candidate cannot replace or delete a previously validated and published script', async t => {
  const state = fixture(t); const old = script(0, 0); await state.publish(old); state.advance();
  const candidate = script(0, 1); const run = state.begin(candidate);
  state.system.authority.fail(run.handle, 'actual_new_candidate_failure');
  const chosen = state.system.query.resolve({ ...old.binding, versionHash: undefined });
  assert.equal(chosen.binding.versionHash, old.binding.versionHash);
  assert.deepEqual(chosen.plan, old.plan);
  assert.equal(state.system.query.get(candidate.binding).state, 'candidate');
  assert.ok(state.system.query.get(candidate.binding).history.some(event => event.type === 'failed'));
  state.restart();
  assert.equal(state.system.query.resolve({ ...old.binding, versionHash: undefined }).binding.versionHash, old.binding.versionHash);
  assert.equal(state.system.query.snapshot().records.length, 2);
});

test('failure of the published version quarantines that version but retains its exact previous validated script and receipts', async t => {
  const state = fixture(t); const target = script(); await state.publish(target);
  const successful = state.system.query.get(target.binding).lastSuccessfulValidation;
  const run = state.begin(target); state.system.authority.fail(run.handle, 'actual_native_failure');
  assert.equal(state.system.query.resolve(target.binding), null);
  const failed = state.system.query.get(target.binding);
  assert.equal(failed.quarantined, true); assert.deepEqual(failed.plan, target.plan);
  assert.deepEqual(failed.lastSuccessfulValidation, successful);
  state.restart(); assert.equal(state.system.query.resolve(target.binding), null);
  assert.deepEqual(state.system.query.get(target.binding).lastSuccessfulValidation, successful);
});

test('controlled whole-world fixtures, component hooks, supplied bags and grants can never publish a from-zero capability', async t => {
  const state = fixture(t);
  for (const patch of [{ mode: 'controlled_component' }, { mode: 'fixture' }, { entrypoint: 'private_component' },
    { initialInventory: [{ name: 'oak_log', count: 64 }] }, { interventions: ['give'] },
    { forbiddenMutations: ['xp add'] }, { gameMode: 'creative' },
    { initialEquipment: [{ name: 'diamond_chestplate', count: 1 }] },
    { initialExperience: { level: 30, totalPoints: 1395 } }]) {
    const run = state.begin(script(), patch); const result = await state.system.authority.validate(run.handle);
    assert.equal(result.accepted, false); assert.equal(result.grade, 'component');
    assert.throws(() => state.system.authority.publish(script().binding), /not_validated/);
  }
  state.restart(); assert.equal(state.system.query.resolve(script().binding), null);
});

test('boolean completion/check strings cannot substitute for native witnesses and causal source ownership', async t => {
  const state = fixture(t);
  for (const mutate of [report => { report.client.checks = Object.fromEntries(Object.keys(report.client.checks).map(key => [key, true])); },
    report => { report.client.checks.structure.details.ownedPlacedBlocks = 0; },
    report => { report.client.checks.material_provenance.details.externalInputCount = 1; },
    report => { report.client.checks.material_provenance.details.nutritionSourceVerified = false; },
    report => { report.client.checks.bed.details.cycles[1].actualWakeConfirmed = false; }]) {
    const run = state.begin(); state.overrides.set(run.reference, mutate);
    assert.equal((await state.system.authority.validate(run.handle)).accepted, false);
  }
});

test('normal farm acceptance rejects bone meal, increased random ticks, time commands and missing real replant debit', async t => {
  const state = fixture(t); const target = script(2);
  for (const mutation of [{ fertilizerUses: 1 }, { tickMode: 'accelerated' }, { timeCommands: 1 }, { seedReserveAfter:7 },{noSupplementarySeedWithinCycle:false}]) {
    const run = state.begin(target); state.overrides.set(run.reference, report => Object.assign(report.client.checks.natural_farm_cycle.details, mutation));
    assert.equal((await state.system.authority.validate(run.handle)).accepted, false);
  }
  assert.equal(state.system.query.endGate().housePrerequisitesPassed, false);
});

test('natural 30-level acceptance rejects granted XP, foreign XP, fake output and unchanged XP/lapis balances', async t => {
  const state = fixture(t); const target = script(1);
  for (const mutation of [{ xpGrantCount: 1 }, { externalXpCount: 1 }, { xpOriginLedgerVerified: false },
    { levelAfter: 30 }, { lapisAfter: 3 }, { enchantedOutputNBTVerified: false }, { requiredLevel: 29 }]) {
    const run = state.begin(target); state.overrides.set(run.reference, report => Object.assign(report.client.checks.natural_enchantment_30.details, mutation));
    assert.equal((await state.system.authority.validate(run.handle)).accepted, false);
  }
});

test('client-only proof, unknown natural origin and failed saved-world save cannot publish whole success', async t => {
  const state=fixture(t);
  for(const mutate of [report=>{delete report.server;},report=>{report.server.facts.normalServerSave=false;},
    report=>{report.server.facts.serverExitCode=1;},report=>{report.server.facts.savedPositionMatches=false;}]) {
    const run=state.begin();state.overrides.set(run.reference,mutate);
    assert.equal((await state.system.authority.validate(run.handle)).accepted,false);
    assert.throws(()=>state.system.authority.publish(script().binding),/not_validated/);
  }
  const unknown=state.begin(script(),{worldOrigin:'unknown'});assert.equal((await state.system.authority.validate(unknown.handle)).grade,'component');
});

test('the default atomic file writer durably stores the ledger with private mode and leaves no temporary file', async t => {
  const state = fixture(t); delete state.options.writeAtomic; state.restart();
  await state.publish();
  assert.equal(fs.statSync(state.filename).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(state.directory).some(name => name.endsWith('.tmp')), false);
  state.restart(); assert.equal(state.system.query.resolve(script().binding).eligible, true);
});

test('concurrent validators and late cancelled receipt callbacks cannot duplicate or promote an acceptance', async t => {
  const state = fixture(t); const run = state.begin(); let release;
  state.overrides.set(run.reference, () => new Promise(resolve => { release = resolve; }));
  const pending = state.system.authority.validate(run.handle);
  await assert.rejects(state.system.authority.validate(run.handle), /validation_in_progress/);
  state.owners.delete(run.reference); release();
  const result = await pending; assert.equal(result.accepted, false);
  assert.equal(state.system.query.snapshot().events.some(event => event.type === 'validated'), false);
  state.restart(); assert.equal(state.system.query.resolve(script().binding), null);
});

test('source changes close current resolution without deleting archived proven scripts', async t => {
  const state = fixture(t); await state.publish(); state.setSource('c'.repeat(64));
  assert.equal(state.system.query.resolve(script().binding), null);
  assert.equal(state.system.query.get(script().binding).state, 'unknown');
  assert.equal(state.system.query.get(script().binding).grade, 'unknown');
  assert.equal(state.system.query.snapshot().records[0].state, 'published');
  state.restart(); assert.equal(state.system.query.resolve(script().binding), null);
  state.setSource('a'.repeat(64)); assert.equal(state.system.query.resolve(script().binding).eligible, true);
});

test('a previous integrity-valid ledger snapshot cannot undo a later recorded actual failure', async t => {
  const state = fixture(t); await state.publish(); const oldSnapshot = fs.readFileSync(state.filename);
  const run = state.begin(); state.system.authority.fail(run.handle, 'actual_failure_after_publication');
  fs.writeFileSync(state.filename, oldSnapshot); state.restart();
  assert.equal(state.system.query.health(), 'ledger_integrity_failed');
  assert.equal(state.system.query.resolve(script().binding), null);
});

test('an intact sealed ledger ahead of its trusted anchor recovers a completed atomic write', async t => {
  const state = fixture(t); await state.publish();
  const events = state.system.query.snapshot().events;
  state.options.writeAnchor({ sequence: events.length - 1, digest: events.at(-2).digest });
  state.restart();
  assert.equal(state.system.query.health(), 'ready');
  assert.equal(state.system.query.resolve(script().binding).eligible, true);
  assert.equal(state.options.readAnchor().sequence, events.length);
});

test('tampered ledger status/events or an unsealed replacement cannot restore publication', async t => {
  const state = fixture(t); await state.publish();
  const envelope = JSON.parse(fs.readFileSync(state.filename, 'utf8'));
  const payload = JSON.parse(envelope.payload); payload.events[0].data.plan.goal = 'forged'; envelope.payload = JSON.stringify(payload);
  fs.writeFileSync(state.filename, JSON.stringify(envelope)); state.restart();
  assert.equal(state.system.query.health(), 'ledger_integrity_failed');
  assert.equal(state.system.query.resolve(script().binding), null);
  assert.throws(() => state.system.authority.register(script().binding, script().plan), /untrusted/);
});

test('an integrity-valid malformed publication chain still cannot certify a component run', async t => {
  const state = fixture(t); const run = state.begin(script(), { mode: 'fixture' }); await state.system.authority.validate(run.handle);
  const snapshot = state.system.query.snapshot();
  const unsigned = { sequence: snapshot.events.length + 1, at: 1000, previousHash: snapshot.events.at(-1).digest,
    type: 'published', data: { binding: script().binding, runId: state.contexts.get(run.reference).runId } };
  const payload = { schema: 2, events: [...snapshot.events, { ...unsigned, digest: hash(unsigned) }] };
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const text = JSON.stringify(stable(payload)); fs.writeFileSync(state.filename, JSON.stringify({ payload: text, seal: state.options.seal(text) }));
  state.restart(); assert.equal(state.system.query.health(), 'ledger_integrity_failed');
  assert.equal(state.system.query.resolve(script().binding), null);
});

test('a missing or changed native artifact makes old persisted publication ineligible', async t => {
  const state = fixture(t); const run = await state.publish();
  fs.writeFileSync(path.join(state.directory, `${state.contexts.get(run.reference).runId}-native_client.json`), '{}');
  assert.equal(state.system.query.resolve(script().binding), null);
  state.restart(); assert.equal(state.system.query.health(), 'ready');
  assert.equal(state.system.query.get(script().binding).reason, 'evidence_unavailable');
});

test('restart abandons an incomplete candidate run without promoting it or discarding an older published version', async t => {
  const state = fixture(t); await state.publish(script(0, 0)); const pending = state.begin(script(0, 1));
  state.restart(); const archived = state.system.query.get(pending.target.binding);
  assert.equal(archived.state, 'candidate'); assert.ok(archived.history.some(event => event.type === 'interrupted'));
  assert.equal(state.system.query.resolve({ ...script().binding, versionHash: undefined }).binding.versionHash, script().binding.versionHash);
});

test('durable write failure cannot report a new publication or make it executable only in memory', async t => {
  const state = fixture(t); const run = state.begin(); assert.equal((await state.system.authority.validate(run.handle)).accepted, true);
  state.failWrites(); assert.throws(() => state.system.authority.publish(script().binding), /write failure/);
  assert.equal(state.system.query.health(), 'storage_failed'); assert.equal(state.system.query.resolve(script().binding), null);
  state.restart(); assert.equal(state.system.query.get(script().binding).state, 'validated');
  assert.equal(state.system.query.resolve(script().binding), null);
});

test('old cancelled handles and run IDs cannot be replayed into a new acceptance', async t => {
  const state = fixture(t); const run = state.begin(); state.owners.delete(run.reference);
  assert.equal((await state.system.authority.validate(run.handle)).accepted, false);
  await assert.rejects(state.system.authority.validate(run.handle), /unknown_or_settled/);
  assert.throws(() => state.system.authority.begin(script().binding, run.reference), /owner_missing/);
  state.owners.add(run.reference); assert.throws(() => state.system.authority.begin(script().binding, run.reference), /run_replayed/);
});

test('unknown native actions, JS, changed complete profiles and missing phases cannot enter the durable library', t => {
  const state = fixture(t); const target = script();
  for (const mutation of [plan => { plan.scriptlet = 'process.env'; }, plan => { plan.steps[0].skill = 'new_native_action'; },
    plan => { plan.steps.pop(); }, plan => { plan.steps[0].args.profile = 'enchanting_library'; },
    plan => { plan.steps.unshift({ skill: 'withdraw_items', args: { item: 'oak_log', count: 64 } }); }]) {
    const plan = copy(target.plan); mutation(plan); const binding = { ...target.binding, versionHash: hash(plan) };
    assert.throws(() => state.system.authority.register(binding, plan));
  }
  assert.equal(state.system.query.snapshot().records.length, 0);
});

test('four whole natural publications satisfy house prerequisites but never enable unimplemented End', async t => {
  const state = fixture(t);
  for (let index = 0; index < 4; index += 1) await state.publish(script(index), { worldOrigin: 'committed_random_normal' });
  state.restart(); const gate = state.system.query.endGate();
  assert.equal(gate.housePrerequisitesPassed, true); assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'end_capability_unimplemented');
  assert.equal(state.system.query.snapshot().arbitraryJavaScript, false);
});

test('End gate recognizes generic maintain_self actions, portal aliases, forged action metadata and native dragon targets', t => {
  const state = fixture(t);
  const steps = [{ skill: 'maintain_self', args: { action: 'attack_ender_dragon' } },
    { skill: 'maintain_self', args: { action: 'approach_end_victory_marker' } },
    ...['kind', 'item', 'block'].map(key => ({ skill: 'ensure_infrastructure', args: { [key]: 'portal' } })),
    { skill: 'craft_item', args: { item: 'eye_of_ender' } },
    { skill: 'maintain_self', args: { action: 'eat_if_needed' }, action: { actionId: 'ensure_infrastructure' } }];
  for (const step of steps) assert.throws(() => state.system.query.assertEndOperation(step), failure => failure.code === 'capability_end_unavailable');
  assert.throws(() => state.system.query.assertEndOperation({ skill: 'go_to_position', args: {} }, 'autonomous_enter_end'), /end_unavailable/);
  for (const name of ['ender_dragon', 'end_crystal']) assert.throws(() => state.system.query.assertNativeEndTarget({ name }), /end_unavailable/);
  for (const context of [{ itemName: 'eye_of_ender' }, { operation: 'ignite_nether_portal' },
    ...['end_portal_frame', 'end_portal', 'nether_portal', 'end_gateway'].map(blockName => ({ blockName }))]) {
    assert.throws(() => state.system.query.assertNativeEndInteraction(context), /end_unavailable/);
  }
  assert.equal(state.system.query.assertEndOperation({ skill: 'mine_resource', args: { block: 'diamond', expedition: true } }), true);
  assert.equal(state.system.query.assertEndOperation({ skill: 'mine_resource', args: { block: 'obsidian' } }), true);
  assert.equal(state.system.query.assertNativeEndTarget({ name: 'zombie' }), true);
  assert.equal(state.system.query.assertNativeEndInteraction({ itemName: 'water_bucket', blockName: 'obsidian' }), true);
  assert.equal(endOperationFor({ skill: 'ensure_infrastructure', args: { kind: 'furnace' } }), null);
});

test('task completed and structural furniture flags without host-native receipts never become whole learning success', async t => {
  const state=fixture(t);
  for(let index=0;index<4;index++) {
    const run=state.begin(script(index));state.overrides.set(run.reference,report=>{
      report.client.checks={completed:true,furnitureVerified:true,farmVerified:true,missingBlocks:0};
    });
    assert.equal((await state.system.authority.validate(run.handle)).accepted,false);
    assert.equal(state.system.query.wholeLearningGate({binding:run.target.binding,plan:run.target.plan,run:state.contexts.get(run.reference)}).eligible,false);
    assert.equal(state.system.query.resolve(run.target.binding),null);
  }
});

test('every declared bed/table/chest/furnace must have its own native cycle, not one representative or duplicate', async t => {
  const state=fixture(t);
  for(const name of ['bed','workbench','chest','furnace'])for(const mutation of [
    d=>{d.cycles.pop();},d=>{d.cycles[0].id='foreign-station';},d=>{d.cycles[0].closedInventoryReadback=false;},
  ]) {
    if(name==='bed'&&mutation.toString().includes('closedInventory'))continue;
    const run=state.begin();state.overrides.set(run.reference,report=>mutation(report.client.checks[name].details));
    assert.equal((await state.system.authority.validate(run.handle)).accepted,false,`${name} incomplete/foreign native cycle`);
  }
  const run=state.begin();state.overrides.set(run.reference,report=>{report.client.checks.bed.details.cycles[1].id='bed0';});
  assert.equal((await state.system.authority.validate(run.handle)).accepted,false);
});

test('third-option actual level30 and saved enchanted NBT are mandatory for every advanced profile', async t => {
  const state=fixture(t);
  for(const index of [1,2,3])for(const patch of [{optionIndex:1},{pointsBefore:1394},{serverPersistedNBTVerified:false},{effectiveBookshelves:14}]) {
    const run=state.begin(script(index));state.overrides.set(run.reference,report=>Object.assign(report.client.checks.natural_enchantment_30.details,patch));
    assert.equal((await state.system.authority.validate(run.handle)).accepted,false);
  }
});

test('natural farms require each plot mature pickup/replant, no bone meal, and nondecreasing unassisted seed reserve', async t => {
  const state=fixture(t);
  for(const index of [2,3])for(const mutate of [
    d=>{d.cycles.pop();},d=>{d.cycles[1].plotId='plot0';},d=>{d.cycles[1].ageMature=6;},
    d=>{d.cycles[0].ageAfterReplant=1;},d=>{d.cycles[1].seedConsumedForReplant=0;},
    d=>{d.cycles[1].wheatCollected=0;},d=>{d.cycles[1].boneMealUsed=1;},
    d=>{d.seedReserveAfter=d.seedReserveBefore-1;},d=>{d.noSupplementarySeedWithinCycle=false;},
  ]) {
    const run=state.begin(script(index));state.overrides.set(run.reference,report=>mutate(report.client.checks.natural_farm_cycle.details));
    assert.equal((await state.system.authority.validate(run.handle)).accepted,false);
  }
});

test('permanent route proof requires all observed out/back legs and actual dry return to owned camp', async t => {
  const state=fixture(t);
  for(const mutate of [d=>{d.routes.pop();},d=>{d.routes[0].outAndBackConfirmed=false;},
    d=>{d.actualDryGroundedCamp=false;},d=>{d.returnedToOwnedCamp=false;},d=>{d.finalInventoryReadback=false;}]) {
    const run=state.begin();state.overrides.set(run.reference,report=>mutate(report.client.checks.permanent_return.details));
    assert.equal((await state.system.authority.validate(run.handle)).accepted,false);
  }
});

test('native and saved receipts are bound to exact task/generation/source/plan/world/profile', async t => {
  const state=fixture(t);
  for(const authority of ['client','server'])for(const [key,value]of Object.entries({taskId:'foreign-task',generation:999,
    runId:'foreign-run',worldId:'foreign-world',sourceDigest:'b'.repeat(64),planHash:'b'.repeat(64),
    profile:'enchanting_library',materialSource:'external_depots',contractDigest:'b'.repeat(64)})) {
    const run=state.begin();state.overrides.set(run.reference,report=>{report[authority][key]=value;});
    assert.equal((await state.system.authority.validate(run.handle)).accepted,false,`${authority}:${key}`);
  }
});

test('a previous accepted run cannot promote the current pending run or a changed revision', async t => {
  const state=fixture(t),old=await state.publish(),proof=state.contexts.get(old.reference);
  const accepted=state.system.query.wholeLearningGate({binding:old.target.binding,plan:old.target.plan,run:proof});
  assert.equal(accepted.eligible,true);
  const next=state.begin();assert.equal(state.system.query.wholeLearningGate({binding:next.target.binding,plan:next.target.plan,run:state.contexts.get(next.reference)}).eligible,false);
  assert.equal(state.system.query.wholeLearningGate({binding:old.target.binding,plan:script(0,1).plan,run:proof}).eligible,false);
  const changed={...old.target.binding,sourceHash:'b'.repeat(64)};
  assert.equal(state.system.query.wholeLearningGate({binding:changed,plan:old.target.plan,run:proof}).eligible,false);
});

test('legacy learned_success counters are quarantined without exact sealed published acceptance reference', async t => {
  const state=fixture(t),run=await state.publish(),context=state.contexts.get(run.reference);
  const bucket={success:99,reusable:true,lastSuccessfulPlan:run.target.plan};
  const request={binding:run.target.binding,plan:run.target.plan};
  assert.equal(state.system.query.legacyBucketGate(bucket,request).classification,'legacy_unverified');
  bucket.wholeAcceptance=state.system.query.wholeLearningGate({...request,run:context}).reference;
  assert.equal(state.system.query.legacyBucketGate(bucket,request).eligible,true);
  state.restart();assert.equal(state.system.query.legacyBucketGate(bucket,request).eligible,true);
  bucket.wholeAcceptance.generation++;assert.equal(state.system.query.legacyBucketGate(bucket,request).eligible,false);
});

test('native receipt callback cannot promote a task whose plan or original source changed during await', async t => {
  const state=fixture(t);
  for(const [key,value]of Object.entries({planHash:'b'.repeat(64),sourceDigest:'b'.repeat(64),taskId:'replacement-task',generation:99})) {
    const run=state.begin();state.overrides.set(run.reference,()=>{state.contexts.get(run.reference)[key]=value;});
    assert.equal((await state.system.authority.validate(run.handle)).accepted,false);
  }
});

test('changed host furniture contract closes previous proof before restart and the plan digest excludes only metadata', async t => {
  const state=fixture(t),run=await state.publish();
  assert.equal(getHouseWholePlanDigest({...run.target.plan,scriptMeta:{source:'learned_success'}}),run.target.binding.versionHash);
  const changed=copy(run.target.plan);changed.steps[0].args.profile='enchanting_library';
  assert.notEqual(getHouseWholePlanDigest(changed),run.target.binding.versionHash);
  const prior=state.options.contractFor;state.options.contractFor=binding=>{const c=prior(binding);c.furniture.beds.push('new-bed');return c;};
  assert.equal(state.system.query.resolve(run.target.binding),null);
});
