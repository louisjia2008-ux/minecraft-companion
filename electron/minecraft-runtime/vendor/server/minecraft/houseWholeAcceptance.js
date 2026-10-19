/* global require, module */
'use strict';
// Durable whole-house acceptance, derived from the private sealed ledger v2.
// No game actions. All authority adapters stay with the host, outside planner
// arguments. Missing authority/evidence remains pending, never a whole success.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const copy = value => JSON.parse(JSON.stringify(value));
const error = code => Object.assign(new Error(code), { code });
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const canonical = value => JSON.stringify(stable(value));
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const SHA = /^[a-f0-9]{64}$/;
const PHASES = ['inspect_inventory', 'select_site', 'prepare_materials', 'clear_site', 'floor', 'frame',
  'walls', 'windows', 'roof', 'furniture', 'finish', 'verify'];
const END_ACTIONS = new Set(['enter_nether_portal', 'use_eye_of_ender', 'fill_end_portal_frames',
  'enter_end_portal', 'stabilize_end_spawn', 'break_end_crystal', 'attack_ender_dragon',
  'recover_end_fight', 'reposition_end_fight', 'hold_end_fight_window', 'approach_end_victory_marker']);
const END_INTENTS = new Set(['defeat_ender_dragon', 'end_expedition', 'autonomous_prepare_diamond_pickaxe',
  'autonomous_craft_diamond_pickaxe', 'autonomous_collect_obsidian', 'autonomous_collect_flint',
  'autonomous_craft_flint_and_steel', 'autonomous_collect_ender_pearls', 'autonomous_collect_blaze_rods',
  'autonomous_search_blaze_area', 'autonomous_craft_eyes_of_ender', 'autonomous_build_nether_portal',
  'autonomous_enter_nether', 'autonomous_return_overworld', 'autonomous_locate_stronghold',
  'autonomous_advance_stronghold', 'autonomous_search_portal_room', 'autonomous_approach_end_portal_room',
  'autonomous_fill_end_portal', 'autonomous_enter_end', 'autonomous_stabilize_end',
  'autonomous_reposition_end_fight', 'autonomous_recover_end_fight', 'autonomous_clear_end_crystals',
  'autonomous_approach_end_crystal', 'autonomous_wait_ender_dragon_window', 'autonomous_complete_end_fight',
  'autonomous_hold_dragon_victory', 'autonomous_attack_ender_dragon']);
const FAMILIES = ['build_furnished_house:cottage', 'build_furnished_house:enchanting_library',
  'build_estate:medieval_castle', 'build_estate:riverside_villa'];
const COMMON = ['original_contract', 'structure', 'material_provenance', 'bed', 'workbench', 'chest', 'furnace', 'permanent_return'];
const requiredChecks = binding => [...COMMON,
  ...(binding.profile !== 'cottage' ? ['natural_enchantment_30'] : []),
  ...(binding.capabilityId === 'build_estate' ? ['routes', 'natural_farm_cycle'] : []),
  ...(binding.profile === 'riverside_villa' ? ['riverbank', 'dock'] : [])];
