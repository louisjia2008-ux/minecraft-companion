const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteJson } = require('./atomicJsonStore');
const { createSkillCatalog, digest, templateFor } = require('./skillCatalog');
const { skillSourceDigest } = require('./skillSourceDigest');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const HOUSE_CRITERIA = Object.freeze(['initialEmptyInventory', 'initialZeroExperience', 'experienceMatchesServer',
  'naturalNormalSurvival', 'noTaskTimeConsoleCommands', 'noDeath', 'inventoryMatchesServer', 'positionMatchesServer',
  'selfGatheredMaterialContract', 'actualNaturalMaterialEvidence', 'noUnexpectedProvider', 'publicTaskCompleted',
  'originalPublicProfilePlan', 'productionStructureAndFurniture', 'naturalFurnitureActualUse', 'runtimeSourceUnchanged',
  'serverNormalStop', 'savedOwnedUtilityConfirmed', 'savedNaturalMetadataConfirmed', 'savedCompleteBuilding',
  'savedPlayerConfirmed', 'noTaskOrVerificationConsoleCommands', 'nativeStagesAllPassed', 'noFatalOrInterrupt']);
function readJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 1048576) throw fail('skill_approval_file_invalid');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function approvals(file) {
  if (!fs.existsSync(file)) return { schemaVersion: 1, approvals: {} };
  const state = readJson(file);
  if (state.schemaVersion !== 1 || !state.approvals || Array.isArray(state.approvals)
    || typeof state.approvals !== 'object') throw fail('skill_approval_store_invalid');
  return state;
}
function nativeFilesCurrent(root, expected) {
  if (!expected || Array.isArray(expected) || !Object.keys(expected).length || Object.keys(expected).length > 512) return false;
  const directory = fs.realpathSync(path.join(root, 'node_modules'));
  return Object.entries(expected).every(([relative, sha]) => {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || !/^[a-f0-9]{64}$/.test(sha)) return false;
    const file = fs.realpathSync(path.join(directory, relative));
    return file.startsWith(directory + path.sep) && hash(fs.readFileSync(file)) === sha;
  });
}

// This fixed host-owned file is never populated by game/model/task JSON.
// Re-read at each lookup so removing/revoking approval takes effect immediately.
function createApprovedSkillVerifier({ file, runtimeRoot = path.resolve(__dirname, '../../..'), onError = () => {} }) {
  // One helper process executes one source/dependency snapshot. Restart after
  // source/package changes; approval removal is nevertheless checked each time.
  const nativeSnapshots = new Map();
  return (manifest, evidence) => {
    try {
      const id = digest(manifest), record = approvals(file).approvals[id];
      if (record?.status !== 'approved') return false;
      const nativeId = digest(record.nativeFiles);
      if (!nativeSnapshots.has(nativeId)) nativeSnapshots.set(nativeId, nativeFilesCurrent(runtimeRoot, record.nativeFiles));
      return nativeSnapshots.get(nativeId) === true && record.manifestId === id
        && record.sourceDigest === manifest.sourceDigest
        && record.minecraftVersion === manifest.minecraftVersion && record.dimension === manifest.dimension
        && record.nodeMajor === Number(process.versions.node.split('.')[0])
        && record.scope?.universalTerrainReliability === false
        && typeof record.approvalId === 'string' && evidence?.approvalId === record.approvalId
        && digest(evidence) === record.evidenceDigest;
    } catch (error) { onError(error); return false; }
  };
}

