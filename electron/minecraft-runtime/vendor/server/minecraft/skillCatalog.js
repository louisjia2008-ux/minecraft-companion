const fs = require('node:fs');
const crypto = require('node:crypto');
const { atomicWriteJson } = require('./atomicJsonStore');

const PARAMS = new Set(['count', 'playerName', 'x', 'y', 'z', 'distance', 'label']);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));

function templateFor(plan, registry) {
  const actions = new Map(registry.listActions().map(a => [a.actionId, a]));
  if (!plan?.intent || !Array.isArray(plan.steps) || !plan.steps.length) throw new Error('invalid_skill_plan');
  const parameters = [];
  const steps = plan.steps.map((step, index) => {
    if (!actions.has(step.skill)) throw new Error('unregistered_skill');
    const args = copy(step.args || {});
    for (const key of Object.keys(args)) if (PARAMS.has(key)) {
      parameters.push({ step: index, name: key, type: typeof args[key],
        ...(key === 'count' ? { integer: true, minimum: 1, maximum: step.skill === 'craft_item' ? 32 : 256 } : {}) });
      delete args[key];
    }
    return { skill: step.skill, args };
  });
  return { intent: plan.intent, steps, parameters, postTaskMode: plan.postTaskMode || null };
}

// This is a JSON action catalog, never executable JavaScript. Promotion belongs
// to a trusted host verifier, not to task JSON, model output or a log sentence.
function createSkillCatalog({ file, registry, sourceDigest, validateEvidence, onError = () => {} }) {
  let state = { schemaVersion: 1, records: {} };
  let readable = true;
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw.schemaVersion !== 1 || !raw.records || typeof raw.records !== 'object') throw new Error('invalid_skill_catalog');
      state = raw;
    } catch (error) { readable = false; onError(error); }
  }
  const save = () => { if (!readable) throw new Error('skill_catalog_unreadable_preserved'); atomicWriteJson(file, state); };
  const checked = record => record && digest(record.manifest) === record.id &&
    record.manifest.sourceDigest === sourceDigest && typeof validateEvidence === 'function' &&
    validateEvidence(copy(record.manifest), copy(record.evidence)) === true;

  function recordCandidate(plan, context = {}) {
    const template = templateFor(plan, registry);
    const version = String(context.minecraftVersion || 'unknown');
    const manifest = { schemaVersion: 1, template, sourceDigest, minecraftVersion: version,
      dimension: String(context.dimension || 'unknown'),
      permissions: [...new Set(template.steps.map(s => s.skill))],
      contracts: template.steps.map(s => {
        const action = registry.getActionDefinition(s.skill);
        return { skill: s.skill, requiredArgs: action?.requiredArgs || [], watchdog: action?.watchdog || null,
          recovery: action?.recovery || null, primitive: action?.primitive || null };
      }),
      verification: 'actual_game_state_and_registered_executor',
      applicability: 'only_the_validated_version_dimension_and_regression_scope' };
    const id = digest(manifest);
    if (!state.records[id]) state.records[id] = { id, manifest, status: 'candidate', createdAt: Date.now(),
      observations: [], evidence: null };
    const record = state.records[id];
    record.observations = [...record.observations, { taskId: String(context.taskId || ''),
      outcome: String(context.outcome || ''), wholeStatus: String(context.wholeStatus || ''), at: Date.now() }].slice(-16);
    save(); return copy(record);
  }
  function validate(id, evidence) {
    const record = state.records[id];
    if (!record || record.status === 'revoked') throw new Error('candidate_unavailable');
    const proposed = { ...record, evidence };
    if (!checked(proposed) || record.manifest.minecraftVersion === 'unknown' || record.manifest.dimension === 'unknown')
      throw new Error('regression_evidence_not_verified');
    record.evidence = copy(evidence); record.status = 'validated'; save(); return copy(record);
  }
  function enable(id) {
    const record = state.records[id];
    if (record?.status !== 'validated' || !checked(record)) throw new Error('skill_not_validated');
    record.status = 'enabled'; save(); return copy(record);
  }
  function revoke(id, reason) {
    const record = state.records[id];
    if (!record) throw new Error('candidate_unavailable');
    record.status = 'revoked'; record.reason = String(reason || 'revoked'); save();
  }
  function find(plan, context = {}) {
    const template = templateFor(plan, registry);
    for (const record of Object.values(state.records)) {
      if (record.status !== 'enabled' || record.manifest.minecraftVersion !== context.minecraftVersion ||
          record.manifest.dimension !== context.dimension || digest(record.manifest.template) !== digest(template)) continue;
      try { if (checked(record)) return copy(record); } catch (error) { onError(error); }
    }
    return null;
  }
  return { recordCandidate, validate, enable, revoke, find, snapshot: () => copy(state) };
}

module.exports = { createSkillCatalog, templateFor, digest };