const family = binding => `${binding.capabilityId}:${binding.profile}`;
function normalizeBinding(raw) {
  const keys = ['capabilityId', 'profile', 'materialSource', 'sourceHash', 'versionHash', 'gameVersion'];
  if (!raw || Object.keys(raw).some(key => !keys.includes(key))) throw error('capability_binding_invalid');
  const value = Object.fromEntries(keys.map(key => [key, raw[key]]));
  if (!FAMILIES.includes(family(value)) || value.materialSource !== 'self_gathered'
    || !SHA.test(value.sourceHash) || !SHA.test(value.versionHash) || !/^\d+\.\d+(?:\.\d+)?$/.test(value.gameVersion)) {
    throw error('capability_binding_invalid');
  }
  return value;
}
const bindingHash = binding => hash(normalizeBinding(binding));
function endOperationFor(step, intent = '') {
  if (END_INTENTS.has(intent)) return `intent:${intent}`;
  const skill = String(step?.skill || '').trim(); const args = step?.args || {};
  if (step?.action?.actionId && step.action.actionId !== skill) return 'compiled_action_mismatch';
  if (skill === 'maintain_self' && END_ACTIONS.has(String(args.action || '').trim())) return args.action;
  if (skill === 'ensure_infrastructure' && ['portal', 'nether_portal'].includes(String(args.kind || args.item || args.block || '').trim())) return 'nether_portal';
  if (skill === 'craft_item' && args.item === 'eye_of_ender') return 'craft_eye_of_ender';
  return null;
}
function normalizePlan(raw, binding, allowed, validatePlan) {
  if (!raw || raw.intent !== binding.capabilityId || !Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length > 32
    || raw.scriptlet || raw.jsScript || raw.kind === 'javascript') throw error('capability_plan_invalid');
  const plan = { mode: 'task', intent: raw.intent, goal: String(raw.goal || ''),
    steps: raw.steps.map(step => ({ skill: String(step?.skill || '').trim(), args: copy(step?.args || {}) })) };
  if (plan.steps.some(step => !allowed.includes(step.skill) || endOperationFor(step, plan.intent)
    || step.skill === 'withdraw_items' || step.args.useNearbySupplyChests === true
    || Array.isArray(step.args.depots) && step.args.depots.length)) throw error('capability_unimplemented_or_external_plan');
  const main = plan.steps.filter(step => step.skill === (binding.capabilityId === 'build_estate' ? 'build_estate' : 'build_furnished_house_phase'));
  if (!main.length || main.some(step => step.args.profile !== binding.profile || step.args.materialSource !== 'self_gathered')
    || binding.capabilityId === 'build_estate' && (main.length !== 1 || main[0].args.schema !== 1 || main[0].args.useNearbySupplyChests !== false)
    || binding.capabilityId === 'build_furnished_house' && (main.some(step => step.args.schema !== 2)
      || canonical(main.map(step => step.args.phase)) !== canonical(PHASES))
    || typeof validatePlan !== 'function' || validatePlan(copy(plan), copy(binding)) !== true) throw error('capability_original_contract_invalid');
  if (hash(plan) !== binding.versionHash) throw error('capability_script_hash_mismatch');
  return plan;
}
function normalizeContext(raw) {
  if (!raw || !SHA.test(raw.sourceDigest) || !SHA.test(raw.planHash) || typeof raw.profile !== 'string'
    || raw.materialSource !== 'self_gathered' || typeof raw.taskId !== 'string' || !raw.taskId || typeof raw.runId !== 'string' || !raw.runId || typeof raw.worldId !== 'string' || !raw.worldId
    || !Number.isInteger(raw.generation) || raw.generation < 1 || !Array.isArray(raw.initialInventory)
    || raw.initialInventory.some(item => !item || typeof item.name !== 'string' || !Number.isInteger(item.count) || item.count <= 0)
    || !Array.isArray(raw.initialEquipment) || raw.initialEquipment.some(item => !item || typeof item.name !== 'string'
      || !Number.isInteger(item.count) || item.count <= 0)
    || !raw.initialExperience || !Number.isInteger(raw.initialExperience.level) || raw.initialExperience.level < 0
    || !Number.isInteger(raw.initialExperience.totalPoints) || raw.initialExperience.totalPoints < 0
    || !Array.isArray(raw.interventions) || !Array.isArray(raw.forbiddenMutations)) throw error('capability_run_context_unknown');
  return copy(raw);
}
const contextIdentity = context => canonical([context.taskId, context.runId, context.worldId, context.generation, context.mode,
  context.entrypoint, context.gameMode, context.worldOrigin || 'unknown', context.initialInventory,
  context.initialEquipment, context.initialExperience, context.difficulty, context.sourceDigest, context.planHash, context.profile, context.materialSource]);
const eligible = context => context.mode === 'normal_live' && context.entrypoint === 'whole_public'
  && context.gameMode === 'survival' && context.worldOrigin === 'committed_random_normal' && context.difficulty === 'normal'
  && context.initialInventory.length === 0 && context.initialEquipment.length === 0
  && context.initialExperience.level === 0 && context.initialExperience.totalPoints === 0
  && context.interventions.length === 0 && context.forbiddenMutations.length === 0;