// Trusted local administration only. The caller supplies pinned evidence files;
// no registered game action or JSONL envelope exposes this function.
// First qualification format covers the actual self-gathered house workflow.
function approveHouseSkill({ runtimeRoot, catalogFile, approvalFile, candidateId,
  manifestFile, qaFile, wholeAuditFile, resultFile, expectedHashes, registry }) {
  if (!path.isAbsolute(catalogFile) || !catalogFile.endsWith('.skills.json') || !path.isAbsolute(approvalFile)
    || approvalFile !== catalogFile.slice(0, -'.skills.json'.length) + '.skill-approvals.json'
    || !/^[a-f0-9]{64}$/.test(candidateId || ''))
    throw fail('skill_approval_destination_invalid');
  const root = path.resolve(runtimeRoot), files = { manifestFile, qaFile, wholeAuditFile, resultFile }, parsed = {}, hashes = {};
  for (const [name, file] of Object.entries(files)) {
    if (!path.isAbsolute(file)) throw fail('skill_evidence_path_not_absolute');
    const bytes = fs.readFileSync(file); hashes[name] = hash(bytes);
    if (!/^[a-f0-9]{64}$/.test(expectedHashes?.[name] || '') || hashes[name] !== expectedHashes[name])
      throw fail('skill_evidence_hash_mismatch');
    parsed[name] = JSON.parse(bytes);
  }
  const { manifestFile: source, qaFile: qa, wholeAuditFile: whole, resultFile: result } = parsed;
  const sourceDigest = skillSourceDigest(root), empty = value => Array.isArray(value) && value.length === 0;
  if (path.resolve(source.candidate || '') !== root || !source.files || Array.isArray(source.files)) throw fail('skill_source_manifest_invalid');
  for (const [relative, expected] of Object.entries(source.files)) {
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || hash(fs.readFileSync(file)) !== expected) throw fail('skill_source_changed');
  }
  if (qa.status !== 'PASS_FULL_QA_ONLY' || qa.nodeExitCode !== 0 || qa.manifestSha256 !== hashes.manifestFile
    || qa.sourceDigest !== sourceDigest || path.resolve(qa.candidateRoot || '') !== root
    || qa.sourceCount !== Object.keys(source.files).length || !empty(qa.sourceMismatch) || !empty(qa.nativeMismatch)
    || !(qa.nativeCount > 0) || !(qa.counts?.tests > 0) || qa.counts.pass !== qa.counts.tests
    || qa.counts.fail !== 0 || qa.counts.cancelled !== 0 || qa.counts.skipped !== 0) throw fail('skill_full_regression_not_verified');
  if (whole.status !== 'CLOSED_RESULT_PASS_INDEPENDENT_SOURCE_NBT_MCA_RECHECK' || whole.integrityPassed !== true
    || whole.publicWholeHouseAcceptance !== true || whole.ownedJavaPidState !== 'ABSENT' || whole.originalNodeExitCode !== 0
    || whole.source?.immutableManifestSha256 !== hashes.manifestFile
    || whole.originalEvidence?.['result.json'] !== hashes.resultFile || !whole.checks || !Object.keys(whole.checks).length
    || Object.values(whole.checks).some(check => check.passed !== true)
    || !whole.criteria || HOUSE_CRITERIA.some(name => whole.criteria[name] !== true)
    || Object.values(whole.criteria).some(value => value !== true)) throw fail('skill_native_whole_not_verified');
  if (result.publicBuildingAcceptancePassed !== true || result.mode !== 'public' || result.task?.status !== 'completed'
    || result.task.intent !== 'build_furnished_house' || result.initial?.clientInventory?.length !== 0
    || String(result.seed) !== String(whole.metadata?.seed)) throw fail('skill_native_task_not_verified');
  const state = readJson(catalogFile), record = state.records?.[candidateId], manifest = record?.manifest;
  if (!record || record.status === 'revoked' || digest(manifest) !== candidateId || manifest.sourceDigest !== sourceDigest
    || manifest.template?.intent !== 'build_furnished_house' || manifest.minecraftVersion !== result.version
    || manifest.dimension !== 'overworld' || !Array.isArray(manifest.template.steps) || !manifest.template.steps.length
    || digest(templateFor(result.task.plan, registry)) !== digest(manifest.template)
    || manifest.template.steps.some(step => step.skill !== 'build_furnished_house_phase'
      || step.args?.materialSource !== 'self_gathered' || step.args?.profile !== result.profile
      || !registry.getActionDefinition(step.skill))) throw fail('skill_candidate_receipt_mismatch');
  const approved = approvals(approvalFile); // Corrupt stores are preserved, never reset.
  const modules = fs.realpathSync(path.join(root, 'node_modules')), nativeFiles = {};
  const baseline = whole.source.additionalSourceBaseline;
  if (!baseline?.files || baseline.fileCount !== qa.nativeCount || Object.keys(baseline.files).length !== qa.nativeCount)
    throw fail('skill_native_dependencies_not_verified');
  for (const [absolute, sha] of Object.entries(baseline.files)) {
    const real = fs.realpathSync(absolute);
    if (!real.startsWith(modules + path.sep)) throw fail('skill_native_dependency_path_invalid');
    nativeFiles[path.relative(modules, real).split(path.sep).join('/')] = sha;
  }
  if (!nativeFilesCurrent(root, nativeFiles)) throw fail('skill_native_dependency_changed');
  const approvalId = crypto.randomUUID(), evidence = { approvalId, qualification: 'trusted_host_full_regression_and_native_house',
    sourceDigest, hashes, worldSeed: String(result.seed), universalTerrainReliability: false };
  approved.approvals[candidateId] = { status: 'approved', manifestId: candidateId, approvalId,
    sourceDigest, minecraftVersion: manifest.minecraftVersion, dimension: manifest.dimension,
    nodeMajor: Number(process.versions.node.split('.')[0]), evidenceDigest: digest(evidence), nativeFiles,
    scope: { universalTerrainReliability: false, worldSeeds: [String(result.seed)],
      description: 'Full frozen regression and this actual house; fresh executor guards remain mandatory.' } };
  atomicWriteJson(approvalFile, approved);
  const catalog = createSkillCatalog({ file: catalogFile, registry, sourceDigest,
    validateEvidence: createApprovedSkillVerifier({ file: approvalFile, runtimeRoot: root }) });
  catalog.validate(candidateId, evidence); const enabled = catalog.enable(candidateId);
  return { status: enabled.status, id: candidateId, approvalId, scope: approved.approvals[candidateId].scope };
}

module.exports = { createApprovedSkillVerifier, approveHouseSkill, HOUSE_CRITERIA };