function normalizeContract(raw, binding) {
  const furniture = raw?.furniture;
  const ids = list => Array.isArray(list) && list.length > 0 && list.length <= 32
    && list.every(id => typeof id === 'string' && id.length > 0 && id.length <= 160) && new Set(list).size === list.length;
  if (!furniture || !['beds', 'workbenches', 'chests', 'furnaces'].every(key => ids(furniture[key]))
    || !ids(raw.routes) || !Array.isArray(raw.farmPlots)
    || (binding.capabilityId === 'build_estate' ? !ids(raw.farmPlots) : raw.farmPlots.length !== 0)) {
    throw error('house_whole_contract_unknown');
  }
  return copy({ furniture, routes: raw.routes, farmPlots: raw.farmPlots });
}
const exactIds = (cycles, expected, field = 'id') => Array.isArray(cycles) && cycles.length === expected.length
  && cycles.every(cycle => cycle && expected.includes(cycle[field])) && new Set(cycles.map(cycle => cycle[field])).size === expected.length;
function validCheck(name, witness, binding, run, contract) {
  if (!witness || witness.passed !== true || !Array.isArray(witness.eventIds) || !witness.eventIds.length
    || witness.eventIds.length > 4096 || witness.eventIds.some(id => typeof id !== 'string' || !id) || !SHA.test(witness.digest)
    || !Number.isFinite(witness.observedAt) || witness.observedAt < run.startedAt || witness.observedAt > run.finishedAt) return false;
  if (witness.digest !== hash({ method: witness.method, eventIds: witness.eventIds,
    observedAt: witness.observedAt, details: witness.details })) return false;
  const d = witness.details || {};
  if (name === 'original_contract') return witness.method === 'original_contract_readback' && d.planHash === binding.versionHash
    && d.profile === binding.profile && d.materialSource === 'self_gathered' && d.originalGoalPreserved === true;
  if (name === 'structure') return witness.method === 'native_block_readback' && Number.isInteger(d.blockCount) && d.blockCount > 0
    && d.ownedPlacedBlocks === d.blockCount && d.missingBlocks === 0 && d.stateMismatches === 0
    && d.clearanceViolations === 0 && d.remainingOwnedScaffolds === 0;
  if (name === 'material_provenance') return witness.method === 'native_material_ledger' && Number.isInteger(d.acquiredCount) && d.acquiredCount > 0 && d.externalInputCount === 0
    && d.gatherPickupDebitsVerified === true && d.craftSmeltDebitsVerified === true && d.ownedStorageVerified === true
    && d.nutritionSourceVerified === true && d.toolProgressionVerified === true && d.allRequiredMaterialsReconciled === true;
  if (name === 'bed') return witness.method === 'native_bed_cycle' && exactIds(d.cycles, contract.furniture.beds)
    && d.cycles.every(c => c.enteredSleep === true && c.serverOccupiedConfirmed === true && c.actualWakeConfirmed === true && c.timeCommands === 0);
  if (name === 'workbench') return witness.method === 'native_craft' && exactIds(d.cycles, contract.furniture.workbenches)
    && d.cycles.every(c => c.ownedStation === true && c.inputDebit === true && c.outputCredit === true && c.closedInventoryReadback === true);
  if (name === 'chest') return witness.method === 'native_container_roundtrip' && exactIds(d.cycles, contract.furniture.chests)
    && d.cycles.every(c => c.ownedStation === true && c.depositDebit === true && c.withdrawCredit === true && c.reopenedReadback === true && c.closedInventoryReadback === true);
  if (name === 'furnace') return witness.method === 'native_smelt' && exactIds(d.cycles, contract.furniture.furnaces)
    && d.cycles.every(c => c.ownedStation === true && c.inputDebit === true && c.fuelDebit === true && c.outputCredit === true && c.closedInventoryReadback === true);
  if (name === 'natural_enchantment_30') return witness.method === 'native_enchantment' && d.effectiveBookshelves === 15 && d.requiredLevel === 30 && d.optionIndex === 2
    && Number.isInteger(d.levelBefore) && d.levelBefore >= 30 && d.levelAfter === d.levelBefore - 3
    && Number.isInteger(d.pointsBefore) && d.pointsBefore >= 1395
    && Number.isInteger(d.lapisBefore) && d.lapisBefore >= 3 && d.lapisAfter === d.lapisBefore - 3
    && d.xpGrantCount === 0 && d.externalXpCount === 0 && d.xpOriginLedgerVerified === true
    && d.enchantedOutputNBTVerified === true && d.sourceItemCraftVerified === true && d.serverPersistedNBTVerified === true;
  if (name === 'natural_farm_cycle') return witness.method === 'native_crop_cycle' && d.tickMode === 'normal' && d.fertilizerUses === 0
    && d.timeCommands === 0 && d.farmlandMoisture === 7 && Number.isInteger(d.seedReserveBefore) && d.seedReserveBefore >= 0
    && Number.isInteger(d.seedReserveAfter) && d.seedReserveAfter >= d.seedReserveBefore && d.noSupplementarySeedWithinCycle === true
    && exactIds(d.cycles, contract.farmPlots, 'plotId') && d.cycles.every(c => c.ageMature === 7 && c.ageAfterReplant === 0
      && c.seedConsumedForReplant === 1 && Number.isInteger(c.wheatCollected) && c.wheatCollected >= 1
      && c.harvestInventoryReadback === true && c.replantServerReadback === true && c.boneMealUsed === 0);
  if (name === 'permanent_return') return witness.method === 'native_physical_readback' && exactIds(d.routes, contract.routes)
    && d.routes.every(r => r.outAndBackConfirmed === true && r.noTeleport === true) && d.returnedToOwnedCamp === true
    && d.actualDryGroundedCamp === true && d.finalInventoryReadback === true;
  return ['routes', 'riverbank', 'dock'].includes(name) && witness.method === 'native_physical_readback'
    && d.walkedOrObserved === true && d.noTeleport === true;
}
function receiptEnvelope(receipt, run, binding, authority, contract) {
  return receipt?.schema === 2 && receipt.authority === authority && receipt.taskId === run.context.taskId
    && receipt.runId === run.context.runId && receipt.generation === run.context.generation && receipt.worldId === run.context.worldId
    && receipt.bindingHash === bindingHash(binding) && receipt.sourceDigest === binding.sourceHash
    && receipt.planHash === binding.versionHash && receipt.profile === binding.profile && receipt.materialSource === 'self_gathered'
    && receipt.contractDigest === hash(contract) && typeof receipt.artifact?.id === 'string' && receipt.artifact.id
    && SHA.test(receipt.artifact.digest) && Number.isFinite(receipt.observedAt)
    && receipt.observedAt >= run.startedAt && receipt.observedAt <= run.finishedAt;
}
function evidenceGrade(evidence, run, binding, contract, verifyArtifact) {
  if (!eligible(run.context) || !receiptEnvelope(evidence?.client, run, binding, 'native_client', contract)
    || !requiredChecks(binding).every(name => validCheck(name, evidence.client.checks?.[name], binding, run, contract))) return null;
  const artifactMatches = receipt => {
    const { artifact, ...expected } = receipt;
    const result = verifyArtifact(copy(artifact), receipt.authority, copy(expected));
    return result?.digestMatches === true && result.evidenceMatches === true;
  };
  if (verifyArtifact && !artifactMatches(evidence.client)) return null;
  const server = evidence.server;
  const serverPass = receiptEnvelope(server, run, binding, 'saved_server', contract)
    && ['normalServerSave', 'savedWorldMatches', 'savedInventoryMatches', 'savedPositionMatches', 'naturalWorldUnmodified', 'functionalStateConfirmed',
      'seedCommitmentVerified', 'runtimeHashesMatch', 'serverStopped'].every(key => server.facts?.[key] === true)
    && server.facts.serverExitCode === 0 && server.facts.sourceDigest === binding.sourceHash
    && server.facts.planHash === binding.versionHash && (!verifyArtifact || artifactMatches(server));
  // Client-only evidence can enrich component records but cannot publish a
  // whole-house capability under the user's current natural acceptance gate.
  return serverPass ? 'native_server' : null;
}
function atomicWrite(filename, text) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${randomUUID()}.tmp`;
  let fd;
  try { fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, filename);
  } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function createHouseWholeAcceptance(options = {}) {
  const now = options.now || Date.now;
  const handles = new WeakMap();
  let events = []; let records = new Map(); let runRecords = new Map(); let health = 'ready';
  const authorityReady = () => typeof options.filename === 'string' && path.isAbsolute(options.filename)
    && ['seal', 'verifySeal', 'readAnchor', 'writeAnchor', 'getRuntime', 'validatePlan', 'runContext', 'isCurrent', 'nativeVerifier', 'verifyArtifact', 'contractFor']
      .every(name => typeof options[name] === 'function') && Array.isArray(options.allowedActionIds);
  if (!authorityReady()) health = 'authority_unavailable';
  const matchesRuntime = binding => {
    try {
      const runtime = options.getRuntime?.({ capabilityId: binding.capabilityId, profile: binding.profile, materialSource: 'self_gathered' });
      return runtime?.sourceHash === binding.sourceHash && runtime?.gameVersion === binding.gameVersion && runtime.materialSource === 'self_gathered';
    } catch (_) { return false; }
  };
  function rebuild(all) {
    const built = new Map(); const runs = new Map(); let previousHash = '0'.repeat(64); let lastAt = 0;
    for (let index = 0; index < all.length; index += 1) {
      const event = all[index];
      const { digest, ...unsigned } = event;
      if (event.sequence !== index + 1 || event.previousHash !== previousHash || hash(unsigned) !== digest
        || !Number.isFinite(event.at) || event.at < lastAt) throw error('capability_ledger_chain_invalid');
      previousHash = digest; lastAt = event.at;
      const data = event.data; const binding = normalizeBinding(data.binding); const id = bindingHash(binding);
      let record = built.get(id);
      if (event.type === 'registered') {
        if (record) throw error('capability_ledger_duplicate_script');
        const plan = normalizePlan(data.plan, binding, options.allowedActionIds, options.validatePlan);
        const contract = normalizeContract(data.contract, binding);
        if (hash(contract) !== hash(normalizeContract(options.contractFor(copy(binding), copy(plan)), binding))) throw error('house_whole_contract_changed');
        record = { binding, bindingHash: id, plan, contract, state: 'candidate', grade: 'unknown', validation: null,
          lastSuccessfulValidation: null, publishedValidation: null, publicationRevoked: false,
          publishedAt: null, quarantined: false, history: [] };
        built.set(id, record);
      } else if (!record) throw error('capability_ledger_unregistered_script');
      if (event.type === 'run_started') {
        const context = normalizeContext(data.context);
        if (runs.has(context.runId)) throw error('capability_ledger_run_replayed');
        runs.set(context.runId, { context, binding, startedAt: event.at, finishedAt: null, settled: false });
      } else if (['validated', 'failed', 'component', 'rejected', 'interrupted'].includes(event.type)) {
        const run = runs.get(data.runId);
        if (!run || run.settled || bindingHash(run.binding) !== id) throw error('capability_ledger_run_invalid');
        run.settled = true; run.finishedAt = event.at;
        if (event.type === 'validated') {
          const context = normalizeContext(data.context);
          if (contextIdentity(context) !== contextIdentity(run.context)) throw error('capability_ledger_context_changed');
          run.context = context;
          const grade = evidenceGrade(data.evidence, run, binding, record.contract);
          if (!grade) throw error('capability_ledger_validation_invalid');
          record.validation = { runId: data.runId, context, startedAt: run.startedAt, finishedAt: event.at, evidence: copy(data.evidence), grade };
          record.lastSuccessfulValidation = copy(record.validation);
          record.state = record.publishedValidation && !record.publicationRevoked ? 'published' : 'validated';
          record.grade = record.state === 'published' ? record.publishedValidation.grade : grade; record.quarantined = false;
        } else if (event.type === 'failed') {
          if (!eligible(normalizeContext(data.context)) || contextIdentity(data.context) !== contextIdentity(run.context)) throw error('capability_ledger_failure_scope_invalid');
          record.state = 'candidate'; record.grade = 'unknown'; record.quarantined = true; record.publicationRevoked = true;
        }
      } else if (event.type === 'published') {
        if (!['validated', 'published'].includes(record.state) || !record.validation || data.runId !== record.validation.runId) throw error('capability_ledger_publication_invalid');
        const keepStronger = !record.publicationRevoked && record.publishedValidation?.grade === 'native_server'
          && record.validation.grade === 'native_client';
        record.publishedValidation = copy(keepStronger ? record.publishedValidation : record.validation);
        record.state = 'published'; record.grade = record.publishedValidation.grade;
        record.publishedAt = event.at; record.quarantined = false; record.publicationRevoked = false;
      } else if (event.type !== 'registered') throw error('capability_ledger_event_unknown');
      record.history.push(copy(event));
    }
    return { built, runs };
  }
  function persist(next) {
    const payload = canonical({ schema: 2, events: next });
    const seal = options.seal(payload);
    if (typeof seal !== 'string' || !seal || options.verifySeal(payload, seal) !== true) throw error('capability_ledger_seal_invalid');
    (options.writeAtomic || atomicWrite)(options.filename, JSON.stringify({ payload, seal }) + '\n');
    options.writeAnchor({ sequence: next.length, digest: next.at(-1)?.digest || '0'.repeat(64) });
  }
  function commit(type, data) {
    if (health !== 'ready') throw error('capability_ledger_untrusted');
    const unsigned = { sequence: events.length + 1, at: now(), previousHash: events.at(-1)?.digest || '0'.repeat(64), type, data: copy(data) };
    const next = [...events, { ...unsigned, digest: hash(unsigned) }];
    const rebuilt = rebuild(next);
    try { persist(next); } catch (failure) { health = 'storage_failed'; throw failure; }
    events = next; records = rebuilt.built; runRecords = rebuilt.runs;
  }
  if (health === 'ready' && fs.existsSync(options.filename)) {
    try {
      const envelope = JSON.parse(fs.readFileSync(options.filename, 'utf8'));
      if (typeof envelope.payload !== 'string' || typeof envelope.seal !== 'string'
        || options.verifySeal(envelope.payload, envelope.seal) !== true) throw error('capability_ledger_seal_invalid');
      const payload = JSON.parse(envelope.payload);
      if (payload.schema !== 2 || !Array.isArray(payload.events) || canonical(payload) !== envelope.payload) throw error('capability_ledger_schema_invalid');
      const rebuilt = rebuild(payload.events); events = payload.events; records = rebuilt.built; runRecords = rebuilt.runs;
      const anchor = options.readAnchor();
      if (!anchor || !Number.isInteger(anchor.sequence) || anchor.sequence < 1 || anchor.sequence > events.length
        || events[anchor.sequence - 1].digest !== anchor.digest) throw error('capability_ledger_rollback_or_fork');
      if (anchor.sequence < events.length) options.writeAnchor({ sequence: events.length, digest: events.at(-1).digest });
      for (const run of [...runRecords.values()].filter(run => !run.settled)) commit('interrupted', { binding: run.binding,
        runId: run.context.runId, reason: 'host_restart_before_acceptance' });
    } catch (_) { health = 'ledger_integrity_failed'; records = new Map(); runRecords = new Map(); }
  } else if (health === 'ready' && options.readAnchor()) health = 'ledger_missing_with_trusted_anchor';
  const owned = run => !run.settled && options.isCurrent?.(run.reference) === true;
  const getRun = handle => { const run = handles.get(handle); if (!run || run.settled) throw error('capability_run_unknown_or_settled'); return run; };
  const finish = run => { run.settled = true; };
  function proofAvailable(record, validation = record?.publishedValidation || record?.validation) {
    if (!validation || typeof options.verifyArtifact !== 'function') return false;
    const run = { context: validation.context, startedAt: validation.startedAt, finishedAt: validation.finishedAt };
    try { return hash(record.contract) === hash(normalizeContract(options.contractFor(copy(record.binding), copy(record.plan)), record.binding))
      && evidenceGrade(validation.evidence, run, record.binding, record.contract, options.verifyArtifact) === validation.grade; }
    catch (_) { return false; }
  }
  function view(record) {
    if (!record) return { state: 'unknown', grade: 'unknown', eligible: false,
      reason: health === 'ready' ? 'capability_unknown' : health, history: [] };
    const valid = health === 'ready' && matchesRuntime(record.binding) && record.state === 'published' && !record.quarantined && proofAvailable(record);
    return copy({ ...record, eligible: valid, storedState: record.state, storedGrade: record.grade,
      grade: record.state === 'published' && !valid ? 'unknown' : record.grade,
      state: record.state === 'published' && !valid ? 'unknown' : record.state,
      reason: valid ? null : health !== 'ready' ? health : !matchesRuntime(record.binding) ? 'runtime_changed'
        : record.state === 'published' ? 'evidence_unavailable' : 'not_published' });
  }
  const authority = Object.freeze({
    register(binding, rawPlan) {
      if (health !== 'ready') throw error('capability_ledger_untrusted');
      binding = normalizeBinding(binding);
      if (!matchesRuntime(binding)) throw error('capability_source_changed');
      const plan = normalizePlan(rawPlan, binding, options.allowedActionIds, options.validatePlan);
      if (!records.has(bindingHash(binding))) commit('registered', { binding, plan, contract: normalizeContract(options.contractFor(copy(binding), copy(plan)), binding) });
      return view(records.get(bindingHash(binding)));
    },
    begin(binding, reference) {
      binding = normalizeBinding(binding);
      if (!records.has(bindingHash(binding)) || !matchesRuntime(binding)) throw error('capability_candidate_missing_or_stale');
      if (options.isCurrent?.(reference) !== true) throw error('capability_owner_missing');
      const context = normalizeContext(options.runContext(reference));
      if (context.sourceDigest !== binding.sourceHash || context.planHash !== binding.versionHash
        || context.profile !== binding.profile || context.materialSource !== binding.materialSource) throw error('house_whole_run_binding_mismatch');
      if (runRecords.has(context.runId)) throw error('capability_run_replayed');
      if ([...runRecords.values()].some(run => !run.settled && bindingHash(run.binding) === bindingHash(binding))) throw error('capability_run_already_active');
      const startedAt = now(); commit('run_started', { binding, context });
      const handle = Object.freeze({}); handles.set(handle, { reference, binding, context, startedAt, settled: false }); return handle;
    },
    async validate(handle) {
      const run = getRun(handle); if (run.validating) throw error('capability_validation_in_progress'); run.validating = true;
      try {
        if (!owned(run) || !matchesRuntime(run.binding)) throw error('capability_run_superseded_or_stale');
        const evidence = await options.nativeVerifier({ reference: run.reference, binding: copy(run.binding),
          taskId: run.context.taskId, runId: run.context.runId, generation: run.context.generation, worldId: run.context.worldId,
          sourceDigest: run.binding.sourceHash, bindingHash: bindingHash(run.binding),
          contract: copy(records.get(bindingHash(run.binding)).contract),
          requiredChecks: requiredChecks(run.binding), startedAt: run.startedAt });
        if (!owned(run) || !matchesRuntime(run.binding)) throw error('capability_run_superseded_or_stale');
        const context = normalizeContext(options.runContext(run.reference));
        if (contextIdentity(context) !== contextIdentity(run.context)) throw error('capability_run_context_changed');
        if (!eligible(context)) {
          commit('component', { binding: run.binding, runId: context.runId, reason: 'not_whole_public_empty_survival', context });
          return { accepted: false, grade: 'component' };
        }
        const grade = evidenceGrade(evidence, { context, startedAt: run.startedAt, finishedAt: now() }, run.binding, records.get(bindingHash(run.binding)).contract, options.verifyArtifact);
        if (!grade) { commit('failed', { binding: run.binding, runId: context.runId, context, reason: 'strict_native_evidence_incomplete' });
          return { accepted: false, grade: 'unknown', reason: 'strict_native_evidence_incomplete' }; }
        commit('validated', { binding: run.binding, runId: context.runId, context, evidence });
        return { accepted: true, grade };
      } catch (failure) {
        if (health === 'ready' && !runRecords.get(run.context.runId)?.settled) commit('rejected', { binding: run.binding,
          runId: run.context.runId, reason: failure.code || 'native_verifier_error' });
        return { accepted: false, grade: 'unknown', reason: failure.code || 'native_verifier_error' };
      } finally { finish(run); }
    },
    fail(handle, reason = 'native_task_failed') {
      const run = getRun(handle); const context = normalizeContext(options.runContext(run.reference));
      const actual = owned(run) && matchesRuntime(run.binding) && eligible(context) && contextIdentity(context) === contextIdentity(run.context);
      commit(actual ? 'failed' : 'component', { binding: run.binding, runId: run.context.runId, context, reason }); finish(run);
      return view(records.get(bindingHash(run.binding)));
    },
    publish(binding) {
      binding = normalizeBinding(binding); const record = records.get(bindingHash(binding));
      if (!matchesRuntime(binding) || !['validated', 'published'].includes(record?.state)
        || !proofAvailable(record, record.validation)) throw error('capability_not_validated');
      commit('published', { binding, runId: record.validation.runId }); return view(records.get(bindingHash(binding)));
    },
  });
  const query = Object.freeze({
    health: () => health,
    get(binding) { try { return view(records.get(bindingHash(binding))); } catch (_) { return view(null); } },
    resolve(target) {
      return [...records.values()].filter(record => family(record.binding) === family(target)
        && target.materialSource === 'self_gathered' && (!target.versionHash || target.versionHash === record.binding.versionHash) && view(record).eligible)
        .sort((a, b) => b.publishedAt - a.publishedAt || b.history.at(-1).sequence - a.history.at(-1).sequence)
        .map(view)[0] || null;
    },
    wholeLearningGate({ binding, plan, run } = {}) {
      try {
        binding = normalizeBinding(binding);
        const normalized = normalizePlan(plan, binding, options.allowedActionIds, options.validatePlan);
        const record = records.get(bindingHash(binding)), resolved = view(record), proof = record?.publishedValidation;
        if (!resolved.eligible || hash(normalized) !== binding.versionHash || !proof
          || !run || ['taskId', 'runId', 'worldId', 'generation'].some(key => run[key] !== proof.context[key])) {
          return { eligible: false, classification: 'pending', reason: 'house_whole_current_run_unverified' };
        }
        return { eligible: true, classification: 'whole_success', reference: {
          schema: 1, bindingHash: bindingHash(binding), sourceDigest: binding.sourceHash, planHash: binding.versionHash,
          contractDigest: hash(record.contract), taskId: proof.context.taskId, runId: proof.context.runId,
          worldId: proof.context.worldId, generation: proof.context.generation,
        } };
      } catch (_) { return { eligible: false, classification: 'pending', reason: 'house_whole_acceptance_unavailable' }; }
    },
    legacyBucketGate(bucket, { binding, plan } = {}) {
      try {
        const proof = bucket?.wholeAcceptance;
        if (!proof) return { eligible: false, classification: 'legacy_unverified', reason: 'house_whole_legacy_no_receipt' };
        const gate = query.wholeLearningGate({ binding, plan, run: proof });
        if (!gate.eligible || canonical(proof) !== canonical(gate.reference)
          || hash(normalizePlan(bucket.lastSuccessfulPlan, normalizeBinding(binding), options.allowedActionIds, options.validatePlan)) !== binding.versionHash) {
          return { eligible: false, classification: 'legacy_unverified', reason: 'house_whole_bucket_receipt_mismatch' };
        }
        return gate;
      } catch (_) { return { eligible: false, classification: 'legacy_unverified', reason: 'house_whole_bucket_receipt_mismatch' }; }
    },
    endGate() {
      const minimumGrade = 'native_server';
      const missing = FAMILIES.filter(key => { const [capabilityId, profile] = key.split(':');
        const record = query.resolve({ capabilityId, profile, materialSource: 'self_gathered' });
        return !record || minimumGrade === 'native_server' && record.grade !== 'native_server'; });
      return { state: 'closed', allowed: false, housePrerequisitesPassed: !missing.length, missing, minimumGrade,
        reason: missing.length ? 'four_whole_natural_houses_not_published' : 'end_capability_unimplemented' };
    },
    assertEndOperation(step, intent = '') {
      const operation = endOperationFor(step, intent);
      if (operation) throw Object.assign(error('capability_end_unavailable'), { operation, gate: query.endGate() });
      return true;
    },
    assertNativeEndTarget(target) {
      if (['ender_dragon', 'end_crystal'].includes(target?.name)) throw error('capability_end_unavailable'); return true;
    },
    assertNativeEndInteraction(context = {}) {
      if (['end_portal_frame', 'end_portal', 'nether_portal', 'end_gateway'].includes(context.blockName)
        || context.itemName === 'eye_of_ender' || END_ACTIONS.has(context.operation)
        || ['ignite_nether_portal', 'fill_end_portal'].includes(context.operation)) throw error('capability_end_unavailable');
      return true;
    },
    snapshot: () => copy({ schema: 2, arbitraryJavaScript: false, health, events, records: [...records.values()] }),
  });
  return Object.freeze({ authority, query });
}
function getHouseWholePlanDigest(raw) {
  if (!raw || !Array.isArray(raw.steps)) throw error('capability_plan_invalid');
  return hash({ mode: 'task', intent: raw.intent, goal: String(raw.goal || ''),
    steps: raw.steps.map(step => ({ skill: String(step?.skill || '').trim(), args: copy(step?.args || {}) })) });
}
module.exports = { createHouseWholeAcceptance, getHouseWholePlanDigest, bindingHash, hash, normalizePlan, requiredChecks, endOperationFor };
