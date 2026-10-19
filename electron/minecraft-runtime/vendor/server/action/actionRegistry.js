const { getHouseWholePlanDigest } = require('../minecraft/houseWholeAcceptance');
const { FURNISHED_HOUSE_PHASES, normalizeFurnishedHouseProfile } = require('../minecraft/furnishedHouseBlueprints');

function cloneSerializable(value, fallback = null) {
  if (value == null) {
    return fallback;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

function limitArray(items, limit) {
  if (!Array.isArray(items)) {
    return [];
  }
  const nextLimit = Math.max(0, Number(limit) || 0);
  if (!nextLimit) {
    return [];
  }
  return items.slice(-nextLimit);
}

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.min(max, Math.max(min, numeric));
}

const CONTINUOUS_ACTIONS = new Set([
  "follow_player",
  "escort_player",
  "attack_hostile",
]);

const ESTATE_PROFILES = Object.freeze(['medieval_castle', 'riverside_villa']);

function isIntegerPosition(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    ['x', 'y', 'z'].every((key) => Number.isInteger(value[key])));
}

function getEstateStep(plan = {}) {
  return plan?.steps?.find((step) => step?.skill === 'build_estate') || null;
}

function getConstructionMaterialSource(step = {}) {
  const args = step.args || {};
  if (args.materialSource === 'self_gathered' && args.useNearbySupplyChests !== true) return 'self_gathered';
  if (step.skill === 'build_estate' && args.useNearbySupplyChests === true &&
      (args.materialSource === undefined || args.materialSource === 'external_depots')) return 'external_depots';
  // Old inventory fixtures do not establish autonomous acquisition. Keep them
  // executable, but give their learning records a separate, unverified identity.
  return 'legacy_inventory';
}

function getConstructionStep(plan = {}) {
  return getEstateStep(plan) || plan?.steps?.find((step) => step?.skill === 'build_furnished_house_phase') || null;
}

function constructionStepsMatch(template, fresh) {
  return Boolean(template && fresh && validateStep(template).valid && validateStep(fresh).valid &&
    template.skill === fresh.skill && template.args?.profile === fresh.args?.profile &&
    getConstructionMaterialSource(template) === getConstructionMaterialSource(fresh));
}

// Host callbacks are executable authority, never planner/checkpoint JSON.
function isSelfGatheredConstruction(plan = {}) {
  return ['build_furnished_house', 'build_estate'].includes(plan?.intent)
    && getConstructionMaterialSource(getConstructionStep(plan) || {}) === 'self_gathered';
}
function wholeReferenceValid(reference, plan) {
  const sha = /^[a-f0-9]{64}$/;
  try { return reference?.schema === 1 && ['bindingHash', 'sourceDigest', 'planHash', 'contractDigest'].every(key => sha.test(reference[key]))
    && ['taskId', 'runId', 'worldId'].every(key => typeof reference[key] === 'string' && reference[key])
    && Number.isSafeInteger(reference.generation) && reference.generation >= 1 && reference.planHash === getHouseWholePlanDigest(plan); }
  catch (_) { return false; }
}
function wholeTaskLearningGate(task, context = {}) {
  try {
    const result = typeof context.wholeLearningGate === 'function' ? context.wholeLearningGate(task) : null;
    const plan = task.completionPlan || task.plan;
    return result?.eligible === true && wholeReferenceValid(result.reference, plan)
      && result.reference.taskId === task.taskId && result.reference.generation === task.executionGeneration
      ? result : { eligible: false, classification: 'pending', reason: result?.reason || 'house_whole_acceptance_pending' };
  } catch (_) { return { eligible: false, classification: 'pending', reason: 'house_whole_acceptance_unavailable' }; }
}
function storedWholeLearningGate(bucket, plan, context = {}) {
  try {
    const result = typeof context.legacyBucketGate === 'function' ? context.legacyBucketGate(bucket, plan) : null;
    return result?.eligible === true && wholeReferenceValid(result.reference, plan)
      && wholeReferenceValid(bucket.wholeAcceptance, bucket.lastSuccessfulPlan)
      && Object.keys(result.reference).length === Object.keys(bucket.wholeAcceptance).length
      && Object.keys(result.reference).every(key => result.reference[key] === bucket.wholeAcceptance[key])
      ? result : { eligible: false, classification: 'legacy_unverified', reason: result?.reason || 'house_whole_legacy_unverified' };
  } catch (_) { return { eligible: false, classification: 'legacy_unverified', reason: 'house_whole_acceptance_unavailable' }; }
}
function getTaskScriptPlanTemplate(bucket, plan, context = {}) {
  if (!bucket?.lastSuccessfulPlan || !(Number(bucket.success || 0) > 0)) return null;
  const selfGathered = isSelfGatheredConstruction(plan) || isSelfGatheredConstruction(bucket.lastSuccessfulPlan);
  if (selfGathered ? !storedWholeLearningGate(bucket, plan, context).eligible : bucket.reusable === false) return null;
  return bucket.lastSuccessfulPlan;
}
function revalidateWholeLearningBucket(bucket, context) {
  const plan = bucket.lastSuccessfulPlan || bucket.templatePlan;
  if (!isSelfGatheredConstruction(plan)) return bucket;
  const result = storedWholeLearningGate(bucket, plan, context);
  bucket.wholeLearningStatus = result.eligible ? 'whole_success' : bucket.lastSuccessfulPlan ? 'legacy_unverified' : 'pending';
  // For self builds this is derived from currently verified evidence. A host
  // outage must not permanently erase a still valid successful script.
  bucket.reusable = result.eligible;
  return bucket;
}

const SMALL_HOUSE_PLAYBOOK_VERSION = 1;
const SMALL_HOUSE_PHASES = Object.freeze({
  inspect_inventory: {
    label: "检查背包",
    stageKind: "prepare",
  },
  select_site: {
    label: "选择建造点",
    stageKind: "prepare",
  },
  prepare_materials: {
    label: "准备木材",
    stageKind: "prepare",
  },
  clear_site: {
    label: "清理地基",
    stageKind: "build",
  },
  place_floor: {
    label: "放置地板",
    stageKind: "build",
  },
  place_walls: {
    label: "搭建墙体",
    stageKind: "build",
  },
  place_roof: {
    label: "封顶",
    stageKind: "build",
  },
  verify: {
    label: "最终校验",
    stageKind: "verify",
  },
});

function getSmallHousePhaseSpec(phase = "") {
  return SMALL_HOUSE_PHASES[String(phase || "").trim()] || null;
}

function createSmallHousePlaybookSteps(payload = {}) {
  const material = String(payload.material || "any_planks").trim() || "any_planks";
  const width = clamp(Number(payload.width) || 3, 3, 3);
  const depth = clamp(Number(payload.depth) || 3, 3, 3);
  const height = clamp(Number(payload.height) || 2, 2, 2);
  const baseArgs = {
    playbookVersion: SMALL_HOUSE_PLAYBOOK_VERSION,
    material,
    width,
    depth,
    height,
    structure: "small_house",
  };
  return Object.keys(SMALL_HOUSE_PHASES).map((phase) =>
    createActionStep("build_small_house_phase", {
      ...baseArgs,
      phase,
      label: SMALL_HOUSE_PHASES[phase].label,
    })
  );
}

const FURNISHED_HOUSE_LABELS = Object.freeze({
  inspect_inventory: '检查房屋材料', select_site: '选择安全建造点', prepare_materials: '补齐建材和家具',
  clear_site: '清理地基和施工空间', floor: '铺设木石地板', frame: '搭建木柱框架',
  walls: '搭建墙体', windows: '安装玻璃窗', roof: '建造双坡屋顶和山墙',
  furniture: '布置室内家具', finish: '安装房门照明并清理脚手架', verify: '核验完整房屋与家具',
});

function createFurnishedHousePlaybookSteps(payload = {}) {
  const profile = normalizeFurnishedHouseProfile(payload.profile || 'cottage');
  return FURNISHED_HOUSE_PHASES.map((phase) => createActionStep('build_furnished_house_phase', {
    schema: 2, profile, phase, label: FURNISHED_HOUSE_LABELS[phase],
    ...(Object.prototype.hasOwnProperty.call(payload, 'materialSource')
      ? (payload.materialSource === undefined ? {} : { materialSource: payload.materialSource })
      : { materialSource: 'self_gathered' }),
    ...(payload.anchor ? { anchor: cloneSerializable(payload.anchor) } : {}),
  }));
}

const ACTION_DEFINITIONS = Object.freeze({
  follow_player: {
    actionId: "follow_player",
    contractType: "continuous",
    primitive: "pathfinder_follow",
    requiredArgs: [],
    defaultArgs: {
      distance: 2,
    },
    learnableArgs: ["distance", "range", "playerName", "once", "repath"],
    watchdog: {
      idleTimeoutMs: 12000,
      hardTimeoutMs: 180000,
      label: "跟随步骤",
      continuous: true,
    },
    recovery: {
      resetOn: ["executor_stalled", "movement_preempted", "timeout", "step_timeout", "no_path"],
      strategy: "continuous_follow_recover",
    },
    revision: {
      strategy: "follow_revision",
    },
    learning: {
      strategy: "move_adaptation",
    },
  },
  escort_player: {
    actionId: "escort_player",
    contractType: "continuous",
    primitive: "escort_combat_loop",
    requiredArgs: [],
    defaultArgs: {
      distance: 3,
      hostileRadius: 10,
      leashDistance: 8,
    },
    learnableArgs: ["playerName", "distance", "hostileRadius", "leashDistance", "guardScanMode"],
    watchdog: {
      idleTimeoutMs: 12000,
      hardTimeoutMs: 180000,
      label: "护卫步骤",
      continuous: true,
    },
    recovery: {
      resetOn: ["executor_stalled", "movement_preempted", "timeout", "step_timeout", "no_path"],
      strategy: "continuous_escort_recover",
    },
    revision: {
      strategy: "escort_revision",
      skipStageRevisionOn: ["no_hostile_in_range"],
      skipRecoveryOn: ["no_hostile_in_range"],
    },
    learning: {
      strategy: "escort_adaptation",
    },
  },
  attack_hostile: {
    actionId: "attack_hostile",
    contractType: "continuous",
    primitive: "combat_loop",
    requiredArgs: [],
    defaultArgs: {
      maxDistance: 12,
      leashDistance: 8,
    },
    learnableArgs: ["maxDistance", "leashDistance", "timeoutMs"],
    watchdog: {
      idleTimeoutMs: 12000,
      hardTimeoutMs: 60000,
      label: "战斗步骤",
      continuous: true,
    },
    recovery: {
      resetOn: ["executor_stalled", "movement_preempted", "timeout", "step_timeout", "no_path"],
      strategy: "combat_loop_recover",
    },
    revision: {
      strategy: "combat_revision",
    },
  },
  go_to_position: {
    actionId: "go_to_position",
    contractType: "bounded",
    primitive: "pathfinder_goto",
    requiredArgs: ["x", "y", "z"],
    defaultArgs: {
      range: 1,
    },
    learnableArgs: ["x", "y", "z", "range", "repath"],
    watchdog: {
      idleTimeoutMs: 12000,
      hardTimeoutMs: 45000,
      label: "移动步骤",
      continuous: false,
    },
    recovery: {
      resetOn: ["executor_stalled", "movement_preempted", "timeout", "step_timeout", "no_path"],
      strategy: "movement_recover",
    },
    revision: {
      strategy: "movement_revision",
    },
    learning: {
      strategy: "move_adaptation",
    },
  },
  mine_resource: {
    actionId: "mine_resource",
    contractType: "bounded",
    primitive: "physical_dig",
    requiredArgs: ["block", "count"],
    learnableArgs: ["block", "count", "maxDistance", "label", "searchStrategy"],
    watchdog: {
      idleTimeoutMs: 16000,
      hardTimeoutMs: 150000,
      label: "采集步骤",
      continuous: false,
    },
    recovery: {
      resetOn: ["executor_stalled", "timeout", "step_timeout", "no_path", "insufficient_material"],
      strategy: "gather_recover",
    },
    revision: {
      strategy: "gather_revision",
    },
    learning: {
      strategy: "gather_adaptation",
    },
  },
  gather_wood: {
    actionId: "gather_wood",
    contractType: "bounded",
    primitive: "physical_dig",
    requiredArgs: ["block", "count"],
    defaultArgs: {
      block: "wood",
      label: "木头",
    },
    learnableArgs: ["block", "count", "maxDistance", "label"],
    watchdog: {
      idleTimeoutMs: 16000,
      hardTimeoutMs: 150000,
      label: "采集步骤",
      continuous: false,
    },
    recovery: {
      resetOn: ["executor_stalled", "timeout", "step_timeout", "no_path", "insufficient_material"],
      strategy: "gather_recover",
    },
    revision: {
      strategy: "gather_revision",
    },
    learning: {
      strategy: "gather_adaptation",
    },
  },
  harvest_crops: {
    actionId: "harvest_crops",
    contractType: "bounded",
    primitive: "crop_harvest",
    requiredArgs: [],
    defaultArgs: {
      crops: ["wheat", "carrots", "potatoes"],
      count: 6,
      maxDistance: 20,
      replant: true,
    },
    learnableArgs: ["crops", "count", "maxDistance", "replant"],
    watchdog: {
      idleTimeoutMs: 16000,
      hardTimeoutMs: 120000,
      label: "农作物收割步骤",
      continuous: false,
    },
    recovery: {
      resetOn: ["executor_stalled", "timeout", "step_timeout", "no_path"],
      strategy: "crop_harvest_recover",
    },
    revision: {
      strategy: "crop_harvest_revision",
      skipStageRevisionOn: ["crop_not_ready"],
      skipRecoveryOn: ["crop_not_ready"],
    },
    learning: {
      strategy: "crop_harvest_adaptation",
    },
  },
  plant_crops: {
    actionId: "plant_crops",
    contractType: "bounded",
    primitive: "crop_planting",
    requiredArgs: [],
    defaultArgs: {
      crops: ["wheat", "carrots", "potatoes"],
      count: 6,
      maxDistance: 20,
    },
    learnableArgs: ["crops", "count", "maxDistance"],
    watchdog: {
      idleTimeoutMs: 16000,
      hardTimeoutMs: 120000,
      label: "农田补种步骤",
      continuous: false,
    },
    recovery: {
      resetOn: ["executor_stalled", "timeout", "step_timeout", "no_path", "insufficient_material"],
      strategy: "crop_planting_recover",
    },
    revision: {
      strategy: "crop_planting_revision",
    },
    learning: {
      strategy: "crop_planting_adaptation",
    },
  },
  collect_block: {
    actionId: "collect_block",
    contractType: "bounded",
    primitive: "physical_dig",
    requiredArgs: ["block", "count"],
    learnableArgs: ["block", "count", "maxDistance", "label"],
    watchdog: {
      idleTimeoutMs: 16000,
      hardTimeoutMs: 150000,
      label: "采集步骤",
      continuous: false,
    },
    recovery: {
      resetOn: ["executor_stalled", "timeout", "step_timeout", "no_path", "insufficient_material"],
      strategy: "gather_recover",
    },
    revision: {
      strategy: "gather_revision",
    },
    learning: {
      strategy: "gather_adaptation",
    },
  },
  craft_item: {
    actionId: "craft_item",
    contractType: "bounded",
    primitive: "crafting",
    requiredArgs: ["item", "count"],
    defaultArgs: {
      count: 1,
    },
    learnableArgs: ["item", "count"],
    watchdog: {
      idleTimeoutMs: 15000,
      hardTimeoutMs: 90000,
      label: "准备步骤",
      continuous: false,
    },
    recovery: {
      resetOn: ["executor_stalled", "timeout", "step_timeout", "insufficient_material"],
      strategy: "craft_recover",
    },
    revision: {
      strategy: "craft_revision",
      prepStrategy: "none",
    },
  },
  smelt_item: {
    actionId: "smelt_item",
    contractType: "bounded",
    primitive: "smelting",
    requiredArgs: ["inputItems", "output", "count"],
    defaultArgs: {
      count: 1,
    },
    learnableArgs: ["inputItems", "output", "count"],
    watchdog: {
      idleTimeoutMs: 15000,
      hardTimeoutMs: 120000,
      label: "冶炼步骤",
      continuous: false,
    },
    recovery: {
      resetOn: ["executor_stalled", "timeout", "step_timeout", "insufficient_material"],
      strategy: "smelt_recover",
    },
    revision: {
      strategy: "smelt_revision",
      prepStrategy: "none",
    },
  },
  build_structure: {
    actionId: "build_structure",
    contractType: "bounded",
    primitive: "block_placement",
    requiredArgs: ["material"],
    learnableArgs: ["material", "width", "depth", "height", "style", "position", "resumeMode"],
    watchdog: {
      idleTimeoutMs: 18000,
      hardTimeoutMs: 240000,
      label: "建造步骤",
      continuous: false,
    },
    recovery: {
      resetOn: ["executor_stalled", "timeout", "step_timeout", "no_path", "insufficient_material", "generic_failure"],
      strategy: "build_recover",
    },
    revision: {
      strategy: "build_revision",
      prepStrategy: "build_material_bootstrap",
    },
    learning: {
      strategy: "build_adaptation",
    },
  },
  build_small_house_phase: {
    actionId: "build_small_house_phase",
    contractType: "bounded",
    primitive: "small_house_playbook",
    requiredArgs: ["phase"],
    defaultArgs: {
      playbookVersion: SMALL_HOUSE_PLAYBOOK_VERSION,
      material: "any_planks",
      width: 3,
      depth: 3,
      height: 2,
      structure: "small_house",
    },
    learnableArgs: ["phase", "material", "width", "depth", "height", "anchor", "resumeMode"],
    watchdog: {
      idleTimeoutMs: 22000,
      hardTimeoutMs: 180000,
      label: "小木屋步骤",
      continuous: false,
    },
    recovery: {
      resetOn: ["executor_stalled", "timeout", "step_timeout", "no_path", "insufficient_material", "generic_failure"],
      strategy: "small_house_playbook_recover",
    },
    revision: {
      strategy: "small_house_playbook_revision",
      prepStrategy: "none",
    },
    learning: {
      strategy: "playbook_phase_adaptation",
    },
  },
  build_furnished_house_phase: {
    actionId: 'build_furnished_house_phase', contractType: 'bounded', primitive: 'furnished_house_playbook',
    requiredArgs: ['phase', 'profile'], defaultArgs: { schema: 2, profile: 'cottage' },
    learnableArgs: ['phase', 'profile', 'anchor', 'resumeMode'],
    watchdog: { idleTimeoutMs: 30000, hardTimeoutMs: 1800000, label: '完整小屋步骤', continuous: false },
    recovery: { resetOn: ['executor_stalled', 'timeout', 'step_timeout', 'no_path', 'insufficient_material', 'generic_failure', 'completion_verification_failed'], strategy: 'furnished_house_playbook_recover' },
    revision: { strategy: 'furnished_house_playbook_revision', prepStrategy: 'none' },
    learning: { strategy: 'playbook_phase_adaptation' },
  },
  build_estate: {
    actionId: 'build_estate', contractType: 'bounded', primitive: 'estate_builder',
    requiredArgs: ['profile'], defaultArgs: { schema: 1, useNearbySupplyChests: false },
    learnableArgs: [],
    watchdog: { idleTimeoutMs: 30000, hardTimeoutMs: 7200000, label: '完整庄园建造', continuous: false },
    recovery: { resetOn: ['executor_stalled', 'timeout', 'step_timeout', 'no_path', 'generic_failure', 'completion_verification_failed'], strategy: 'estate_checkpoint_recover' },
    revision: { strategy: 'estate_checkpoint_revision', prepStrategy: 'none' },
  },
  deposit_items: {
    actionId: "deposit_items",
    contractType: "bounded",
    primitive: "container_io",
    requiredArgs: [],
    learnableArgs: ["item", "items", "count", "maxDistance"],
    watchdog: {
      idleTimeoutMs: 15000,
      hardTimeoutMs: 90000,
      label: "准备步骤",
      continuous: false,
    },
    recovery: {
      resetOn: ["executor_stalled", "timeout", "step_timeout", "no_path"],
      strategy: "container_recover",
    },
  },
  withdraw_items: {
    actionId: "withdraw_items",
    contractType: "bounded",
    primitive: "container_io",
    requiredArgs: [],
    defaultArgs: {
      count: 1,
    },
    learnableArgs: ["item", "items", "count", "maxDistance"],
    watchdog: {
      idleTimeoutMs: 15000,
      hardTimeoutMs: 90000,
      label: "准备步骤",
      continuous: false,
    },
    recovery: {
      resetOn: ["executor_stalled", "timeout", "step_timeout", "no_path"],
      strategy: "container_recover",
    },
  },
  ensure_infrastructure: {
    actionId: "ensure_infrastructure",
    contractType: "bounded",
    primitive: "infrastructure",
    requiredArgs: [],
    learnableArgs: ["kind", "item", "block", "count"],
    watchdog: {
      idleTimeoutMs: 15000,
      hardTimeoutMs: 90000,
      label: "准备步骤",
      continuous: false,
    },
    recovery: {
      resetOn: ["executor_stalled", "timeout", "step_timeout", "insufficient_material"],
      strategy: "infrastructure_recover",
    },
  },
  maintain_self: {
    actionId: "maintain_self",
    contractType: "bounded",
    primitive: "self_maintenance",
    requiredArgs: ["action"],
    learnableArgs: ["action", "maxDistance", "range", "waitMs", "timeoutMs", "minFood"],
    watchdog: {
      idleTimeoutMs: 15000,
      hardTimeoutMs: 120000,
      label: "自维护步骤",
      continuous: false,
    },
    recovery: {
      resetOn: ["executor_stalled", "timeout", "step_timeout", "no_path", "insufficient_material"],
      strategy: "maintain_self_recover",
    },
    revision: {
      strategy: "maintain_self_revision",
      prepStrategy: "none",
    },
  },
});

function getActionDefinition(skill = "") {
  return ACTION_DEFINITIONS[String(skill || "").trim()] || null;
}

function getActionContractType(skill = "", args = {}) {
  if (String(skill || "").trim() === "follow_player" && args?.once === true) {
    return "bounded";
  }
  return CONTINUOUS_ACTIONS.has(String(skill || "").trim()) ? "continuous" : "bounded";
}

function validateStep(step = {}) {
  const skill = String(step?.skill || "").trim();
  const definition = getActionDefinition(skill);
  const defaultArgs =
    definition?.defaultArgs && typeof definition.defaultArgs === "object"
      ? cloneSerializable(definition.defaultArgs, {}) || {}
      : {};
  const args = {
    ...defaultArgs,
    ...(step?.args && typeof step.args === "object" ? step.args : {}),
  };
  if (!definition) {
    return {
      valid: false,
      errors: [`未注册的动作: ${skill || "unknown"}`],
    };
  }
  const errors = [];
  for (const key of definition.requiredArgs || []) {
    const value = args[key];
    if (value == null || (typeof value === "string" && !value.trim())) {
      errors.push(`缺少参数 ${key}`);
    }
  }
  if (skill === 'build_furnished_house_phase') {
    if (!FURNISHED_HOUSE_PHASES.includes(args.phase)) errors.push(`未知房屋阶段: ${args.phase}`);
    if (!['cottage', 'enchanting_library'].includes(args.profile)) errors.push(`未知房屋款式: ${args.profile}`);
    if (args.schema !== 2) errors.push('完整房屋需要 schema=2');
    if (args.materialSource !== undefined && args.materialSource !== 'self_gathered') errors.push('完整房屋的材料来源必须为 self_gathered');
    if (args.useNearbySupplyChests === true || (Array.isArray(args.depots) && args.depots.length)) errors.push('完整房屋不能使用外部补给箱');
    if (args.anchor != null && !['x', 'y', 'z'].every((key) => Number.isInteger(args.anchor[key]))) {
      errors.push('房屋锚点必须为整数 x/y/z');
    }
  }
  if (skill === 'build_estate') {
    if (args.schema !== 1) errors.push('庄园建造需要 schema=1');
    if (!ESTATE_PROFILES.includes(args.profile)) errors.push(`未知庄园款式: ${args.profile}`);
    if (args.anchor !== undefined && !isIntegerPosition(args.anchor)) errors.push('庄园锚点必须为整数 x/y/z');
    if (args.depots !== undefined && (!Array.isArray(args.depots) || args.depots.length > 8 || !args.depots.every(isIntegerPosition))) {
      errors.push('补给箱坐标必须为最多8个整数 x/y/z');
    }
    if (typeof args.useNearbySupplyChests !== 'boolean') errors.push('使用附近补给箱必须为布尔值');
    if (args.materialSource !== undefined && !['self_gathered', 'external_depots'].includes(args.materialSource)) errors.push('未知庄园材料来源');
    if (args.materialSource !== undefined && args.materialSource !== (args.useNearbySupplyChests ? 'external_depots' : 'self_gathered')) errors.push('庄园材料来源与补给箱权限冲突');
  }
  return {
    valid: errors.length === 0,
    errors,
  };
}

function compileStep(step = {}) {
  const skill = String(step?.skill || "").trim();
  const definition = getActionDefinition(skill);
  const defaultArgs =
    definition?.defaultArgs && typeof definition.defaultArgs === "object"
      ? cloneSerializable(definition.defaultArgs, {}) || {}
      : {};
  const args = {
    ...defaultArgs,
    ...(step?.args && typeof step.args === "object" ? cloneSerializable(step.args, {}) || {} : {}),
  };
  const validation = validateStep({
    ...step,
    args,
  });
  return {
    actionId: definition?.actionId || skill || "unknown_action",
    contractType: getActionContractType(skill, args),
    primitive: definition?.primitive || "unknown",
    requiredArgs: cloneSerializable(definition?.requiredArgs || [], []) || [],
    learnableArgs: cloneSerializable(definition?.learnableArgs || [], []) || [],
    watchdog: cloneSerializable(definition?.watchdog || null, null),
    recovery: cloneSerializable(definition?.recovery || null, null),
    validationErrors: validation.errors || [],
    valid: validation.valid === true,
    skill,
    args,
  };
}

function createActionStep(skill = "", args = {}) {
  const normalizedSkill = String(skill || "").trim();
  const step = {
    skill: normalizedSkill,
    args: args && typeof args === "object" ? cloneSerializable(args, {}) || {} : {},
  };
  return {
    ...step,
    action: compileStep(step),
  };
}

function createPostTaskDirective(mode = "", args = {}) {
  const normalizedMode = String(mode || "").trim();
  if (!normalizedMode) {
    return {
      postTaskMode: null,
      postTaskArgs: null,
    };
  }
  const step = createActionStep(normalizedMode, args);
  return {
    postTaskMode: normalizedMode,
    postTaskArgs: cloneSerializable(step.args, {}) || {},
  };
}

function getPreparationDescriptor(step = {}, context = {}) {
  const compiled = step?.action && typeof step.action === "object" ? step.action : compileStep(step);
  const actionId = String(compiled?.actionId || step?.skill || "").trim();
  const args = step?.args || {};
  const descriptor = {
    progressText: null,
    logText: null,
    ensureBasicAxe: false,
    ensureBasicPickaxe: false,
    ensureCombatReadiness: false,
    allowBootstrapCombat: false,
    markEscortHoldingWithoutWeapon: false,
    prepareCraftItem: null,
    ensureCraftingTable: false,
    ensureFuelForSmelting: false,
    ensureFurnace: false,
  };

  const resolveBuildMaterial =
    typeof context.resolveBuildMaterial === "function"
      ? context.resolveBuildMaterial
      : (value) => String(value || "").trim().toLowerCase();
  const getAliasSpec =
    typeof context.getAliasSpec === "function"
      ? context.getAliasSpec
      : () => null;
  const isWoodBlockName =
    typeof context.isWoodBlockName === "function"
      ? context.isWoodBlockName
      : () => false;
  const anyPlanks = Array.isArray(context.anyPlanks) ? context.anyPlanks : [];
  const itemNeedsCraftingTable =
    typeof context.itemNeedsCraftingTable === "function"
      ? context.itemNeedsCraftingTable
      : () => false;

  if (actionId === "gather_wood") {
    descriptor.progressText = "正在准备木工工具";
    descriptor.logText = "正在检查斧头和木工准备";
    descriptor.ensureBasicAxe = true;
    return descriptor;
  }

  if (actionId === "harvest_crops") {
    descriptor.progressText = "正在准备收割成熟作物";
    descriptor.logText = "正在检查附近成熟作物和基础口粮链";
    return descriptor;
  }

  if (actionId === "plant_crops") {
    descriptor.progressText = "正在准备补种附近农田";
    descriptor.logText = "正在检查空农田和可用种子";
    return descriptor;
  }

  if (["collect_block", "mine_resource"].includes(actionId)) {
    const spec = getAliasSpec(args.block || "stone");
    if (spec?.blocks?.some((name) => isWoodBlockName(name))) {
      descriptor.progressText = "正在准备木工工具";
      descriptor.logText = "正在检查斧头和木工准备";
      descriptor.ensureBasicAxe = true;
      return descriptor;
    }
    if (
      spec?.blocks?.some((name) =>
        [
          "stone",
          "cobblestone",
          "coal_ore",
          "deepslate_coal_ore",
          "iron_ore",
          "deepslate_iron_ore",
          "diamond_ore",
          "deepslate_diamond_ore",
        ].includes(String(name || "").trim())
      )
    ) {
      descriptor.progressText = "正在准备采矿工具";
      descriptor.logText = "正在检查镐子和采矿准备";
      descriptor.ensureBasicPickaxe = true;
    }
    return descriptor;
  }

  if (["attack_hostile", "escort_player"].includes(actionId)) {
    descriptor.progressText = "正在准备武器";
    descriptor.logText = "正在检查武器和护卫准备";
    descriptor.ensureCombatReadiness = true;
    descriptor.allowBootstrapCombat = false;
    descriptor.markEscortHoldingWithoutWeapon = actionId === "escort_player";
    return descriptor;
  }

  if (actionId === "build_structure") {
    const rawMaterial = String(args.material || "wood").trim().toLowerCase();
    const material = resolveBuildMaterial(rawMaterial || "wood");
    if (!rawMaterial || ["wood", "oak", "plank", "planks"].includes(rawMaterial) || anyPlanks.includes(material)) {
      descriptor.progressText = "正在准备木屋建材和工具";
      descriptor.logText = "正在准备斧头和木屋建材";
      descriptor.ensureBasicAxe = true;
      return descriptor;
    }
    if (["cobblestone", "stone"].includes(material)) {
      descriptor.progressText = "正在准备建筑材料和采矿工具";
      descriptor.logText = "正在准备镐子和建筑材料";
      descriptor.ensureBasicPickaxe = true;
    }
    return descriptor;
  }

  if (actionId === "craft_item") {
    const itemName = String(args.item || "").trim();
    descriptor.prepareCraftItem = itemName || null;
    if (itemName) {
      descriptor.progressText = `正在准备合成 ${itemName}`;
      descriptor.logText = `正在准备合成 ${itemName}`;
      descriptor.ensureCraftingTable = itemNeedsCraftingTable(itemName);
    }
    return descriptor;
  }

  if (actionId === "ensure_infrastructure") {
    const kind = String(args.kind || args.item || args.block || "").trim();
    descriptor.progressText = `正在准备基础设施 ${kind || "目标方块"}`;
    descriptor.logText = `正在检查并布置基础设施：${kind || "目标方块"}`;
    return descriptor;
  }

  if (actionId === "maintain_self") {
    const action = String(args.action || "").trim();
    const maintainTextMap = {
      restock_food: ["正在准备基础口粮", "正在检查附近食物储备"],
      sleep_if_night: ["正在准备过夜", "正在检查附近床位并准备休息"],
      enter_nether_portal: ["正在准备进入下界门", "正在检查附近下界门并准备穿门"],
      use_eye_of_ender: ["正在准备投掷末影之眼", "正在检查末影之眼并准备记录要塞方向"],
      fill_end_portal_frames: ["正在准备补末地门框", "正在检查门房附近的末地门框和末影之眼储备"],
      enter_end_portal: ["正在准备进入末地", "正在检查附近末地传送门并准备进入末地"],
      stabilize_end_spawn: ["正在准备末地站稳", "刚进入末地，先检查站位和基础状态"],
      break_end_crystal: ["正在准备清理末地水晶", "正在检查附近末地水晶"],
      attack_ender_dragon: ["正在准备攻击末影龙", "正在检查末影龙位置并准备接战"],
      recover_end_fight: ["正在准备恢复末地战斗状态", "正在检查血量、饱食度和末地附近站位"],
      reposition_end_fight: ["正在准备回到末地安全落脚点", "正在检查末地附近更安全的落脚位置"],
      hold_end_fight_window: ["正在准备等待末影龙接战窗口", "正在检查末影龙位置并准备等待更合适的接战时机"],
      approach_end_victory_marker: ["正在准备末地战斗收尾", "正在检查末地回程门或奖励点位置"],
    };
    const pair = maintainTextMap[action];
    if (pair) {
      descriptor.progressText = pair[0];
      descriptor.logText = pair[1];
    }
    return descriptor;
  }

  if (actionId === "smelt_item") {
    const output = String(args.output || "物品").trim() || "物品";
    descriptor.progressText = `正在准备冶炼 ${output}`;
    descriptor.logText = `正在准备冶炼 ${output}`;
    descriptor.ensureFuelForSmelting = true;
    descriptor.ensureFurnace = true;
    return descriptor;
  }

  return descriptor;
}

function getExecutionDescriptor(step = {}, context = {}) {
  const compiled = step?.action && typeof step.action === "object" ? step.action : compileStep(step);
  const actionId = String(compiled?.actionId || step?.skill || "").trim();
  const args = step?.args && typeof step.args === "object" ? cloneSerializable(step.args, {}) || {} : {};

  if (actionId === "ensure_infrastructure") {
    const kind = String(args.kind || args.item || args.block || "").trim();
    return {
      actionId,
      dispatchKind: "ensure_infrastructure",
      runtimeGroup: "ensure_infrastructure",
      runtimeKey:
        kind === "chest"
          ? "container"
          : ["torch", "torches"].includes(kind)
            ? "lighting"
            : kind === "portal"
              ? "nether_portal"
              : kind,
      args,
    };
  }

  if (actionId === "maintain_self") {
    return {
      actionId,
      dispatchKind: "maintain_self",
      runtimeGroup: "maintain_self",
      runtimeKey: String(args.action || "").trim(),
      args,
    };
  }

  if (actionId === "craft_item") {
    const itemName = String(args.item || "").trim();
    const itemNeedsCraftingTable =
      typeof context.itemNeedsCraftingTable === "function"
        ? context.itemNeedsCraftingTable
        : () => false;
    return {
      actionId,
      dispatchKind: "craft_item",
      runtimeGroup: "craft_item",
      runtimeKey: itemName,
      args,
      count: clamp(Number(args.count) || 1, 1, 32),
      needsCraftingTable: itemNeedsCraftingTable(itemName),
    };
  }

  if (actionId === "smelt_item") {
    return {
      actionId,
      dispatchKind: "smelt_item",
      runtimeGroup: "smelt_item",
      runtimeKey: String(args.output || "").trim().toLowerCase() || "generic",
      args,
    };
  }

  if (actionId === "build_structure") {
    return {
      actionId,
      dispatchKind: "build_structure",
      runtimeGroup: "build_structure",
      runtimeKey: String(args.structure || args.style || args.material || "generic").trim().toLowerCase(),
      args,
    };
  }

  if (actionId === 'build_furnished_house_phase') {
    return { actionId, dispatchKind: actionId, runtimeGroup: actionId, runtimeKey: args.phase,
      args: { ...args, label: FURNISHED_HOUSE_LABELS[args.phase] || args.phase } };
  }

  if (actionId === 'build_estate') {
    return { actionId, dispatchKind: actionId, runtimeGroup: actionId, runtimeKey: compiled.args.profile,
      args: cloneSerializable(compiled.args, {}) };
  }

  if (actionId === "build_small_house_phase") {
    const phaseArgs = compiled?.args && typeof compiled.args === "object" ? compiled.args : args;
    const phase = String(phaseArgs.phase || "").trim();
    return {
      actionId,
      dispatchKind: "build_small_house_phase",
      runtimeGroup: "build_small_house_phase",
      runtimeKey: phase,
      args: {
        ...phaseArgs,
        label: String(phaseArgs.label || getSmallHousePhaseSpec(phase)?.label || phase || "小木屋步骤").trim(),
      },
    };
  }

  return {
    actionId,
    dispatchKind: actionId,
    runtimeGroup: actionId,
    runtimeKey: actionId,
    args,
  };
}

function getExecutionRuntimeGroup(step = {}, context = {}) {
  return String(getExecutionDescriptor(step, context)?.dispatchKind || "").trim();
}

function getExecutionRuntimeKey(step = {}, context = {}) {
  return String(getExecutionDescriptor(step, context)?.runtimeKey || "").trim();
}

function getExecutionRuntimeArgs(step = {}, context = {}) {
  return cloneSerializable(getExecutionDescriptor(step, context)?.args || {}, {}) || {};
}

function buildCraftRecoveryPlan(itemName = "", context = {}) {
  const normalized = String(itemName || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const returnStep =
    context.returnStep && typeof context.returnStep === "object"
      ? cloneSerializable(context.returnStep, null)
      : null;
  const steps = [];
  if (["wooden_pickaxe", "wooden_axe", "wooden_sword"].includes(normalized)) {
    steps.push(
      createActionStep("gather_wood", {
        count: normalized === "wooden_sword" ? 2 : 3,
        maxDistance: 24,
      }),
      createActionStep("craft_item", {
        item: normalized,
      })
    );
  } else if (["stone_pickaxe", "stone_axe", "stone_sword"].includes(normalized)) {
    steps.push(
      createActionStep("craft_item", {
        item: "wooden_pickaxe",
      }),
      createActionStep("mine_resource", {
        block: "stone",
        count: normalized === "stone_sword" ? 6 : 8,
        label: "圆石",
        maxDistance: 28,
      }),
      createActionStep("craft_item", {
        item: normalized,
      })
    );
  } else {
    return null;
  }
  if (returnStep) {
    steps.push(returnStep);
  }
  return {
    mode: "task",
    intent: `${normalized}_recovery`,
    goal: `recover crafting flow for ${normalized}`,
    steps,
    replyText: `我先把 ${normalized} 的材料链补齐，再重新合成。`,
  };
}

function buildToolProgressionPlan(kind = "", context = {}) {
  const normalizedKind = String(kind || "").trim();
  const getLearnedSearchRadius =
    typeof context.getLearnedSearchRadius === "function"
      ? context.getLearnedSearchRadius
      : (_resourceKey, fallback) => Number(fallback || 24);
  if (normalizedKind !== "iron_pickaxe_progression") {
    return [];
  }
  const includeFinalCraft = context.includeFinalCraft !== false;
  const requiredIronIngots = clamp(Number(context.requiredIronIngots) || 3, 1, 8);
  const hasStoneOrBetter = context.hasStoneOrBetter === true;
  const hasIronOrBetter = context.hasIronOrBetter === true;
  const ironIngots = Math.max(0, Number(context.ironIngots || 0) || 0);
  const rawIron = Math.max(0, Number(context.rawIron || 0) || 0);
  const hasFuel = context.hasFuel === true;
  const hasFurnace = context.hasFurnace === true;
  const ironOreItemNames = Array.isArray(context.ironOreItemNames) ? context.ironOreItemNames : [];

  const steps = [];
  if (!hasStoneOrBetter) {
    steps.push(
      createActionStep("craft_item", {
        item: "stone_pickaxe",
      })
    );
  }
  if (!hasFuel && context.deferFuelPreparation !== true) {
    steps.push(
      createActionStep("mine_resource", {
        block: "coal",
        count: 2,
        label: "煤炭",
        maxDistance: getLearnedSearchRadius("coal", 36, 72),
      })
    );
  }
  if (ironIngots < requiredIronIngots && rawIron < requiredIronIngots) {
    steps.push(
      createActionStep("mine_resource", {
        block: "iron_ore",
        count: requiredIronIngots,
        label: "铁矿",
        maxDistance: getLearnedSearchRadius("iron", 40, 80),
      })
    );
  }
  if (ironIngots < requiredIronIngots && !hasFurnace) {
    steps.push(
      createActionStep("craft_item", {
        item: "furnace",
      })
    );
  }
  if (ironIngots < requiredIronIngots) {
    steps.push(
      createActionStep("smelt_item", {
        inputItems: ironOreItemNames,
        output: "iron_ingot",
        count: requiredIronIngots,
      })
    );
  }
  if (includeFinalCraft && !hasIronOrBetter) {
    steps.push(
      createActionStep("craft_item", {
        item: "iron_pickaxe",
      })
    );
  }
  return steps;
}

function getStageKind(step = {}) {
  const compiled = step?.action && typeof step.action === "object" ? step.action : compileStep(step);
  const actionId = String(compiled?.actionId || step?.skill || "").trim();
  if (actionId === 'build_estate') return 'build';
  if (actionId === 'build_furnished_house_phase') {
    if (['inspect_inventory', 'select_site', 'prepare_materials'].includes(step.args?.phase)) return 'prepare';
    return step.args?.phase === 'verify' ? 'verify' : 'build';
  }
  if (["craft_item", "smelt_item", "ensure_infrastructure", "withdraw_items", "deposit_items", "maintain_self"].includes(actionId)) {
    return "prepare";
  }
  if (["mine_resource", "gather_wood", "collect_block", "harvest_crops", "plant_crops"].includes(actionId)) {
    return "gather";
  }
  if (["build_structure", "place_block", "break_block"].includes(actionId)) {
    return "build";
  }
  if (actionId === "build_small_house_phase") {
    return getSmallHousePhaseSpec(step?.args?.phase)?.stageKind || "build";
  }
  if (["escort_player", "attack_hostile"].includes(actionId)) {
    return "combat";
  }
  if (actionId === "follow_player") {
    return step?.args?.once === true ? "return" : "move";
  }
  if (actionId === "go_to_position") {
    return "move";
  }
  return "act";
}

function getStageResourceKey(step = {}, context = {}) {
  const args = step?.args || {};
  const compiled = step?.action && typeof step.action === "object" ? step.action : compileStep(step);
  const actionId = String(compiled?.actionId || step?.skill || "").trim();
  const getResourceLearningKey =
    typeof context.getResourceLearningKey === "function"
      ? context.getResourceLearningKey
      : (value) => String(value || "").trim().toLowerCase();
  const resolveBuildMaterial =
    typeof context.resolveBuildMaterial === "function"
      ? context.resolveBuildMaterial
      : (value) => String(value || "").trim().toLowerCase();

  if (["mine_resource", "gather_wood", "collect_block", "harvest_crops", "plant_crops"].includes(actionId)) {
    return getResourceLearningKey(args.block || args.item || args.material || args.crop || "");
  }
  if (actionId === "build_structure") {
    return getResourceLearningKey(resolveBuildMaterial(args.material || "wood"));
  }
  if (actionId === "build_small_house_phase") {
    return "wood";
  }
  if (actionId === 'build_furnished_house_phase') return `furnished_house:${args.profile}:${getConstructionMaterialSource(step)}`;
  if (actionId === 'build_estate') return `estate:${args.profile}:${getConstructionMaterialSource(step)}`;
  if (["craft_item", "place_block", "break_block"].includes(actionId)) {
    return getResourceLearningKey(args.item || args.block || "");
  }
  if (actionId === "smelt_item") {
    return getResourceLearningKey(args.output || args.input || "");
  }
  if (["attack_hostile", "escort_player"].includes(actionId)) {
    return "combat";
  }
  if (["follow_player", "go_to_position"].includes(actionId)) {
    return "movement";
  }
  if (actionId === "maintain_self") {
    return String(args.action || "self_maintenance").trim().toLowerCase();
  }
  return getResourceLearningKey(args.item || args.block || args.material || args.output || "");
}

function getStageTargetKey(step = {}, context = {}) {
  const args = step?.args || {};
  const compiled = step?.action && typeof step.action === "object" ? step.action : compileStep(step);
  const actionId = String(compiled?.actionId || step?.skill || "").trim();
  const getResourceLearningKey =
    typeof context.getResourceLearningKey === "function"
      ? context.getResourceLearningKey
      : (value) => String(value || "").trim().toLowerCase();
  const resolveBuildMaterial =
    typeof context.resolveBuildMaterial === "function"
      ? context.resolveBuildMaterial
      : (value) => String(value || "").trim().toLowerCase();

  if (actionId === "build_structure") {
    const material = resolveBuildMaterial(args.material || "wood");
    return `${material}:${clamp(Number(args.width) || 3, 3, 8)}x${clamp(Number(args.depth) || 3, 3, 8)}`;
  }
  if (actionId === "build_small_house_phase") {
    const phase = String(args.phase || "phase").trim() || "phase";
    return `small_house_v${Number(args.playbookVersion || SMALL_HOUSE_PLAYBOOK_VERSION) || SMALL_HOUSE_PLAYBOOK_VERSION}:${phase}`;
  }
  if (actionId === 'build_furnished_house_phase') return `furnished_house_v3:${args.profile}:${args.phase}:${getConstructionMaterialSource(step)}`;
  if (actionId === 'build_estate') return `estate_v2:${args.profile}:${getConstructionMaterialSource(step)}`;
  if (["mine_resource", "gather_wood", "collect_block", "harvest_crops", "plant_crops"].includes(actionId)) {
    return getResourceLearningKey(args.block || args.crop || "") || "resource";
  }
  if (actionId === "craft_item") {
    return String(args.item || "").trim().toLowerCase() || "item";
  }
  if (actionId === "escort_player") {
    return "protected_player";
  }
  if (actionId === "follow_player") {
    return args.once === true ? "return_to_player" : "follow_player";
  }
  if (actionId === "maintain_self") {
    return String(args.action || actionId || "stage").trim().toLowerCase();
  }
  return String(args.item || args.block || args.material || args.output || actionId || "stage")
    .trim()
    .toLowerCase();
}

function getTaskScriptKey(plan = {}, command = "", context = {}) {
  const normalizeLearningIntent =
    typeof context.normalizeLearningIntent === "function"
      ? context.normalizeLearningIntent
      : (value) => String(value || "").trim();
  const resolveBuildMaterial =
    typeof context.resolveBuildMaterial === "function"
      ? context.resolveBuildMaterial
      : (value) => String(value || "").trim().toLowerCase();
  const getResourceLearningKey =
    typeof context.getResourceLearningKey === "function"
      ? context.getResourceLearningKey
      : (value) => String(value || "").trim().toLowerCase();
  const intent = normalizeLearningIntent(plan?.intent || "");
  if (!intent) {
    return "";
  }
  if (['build_furnished_house', 'build_estate'].includes(intent)) {
    const step = getConstructionStep(plan);
    return `${intent}:v${intent === 'build_estate' ? 2 : 3}:${step?.args?.profile || 'unknown'}:${getConstructionMaterialSource(step || {})}`;
  }
  if (intent === "build_small_house") {
    const material = plan?.steps?.some((step) => String(step?.skill || "").trim() === "build_small_house_phase")
      ? "wood_playbook_v1"
      : resolveBuildMaterial(plan?.steps?.[0]?.args?.material || "wood");
    return `build_small_house:${material}`;
  }
  if (intent === "mine_diamond_resource") {
    return "mine_diamond_resource:diamond";
  }
  if (intent === "mine_resource") {
    const block = getResourceLearningKey(plan?.steps?.[0]?.args?.block || "");
    return `mine_resource:${block || "generic"}`;
  }
  if (intent === "gather_wood") {
    return "gather_wood:wood";
  }
  if (intent === "craft_item") {
    const item = String(plan?.steps?.[0]?.args?.item || "").trim().toLowerCase();
    return `craft_item:${item || "generic"}`;
  }
  if (intent === "smelt_item") {
    const output = String(plan?.steps?.[0]?.args?.output || "").trim().toLowerCase();
    return `smelt_item:${output || "generic"}`;
  }
  if (intent === "escort_player" || intent === "follow_player" || intent === "attack_hostile") {
    return intent;
  }
  const sortedTokens = tokenizeTaskCommand(command || "")
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 6);
  const textHint = sortedTokens.length
    ? sortedTokens.join("_").slice(0, 40)
    : String(command || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_")
        .slice(0, 24);
  return textHint ? `${intent}:${textHint}` : intent;
}

function tokenizeTaskCommand(command = "") {
  return Array.from(
    new Set(
      String(command || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .split(/\s+/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2)
    )
  );
}

function hashString(value = "") {
  let hash = 5381;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

function extractTaskScriptFeatures(plan = {}, command = "") {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const skillSequence = steps.map((step) => String(step?.skill || "").trim()).filter(Boolean);
  const argTokens = [];
  for (const step of steps) {
    const args = step?.args && typeof step.args === "object" ? step.args : {};
    for (const key of ["item", "block", "material", "output", "style", "kind", "action", "label"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) {
        argTokens.push(value);
      }
      if (Array.isArray(value)) {
        argTokens.push(...value.map((item) => String(item || "").trim()).filter(Boolean));
      }
    }
  }
  const tokenSource = [
    command,
    plan.intent,
    plan.goal,
    plan.replyText,
    ...skillSequence,
    ...argTokens,
  ].join(" ");
  const tokens = tokenizeTaskCommand(tokenSource);
  const resourceKeys = Array.from(
    new Set(
      argTokens
        .map((item) => String(item || "").trim().toLowerCase().replace(/\s+/g, "_"))
        .filter(Boolean)
    )
  );
  return {
    intent: String(plan?.intent || "").trim(),
    skillSequence,
    tokens,
    resourceKeys,
    stepCount: skillSequence.length,
    planHash: hashString(
      JSON.stringify({
        intent: plan?.intent || "",
        steps: steps.map((step) => ({
          skill: step?.skill || "",
          args: step?.args || {},
        })),
      })
    ),
  };
}

function planUsesSmallHousePlaybook(plan = {}) {
  return (
    String(plan?.intent || "").trim() === "build_small_house" &&
    Array.isArray(plan?.steps) &&
    plan.steps.some((step) => String(step?.skill || "").trim() === "build_small_house_phase")
  );
}

function scoreTaskScriptBucket(bucket = null, plan = {}, command = "", context = {}) {
  if (!getTaskScriptPlanTemplate(bucket, plan, context)) {
    return -1;
  }
  const normalizeLearningIntent =
    typeof context.normalizeLearningIntent === "function"
      ? context.normalizeLearningIntent
      : (value) => String(value || "").trim();
  const intent = normalizeLearningIntent(plan?.intent || "");
  const bucketIntent = normalizeLearningIntent(bucket.intent || bucket.lastSuccessfulPlan?.intent || "");
  if (!intent || !bucketIntent || intent !== bucketIntent) {
    return -1;
  }
  if (['build_furnished_house', 'build_estate'].includes(intent)) {
    const key = getTaskScriptKey(plan);
    if (String(bucket.key || '') !== key || key !== getTaskScriptKey(bucket.lastSuccessfulPlan) ||
        !constructionStepsMatch(getConstructionStep(bucket.lastSuccessfulPlan), getConstructionStep(plan))) return -1;
  }
  if (intent === "build_small_house" && planUsesSmallHousePlaybook(plan)) {
    if (!planUsesSmallHousePlaybook(bucket.lastSuccessfulPlan)) {
      return -1;
    }
    if (
      Number(bucket.playbookVersion || SMALL_HOUSE_PLAYBOOK_VERSION) !== SMALL_HOUSE_PLAYBOOK_VERSION
    ) {
      return -1;
    }
  }
  const commandTokens = tokenizeTaskCommand(command);
  const recentCommands = Array.isArray(bucket.recentCommands) ? bucket.recentCommands : [];
  const commandOverlap = recentCommands.reduce((best, previous) => {
    const previousTokens = tokenizeTaskCommand(previous);
    const overlap = commandTokens.filter((token) => previousTokens.includes(token)).length;
    return Math.max(best, overlap);
  }, 0);
  const bucketKey = String(bucket.key || "").toLowerCase();
  const keyOverlap = bucketKey
    ? commandTokens.filter((token) => token.length >= 2 && bucketKey.includes(token)).length
    : 0;
  const planFeatures = extractTaskScriptFeatures(plan, command);
  const bucketFeatures =
    bucket.features && typeof bucket.features === "object"
      ? bucket.features
      : extractTaskScriptFeatures(bucket.lastSuccessfulPlan, recentCommands.slice(-1)[0] || "");
  const featureTokens = Array.isArray(bucketFeatures.tokens) ? bucketFeatures.tokens : [];
  const featureOverlap = planFeatures.tokens.filter((token) => featureTokens.includes(token)).length;
  const bucketSkills = Array.isArray(bucketFeatures.skillSequence) ? bucketFeatures.skillSequence : [];
  const skillOverlap = planFeatures.skillSequence.filter((skill) => bucketSkills.includes(skill)).length;
  const totalRuns = Number(bucket.success || 0) + Number(bucket.failed || 0) + Number(bucket.blocked || 0);
  const successRate = totalRuns > 0 ? Number(bucket.success || 0) / totalRuns : 0;
  const recentBonus =
    Number(bucket.lastUsedAt || 0) && Date.now() - Number(bucket.lastUsedAt || 0) < 7 * 24 * 60 * 60 * 1000
      ? 1
      : 0;
  return (
    Number(bucket.success || 0) * 4 +
    successRate * 4 +
    commandOverlap * 3 +
    Math.min(featureOverlap, 8) * 2 +
    Math.min(skillOverlap, 6) * 2 +
    Math.min(keyOverlap, 5) * 2 -
    Number(bucket.blocked || 0) * 2 -
    Number(bucket.failed || 0) +
    recentBonus
  );
}

function findBestLearnedTaskScript(plan = {}, command = "", taskScripts = {}, context = {}) {
  const getTaskScriptKeyImpl =
    typeof context.getTaskScriptKey === "function"
      ? context.getTaskScriptKey
      : (candidatePlan, candidateCommand) => getTaskScriptKey(candidatePlan, candidateCommand, context);
  const ensureBucket =
    typeof context.ensureLearningTaskScriptBucket === "function"
      ? context.ensureLearningTaskScriptBucket
      : (scriptKey, intent) => {
          const key = String(scriptKey || "").trim();
          return key && taskScripts && typeof taskScripts === "object" ? taskScripts[key] || null : null;
        };

  const exactKey = getTaskScriptKeyImpl(plan, command);
  const exactBucket = ensureBucket(exactKey, plan?.intent || "");
  if (exactBucket?.lastSuccessfulPlan && Number(exactBucket.success || 0) > 0 &&
      scoreTaskScriptBucket(exactBucket, plan, command, context) >= 0) {
    return {
      key: exactKey,
      bucket: exactBucket,
      score: scoreTaskScriptBucket(exactBucket, plan, command, context),
      rerankMode: "exact",
    };
  }
  const candidates = Object.values(taskScripts || {})
    .map((bucket) => ({
      bucket,
      score: scoreTaskScriptBucket(bucket, plan, command, context),
    }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score);
  if (!candidates.length) {
    return null;
  }
  return {
    key: String(candidates[0].bucket.key || exactKey || "").trim(),
    bucket: candidates[0].bucket,
    score: candidates[0].score,
    rerankMode: "local_features",
  };
}

function createTaskScriptBucket(scriptKey = "", intent = "", context = {}) {
  const normalizeLearningIntent =
    typeof context.normalizeLearningIntent === "function"
      ? context.normalizeLearningIntent
      : (value) => String(value || "").trim();
  const key = String(scriptKey || "").trim();
  if (!key) {
    return null;
  }
  return {
    key,
    intent: normalizeLearningIntent(intent),
    success: 0,
    blocked: 0,
    failed: 0,
    revision: 0,
    lastOutcome: null,
    lastReason: null,
    reasonCounts: {},
    lastUsedAt: 0,
    recentCommands: [],
    recentNotes: [],
    summary: "",
    features: null,
    planHash: "",
    playbookVersion: normalizeLearningIntent(intent) === "build_small_house" ? SMALL_HOUSE_PLAYBOOK_VERSION : null,
    reusable: true,
    lastMatchScore: 0,
    lastRerankMode: "",
    templatePlan: null,
    lastSuccessfulPlan: null,
  };
}

function ensureTaskScriptBucket(taskScripts = {}, scriptKey = "", intent = "", context = {}) {
  const normalizeLearningIntent =
    typeof context.normalizeLearningIntent === "function"
      ? context.normalizeLearningIntent
      : (value) => String(value || "").trim();
  const key = String(scriptKey || "").trim();
  if (!key) {
    return null;
  }
  if (!taskScripts[key] || typeof taskScripts[key] !== "object") {
    taskScripts[key] = createTaskScriptBucket(key, intent, context);
  }
  if (taskScripts[key] && !taskScripts[key].intent) {
    taskScripts[key].intent = normalizeLearningIntent(intent);
  }
  return taskScripts[key] || null;
}

function getTaskScriptReasonCount(bucket = null, reason = "") {
  if (!bucket || !reason) {
    return 0;
  }
  return Math.max(0, Number(bucket.reasonCounts?.[reason] || 0) || 0);
}

function createIntentLearningBucket() {
  return {
    success: 0,
    blocked: 0,
    failed: 0,
    reasons: {},
  };
}

function createResourceLearningBucket() {
  return {
    searchRadiusBonus: 0,
    success: 0,
    blocked: 0,
  };
}

function getTaskScriptStepSignature(step = {}) {
  const skill = String(step?.skill || "").trim();
  if (!skill) {
    return "";
  }
  const args = step?.args || {};
  if (skill === 'build_furnished_house_phase') return `${skill}:v3:${args.profile}:${args.phase}:${getConstructionMaterialSource(step)}`;
  if (skill === 'build_estate') return `${skill}:v2:${args.profile}:${getConstructionMaterialSource(step)}`;
  if (skill === "build_small_house_phase") {
    const phase = String(args.phase || "phase").trim().toLowerCase() || "phase";
    return `${skill}:${phase}`;
  }
  const anchor =
    String(args.item || args.block || args.material || args.action || args.style || "").trim().toLowerCase();
  return `${skill}:${anchor}`;
}

function getStepObjectiveKey(step = {}, context = {}) {
  const skill = String(step.skill || "").trim();
  const args = { ...(step.args || {}) };
  // These values describe how to retry, rather than what the requested stage must achieve.
  for (const key of ["count", "label", "maxDistance", "timeoutMs", "searchStrategy", "repath", "guardScanMode", "range", "distance", "hostileRadius", "leashDistance"]) delete args[key];
  const resourceKey = typeof context.getResourceLearningKey === "function"
    ? context.getResourceLearningKey
    : (value) => String(value || "").trim().toLowerCase();
  if (["mine_resource", "collect_block", "gather_wood"].includes(skill) && args.block) args.block = resourceKey(args.block);
  for (const key of ["item", "input", "output", "material", "action", "phase", "playerName"]) {
    if (typeof args[key] === "string") args[key] = args[key].trim().toLowerCase();
  }
  const stableValue = (value) => Array.isArray(value)
    ? value.map(stableValue)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
      : value;
  return `${skill}:${JSON.stringify(stableValue(args))}`;
}

function pickTaskScriptDynamicArgs(args = {}) {
  const next = {};
  for (const key of [
    "count",
    "label",
    "playerName",
    "distance",
    "hostileRadius",
    "leashDistance",
    "x",
    "y",
    "z",
    "range",
    "once",
    "crops",
  ]) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      next[key] = cloneSerializable(args[key], args[key]);
    }
  }
  return next;
}

function rememberTaskScriptOutcome(bucket = null, task = null, outcome = "", note = "", context = {}) {
  if (!bucket || !task?.plan) {
    return bucket;
  }
  const normalizeTaskScriptPlan =
    typeof context.normalizeTaskScriptPlan === "function"
      ? context.normalizeTaskScriptPlan
      : (value) => value;
  const limitArray =
    typeof context.limitArray === "function"
      ? context.limitArray
      : (items) => items;
  const normalizedOutcome = String(outcome || "").trim();
  if (['build_estate', 'build_furnished_house'].includes(task.plan.intent) &&
      (String(bucket.key || '') !== getTaskScriptKey(task.plan) ||
       (getConstructionStep(task.completionPlan) && !constructionStepsMatch(getConstructionStep(task.completionPlan), getConstructionStep(task.plan))))) return bucket;
  const selfGathered = isSelfGatheredConstruction(task.completionPlan || task.plan);
  const whole = normalizedOutcome === 'completed' && selfGathered ? wholeTaskLearningGate(task, context) : null;
  if (normalizedOutcome === 'completed' && selfGathered && !whole.eligible) {
    bucket.componentSuccess = Number(bucket.componentSuccess || 0) + 1;
    bucket.lastWholeOutcome = 'pending'; bucket.pendingWholeReason = whole.reason;
    bucket.templatePlan = normalizeTaskScriptPlan(task.plan) || bucket.templatePlan;
    revalidateWholeLearningBucket(bucket, context);
  } else if (normalizedOutcome === "completed") {
    bucket.success += 1;
    if (selfGathered) { bucket.wholeAcceptance = cloneSerializable(whole.reference); bucket.wholeLearningStatus = 'whole_success';
      bucket.lastWholeOutcome = 'whole_success'; bucket.pendingWholeReason = null; }
    bucket.reusable = true;
    bucket.lastSuccessfulPlan = normalizeTaskScriptPlan(task.plan);
    bucket.templatePlan = normalizeTaskScriptPlan(task.plan);
    bucket.features = extractTaskScriptFeatures(bucket.lastSuccessfulPlan, task.userCommand || "");
    bucket.planHash = bucket.features?.planHash || "";
    bucket.playbookVersion =
      String(task.plan?.intent || "").trim() === "build_small_house"
        ? SMALL_HOUSE_PLAYBOOK_VERSION
        : bucket.playbookVersion || null;
    bucket.summary =
      String(task.plan?.planSummary || task.plan?.goal || task.userCommand || bucket.key || "")
        .trim()
        .slice(0, 240);
  } else if (normalizedOutcome === "blocked") {
    bucket.blocked += 1;
    bucket.templatePlan = normalizeTaskScriptPlan(task.plan) || bucket.templatePlan;
    if (!bucket.lastSuccessfulPlan) {
      bucket.reusable = false;
    }
  } else if (normalizedOutcome !== "cancelled") {
    bucket.failed += 1;
    bucket.templatePlan = normalizeTaskScriptPlan(task.plan) || bucket.templatePlan;
    if (!bucket.lastSuccessfulPlan) {
      bucket.reusable = false;
    }
  }
  bucket.lastOutcome = normalizedOutcome;
  bucket.lastReason = String(task.errorCode || "").trim() || bucket.lastReason || null;
  if (bucket.lastReason) {
    bucket.reasonCounts = bucket.reasonCounts && typeof bucket.reasonCounts === "object" ? bucket.reasonCounts : {};
    bucket.reasonCounts[bucket.lastReason] = Math.max(0, Number(bucket.reasonCounts[bucket.lastReason] || 0) || 0) + 1;
  }
  bucket.lastUsedAt = Date.now();
  bucket.recentCommands = limitArray(
    [...(bucket.recentCommands || []), String(task.userCommand || "").trim()].filter(Boolean),
    6
  );
  if (note) {
    bucket.recentNotes = limitArray(
      [...(bucket.recentNotes || []), String(note || "").trim()].filter(Boolean),
      8
    );
  }
  return bucket;
}

function mergeTaskScriptPlan(scriptPlan = null, freshPlan = null, context = {}) {
  const normalizeTaskScriptPlan =
    typeof context.normalizeTaskScriptPlan === "function"
      ? context.normalizeTaskScriptPlan
      : (value) => value;
  const getTaskScriptStepSignature =
    typeof context.getTaskScriptStepSignature === "function"
      ? context.getTaskScriptStepSignature
      : (step) => String(step?.skill || "").trim();
  const normalizedScriptPlan = normalizeTaskScriptPlan(scriptPlan);
  const normalizedFreshPlan = normalizeTaskScriptPlan(freshPlan);
  if (!normalizedScriptPlan || !normalizedFreshPlan) {
    return normalizedFreshPlan || normalizedScriptPlan || null;
  }
  const remainingTemplates = [...normalizedScriptPlan.steps];
  const mergedSteps = normalizedFreshPlan.steps.map((freshStep) => {
    const signature = getTaskScriptStepSignature(freshStep);
    const templateIndex = remainingTemplates.findIndex((candidate) =>
      getTaskScriptStepSignature(candidate) === signature
    );
    if (templateIndex < 0) return freshStep;
    const template = remainingTemplates.splice(templateIndex, 1)[0];
    return mergeLearnedStep(template, freshStep);
  });
  return {
    ...normalizedFreshPlan,
    steps: mergedSteps,
  };
}

function pickStepExecutionTuning(args = {}) {
  const result = {};
  for (const key of ["maxDistance", "timeoutMs", "searchStrategy", "repath", "guardScanMode"]) {
    if (Object.prototype.hasOwnProperty.call(args, key)) result[key] = cloneSerializable(args[key], args[key]);
  }
  return result;
}

function mergeLearnedStep(template = {}, freshStep = {}) {
  // A successful execution may teach search settings; the current request owns all target arguments.
  return {
    ...freshStep,
    args: { ...pickStepExecutionTuning(template.args || {}), ...(freshStep.args || {}) },
  };
}

function continueTaskPlan(task, repairSteps, options = {}) {
  const original = task.plan || {};
  if (['build_estate', 'build_furnished_house'].includes(task.intent || original.intent)) {
    // A generic/AI repair prefix may contain a depot withdrawal. Construction
    // resumes its original dedicated contract instead of accepting that prefix.
    return buildRecoveryPlan(task, { code: 'generic_failure' });
  }
  const index = Number.isInteger(options.resumeAfterIndex) ? options.resumeAfterIndex : Number(task.currentStepIndex) || 0;
  return {
    ...original,
    mode: "task",
    intent: task.intent || original.intent,
    goal: original.goal || task.userCommand || "",
    steps: [...repairSteps, ...(original.steps || []).slice(index + 1)],
    replyText: options.replyText || original.replyText || "正在修复当前步骤，之后继续原任务。",
    scriptMeta: { ...(original.scriptMeta || {}), ...(options.scriptMeta || {}) },
  };
}

function getTaskScriptPlanningHints(command = "", plan = {}, taskScripts = {}, context = {}) {
  const normalizeTaskScriptPlan =
    typeof context.normalizeTaskScriptPlan === "function"
      ? context.normalizeTaskScriptPlan
      : (value) => value;
  const limitArrayValue =
    typeof context.limitArray === "function"
      ? context.limitArray
      : limitArray;
  const normalizedPlan = normalizeTaskScriptPlan(plan);
  if (!normalizedPlan) {
    return null;
  }
  const match = findBestLearnedTaskScript(normalizedPlan, command, taskScripts, context);
  if (!match?.bucket) {
    return null;
  }
  return {
    key: String(match.key || "").trim(),
    intent: String(match.bucket.intent || "").trim() || normalizedPlan.intent,
    revision: Number(match.bucket.revision || 0),
    success: Number(match.bucket.success || 0),
    blocked: Number(match.bucket.blocked || 0),
    failed: Number(match.bucket.failed || 0),
    lastReason: String(match.bucket.lastReason || "").trim() || null,
    reasonCounts:
      match.bucket.reasonCounts && typeof match.bucket.reasonCounts === "object"
        ? Object.fromEntries(
            Object.entries(match.bucket.reasonCounts)
              .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
              .slice(0, 3)
          )
        : {},
    recentNotes: limitArrayValue(match.bucket.recentNotes || [], 3),
  };
}

function buildHeuristicTaskPlan(kind = "", payload = {}, context = {}) {
  const normalizedKind = String(kind || "").trim();
  const playerName = String(payload.playerName || context.playerName || "").trim();
  const count = Math.max(1, Number(payload.count || 0) || 1);
  const getLearnedSearchRadius =
    typeof context.getLearnedSearchRadius === "function"
      ? context.getLearnedSearchRadius
      : (_resourceKey, fallback) => Number(fallback || 24);

  const postTaskEscort = createPostTaskDirective("escort_player", {
    playerName,
    distance: 2,
  });

  if (normalizedKind === "follow_player") {
    return {
      mode: "task",
      intent: "follow_player",
      goal: "follow the player continuously",
      steps: [
        createActionStep("follow_player", {
          playerName,
        }),
      ],
      replyText: "我会跟在你身边，直到你让我停下。",
    };
  }

  if (normalizedKind === "escort_player") {
    return {
      mode: "task",
      intent: "escort_player",
      goal: "escort the player and attack nearby hostiles",
      steps: [
        createActionStep("escort_player", {
          playerName,
        }),
      ],
      replyText: "我会守在你附近，优先清理靠近你的怪，也不会傻追太远。",
    };
  }

  if (normalizedKind === "go_to_position") {
    return {
      mode: "task",
      intent: "go_to_position",
      goal: "go to a target position",
      steps: [
        createActionStep("go_to_position", {
          x: Number(payload.x),
          y: Number(payload.y),
          z: Number(payload.z),
        }),
      ],
      replyText: `我去 ${Number(payload.x)}, ${Number(payload.y)}, ${Number(payload.z)}。`,
    };
  }

  if (normalizedKind === "mine_cobblestone") {
    return {
      mode: "task",
      intent: "mine_resource",
      goal: `collect ${count} cobblestone`,
      steps: [
        createActionStep("mine_resource", {
          block: "stone",
          count,
          label: "圆石",
        }),
      ],
      postTaskMode: postTaskEscort.postTaskMode,
      postTaskArgs: postTaskEscort.postTaskArgs,
      replyText: `我去挖 ${count} 个圆石，挖完会回到你身边继续护卫你。`,
    };
  }

  if (normalizedKind === "mine_diamond") {
    const diamondCount = Math.max(1, Number(payload.count || 0) || 1);
    const learnedDiamondDistance = getLearnedSearchRadius("diamond", 48, 96);
    return {
      mode: "task",
      intent: "mine_diamond_resource",
      goal: `collect ${diamondCount} diamond`,
      steps: [
        createActionStep("mine_resource", {
          block: "diamond",
          count: diamondCount,
          expedition: true,
          label: "钻石",
          maxDistance: learnedDiamondDistance,
        }),
      ],
      postTaskMode: postTaskEscort.postTaskMode,
      postTaskArgs: postTaskEscort.postTaskArgs,
      replyText: "我会从工具和补给开始，开阶梯下矿、探铁矿并熔炼铁镐，然后开分支矿道找钻石，遇到岩浆会换路或撤退。",
    };
  }

  if (normalizedKind === "mine_iron") {
    return {
      mode: "task",
      intent: "mine_resource",
      goal: `collect ${count} iron ore`,
      steps: [
        createActionStep("mine_resource", {
          block: "iron_ore",
          count,
          label: "铁矿",
          maxDistance: getLearnedSearchRadius("iron", 40, 80),
        }),
      ],
      postTaskMode: postTaskEscort.postTaskMode,
      postTaskArgs: postTaskEscort.postTaskArgs,
      replyText: `我去挖 ${count} 个铁矿，挖完会回到你身边。`,
    };
  }

  if (normalizedKind === "mine_coal") {
    return {
      mode: "task",
      intent: "mine_resource",
      goal: `collect ${count} coal`,
      steps: [
        createActionStep("mine_resource", {
          block: "coal",
          count,
          label: "煤炭",
          maxDistance: getLearnedSearchRadius("coal", 36, 72),
        }),
      ],
      postTaskMode: postTaskEscort.postTaskMode,
      postTaskArgs: postTaskEscort.postTaskArgs,
      replyText: `我去挖 ${count} 个煤炭，挖完会回到你身边。`,
    };
  }

  if (normalizedKind === "gather_wood") {
    return {
      mode: "task",
      intent: "gather_wood",
      goal: `collect ${count} logs`,
      steps: [
        createActionStep("gather_wood", {
          count,
        }),
      ],
      postTaskMode: postTaskEscort.postTaskMode,
      postTaskArgs: postTaskEscort.postTaskArgs,
      replyText: `我去收集 ${count} 个木头，完成后会回到你身边护卫你。`,
    };
  }

  if (normalizedKind === "craft_wooden_pickaxe") {
    return {
      mode: "task",
      intent: "craft_item",
      goal: "craft a wooden pickaxe",
      steps: [
        createActionStep("craft_item", {
          item: "wooden_pickaxe",
          count,
        }),
      ],
      replyText: "我来试着做一把木镐。",
    };
  }

  if (normalizedKind === "craft_stone_pickaxe") {
    return {
      mode: "task",
      intent: "craft_item",
      goal: "craft a stone pickaxe",
      steps: [
        createActionStep("craft_item", {
          item: "stone_pickaxe",
          count,
        }),
      ],
      replyText: "我来试着做一把石镐。",
    };
  }

  if (normalizedKind === "craft_iron_pickaxe") {
    return {
      mode: "task",
      intent: "craft_item",
      goal: "craft an iron pickaxe",
      steps: [
        createActionStep("craft_item", {
          item: "iron_pickaxe",
          count,
        }),
      ],
      replyText: "我来先把铁镐这条前置链补齐。",
    };
  }

  if (normalizedKind === "deposit_items") {
    return {
      mode: "task",
      intent: "deposit_items",
      goal: "deposit inventory items into a nearby container",
      steps: [
        createActionStep("deposit_items", {}),
      ],
      replyText: "我去把背包里大部分东西放进附近箱子。",
    };
  }

  if (normalizedKind === "harvest_crops") {
    const crops = Array.isArray(payload.crops) && payload.crops.length ? payload.crops : ["wheat", "carrots", "potatoes"];
    return {
      mode: "task",
      intent: "harvest_crops",
      goal: "harvest nearby mature crops",
      steps: [
        createActionStep("harvest_crops", {
          crops,
          count: Math.max(1, Number(payload.count || 0) || 6),
          maxDistance: Number(payload.maxDistance || 20) || 20,
          replant: payload.replant !== false,
        }),
      ],
      replyText: "我去收一轮附近成熟作物，顺手把能补种的补回去。",
    };
  }

  if (normalizedKind === "plant_crops") {
    const crops = Array.isArray(payload.crops) && payload.crops.length ? payload.crops : ["wheat", "carrots", "potatoes"];
    return {
      mode: "task",
      intent: "plant_crops",
      goal: "replant nearby farmland",
      steps: [
        createActionStep("plant_crops", {
          crops,
          count: Math.max(1, Number(payload.count || 0) || 6),
          maxDistance: Number(payload.maxDistance || 20) || 20,
        }),
      ],
      replyText: "我去把附近空出来的农田尽量补种回去。",
    };
  }

  if (normalizedKind === "withdraw_items") {
    const itemName = String(payload.item || "").trim() || "bread";
    return {
      mode: "task",
      intent: "withdraw_items",
      goal: `withdraw ${count} ${itemName} from a nearby container`,
      steps: [
        createActionStep("withdraw_items", {
          item: itemName,
          count,
        }),
      ],
      replyText: `我去附近箱子拿一些 ${itemName}。`,
    };
  }

  if (normalizedKind === "attack_hostile") {
    return {
      mode: "task",
      intent: "attack_hostile",
      goal: "attack nearby hostile mobs",
      steps: [
        createActionStep("attack_hostile", {}),
      ],
      replyText: "我去清一下附近的怪。",
    };
  }

  if (normalizedKind === 'build_furnished_house') {
    const profile = normalizeFurnishedHouseProfile(payload.profile || 'cottage');
    const advanced = profile === 'enchanting_library';
    return { mode: 'task', intent: 'build_furnished_house',
      goal: advanced ? 'build and verify a furnished cottage with a full-power enchanting library' : 'build and verify a furnished wooden-and-stone cottage',
      steps: createFurnishedHousePlaybookSteps({ ...payload, profile }),
      replyText: advanced
        ? '我会建木石小屋，布置床、工作台、箱子、熔炉和照明，再加附魔台与15个留出有效间距的书架，逐项核验后完成。我会自动采集、合成和冶炼所需材料，并从自己建造的仓库取回本任务物资。'
        : '我会建带双坡屋顶、玻璃窗、房门和照明的木石小屋，布置床、工作台、箱子与熔炉，全部核验后完成。我会自动采集、合成和冶炼所需材料，并从自己建造的仓库取回本任务物资。' };
  }

  if (normalizedKind === 'build_estate') {
    const args = {
      schema: 1, profile: payload.profile,
      useNearbySupplyChests: payload.useNearbySupplyChests === undefined ? false : payload.useNearbySupplyChests,
      materialSource: payload.materialSource === undefined
        ? (payload.useNearbySupplyChests === true ? 'external_depots' : 'self_gathered') : payload.materialSource,
      ...(payload.anchor !== undefined ? { anchor: cloneSerializable(payload.anchor) } : {}),
      ...(payload.depots !== undefined ? { depots: cloneSerializable(payload.depots) } : {}),
    };
    const step = createActionStep('build_estate', args);
    if (!step.action.valid) throw new Error(step.action.validationErrors.join('；'));
    const castle = args.profile === 'medieval_castle';
    return { mode: 'task', intent: 'build_estate',
      goal: castle ? 'build and verify the complete medieval castle estate' : 'build and verify the complete riverside villa estate',
      steps: [step],
      replyText: `${castle ? '我会建造完整的中世纪城堡庄园' : '我会建造完整的河畔别墅庄园'}，保留原定布局、家具和农田，逐项核验后完成。${args.useNearbySupplyChests ? '可以使用你指定或附近补给箱里的材料。' : '本次会自动采集、合成和冶炼所需材料，并从自己建造的仓库取回本任务物资。'}` };
  }

  if (normalizedKind === "build_small_house") {
    const wantsStone = payload.wantsStone === true;
    if (!wantsStone) {
      return {
        mode: "task",
        intent: "build_small_house",
        goal: "build a minimal wooden cottage near the player",
        steps: createSmallHousePlaybookSteps({
          material: "any_planks",
          width: 3,
          depth: 3,
          height: 2,
        }),
        replyText: "我会按真人式步骤来盖：先看背包和地形，再备木材、清地、铺地板、搭墙、封顶并检查。",
      };
    }
    return {
      mode: "task",
      intent: "build_small_house",
      goal: wantsStone ? "build a small stone house near the player" : "build a wooden cottage near the player",
      steps: [
        createActionStep("build_structure", {
          material: wantsStone ? "cobblestone" : "wood",
          width: 3,
          depth: 3,
          height: 2,
          style: wantsStone ? "compact_house" : "wood_cottage",
        }),
      ],
      replyText: wantsStone ? "我会在附近盖一间小石屋。" : "我会在附近盖一间更像样的小木屋，不是简单火柴盒。",
    };
  }

  return null;
}

function buildAutonomousTaskPlan(kind = "", payload = {}, context = {}) {
  const normalizedKind = String(kind || "").trim();
  const returnStep =
    payload.returnStep && typeof payload.returnStep === "object"
      ? cloneSerializable(payload.returnStep, null)
      : null;
  const distanceToPlayer = Number(payload.distanceToPlayer || 0);
  const getLearnedSearchRadius =
    typeof context.getLearnedSearchRadius === "function"
      ? context.getLearnedSearchRadius
      : (_resourceKey, fallback) => Number(fallback || 24);
  const maybeAppendReturnStep = (steps, threshold = 0) => {
    const nextSteps = Array.isArray(steps) ? [...steps] : [];
    if (
      returnStep &&
      (!Number.isFinite(distanceToPlayer) || distanceToPlayer > Math.max(0, Number(threshold) || 0))
    ) {
      nextSteps.push(cloneSerializable(returnStep, null));
    }
    return nextSteps.filter(Boolean);
  };

  if (normalizedKind === "autonomous_maintain_food") {
    return {
      phase: "survival",
      mode: "task",
      intent: "autonomous_maintain_food",
      goal: "restore hunger before continuing",
      steps: maybeAppendReturnStep(
        [
          createActionStep("maintain_self", {
            action: "eat_if_needed",
            minFood: 16,
          }),
        ],
        8
      ),
      replyText: "我先补一下食物状态，再继续发育。",
    };
  }

  if (normalizedKind === "autonomous_pickup_drops") {
    return {
      phase: "pickup",
      mode: "task",
      intent: "autonomous_pickup_drops",
      goal: "collect nearby dropped items",
      steps: maybeAppendReturnStep(
        [
          createActionStep("maintain_self", {
            action: "pickup_nearby_drops",
            radius: 6,
            timeoutMs: 3200,
            idleGraceMs: 400,
          }),
        ],
        8
      ),
      replyText: "我先把脚边的掉落物收一下，别浪费。",
    };
  }

  if (normalizedKind === "autonomous_guard_player") {
    return {
      phase: "guard",
      mode: "task",
      intent: "autonomous_guard_player",
      goal: "clear hostile mobs near the player",
      steps: maybeAppendReturnStep(
        [
          ...(returnStep && Number.isFinite(distanceToPlayer) && distanceToPlayer > 5
            ? [cloneSerializable(returnStep, null)]
            : []),
          createActionStep("attack_hostile", {
            maxDistance: 12,
            leashDistance: 10,
            timeoutMs: 9000,
          }),
        ],
        0
      ),
      replyText: "我先清掉你附近的怪，再继续推进进度。",
    };
  }

  if (normalizedKind === "autonomous_build_companion_house") {
    return {
      phase: "shelter",
      mode: "task",
      intent: "autonomous_build_companion_house",
      goal: "build a nearby shelter so the companion can operate steadily through the night",
      steps: maybeAppendReturnStep(
        [
          createActionStep("build_structure", {
            structure: "small_house",
            material: "wood",
          }),
        ]
      ),
      replyText: "天快黑了，我先在你附近弄一个落脚点，后面行动会稳很多。",
    };
  }

  if (normalizedKind === "autonomous_prepare_shelter_materials") {
    return {
      phase: "shelter",
      mode: "task",
      intent: "autonomous_prepare_shelter_materials",
      goal: "prepare enough wood stock to build a nearby shelter when needed",
      steps: maybeAppendReturnStep(
        [
          createActionStep("gather_wood", {
            count: 6,
            maxDistance: getLearnedSearchRadius("wood", 40, 72),
          }),
        ]
      ),
      replyText: "天色不太好了，我先补一点木头，准备随时搭个落脚点。",
    };
  }

  if (normalizedKind === "autonomous_prepare_storage") {
    return {
      phase: "organize",
      mode: "task",
      intent: "autonomous_prepare_storage",
      goal: "set up nearby storage and clear excess inventory for longer companion play",
      steps: maybeAppendReturnStep(
        [
          createActionStep("ensure_infrastructure", {
            kind: "container",
            position: payload.workAreaAnchor || null,
          }),
          createActionStep("deposit_items", {
            maxDistance: 12,
          }),
        ],
        6
      ),
      replyText: "背包开始挤了，我先在你附近补个箱子并整理一下物资。",
    };
  }

  if (normalizedKind === "autonomous_settle_work_area") {
    const workAreaSteps = Array.isArray(payload.workAreaSteps)
      ? payload.workAreaSteps.map((step) => cloneSerializable(step, null)).filter(Boolean)
      : [];
    if (!workAreaSteps.length) {
      return null;
    }
    const steps = workAreaSteps.slice(0, 3);
    if (steps.some((step) => String(step?.args?.kind || "").trim() === "container")) {
      steps.push(
        createActionStep("deposit_items", {
          maxDistance: 12,
        })
      );
    }
    return {
      phase: "secure",
      mode: "task",
      intent: "autonomous_settle_work_area",
      goal: "stabilize a nearby companion work area around the player",
      steps: maybeAppendReturnStep(steps, 6),
      replyText: "我先把你附近这片工作区补齐，后面收集、冶炼和过夜都会顺很多。",
    };
  }

  if (normalizedKind === "autonomous_prepare_lighting") {
    const hasNearbyBase = payload.hasNearbyBase === true;
    return {
      phase: "secure",
      mode: "task",
      intent: "autonomous_prepare_lighting",
      goal: "light up the nearby work area so the companion and player can operate more safely",
      steps: maybeAppendReturnStep(
        [
          createActionStep("ensure_infrastructure", {
            kind: "lighting",
            position: payload.workAreaAnchor || null,
            radius: 6,
            minLights: hasNearbyBase ? 4 : 3,
            minSpacing: 3,
          }),
        ],
        6
      ),
      replyText: "这附近有点暗，我先补一点照明，晚上活动会安全很多。",
    };
  }

  if (normalizedKind === "autonomous_sleep_until_morning") {
    return {
      phase: "survival",
      mode: "task",
      intent: "autonomous_sleep_until_morning",
      goal: "sleep through the night when a safe nearby bed is available",
      steps: maybeAppendReturnStep(
        [
          ...(payload.nearbyBed ? [] : [
            createActionStep("ensure_infrastructure", {
              kind: "bed",
              position: payload.workAreaAnchor || null,
            }),
          ]),
          createActionStep("maintain_self", {
            action: "sleep_if_night",
            maxDistance: 10,
            waitMs: 8000,
          }),
        ],
        4
      ),
      replyText: "现在适合先过个夜，我去把床位准备好，尽量把夜晚平稳跳过去。",
    };
  }

  if (normalizedKind === "autonomous_stock_food") {
    return {
      phase: "survival",
      mode: "task",
      intent: "autonomous_stock_food",
      goal: "keep a basic reserve of food available for longer companion sessions",
      steps: maybeAppendReturnStep(
        [
          createActionStep("maintain_self", {
            action: "restock_food",
            minCount: Number(payload.minCount || 0) || 8,
          }),
        ],
        6
      ),
      replyText: "我先补一点基础口粮，省得后面做事做到一半又断粮。",
    };
  }

  if (normalizedKind === "autonomous_harvest_food_inputs") {
    return {
      phase: "survival",
      mode: "task",
      intent: "autonomous_harvest_food_inputs",
      goal: "harvest mature nearby crops to keep food inputs flowing",
      steps: maybeAppendReturnStep(
        [
          createActionStep("harvest_crops", {
            crops: ["wheat", "carrots", "potatoes"],
            count: Math.min(6, Math.max(1, Number(payload.count || 0) || 1)),
            maxDistance: Number(payload.maxDistance || 20) || 20,
            replant: true,
          }),
        ],
        6
      ),
      replyText: "附近有成熟作物，我先收一轮并补回去，顺手把口粮链接起来。",
    };
  }

  if (normalizedKind === "autonomous_replant_farm") {
    const harvestCount = Math.min(4, Math.max(0, Number(payload.harvestCount || 0) || 0));
    return {
      phase: "survival",
      mode: "task",
      intent: "autonomous_replant_farm",
      goal: "keep nearby farmland planted so food production remains sustainable",
      steps: maybeAppendReturnStep(
        [
          ...(harvestCount > 0
            ? [
                createActionStep("harvest_crops", {
                  crops: ["wheat", "carrots", "potatoes"],
                  count: harvestCount,
                  maxDistance: Number(payload.maxDistance || 20) || 20,
                  replant: true,
                }),
              ]
            : []),
          createActionStep("plant_crops", {
            crops: ["wheat", "carrots", "potatoes"],
            count: Math.min(6, Math.max(1, Number(payload.plantCount || 0) || 1)),
            maxDistance: Number(payload.maxDistance || 20) || 20,
          }),
        ],
        6
      ),
      replyText: "这片农田有空位，我先把能收的收掉，再尽量补种回去。",
    };
  }

  if (normalizedKind === "autonomous_stock_planting_inputs") {
    return {
      phase: "survival",
      mode: "task",
      intent: "autonomous_stock_planting_inputs",
      goal: "keep a small reserve of planting inputs for farm maintenance",
      steps: maybeAppendReturnStep(
        [
          createActionStep("withdraw_items", {
            items: ["wheat_seeds", "carrot", "potato"],
            count: Math.max(1, Number(payload.count || 0) || 6),
            maxDistance: 12,
          }),
        ],
        6
      ),
      replyText: "我先留一点种子和作物当农田储备，免得下一轮补种断料。",
    };
  }

  if (normalizedKind === "autonomous_consolidate_outputs") {
    return {
      phase: "organize",
      mode: "task",
      intent: "autonomous_consolidate_outputs",
      goal: "stash bulky task outputs while keeping a working reserve on hand",
      steps: maybeAppendReturnStep(
        [
          createActionStep("deposit_items", {
            maxDistance: 12,
          }),
        ],
        6
      ),
      replyText: "我先把这轮产出归一下仓，顺手保留一部分常用物资继续干活。",
    };
  }

  if (normalizedKind === "autonomous_organize_inventory") {
    return {
      phase: "organize",
      mode: "task",
      intent: "autonomous_organize_inventory",
      goal: "store extra items in a nearby container before continuing other work",
      steps: maybeAppendReturnStep(
        [
          createActionStep("deposit_items", {
            maxDistance: 12,
          }),
        ],
        6
      ),
      replyText: "背包有点乱了，我先把多余物资放进附近箱子，后面做事会更顺。",
    };
  }

  if (normalizedKind === "autonomous_prepare_crafting_table") {
    return {
      phase: "tools",
      mode: "task",
      intent: "autonomous_prepare_crafting_table",
      goal: "prepare a crafting table so future autonomous work has stable crafting infrastructure",
      steps: maybeAppendReturnStep(
        [
          createActionStep("ensure_infrastructure", {
            kind: "crafting_table",
            position: payload.workAreaAnchor || null,
          }),
        ],
        6
      ),
      replyText: "我先备一个工作台，后面自己推进工具和建造都会稳一些。",
    };
  }

  if (normalizedKind === "autonomous_prepare_furnace") {
    return {
      phase: "progress",
      mode: "task",
      intent: "autonomous_prepare_furnace",
      goal: "prepare a furnace so the companion can sustain smelting progression autonomously",
      steps: maybeAppendReturnStep(
        [
          createActionStep("ensure_infrastructure", {
            kind: "furnace",
            position: payload.workAreaAnchor || null,
          }),
        ],
        6
      ),
      replyText: "我先补一个熔炉，后面铁链和长期发育都会顺很多。",
    };
  }

  if (normalizedKind === "autonomous_stock_coal") {
    return {
      phase: "progress",
      mode: "task",
      intent: "autonomous_stock_coal",
      goal: "stock fuel for smelting and longer autonomous progression",
      steps: maybeAppendReturnStep(
        [
          createActionStep("mine_resource", {
            block: "coal",
            count: Math.max(1, Number(payload.count || 0) || 4),
            label: "煤炭",
            maxDistance: getLearnedSearchRadius("coal", 36, 72),
          }),
        ]
      ),
      replyText: "我先补一点煤，后面冶炼和连续推进会更从容。",
    };
  }

  if (normalizedKind === "autonomous_return_to_work_area") {
    return {
      phase: "return",
      mode: "task",
      intent: "autonomous_return_to_work_area",
      goal: "return to the remembered work area and continue progression from a stable base",
      steps: [
        createActionStep("go_to_position", {
          x: Math.floor(Number(payload.x || 0)),
          y: Math.floor(Number(payload.y || 0)),
          z: Math.floor(Number(payload.z || 0)),
          range: 2,
        }),
      ],
      replyText: "我先回到工作区，把节奏续上，再继续往后发育。",
    };
  }

  if (normalizedKind === "autonomous_return_to_player") {
    return {
      phase: "return",
      mode: "task",
      intent: "autonomous_return_to_player",
      goal: payload.goal || "return near the player and stay in companion range",
      steps: returnStep ? [cloneSerializable(returnStep, null)].filter(Boolean) : [],
      replyText: String(payload.replyText || "").trim() || "我先回到你附近，别离你太远了。",
    };
  }

  if (normalizedKind === "autonomous_prepare_axe") {
    return {
      phase: "tools",
      mode: "task",
      intent: "autonomous_prepare_axe",
      goal: "prepare an axe and basic wood stock",
      steps: maybeAppendReturnStep(
        [
          createActionStep("gather_wood", {
            count: 3,
            maxDistance: 32,
          }),
        ]
      ),
      replyText: "我先补一点木头，并在条件合适时顺手把斧头链补起来。",
    };
  }

  if (normalizedKind === "autonomous_stock_iron") {
    const oreInInventory = Math.max(0, Number(payload.oreInInventory || 0) || 0);
    return {
      phase: "progress",
      mode: "task",
      intent: "autonomous_stock_iron",
      goal: "stock iron ingots for companion progression",
      steps: maybeAppendReturnStep(
        [
          ...(oreInInventory < 4
            ? [
                createActionStep("mine_resource", {
                  block: "iron_ore",
                  count: 4,
                  label: "铁矿",
                  maxDistance: getLearnedSearchRadius("iron", 40, 80),
                }),
              ]
            : []),
          createActionStep("smelt_item", {
            inputItems: payload.ironOreItemNames || [],
            output: "iron_ingot",
            count: 4,
          }),
        ]
      ),
      replyText: "我先补一点铁锭，后面工具和战斗都会更稳。",
    };
  }

  if (normalizedKind === "autonomous_progress_diamond") {
    return {
      phase: "progress",
      mode: "task",
      intent: "autonomous_progress_diamond",
      goal: "carefully advance mining progression with nearby diamonds",
      steps: maybeAppendReturnStep(
        [
          createActionStep("mine_resource", {
            block: "diamond",
            count: Math.max(1, Number(payload.count || 0) || 1),
            label: "钻石",
            maxDistance: getLearnedSearchRadius("diamond", 48, 96),
          }),
        ]
      ),
      replyText: "我在你附近看到了可尝试的高阶矿物，先推进一点进度再回来。",
    };
  }

  if (normalizedKind === "autonomous_prepare_pickaxe") {
    const woodStock = Math.max(0, Number(payload.woodStock || 0) || 0);
    const shouldGatherWood = payload.shouldGatherWood === true;
    return {
      phase: "tools",
      mode: "task",
      intent: "autonomous_prepare_pickaxe",
      goal: "prepare a pickaxe and basic cobblestone stock",
      steps: maybeAppendReturnStep(
        [
          ...(shouldGatherWood
            ? [
                createActionStep("gather_wood", {
                  count: woodStock < 6 ? 2 : 1,
                  maxDistance: 32,
                }),
              ]
            : []),
          createActionStep("craft_item", {
            item: "wooden_pickaxe",
          }),
          createActionStep("mine_resource", {
            block: "stone",
            count: 8,
            label: "圆石",
            maxDistance: 32,
          }),
          createActionStep("craft_item", {
            item: "stone_pickaxe",
          }),
        ]
      ),
      replyText: "我先把采矿工具链补起来，再顺手备一点圆石。",
    };
  }

  if (normalizedKind === "autonomous_prepare_iron_pickaxe") {
    const progressionSteps = Array.isArray(payload.progressionSteps)
      ? payload.progressionSteps.map((step) => cloneSerializable(step, null)).filter(Boolean)
      : [];
    if (!progressionSteps.length) {
      return null;
    }
    return {
      phase: "tools",
      mode: "task",
      intent: "autonomous_prepare_iron_pickaxe",
      goal: "prepare an iron pickaxe for higher-tier mining",
      steps: maybeAppendReturnStep(progressionSteps),
      replyText: "我先把铁镐链补起来，后面挖高阶资源会稳很多。",
    };
  }

  if (normalizedKind === "autonomous_prepare_weapon") {
    const hasCobble = payload.hasCobble === true;
    const needsWood = payload.needsWood === true;
    return {
      phase: "tools",
      mode: "task",
      intent: "autonomous_prepare_weapon",
      goal: "prepare a basic weapon",
      steps: maybeAppendReturnStep(
        [
          ...(!hasCobble && needsWood
            ? [
                createActionStep("gather_wood", {
                  count: 2,
                  maxDistance: 32,
                }),
              ]
            : []),
          createActionStep("craft_item", {
            item: hasCobble ? "stone_sword" : "wooden_sword",
          }),
        ]
      ),
      replyText: "我先补一把基础武器，免得只能站着挨打。",
    };
  }

  if (normalizedKind === "autonomous_stock_wood") {
    return {
      phase: "stock",
      mode: "task",
      intent: "autonomous_stock_wood",
      goal: "stock some nearby wood",
      steps: maybeAppendReturnStep(
        [
          createActionStep("gather_wood", {
            count: 4,
            maxDistance: 36,
          }),
        ]
      ),
      replyText: "我先在附近补一点木头，省得后面又断料。",
    };
  }

  if (normalizedKind === "autonomous_stock_cobblestone") {
    return {
      phase: "stock",
      mode: "task",
      intent: "autonomous_stock_cobblestone",
      goal: "stock some nearby cobblestone",
      steps: maybeAppendReturnStep(
        [
          createActionStep("mine_resource", {
            block: "stone",
            count: 12,
            label: "圆石",
            maxDistance: 36,
          }),
        ]
      ),
      replyText: "我先补一点圆石，后面做工具和建造都会更顺手。",
    };
  }

  if (normalizedKind === "autonomous_prepare_diamond_pickaxe") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_prepare_diamond_pickaxe",
      goal: "collect enough diamonds for endgame mining progression",
      steps: maybeAppendReturnStep(
        [
          createActionStep("mine_resource", {
            block: "diamond",
            count: Math.max(1, Number(payload.count || 0) || 1),
            label: "钻石",
            maxDistance: getLearnedSearchRadius("diamond", 48, 96),
          }),
        ]
      ),
      replyText: "我先把钻石镐材料补齐，终局主线就能真正往前推。",
    };
  }

  if (normalizedKind === "autonomous_craft_diamond_pickaxe") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_craft_diamond_pickaxe",
      goal: "craft a diamond pickaxe for obsidian and portal progression",
      steps: maybeAppendReturnStep(
        [
          createActionStep("craft_item", {
            item: "diamond_pickaxe",
          }),
        ]
      ),
      replyText: "钻石够了，我先把钻石镐做出来，后面才能推进黑曜石和下界。",
    };
  }

  if (normalizedKind === "autonomous_collect_obsidian") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_collect_obsidian",
      goal: "collect obsidian for portal progression",
      steps: maybeAppendReturnStep(
        [
          createActionStep("mine_resource", {
            block: "obsidian",
            count: Math.max(1, Number(payload.count || 0) || 1),
            label: "黑曜石",
            maxDistance: getLearnedSearchRadius("obsidian", 24, 64),
          }),
        ]
      ),
      replyText: "我先把黑曜石补齐，准备把终局主线推向下界。",
    };
  }

  if (normalizedKind === "autonomous_collect_flint") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_collect_flint",
      goal: "collect flint for portal ignition",
      steps: maybeAppendReturnStep(
        [
          createActionStep("mine_resource", {
            block: "flint",
            count: Math.max(1, Number(payload.count || 0) || 1),
            label: "燧石",
            maxDistance: getLearnedSearchRadius("gravel", 24, 48),
          }),
        ]
      ),
      replyText: "我先补一块燧石，打火工具就差这一步。",
    };
  }

  if (normalizedKind === "autonomous_craft_flint_and_steel") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_craft_flint_and_steel",
      goal: "craft portal ignition equipment",
      steps: maybeAppendReturnStep(
        [
          createActionStep("craft_item", {
            item: "flint_and_steel",
          }),
        ]
      ),
      replyText: "材料已经够了，我先把打火工具做好。",
    };
  }

  if (normalizedKind === "autonomous_collect_ender_pearls") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_collect_ender_pearls",
      goal: "collect ender pearls for end progression",
      steps: maybeAppendReturnStep(
        [
          createActionStep("attack_hostile", {
            maxDistance: 18,
            leashDistance: 12,
            timeoutMs: 12000,
          }),
          createActionStep("maintain_self", {
            action: "pickup_nearby_drops",
            radius: 8,
            timeoutMs: 3000,
            idleGraceMs: 400,
          }),
        ]
      ),
      replyText: "附近有末影人，我先补一点末影珍珠。",
    };
  }

  if (normalizedKind === "autonomous_collect_blaze_rods") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_collect_blaze_rods",
      goal: "collect blaze rods for end progression",
      steps: maybeAppendReturnStep(
        [
          createActionStep("attack_hostile", {
            maxDistance: 18,
            leashDistance: 12,
            timeoutMs: 12000,
          }),
          createActionStep("maintain_self", {
            action: "pickup_nearby_drops",
            radius: 8,
            timeoutMs: 3000,
            idleGraceMs: 400,
          }),
        ]
      ),
      replyText: "下界附近已经有烈焰人了，我先补烈焰棒。",
    };
  }

  if (normalizedKind === "autonomous_search_blaze_area") {
    const scoutTarget = payload.scoutTarget && typeof payload.scoutTarget === "object"
      ? payload.scoutTarget
      : null;
    if (!scoutTarget) {
      return null;
    }
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_search_blaze_area",
      goal: "explore the nether for nearby blazes and continue blaze-rod progression",
      steps: [
        createActionStep("go_to_position", {
          x: Math.floor(Number(scoutTarget.x)),
          y: Math.floor(Number(scoutTarget.y)),
          z: Math.floor(Number(scoutTarget.z)),
          range: 4,
        }),
      ],
      replyText:
        scoutTarget.source === "fortress"
          ? "我先朝疑似下界堡垒结构那边推进，烈焰人更可能在那附近。"
          : "附近还没看到烈焰人，我先继续在下界周围扩大搜索圈。",
    };
  }

  if (normalizedKind === "autonomous_craft_eyes_of_ender") {
    const craftCount = Math.max(1, Number(payload.craftCount || 0) || 1);
    const steps = [];
    if (payload.needsBlazePowder === true) {
      steps.push(
        createActionStep("craft_item", {
          item: "blaze_powder",
          count: Math.max(1, Math.ceil(craftCount / 2)),
        })
      );
    }
    steps.push(
      createActionStep("craft_item", {
        item: "eye_of_ender",
        count: craftCount,
      })
    );
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_craft_eyes_of_ender",
      goal: "craft eyes of ender for stronghold progression",
      steps: maybeAppendReturnStep(steps),
      replyText: "材料已经够了，我先把末影之眼做出来。",
    };
  }

  if (normalizedKind === "autonomous_build_nether_portal") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_build_nether_portal",
      goal: "build and ignite a nearby nether portal",
      steps: maybeAppendReturnStep(
        [
          createActionStep("ensure_infrastructure", {
            kind: "nether_portal",
            position: payload.workAreaAnchor || null,
          }),
        ],
        6
      ),
      replyText: "下界材料已经差不多了，我先把门搭起来并点燃。",
    };
  }

  if (normalizedKind === "autonomous_enter_nether") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_enter_nether",
      goal: "enter the nether and continue blaze progression",
      steps: [
        createActionStep("maintain_self", {
          action: "enter_nether_portal",
          maxDistance: 14,
          waitMs: 20000,
        }),
      ],
      replyText: "下界门已经准备好了，我先进去把烈焰棒这条线接上。",
    };
  }

  if (normalizedKind === "autonomous_return_overworld") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_return_overworld",
      goal: "return to the overworld and continue stronghold progression",
      steps: [
        createActionStep("maintain_self", {
          action: "enter_nether_portal",
          maxDistance: 14,
          waitMs: 20000,
        }),
      ],
      replyText: "下界材料已经差不多了，我先回主世界继续要塞主线。",
    };
  }

  if (normalizedKind === "autonomous_locate_stronghold") {
    const trace = payload.lastEyeTrace && typeof payload.lastEyeTrace === "object" ? payload.lastEyeTrace : null;
    const steps = [
      createActionStep("maintain_self", {
        action: "use_eye_of_ender",
        waitMs: 2500,
      }),
    ];
    if (trace) {
      steps.push(
        createActionStep("go_to_position", {
          x: Math.floor(Number(trace.x || 0)),
          y: Math.floor(Number(trace.y || 0)),
          z: Math.floor(Number(trace.z || 0)),
          range: 4,
        })
      );
    }
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_locate_stronghold",
      goal: "use eyes of ender and keep advancing toward the stronghold",
      steps,
      replyText: trace
        ? "我先再投一颗末影之眼，并顺着上一次记录的方向继续推进。"
        : "我先投一颗末影之眼，开始记录要塞方向。",
    };
  }

  if (normalizedKind === "autonomous_advance_stronghold") {
    const target = payload.advanceTarget && typeof payload.advanceTarget === "object" ? payload.advanceTarget : null;
    if (!target) {
      return null;
    }
    const steps = [
      createActionStep("go_to_position", {
        x: Math.floor(Number(target.x || 0)),
        y: Math.floor(Number(target.y || 0)),
        z: Math.floor(Number(target.z || 0)),
        range: 4,
      }),
    ];
    if (payload.shouldRefreshEye === true) {
      steps.push(
        createActionStep("maintain_self", {
          action: "use_eye_of_ender",
          waitMs: 2500,
        })
      );
    }
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_advance_stronghold",
      goal: "continue advancing along the last known eye-of-ender heading",
      steps,
      replyText:
        steps.length > 1
          ? "我先顺着刚才记录到的方向推进一段，再重新投一颗末影之眼校正要塞方向。"
          : "我先顺着刚才记录到的末影之眼方向继续往前推进。",
    };
  }

  if (normalizedKind === "autonomous_search_portal_room") {
    const target = payload.target && typeof payload.target === "object" ? payload.target : null;
    if (!target) {
      return null;
    }
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_search_portal_room",
      goal: "push deeper through stronghold structures and keep searching for the portal room",
      steps: [
        createActionStep("go_to_position", {
          x: Math.floor(Number(target.x || 0)),
          y: Math.floor(Number(target.y || 0)),
          z: Math.floor(Number(target.z || 0)),
          range: 3,
        }),
      ],
      replyText:
        target.source === "end_portal_frame"
          ? "我已经摸到末地门框附近了，先靠过去把门房位置站稳。"
          : "我已经碰到强要塞结构了，先顺着结构继续往门房方向推进。",
    };
  }

  if (normalizedKind === "autonomous_approach_end_portal_room") {
    const target = payload.target && typeof payload.target === "object" ? payload.target : null;
    if (!target) {
      return null;
    }
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_approach_end_portal_room",
      goal: "approach the detected end portal room area",
      steps: [
        createActionStep("go_to_position", {
          x: Math.floor(Number(target.x || 0)),
          y: Math.floor(Number(target.y || 0)),
          z: Math.floor(Number(target.z || 0)),
          range: 2,
        }),
      ],
      replyText: "我已经检测到末地门框了，先靠近门房，把最终入口站住。",
    };
  }

  if (normalizedKind === "autonomous_fill_end_portal") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_fill_end_portal",
      goal: "fill the detected end portal frames with eyes of ender",
      steps: [
        createActionStep("maintain_self", {
          action: "fill_end_portal_frames",
          maxDistance: 48,
        }),
      ],
      replyText: "我已经摸到门房了，先把末地门框补满。",
    };
  }

  if (normalizedKind === "autonomous_enter_end") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_enter_end",
      goal: "enter the end through the activated portal",
      steps: [
        createActionStep("maintain_self", {
          action: "enter_end_portal",
          maxDistance: 24,
          waitMs: 15000,
        }),
      ],
      replyText: "末地门已经激活了，我先进去把最后一段主线接上。",
    };
  }

  if (normalizedKind === "autonomous_stabilize_end") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_stabilize_end",
      goal: "stabilize at the end spawn before engaging the dragon fight",
      steps: [
        createActionStep("maintain_self", {
          action: "stabilize_end_spawn",
          minFood: 16,
        }),
      ],
      replyText: "我先在末地出生点附近站稳，再接后面的龙战。",
    };
  }

  if (normalizedKind === "autonomous_reposition_end_fight") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_reposition_end_fight",
      goal: "move back to a safer end-fight footing before continuing combat",
      steps: [
        createActionStep("maintain_self", {
          action: "reposition_end_fight",
          maxDistance: 24,
          waitMs: 900,
        }),
      ],
      replyText: "我先回到更安全的末地落脚点，再继续这波战斗。",
    };
  }

  if (normalizedKind === "autonomous_recover_end_fight") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_recover_end_fight",
      goal: "recover hunger, health rhythm, and footing before continuing the end fight",
      steps: [
        createActionStep("maintain_self", {
          action: "recover_end_fight",
          minFood: 18,
          waitMs: 1800,
        }),
      ],
      replyText: "我先把末地里的状态稳一下，再继续清水晶和打龙。",
    };
  }

  if (normalizedKind === "autonomous_clear_end_crystals") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_clear_end_crystals",
      goal: "clear nearby end crystals before focusing the dragon",
      steps: [
        createActionStep("maintain_self", {
          action: "break_end_crystal",
          maxDistance: 48,
          timeoutMs: 12000,
        }),
      ],
      replyText: "我先把附近能处理到的末地水晶清掉，再接龙战本体。",
    };
  }

  if (normalizedKind === "autonomous_approach_end_crystal") {
    const target = payload.target && typeof payload.target === "object" ? payload.target : null;
    if (!target) {
      return null;
    }
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_approach_end_crystal",
      goal: "move into a better position to clear a visible end crystal",
      steps: [
        createActionStep("go_to_position", {
          x: Math.floor(Number(target.x || 0)),
          y: Math.floor(Number(target.y || 0)),
          z: Math.floor(Number(target.z || 0)),
          range: 3,
        }),
      ],
      replyText: "我先靠近一个更容易处理的末地水晶位置，再把它清掉。",
    };
  }

  if (normalizedKind === "autonomous_wait_ender_dragon_window") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_wait_ender_dragon_window",
      goal: "hold a safer position until the dragon enters a better attack window",
      steps: [
        createActionStep("maintain_self", {
          action: "hold_end_fight_window",
          maxDistance: 24,
          waitMs: 1600,
        }),
      ],
      replyText: "末影龙现在位置不适合硬追，我先卡在安全点等更好的接战窗口。",
    };
  }

  if (normalizedKind === "autonomous_complete_end_fight") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_complete_end_fight",
      goal: "approach the exit portal or dragon drop area and finish the end fight sequence",
      steps: [
        createActionStep("maintain_self", {
          action: "approach_end_victory_marker",
          maxDistance: 64,
          range: 3,
        }),
      ],
      replyText: "龙战看起来已经收尾了，我先靠近回程门和掉落区确认战斗结束。",
    };
  }

  if (normalizedKind === "autonomous_hold_dragon_victory") {
    const marker = payload.marker && typeof payload.marker === "object" ? payload.marker : null;
    if (!marker) {
      return null;
    }
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_hold_dragon_victory",
      goal: "hold near the completion marker after the dragon run is done",
      steps: [
        createActionStep("go_to_position", {
          x: Math.floor(Number(marker.x || 0)),
          y: Math.floor(Number(marker.y || 0)),
          z: Math.floor(Number(marker.z || 0)),
          range: 3,
        }),
      ],
      replyText: "末影龙这条线已经完成了，我先留在回程门附近待命。",
    };
  }

  if (normalizedKind === "autonomous_attack_ender_dragon") {
    return {
      phase: "endgame",
      mode: "task",
      intent: "autonomous_attack_ender_dragon",
      goal: "run a basic dragon attack loop once nearby crystals are cleared",
      steps: [
        createActionStep("maintain_self", {
          action: "attack_ender_dragon",
          maxDistance: 96,
          timeoutMs: 12000,
        }),
      ],
      replyText: "附近水晶先清得差不多了，我开始接末影龙本体。",
    };
  }

  return null;
}

function compileTaskScriptPlan(command = "", plan = {}, taskScripts = {}, stageScripts = {}, context = {}) {
  const normalizeTaskScriptPlan =
    typeof context.normalizeTaskScriptPlan === "function"
      ? context.normalizeTaskScriptPlan
      : (value) => value;
  const getTaskScriptKeyValue =
    typeof context.getTaskScriptKey === "function"
      ? context.getTaskScriptKey
      : (taskPlan, taskCommand) => getTaskScriptKey(taskPlan, taskCommand, context);
  const ensureTaskScriptBucketValue =
    typeof context.ensureLearningTaskScriptBucket === "function"
      ? context.ensureLearningTaskScriptBucket
      : (scriptKey, intent) => ensureTaskScriptBucket(taskScripts, scriptKey, intent, context);
  const findBestLearnedTaskScriptValue =
    typeof context.findBestLearnedTaskScript === "function"
      ? context.findBestLearnedTaskScript
      : (taskPlan, taskCommand) => findBestLearnedTaskScript(taskPlan, taskCommand, taskScripts, context);
  const mergeTaskScriptPlanValue =
    typeof context.mergeTaskScriptPlan === "function"
      ? context.mergeTaskScriptPlan
      : (scriptPlan, freshPlan) => mergeTaskScriptPlan(scriptPlan, freshPlan, context);
  const applyLearnedStageScriptsValue =
    typeof context.applyLearnedStageScripts === "function"
      ? context.applyLearnedStageScripts
      : (taskPlan) => applyLearnedStageScripts(taskPlan, stageScripts, context);

  const normalizedPlan = normalizeTaskScriptPlan(plan);
  if (!normalizedPlan || normalizedPlan.mode !== "task") {
    return normalizedPlan;
  }

  const candidateMatch = findBestLearnedTaskScriptValue(normalizedPlan, command);
  const construction = ['build_estate', 'build_furnished_house'].includes(normalizedPlan.intent);
  // AI rerank and injected matchers use the same hard source/profile boundary.
  const scriptMatch = construction && candidateMatch && scoreTaskScriptBucket(candidateMatch.bucket, normalizedPlan, command, context) < 0
    ? null : candidateMatch;
  const scriptKey = String(scriptMatch?.key || getTaskScriptKeyValue(normalizedPlan, command)).trim();
  const bucket = ensureTaskScriptBucketValue(scriptKey, normalizedPlan.intent);
  const successfulTemplate = scriptMatch && getTaskScriptPlanTemplate(scriptMatch.bucket, normalizedPlan, context);
  const learnedPlan =
    successfulTemplate
      ? mergeTaskScriptPlanValue(successfulTemplate, normalizedPlan)
      : normalizedPlan;
  let adaptedPlan = applyLearnedStageScriptsValue(
    adaptPlanForLearning(learnedPlan, {
      timeout: getTaskScriptReasonCount(bucket, "timeout"),
      no_path: getTaskScriptReasonCount(bucket, "no_path"),
      target_not_found: getTaskScriptReasonCount(bucket, "target_not_found"),
      resource_not_found: getTaskScriptReasonCount(bucket, "resource_not_found"),
      insufficient_material: getTaskScriptReasonCount(bucket, "insufficient_material"),
      generic_failure: getTaskScriptReasonCount(bucket, "generic_failure"),
      crop_not_ready: getTaskScriptReasonCount(bucket, "crop_not_ready"),
      planting_input_missing: getTaskScriptReasonCount(bucket, "planting_input_missing"),
    })
  );
  if (construction) {
    adaptedPlan = { ...adaptedPlan, intent: normalizedPlan.intent, goal: normalizedPlan.goal,
      steps: cloneSerializable(normalizedPlan.steps, []) };
  }
  const resultPlan = {
    ...adaptedPlan,
    scriptMeta: {
      ...(adaptedPlan.scriptMeta && typeof adaptedPlan.scriptMeta === "object"
        ? cloneSerializable(adaptedPlan.scriptMeta, {}) || {}
        : {}),
      key: scriptKey,
      revision: Math.max(0, Number(bucket?.revision || 0) || 0),
      source:
        successfulTemplate
          ? "learned_success"
          : "generated",
      matchedFrom:
        scriptMatch?.bucket && scriptMatch.key !== getTaskScriptKeyValue(normalizedPlan, command)
          ? String(scriptMatch.key || "").trim()
          : null,
      matchScore: Number(scriptMatch?.score || 0) || 0,
      rerankMode: String(scriptMatch?.rerankMode || "").trim() || "local_features",
    },
  };

  if (resultPlan.scriptMeta.source === "learned_success") {
    resultPlan.replyText = [
      adaptedPlan.replyText || normalizedPlan.replyText || "",
      "我会先按上次跑通的任务脚本执行，途中如果卡住就继续修这版脚本。",
      getTaskScriptReasonCount(bucket, "timeout") >= 2 ||
      getTaskScriptReasonCount(bucket, "no_path") >= 2 ||
      getTaskScriptReasonCount(bucket, "target_not_found") >= 2 ||
      getTaskScriptReasonCount(bucket, "insufficient_material") >= 2
        ? "这次我还会先避开它历史上最容易卡住的点。"
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  } else if (Number(resultPlan.scriptMeta.scriptLibraryHit || 0) > 0) {
    resultPlan.replyText = [
      adaptedPlan.replyText || normalizedPlan.replyText || "",
      `我命中了 ${Number(resultPlan.scriptMeta.scriptLibraryHit || 0)} 个已固化阶段，会在这些成功阶段基础上继续补齐和修正。`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  return resultPlan;
}

function normalizeStageScriptStep(step) {
  const skill = String(step?.skill || '').trim();
  return skill ? { skill, args: step?.args && typeof step.args === 'object'
    ? cloneSerializable(step.args, {}) || {} : {} } : null;
}

function sameStageScriptStep(left, right) {
  const stable = value => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const a = normalizeStageScriptStep(left); const b = normalizeStageScriptStep(right);
  return Boolean(a && b && JSON.stringify(stable(a)) === JSON.stringify(stable(b)));
}

function validatedStageScriptStep(bucket) {
  if (!bucket || Number(bucket.success || 0) <= 0) return null;
  // A legacy failed template may already contain an untested repair. Only its
  // latest completed template can establish a known successful legacy version.
  const step = bucket.validationSchema === 1
    ? Number.isInteger(bucket.validatedRevision) && bucket.validatedRevision >= 0
      ? normalizeStageScriptStep(bucket.lastSuccessfulStep) : null
    : bucket.lastOutcome === 'completed' ? normalizeStageScriptStep(bucket.templateStep) : null;
  return step && validateStep(step).valid ? step : null;
}

function rememberStageScriptVersion(bucket, step, revision, status, outcome, reason = '') {
  const normalized = normalizeStageScriptStep(step);
  if (!normalized) return;
  const now = Date.now();
  bucket.stepHistory = Array.isArray(bucket.stepHistory) ? bucket.stepHistory : [];
  const prior = bucket.stepHistory.find(version => version.revision === revision && version.status === status
    && version.outcome === outcome && version.reason === reason && sameStageScriptStep(version.step, normalized));
  if (prior) {
    prior.occurrences = Math.max(1, Number(prior.occurrences) || 1) + 1;
    prior.lastUsedAt = now;
  } else bucket.stepHistory.push({ revision, status, step: normalized, outcome, reason,
    occurrences: 1, firstUsedAt: now, lastUsedAt: now });
}

function upgradeStageScriptValidation(bucket) {
  if (bucket.validationSchema === 1) return bucket;
  const step = normalizeStageScriptStep(bucket.templateStep);
  const revision = Math.max(0, Number(bucket.revision) || 0);
  const known = validatedStageScriptStep(bucket);
  bucket.validationSchema = 1;
  bucket.lastSuccessfulStep = known;
  bucket.validatedRevision = known ? revision : null;
  bucket.candidateStep = !known && Number(bucket.success || 0) > 0 ? step : null;
  bucket.candidateRevision = bucket.candidateStep ? revision : null;
  bucket.candidateStatus = bucket.candidateStep ? 'legacy_unverified' : null;
  bucket.stepHistory = Array.isArray(bucket.stepHistory) ? bucket.stepHistory : [];
  if (known || bucket.candidateStep) rememberStageScriptVersion(bucket, step, revision,
    known ? 'validated' : 'legacy_unverified', String(bucket.lastOutcome || 'unknown'), String(bucket.lastReason || ''));
  return bucket;
}

function createStageScriptBucket(intent = "", step = {}, context = {}) {
  const getStageScriptKeyValue =
    typeof context.getStageScriptKey === "function"
      ? context.getStageScriptKey
      : (taskIntent, taskStep) => getStageScriptKey(taskIntent, taskStep, context);
  const normalizeLearningIntent =
    typeof context.normalizeLearningIntent === "function"
      ? context.normalizeLearningIntent
      : (value) => String(value || "").trim();
  const getTaskScriptStepSignatureValue =
    typeof context.getTaskScriptStepSignature === "function"
      ? context.getTaskScriptStepSignature
      : (candidate) => getTaskScriptStepSignature(candidate);
  const getStageEnvironmentTags =
    typeof context.getStageEnvironmentTags === "function"
      ? context.getStageEnvironmentTags
      : () => [];
  const key = String(getStageScriptKeyValue(intent, step) || "").trim();
  if (!key) {
    return null;
  }
  const taskIntent = normalizeLearningIntent(intent);
  const skill = String(step?.skill || "").trim();
  return {
    key,
    intent: taskIntent,
    taskIntent,
    stageKind: getStageKind(step),
    skill,
    signature: getTaskScriptStepSignatureValue(step),
    resourceKey: getStageResourceKey(step, context),
    targetKey: getStageTargetKey(step, context),
    environmentTags: getStageEnvironmentTags(step),
    success: 0,
    blocked: 0,
    failed: 0,
    revision: 0,
    lastOutcome: null,
    lastReason: null,
    lastUsedAt: 0,
    reasonCounts: {},
    telemetry: {},
    recentNotes: [],
    validationSchema: 1,
    lastSuccessfulStep: null,
    validatedRevision: null,
    candidateStep: null,
    candidateRevision: null,
    candidateStatus: null,
    stepHistory: [],
    templateStep: {
      skill,
      args: step?.args && typeof step.args === "object" ? cloneSerializable(step.args, {}) || {} : {},
    },
  };
}

function ensureStageScriptBucket(stageScripts = {}, intent = "", step = {}, context = {}) {
  const getStageScriptKeyValue =
    typeof context.getStageScriptKey === "function"
      ? context.getStageScriptKey
      : (taskIntent, taskStep) => getStageScriptKey(taskIntent, taskStep, context);
  const normalizeLearningIntent =
    typeof context.normalizeLearningIntent === "function"
      ? context.normalizeLearningIntent
      : (value) => String(value || "").trim();
  const getTaskScriptStepSignatureValue =
    typeof context.getTaskScriptStepSignature === "function"
      ? context.getTaskScriptStepSignature
      : (candidate) => getTaskScriptStepSignature(candidate);
  const getStageEnvironmentTags =
    typeof context.getStageEnvironmentTags === "function"
      ? context.getStageEnvironmentTags
      : () => [];
  const key = String(getStageScriptKeyValue(intent, step) || "").trim();
  if (!key) {
    return null;
  }
  if (!stageScripts || typeof stageScripts !== "object") {
    return null;
  }
  if (!stageScripts[key] || typeof stageScripts[key] !== "object") {
    stageScripts[key] = createStageScriptBucket(intent, step, {
      ...context,
      getStageScriptKey: getStageScriptKeyValue,
    });
  }
  const bucket = stageScripts[key];
  const taskIntent = normalizeLearningIntent(intent);
  const stageKind = getStageKind(step);
  const skill = String(step?.skill || "").trim();
  const signature = getTaskScriptStepSignatureValue(step);
  const resourceKey = getStageResourceKey(step, context);
  const targetKey = getStageTargetKey(step, context);
  bucket.intent = bucket.intent || taskIntent;
  bucket.taskIntent = bucket.taskIntent || taskIntent;
  bucket.stageKind = bucket.stageKind || stageKind;
  bucket.skill = bucket.skill || skill;
  bucket.signature = bucket.signature || signature;
  bucket.resourceKey = bucket.resourceKey || resourceKey;
  bucket.targetKey = bucket.targetKey || targetKey;
  bucket.environmentTags = Array.isArray(bucket.environmentTags) ? bucket.environmentTags : getStageEnvironmentTags(step);
  return bucket;
}

function scoreStageScriptBucket(bucket = null, intent = "", step = {}, context = {}) {
  const successfulStep = validatedStageScriptStep(bucket);
  if (!successfulStep) {
    return -1;
  }
  const normalizeLearningIntent =
    typeof context.normalizeLearningIntent === "function"
      ? context.normalizeLearningIntent
      : (value) => String(value || "").trim();
  const getStageEnvironmentTags =
    typeof context.getStageEnvironmentTags === "function"
      ? context.getStageEnvironmentTags
      : () => [];
  const taskIntent = normalizeLearningIntent(intent);
  const stageKind = getStageKind(step);
  const skill = String(step?.skill || "").trim();
  if (['build_estate', 'build_furnished_house_phase'].includes(skill) &&
      (!constructionStepsMatch(successfulStep, step) ||
       String(bucket.key || '') !== getStageScriptKey(intent, step) ||
       (skill === 'build_furnished_house_phase' && successfulStep.args?.phase !== step.args?.phase))) return -1;
  const resourceKey = getStageResourceKey(step, context);
  const targetKey = getStageTargetKey(step, context);
  let score = Number(bucket.success || 0) * 7 - Number(bucket.blocked || 0) * 2 - Number(bucket.failed || 0) * 3;
  if (String(bucket.stageKind || "") !== stageKind) {
    return -1;
  }
  if (String(bucket.skill || "") === skill) {
    score += 12;
  } else if (String(bucket.signature || "").startsWith(`${skill}:`)) {
    score += 6;
  } else {
    return -1;
  }
  if (normalizeLearningIntent(bucket.taskIntent || bucket.intent || "") === taskIntent) {
    score += 10;
  }
  if (String(bucket.resourceKey || "") && String(bucket.resourceKey || "") === resourceKey) {
    score += 8;
  }
  if (String(bucket.targetKey || "") && String(bucket.targetKey || "") === targetKey) {
    score += 5;
  }
  const envTags = getStageEnvironmentTags(step);
  const bucketTags = Array.isArray(bucket.environmentTags) ? bucket.environmentTags : [];
  const overlap = envTags.filter((tag) => bucketTags.includes(tag)).length;
  score += overlap * 2;
  if (Number(bucket.lastUsedAt || 0) > 0) {
    const ageHours = Math.max(0, (Date.now() - Number(bucket.lastUsedAt || 0)) / 3600000);
    score += Math.max(0, 4 - Math.min(4, ageHours / 12));
  }
  const total = Number(bucket.success || 0) + Number(bucket.blocked || 0) + Number(bucket.failed || 0);
  if (total > 0) {
    score += (Number(bucket.success || 0) / total) * 10;
  }
  return score;
}

function findBestLearnedStageScript(intent = "", step = {}, stageScripts = {}, context = {}) {
  const getStageScriptKeyValue =
    typeof context.getStageScriptKey === "function"
      ? context.getStageScriptKey
      : (taskIntent, taskStep) => getStageScriptKey(taskIntent, taskStep, context);
  const exactKey = String(getStageScriptKeyValue(intent, step) || "").trim();
  const exactBucket = stageScripts?.[exactKey];
  if (validatedStageScriptStep(exactBucket) && scoreStageScriptBucket(exactBucket, intent, step, context) >= 0) {
    return {
      key: exactKey,
      bucket: exactBucket,
      score: scoreStageScriptBucket(exactBucket, intent, step, context) + 8,
      exact: true,
    };
  }
  const candidates = Object.values(stageScripts || {})
    .map((bucket) => ({
      key: String(bucket?.key || "").trim(),
      bucket,
      score: scoreStageScriptBucket(bucket, intent, step, context),
      exact: false,
    }))
    .filter((item) => item.key && item.score >= 0)
    .sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function applyLearnedStageScripts(plan = {}, stageScripts = {}, context = {}) {
  const normalizeTaskScriptPlan =
    typeof context.normalizeTaskScriptPlan === "function"
      ? context.normalizeTaskScriptPlan
      : (value) => value;
  const ensureLearningStageScriptBucket =
    typeof context.ensureLearningStageScriptBucket === "function"
      ? context.ensureLearningStageScriptBucket
      : () => null;
  const findBestLearnedStageScriptForPlan =
    typeof context.findBestLearnedStageScript === "function"
      ? context.findBestLearnedStageScript
      : (intent, step) => findBestLearnedStageScript(intent, step, stageScripts, context);
  const getStageKindForStep =
    typeof context.getStageKindForStep === "function"
      ? context.getStageKindForStep
      : (step) => getStageKind(step);

  const normalizedPlan = normalizeTaskScriptPlan(plan);
  if (!normalizedPlan?.steps?.length) {
    return normalizedPlan;
  }

  const applied = [];
  const steps = normalizedPlan.steps.map((step) => {
    ensureLearningStageScriptBucket(normalizedPlan.intent, step);
    const match = findBestLearnedStageScriptForPlan(normalizedPlan.intent, step);
    const successfulStep = validatedStageScriptStep(match?.bucket);
    if (!successfulStep || Number(match.score || 0) < 12 ||
        (['build_estate', 'build_furnished_house_phase'].includes(step.skill) &&
          scoreStageScriptBucket(match.bucket, normalizedPlan.intent, step, context) < 0)) {
      return step;
    }
    applied.push({
      key: match.key,
      stageKind: String(match.bucket.stageKind || getStageKindForStep(step)),
      revision: Number(match.bucket.validatedRevision ?? match.bucket.revision ?? 0),
      score: Number(match.score || 0),
      exact: match.exact === true,
    });
    return mergeLearnedStep(successfulStep, step);
  });

  if (!applied.length) {
    return normalizedPlan;
  }

  return {
    ...normalizedPlan,
    steps,
    scriptMeta: {
      ...(normalizedPlan.scriptMeta || {}),
      scriptLibraryHit: applied.length,
      stageScriptKeys: applied.map((item) => item.key).slice(-12),
      stageScriptMatches: applied.slice(-12),
      stageSource: "learned_stages",
    },
  };
}

function rememberStageScriptOutcome(
  bucket = null,
  task = null,
  step = {},
  outcome = "",
  reason = "",
  telemetry = {},
  context = {}
) {
  if (!bucket || !task || !step) {
    return bucket;
  }
  const normalizeLearningIntent =
    typeof context.normalizeLearningIntent === "function"
      ? context.normalizeLearningIntent
      : (value) => String(value || "").trim();
  const getTaskScriptStepSignatureValue =
    typeof context.getTaskScriptStepSignature === "function"
      ? context.getTaskScriptStepSignature
      : (candidate) => getTaskScriptStepSignature(candidate);
  const getStageEnvironmentTags =
    typeof context.getStageEnvironmentTags === "function"
      ? context.getStageEnvironmentTags
      : () => [];
  const reviseStepForFailure =
    typeof context.reviseStepForFailure === "function"
      ? context.reviseStepForFailure
      : (candidate) => candidate;
  const normalizedOutcome = String(outcome || "").trim() || "failed";
  if (['build_estate', 'build_furnished_house_phase'].includes(step.skill) &&
      (String(bucket.key || '') !== getStageScriptKey(task.intent || task.plan?.intent, step) ||
       (getConstructionStep(task.completionPlan) && !constructionStepsMatch(getConstructionStep(task.completionPlan), step)))) return bucket;
  const currentStep = Number.isInteger(task.currentStepIndex) ? task.plan?.steps?.[task.currentStepIndex] : null;
  if (currentStep && !sameStageScriptStep(currentStep, step)) return bucket;
  upgradeStageScriptValidation(bucket);
  const taskIntent = normalizeLearningIntent(task.intent || task.plan?.intent || "");
  bucket.intent = bucket.intent || taskIntent;
  bucket.taskIntent = taskIntent || bucket.taskIntent || bucket.intent || "";
  bucket.stageKind = getStageKind(step);
  bucket.skill = String(step.skill || "").trim();
  bucket.signature = getTaskScriptStepSignatureValue(step);
  bucket.resourceKey = getStageResourceKey(step, context);
  bucket.targetKey = getStageTargetKey(step, context);
  bucket.environmentTags = getStageEnvironmentTags(step);
  if (normalizedOutcome === "completed") {
    bucket.success += 1;
    const candidateCompleted = ['pending', 'legacy_unverified'].includes(bucket.candidateStatus) && sameStageScriptStep(bucket.candidateStep, step);
    const knownRevision = bucket.stepHistory.find(version => version.status === 'validated' && sameStageScriptStep(version.step, step))?.revision;
    const revision = candidateCompleted ? bucket.candidateRevision
      : sameStageScriptStep(bucket.lastSuccessfulStep, step) ? bucket.validatedRevision
        : knownRevision ?? (bucket.lastSuccessfulStep || bucket.candidateStep ? Number(bucket.revision || 0) + 1 : Number(bucket.revision || 0));
    bucket.revision = Math.max(Number(bucket.revision || 0), revision);
    bucket.lastSuccessfulStep = normalizeStageScriptStep(step);
    bucket.templateStep = normalizeStageScriptStep(step);
    bucket.validatedRevision = revision;
    if (candidateCompleted) bucket.candidateStatus = 'validated';
    rememberStageScriptVersion(bucket, step, revision, 'validated', normalizedOutcome);
  } else if (normalizedOutcome === "blocked") {
    bucket.blocked += 1;
  } else if (!['cancelled', 'paused'].includes(normalizedOutcome)) {
    bucket.failed += 1;
  }
  bucket.lastOutcome = normalizedOutcome;
  bucket.lastReason = String(reason || "").trim() || null;
  if (bucket.lastReason) {
    bucket.reasonCounts = bucket.reasonCounts && typeof bucket.reasonCounts === "object" ? bucket.reasonCounts : {};
    bucket.reasonCounts[bucket.lastReason] = Number(bucket.reasonCounts[bucket.lastReason] || 0) + 1;
    if (!['completed', 'cancelled', 'paused'].includes(normalizedOutcome)) {
      const failedRevision = sameStageScriptStep(bucket.candidateStep, step) ? bucket.candidateRevision
        : sameStageScriptStep(bucket.lastSuccessfulStep, step) ? bucket.validatedRevision : Number(bucket.revision || 0);
      rememberStageScriptVersion(bucket, step, failedRevision, 'failed', normalizedOutcome, bucket.lastReason);
      bucket.revision = Number(bucket.revision || 0) + 1;
      const revised = normalizeStageScriptStep(reviseStepForFailure(step, { code: bucket.lastReason }));
      if (revised && validateStep(revised).valid && (!['build_estate', 'build_furnished_house_phase'].includes(step.skill)
        || constructionStepsMatch(step, revised) && (step.skill !== 'build_furnished_house_phase' || revised.args.phase === step.args.phase))) {
        bucket.candidateStep = revised;
        bucket.candidateRevision = bucket.revision;
        bucket.candidateStatus = 'pending';
        rememberStageScriptVersion(bucket, revised, bucket.revision, 'candidate', 'pending', bucket.lastReason);
      }
    }
  }
  bucket.lastUsedAt = Date.now();
  bucket.telemetry = {
    ...(bucket.telemetry && typeof bucket.telemetry === "object" ? bucket.telemetry : {}),
    ...(telemetry && typeof telemetry === "object" ? cloneSerializable(telemetry, {}) || {} : {}),
  };
  bucket.recentNotes = limitArray(
    [
      ...(bucket.recentNotes || []),
      normalizedOutcome === "completed"
        ? `${bucket.stageKind} 阶段已通过真实动作验证并固化。`
        : `${bucket.stageKind} 阶段失败：${bucket.lastReason || "unknown"}`,
    ],
    8
  );
  return bucket;
}

function getTaskLearningResourceKey(task = null, context = {}) {
  if (!task) {
    return "";
  }
  const normalizeLearningIntent =
    typeof context.normalizeLearningIntent === "function"
      ? context.normalizeLearningIntent
      : (value) => String(value || "").trim();
  const getResourceLearningKey =
    typeof context.getResourceLearningKey === "function"
      ? context.getResourceLearningKey
      : (value) => String(value || "").trim().toLowerCase();
  if (normalizeLearningIntent(task.intent) === "build_small_house") {
    return "wood";
  }
  const step = task.plan?.steps?.find((item) =>
    ["mine_resource", "gather_wood", "collect_block", "smelt_item"].includes(String(item?.skill || ""))
  );
  if (!step) {
    return "";
  }
  if (String(step.skill || "") === "smelt_item") {
    return getResourceLearningKey(step.args?.output || step.args?.input || "");
  }
  return getResourceLearningKey(step.args?.block || step.args?.item || "");
}

function recordTaskLearningOutcome(learningState = {}, task = null, outcome = "", context = {}) {
  if (!task) {
    return null;
  }
  const normalizeLearningIntent =
    typeof context.normalizeLearningIntent === "function"
      ? context.normalizeLearningIntent
      : (value) => String(value || "").trim();
  const getTaskLearningResourceKeyFromTask =
    typeof context.getTaskLearningResourceKey === "function"
      ? context.getTaskLearningResourceKey
      : (candidate) => getTaskLearningResourceKey(candidate, context);
  const addLearningInsight =
    typeof context.addLearningInsight === "function"
      ? context.addLearningInsight
      : () => {};
  const clampValue =
    typeof context.clamp === "function"
      ? context.clamp
      : clamp;

  if (!learningState.intents || typeof learningState.intents !== "object") {
    learningState.intents = {};
  }
  if (!learningState.resources || typeof learningState.resources !== "object") {
    learningState.resources = {};
  }
  if (!learningState.builds || typeof learningState.builds !== "object") {
    learningState.builds = {};
  }

  const intent = normalizeLearningIntent(task.intent);
  const pendingWhole = outcome === 'completed' && isSelfGatheredConstruction(task.completionPlan || task.plan) && !wholeTaskLearningGate(task, context).eligible;
  const reason = String(task.errorCode || "").trim();

  if (intent && (!learningState.intents[intent] || typeof learningState.intents[intent] !== "object")) {
    learningState.intents[intent] = createIntentLearningBucket();
  }
  const intentBucket = learningState.intents[intent] || null;
  if (intentBucket) {
    if (pendingWhole) {
      intentBucket.componentSuccess = Number(intentBucket.componentSuccess || 0) + 1;
    } else if (outcome === "completed") {
      intentBucket.success += 1;
    } else if (outcome === "blocked") {
      intentBucket.blocked += 1;
    } else if (outcome !== "cancelled") {
      intentBucket.failed += 1;
    }
    if (reason) {
      intentBucket.reasons[reason] = Number(intentBucket.reasons[reason] || 0) + 1;
    }
  }

  const resourceKey = String(getTaskLearningResourceKeyFromTask(task) || "").trim();
  if (
    resourceKey &&
    (!learningState.resources[resourceKey] || typeof learningState.resources[resourceKey] !== "object")
  ) {
    learningState.resources[resourceKey] = createResourceLearningBucket();
  }
  const resourceBucket = learningState.resources[resourceKey] || null;
  if (resourceBucket) {
    if (pendingWhole) {
      resourceBucket.componentSuccess = Number(resourceBucket.componentSuccess || 0) + 1;
    } else if (outcome === "completed") {
      resourceBucket.success += 1;
    } else if (outcome === "blocked") {
      resourceBucket.blocked += 1;
    }
  }

  if (resourceBucket && ["blocked", "failed"].includes(outcome) && ["target_not_found", "timeout", "no_path"].includes(reason)) {
    resourceBucket.searchRadiusBonus = clampValue(
      Number(resourceBucket.searchRadiusBonus || 0) + 8,
      0,
      48
    );
    addLearningInsight(`学习到 ${resourceKey || intent} 任务更适合扩大搜索半径`, {
      intent,
      reason,
      resourceKey,
    });
  }

  if (intent === "build_small_house") {
    if (["blocked", "failed"].includes(outcome) && ["insufficient_material", "timeout", "generic_failure"].includes(reason)) {
      learningState.builds.smallHouseScalePenalty = clampValue(
        Number(learningState.builds.smallHouseScalePenalty || 0) + 1,
        0,
        3
      );
      addLearningInsight("学习到小木屋任务需要先缩小尺寸再求稳", {
        intent,
        reason,
      });
    } else if (outcome === "completed") {
      learningState.builds.smallHouseScalePenalty = clampValue(
        Number(learningState.builds.smallHouseScalePenalty || 0) - 1,
        0,
        3
      );
    }
  }

  if (intent === "mine_diamond_resource" && outcome === "completed") {
    addLearningInsight("学习到当前世界的钻石链已经可达，后续可更积极尝试高阶采矿", {
      intent,
    });
  }

  return {
    intent,
    reason,
    resourceKey,
    scriptNote:
      pendingWhole ? "结构执行已完成；完整自然功能验收尚未签发，保留组件记录。" : outcome === "completed"
        ? "这版任务脚本已跑通并被固化。"
        : task?.error
          ? `脚本在这次执行里暴露了问题：${task.error}`
          : "",
  };
}

function getStageScriptKey(intent = "", step = {}, context = {}) {
  const normalizeLearningIntent =
    typeof context.normalizeLearningIntent === "function"
      ? context.normalizeLearningIntent
      : (value) => String(value || "").trim();
  const getTaskScriptStepSignatureValue =
    typeof context.getTaskScriptStepSignature === "function"
      ? context.getTaskScriptStepSignature
      : (candidate) => getTaskScriptStepSignature(candidate);
  const normalizedIntent = normalizeLearningIntent(intent || "generic_task");
  const stageKind = getStageKind(step);
  if (['build_estate', 'build_furnished_house_phase'].includes(step.skill)) {
    const args = step.args || {};
    return `${normalizedIntent}:v${step.skill === 'build_estate' ? 2 : 3}:${getConstructionMaterialSource(step)}:${args.profile}:${args.phase || 'build'}`;
  }
  const signature = getTaskScriptStepSignatureValue(step) || String(step?.skill || "step").trim();
  return `${normalizedIntent}:${stageKind}:${signature}`.toLowerCase().slice(0, 96);
}

function annotateTaskScriptRevision(plan = null, revisionMeta = {}, context = {}) {
  const normalizeTaskScriptPlan =
    typeof context.normalizeTaskScriptPlan === "function"
      ? context.normalizeTaskScriptPlan
      : (value) => value;
  const normalizedPlan = normalizeTaskScriptPlan(plan);
  if (!normalizedPlan) {
    return null;
  }
  return {
    ...normalizedPlan,
    scriptMeta: {
      ...(normalizedPlan.scriptMeta || {}),
      ...(revisionMeta && typeof revisionMeta === "object" ? revisionMeta : {}),
    },
  };
}

function getStageScriptLibrarySummary(stageScripts = {}, currentTask = null) {
  const scripts = Object.values(stageScripts || {}).filter((script) => script?.key);
  const bySuccess = [...scripts].sort((a, b) => Number(b.success || 0) - Number(a.success || 0));
  const byRecentSuccess = [...scripts]
    .filter((script) => validatedStageScriptStep(script))
    .sort((a, b) => Number(b.lastUsedAt || 0) - Number(a.lastUsedAt || 0));
  const byFailureRate = [...scripts]
    .map((script) => {
      const success = Number(script.success || 0);
      const failed = Number(script.failed || 0) + Number(script.blocked || 0);
      const total = success + failed;
      return {
        script,
        failureRate: total > 0 ? failed / total : 0,
        total,
      };
    })
    .filter((item) => item.total > 0 && item.failureRate > 0)
    .sort((a, b) => b.failureRate - a.failureRate || b.total - a.total);
  return {
    total: scripts.length,
    successful: scripts.filter((script) => validatedStageScriptStep(script)).length,
    currentTaskHitCount: Number(currentTask?.plan?.scriptMeta?.scriptLibraryHit || 0) || 0,
    activeStageKey: String(currentTask?.activeStageScript?.key || "").trim() || null,
    recentSuccessfulStages: byRecentSuccess.slice(0, 5).map((script) => ({
      key: String(script.key || "").trim(),
      stageKind: String(script.stageKind || "").trim(),
      skill: String(script.skill || "").trim(),
      resourceKey: String(script.resourceKey || "").trim() || null,
      revision: Number(script.validatedRevision ?? script.revision ?? 0),
      success: Number(script.success || 0),
    })),
    topReused: bySuccess.slice(0, 5).map((script) => ({
      key: String(script.key || "").trim(),
      stageKind: String(script.stageKind || "").trim(),
      skill: String(script.skill || "").trim(),
      success: Number(script.success || 0),
      blocked: Number(script.blocked || 0),
      failed: Number(script.failed || 0),
    })),
    failureHotspots: byFailureRate.slice(0, 5).map((item) => ({
      key: String(item.script.key || "").trim(),
      stageKind: String(item.script.stageKind || "").trim(),
      skill: String(item.script.skill || "").trim(),
      failureRate: Number(item.failureRate.toFixed(2)),
      lastReason: String(item.script.lastReason || "").trim() || null,
    })),
  };
}

function buildLearningSnapshot(learningState = {}, currentTask = null, context = {}) {
  const clampValue =
    typeof context.clamp === "function"
      ? context.clamp
      : clamp;
  return {
    intents: Object.entries(learningState.intents || {})
      .slice(0, 8)
      .map(([intent, stats]) => ({
        intent,
        success: Number(stats?.success || 0),
        blocked: Number(stats?.blocked || 0),
        failed: Number(stats?.failed || 0),
      })),
    resources: Object.entries(learningState.resources || {})
      .slice(0, 8)
      .map(([resource, stats]) => ({
        resource,
        searchRadiusBonus: Number(stats?.searchRadiusBonus || 0),
        success: Number(stats?.success || 0),
        blocked: Number(stats?.blocked || 0),
      })),
    builds: {
      smallHouseScalePenalty: clampValue(
        Number(learningState.builds?.smallHouseScalePenalty) || 0,
        0,
        3
      ),
      smallHousePlaybookVersion:
        Number(learningState.builds?.smallHousePlaybookVersion || SMALL_HOUSE_PLAYBOOK_VERSION) ||
        SMALL_HOUSE_PLAYBOOK_VERSION,
    },
    taskScripts: Object.values(learningState.taskScripts || {})
      .slice(-8)
      .map((script) => ({
        key: String(script?.key || "").trim(),
        intent: String(script?.intent || "").trim(),
        success: Number(script?.success || 0),
        blocked: Number(script?.blocked || 0),
        failed: Number(script?.failed || 0),
        summary: String(script?.summary || "").trim() || null,
        planHash: String(script?.planHash || "").trim() || null,
        reusable: script?.reusable !== false,
        playbookVersion: Number(script?.playbookVersion || 0) || null,
        featureTokens: Array.isArray(script?.features?.tokens)
          ? script.features.tokens.slice(0, 12)
          : [],
        revision: Number(script?.revision || 0),
        lastOutcome: String(script?.lastOutcome || "").trim() || null,
        lastReason: String(script?.lastReason || "").trim() || null,
        reasonCounts:
          script?.reasonCounts && typeof script.reasonCounts === "object"
            ? Object.fromEntries(
                Object.entries(script.reasonCounts)
                  .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
                  .slice(0, 3)
              )
            : {},
        recentNotes: limitArray(script?.recentNotes || [], 3),
      }))
      .filter((item) => item.key),
    stageScripts: Object.values(learningState.stageScripts || {})
      .slice(-12)
      .map((script) => ({
        key: String(script?.key || "").trim(),
        intent: String(script?.intent || "").trim(),
        taskIntent: String(script?.taskIntent || script?.intent || "").trim(),
        stageKind: String(script?.stageKind || "").trim(),
        skill: String(script?.skill || "").trim(),
        resourceKey: String(script?.resourceKey || "").trim() || null,
        targetKey: String(script?.targetKey || "").trim() || null,
        success: Number(script?.success || 0),
        blocked: Number(script?.blocked || 0),
        failed: Number(script?.failed || 0),
        revision: Number(script?.revision || 0),
        lastOutcome: String(script?.lastOutcome || "").trim() || null,
        lastReason: String(script?.lastReason || "").trim() || null,
      }))
      .filter((item) => item.key),
    scriptLibrary: getStageScriptLibrarySummary(learningState.stageScripts || {}, currentTask),
    recentInsights: limitArray(learningState.recentInsights || [], 5),
  };
}

function normalizeLearningTaskScripts(rawScripts = {}, context = {}) {
  const normalizeTaskScriptPlan =
    typeof context.normalizeTaskScriptPlan === "function"
      ? context.normalizeTaskScriptPlan
      : (value) => value;
  if (!rawScripts || typeof rawScripts !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(rawScripts)
      .map(([rawKey, rawBucket]) => {
        const key = String(rawKey || "").trim();
        if (!key || !rawBucket || typeof rawBucket !== "object") {
          return null;
        }
        return [
          key,
          revalidateWholeLearningBucket({
            key,
            intent: String(rawBucket.intent || "").trim(),
            success: Math.max(0, Number(rawBucket.success || 0) || 0),
            componentSuccess: Math.max(0, Number(rawBucket.componentSuccess || 0) || 0),
            wholeAcceptance: cloneSerializable(rawBucket.wholeAcceptance, null),
            wholeLearningStatus: String(rawBucket.wholeLearningStatus || '').trim() || null,
            lastWholeOutcome: String(rawBucket.lastWholeOutcome || '').trim() || null,
            pendingWholeReason: String(rawBucket.pendingWholeReason || '').trim() || null,
            blocked: Math.max(0, Number(rawBucket.blocked || 0) || 0),
            failed: Math.max(0, Number(rawBucket.failed || 0) || 0),
            revision: Math.max(0, Number(rawBucket.revision || 0) || 0),
            lastOutcome: String(rawBucket.lastOutcome || "").trim() || null,
            lastReason: String(rawBucket.lastReason || "").trim() || null,
            reasonCounts:
              rawBucket.reasonCounts && typeof rawBucket.reasonCounts === "object"
                ? Object.fromEntries(
                    Object.entries(rawBucket.reasonCounts)
                      .map(([reason, count]) => [String(reason || "").trim(), Math.max(0, Number(count || 0) || 0)])
                      .filter(([reason]) => reason)
                  )
                : {},
            lastUsedAt: Number(rawBucket.lastUsedAt || 0) || 0,
            recentCommands: Array.isArray(rawBucket.recentCommands)
              ? rawBucket.recentCommands
                  .map((item) => String(item || "").trim())
                  .filter(Boolean)
                  .slice(-6)
              : [],
            recentNotes: Array.isArray(rawBucket.recentNotes)
              ? rawBucket.recentNotes
                  .map((item) => String(item || "").trim())
                  .filter(Boolean)
                  .slice(-8)
              : [],
            summary: String(rawBucket.summary || "").trim().slice(0, 240),
            features:
              rawBucket.features && typeof rawBucket.features === "object"
                ? {
                    intent: String(rawBucket.features.intent || "").trim(),
                    skillSequence: Array.isArray(rawBucket.features.skillSequence)
                      ? rawBucket.features.skillSequence.map((item) => String(item || "").trim()).filter(Boolean)
                      : [],
                    tokens: Array.isArray(rawBucket.features.tokens)
                      ? rawBucket.features.tokens.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 80)
                      : [],
                    resourceKeys: Array.isArray(rawBucket.features.resourceKeys)
                      ? rawBucket.features.resourceKeys.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 24)
                      : [],
                    stepCount: Math.max(0, Number(rawBucket.features.stepCount || 0) || 0),
                    planHash: String(rawBucket.features.planHash || "").trim(),
                  }
                : null,
            planHash: String(rawBucket.planHash || rawBucket.features?.planHash || "").trim(),
            playbookVersion: Number(rawBucket.playbookVersion || 0) || null,
            reusable:
              rawBucket.reusable === false
                ? false
                : Boolean(rawBucket.lastSuccessfulPlan) || Number(rawBucket.success || 0) > 0,
            lastMatchScore: Number(rawBucket.lastMatchScore || 0) || 0,
            lastRerankMode: String(rawBucket.lastRerankMode || "").trim(),
            templatePlan: normalizeTaskScriptPlan(rawBucket.templatePlan),
            lastSuccessfulPlan: normalizeTaskScriptPlan(rawBucket.lastSuccessfulPlan),
          }, context),
        ];
      })
      .filter(Boolean)
      .slice(-30)
  );
}

function normalizeLearningStageScripts(rawScripts = {}, context = {}) {
  if (!rawScripts || typeof rawScripts !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(rawScripts)
      .map(([rawKey, rawBucket]) => {
        const key = String(rawKey || "").trim();
        if (!key || !rawBucket || typeof rawBucket !== "object") {
          return null;
        }
        const templateStep = normalizeStageScriptStep(rawBucket.templateStep);
        const bucket = {
            key,
            intent: String(rawBucket.intent || rawBucket.taskIntent || "").trim(),
            taskIntent: String(rawBucket.taskIntent || rawBucket.intent || "").trim(),
            stageKind: String(rawBucket.stageKind || "").trim() || "act",
            skill: String(rawBucket.skill || templateStep?.skill || "").trim(),
            signature: String(rawBucket.signature || "").trim(),
            resourceKey: String(rawBucket.resourceKey || "").trim(),
            targetKey: String(rawBucket.targetKey || "").trim(),
            environmentTags: Array.isArray(rawBucket.environmentTags)
              ? rawBucket.environmentTags
                  .map((item) => String(item || "").trim())
                  .filter(Boolean)
                  .slice(0, 12)
              : [],
            success: Math.max(0, Number(rawBucket.success || 0) || 0),
            blocked: Math.max(0, Number(rawBucket.blocked || 0) || 0),
            failed: Math.max(0, Number(rawBucket.failed || 0) || 0),
            revision: Math.max(0, Number(rawBucket.revision || 0) || 0),
            lastOutcome: String(rawBucket.lastOutcome || "").trim() || null,
            lastReason: String(rawBucket.lastReason || "").trim() || null,
            lastUsedAt: Number(rawBucket.lastUsedAt || 0) || 0,
            reasonCounts:
              rawBucket.reasonCounts && typeof rawBucket.reasonCounts === "object"
                ? Object.fromEntries(
                    Object.entries(rawBucket.reasonCounts)
                      .map(([reason, count]) => [String(reason || "").trim(), Math.max(0, Number(count || 0) || 0)])
                      .filter(([reason]) => reason)
                  )
                : {},
            telemetry:
              rawBucket.telemetry && typeof rawBucket.telemetry === "object"
                ? cloneSerializable(rawBucket.telemetry, {}) || {}
                : {},
            recentNotes: Array.isArray(rawBucket.recentNotes)
              ? rawBucket.recentNotes
                  .map((item) => String(item || "").trim())
                  .filter(Boolean)
                  .slice(-8)
              : [],
            templateStep: templateStep?.skill ? templateStep : null,
            validationSchema: rawBucket.validationSchema === 1 ? 1 : undefined,
            lastSuccessfulStep: normalizeStageScriptStep(rawBucket.lastSuccessfulStep),
            validatedRevision: Number.isInteger(rawBucket.validatedRevision) && rawBucket.validatedRevision >= 0 ? rawBucket.validatedRevision : null,
            candidateStep: normalizeStageScriptStep(rawBucket.candidateStep),
            candidateRevision: Number.isInteger(rawBucket.candidateRevision) && rawBucket.candidateRevision >= 0 ? rawBucket.candidateRevision : null,
            candidateStatus: ['pending', 'validated', 'legacy_unverified'].includes(rawBucket.candidateStatus) ? rawBucket.candidateStatus : null,
            stepHistory: Array.isArray(rawBucket.stepHistory) ? cloneSerializable(rawBucket.stepHistory, []) || [] : [],
          };
        upgradeStageScriptValidation(bucket);
        // templateStep remains the compatibility view of the validated version;
        // quarantined legacy templates are retained only as unverified history.
        if (bucket.lastSuccessfulStep) bucket.templateStep = normalizeStageScriptStep(bucket.lastSuccessfulStep);
        return [key, bucket];
      })
      .filter(Boolean)
      .slice(-80)
  );
}

function normalizeLearningState(raw = null, context = {}) {
  const clampValue =
    typeof context.clamp === "function"
      ? context.clamp
      : clamp;
  const createDefaultLearningState =
    typeof context.createDefaultLearningState === "function"
      ? context.createDefaultLearningState
      : () => ({
          schemaVersion: 2,
          migratedAt: null,
          indexes: { taskFeatures: {} },
          intents: {},
          resources: {},
          taskScripts: {},
          stageScripts: {},
          builds: {
            smallHouseScalePenalty: 0,
            smallHousePlaybookVersion: SMALL_HOUSE_PLAYBOOK_VERSION,
            smallHousePhaseStats: {},
          },
          recentInsights: [],
        });
  const base = createDefaultLearningState();
  if (!raw || typeof raw !== "object") {
    return base;
  }
  return {
    schemaVersion: 2,
    migratedAt:
      typeof raw.migratedAt === "number" && Number.isFinite(raw.migratedAt)
        ? raw.migratedAt
        : base.migratedAt || null,
    indexes:
      raw.indexes && typeof raw.indexes === "object"
        ? {
            taskFeatures:
              raw.indexes.taskFeatures && typeof raw.indexes.taskFeatures === "object"
                ? raw.indexes.taskFeatures
                : {},
          }
        : base.indexes || { taskFeatures: {} },
    intents: raw.intents && typeof raw.intents === "object" ? raw.intents : {},
    resources: raw.resources && typeof raw.resources === "object" ? raw.resources : {},
    taskScripts: normalizeLearningTaskScripts(raw.taskScripts, context),
    stageScripts: normalizeLearningStageScripts(raw.stageScripts, context),
    builds: {
      smallHouseScalePenalty: clampValue(Number(raw.builds?.smallHouseScalePenalty) || 0, 0, 3),
      smallHousePlaybookVersion:
        Number(raw.builds?.smallHousePlaybookVersion || SMALL_HOUSE_PLAYBOOK_VERSION) ||
        SMALL_HOUSE_PLAYBOOK_VERSION,
      smallHousePhaseStats:
        raw.builds?.smallHousePhaseStats && typeof raw.builds.smallHousePhaseStats === "object"
          ? raw.builds.smallHousePhaseStats
          : {},
    },
    recentInsights: Array.isArray(raw.recentInsights)
      ? raw.recentInsights.slice(-20).filter((item) => item && typeof item === "object")
      : [],
  };
}

function getWatchdogProfile(step = {}) {
  return cloneSerializable(compileStep(step)?.watchdog || null, null);
}

function classifyErrorForStep(step = {}, error) {
  const detail = String(error?.message || error || "").trim();
  if (/^(?:mining_|estate_|farm_)/.test(String(error?.code || ''))) {
    return { status: "blocked", code: error.code, message: detail };
  }
  const compiled = step?.action && typeof step.action === "object" ? step.action : compileStep(step);
  const actionId = String(compiled?.actionId || step?.skill || "").trim();

  if (!detail) {
    return {
      status: "failed",
      code: "unknown",
      message: "任务执行失败",
    };
  }

  if (detail === "server_disconnected") {
    return {
      status: "failed",
      code: "server_disconnected",
      message: "Minecraft 连接已断开",
    };
  }

  if (
    /材料不足|背包里没有|无法现做|工作台|熔炉|furnace|iron_ingot|raw_iron|coal|没有可用的工作台|stick|pickaxe|axe|sword|无法合成|当前无法挖掘|无法继续冶炼|缺少可用燃料/.test(
      detail
    )
  ) {
    return {
      status: "blocked",
      code: "insufficient_material",
      message: detail,
    };
  }

  if (["escort_player", "follow_player"].includes(actionId) && /没有找到要护卫的玩家|没有找到要跟随的玩家/.test(detail)) {
    return {
      status: "blocked",
      code: "player_not_found",
      message: detail,
    };
  }

  if (["escort_player", "attack_hostile"].includes(actionId) && /没有发现敌对生物/.test(detail)) {
    return {
      status: "blocked",
      code: "no_hostile_in_range",
      message: detail,
    };
  }

  if (actionId === "harvest_crops" && /附近没有找到成熟可收割的作物|没有成熟可收割/.test(detail)) {
    return {
      status: "blocked",
      code: "crop_not_ready",
      message: detail,
    };
  }

  if (
    actionId === "plant_crops" &&
    /附近没有可补种的空农田|缺少可用种子\/作物|当前无法补种|无法补种|没有可种/.test(detail)
  ) {
    return {
      status: "blocked",
      code: "planting_input_missing",
      message: detail,
    };
  }

  if (actionId === "maintain_self") {
    const maintainAction = String(compiled?.args?.action || "").trim();
    if (
      ["eat_if_needed", "restock_food"].includes(maintainAction) &&
      /食物|口粮|面包|苹果|胡萝卜|土豆|小麦/.test(detail)
    ) {
      return {
        status: "blocked",
        code: "insufficient_material",
        message: detail,
      };
    }
    if (maintainAction === "pickup_nearby_drops" && /没有找到|附近没有/.test(detail)) {
      return {
        status: "blocked",
        code: "resource_not_found",
        message: detail,
      };
    }
  }

  if (/附近没有找到|没有找到/.test(detail)) {
    return {
      status: "blocked",
      code: "resource_not_found",
      message: detail,
    };
  }

  if (/socket_not_writable|bot_connection_lost|write EPIPE|socket_write_epipe/i.test(detail)) {
    return {
      status: "failed",
      code: /socket_write_epipe|write EPIPE/i.test(detail)
        ? "socket_write_epipe"
        : /bot_connection_lost/i.test(detail)
          ? "bot_connection_lost"
          : "socket_not_writable",
      message: detail,
    };
  }

  if (/executor_stalled|没有真正开始动作|没有检测到真实动作|movement_preempted/.test(detail)) {
    return {
      status: "blocked",
      code: /movement_preempted/.test(detail) ? "movement_preempted" : "executor_stalled",
      message: detail,
    };
  }

  if (/超时/.test(detail)) {
    return {
      status: "blocked",
      code: "timeout",
      message: detail,
    };
  }

  if (/path|route|goal|position/i.test(detail)) {
    return {
      status: "blocked",
      code: "no_path",
      message: detail,
    };
  }

  return {
    status: "failed",
    code: "generic_failure",
    message: detail,
  };
}

function shouldResetRuntimeFor(step = {}, code = "") {
  const normalizedCode = String(code || "").trim();
  if (["socket_not_writable", "bot_connection_lost", "socket_write_epipe"].includes(normalizedCode)) {
    return false;
  }
  const recovery = compileStep(step)?.recovery;
  if (!recovery || !Array.isArray(recovery.resetOn)) {
    return false;
  }
  return recovery.resetOn.includes(normalizedCode);
}

function getRecoveryPolicy(step = {}, code = "") {
  const compiled = compileStep(step);
  const normalizedCode = String(code || "").trim();
  const recovery = compiled?.recovery || null;
  const revision = compiled?.revision || null;
  const isConnectionLoss = ["socket_not_writable", "bot_connection_lost", "socket_write_epipe"].includes(
    normalizedCode
  );
  return {
    actionId: compiled?.actionId || "unknown_action",
    contractType: compiled?.contractType || "bounded",
    strategy: String(recovery?.strategy || "").trim() || null,
    shouldResetRuntime: isConnectionLoss ? false : shouldResetRuntimeFor(step, normalizedCode),
    skipRecovery:
      isConnectionLoss ||
      (Boolean(normalizedCode) &&
      Array.isArray(revision?.skipRecoveryOn) &&
      revision.skipRecoveryOn.includes(normalizedCode)),
  };
}

function shouldSkipStageRevision(step = {}, code = "") {
  const compiled = compileStep(step);
  const normalizedCode = String(code || "").trim();
  if (["socket_not_writable", "bot_connection_lost", "socket_write_epipe"].includes(normalizedCode)) {
    return true;
  }
  const revision = compiled?.revision || null;
  if (!normalizedCode || !revision || !Array.isArray(revision.skipStageRevisionOn)) {
    return false;
  }
  return revision.skipStageRevisionOn.includes(normalizedCode);
}

function reviseStepForFailure(step = {}, classified = {}) {
  const compiled = step?.action && typeof step.action === "object" ? step.action : compileStep(step);
  const actionId = String(compiled?.actionId || step?.skill || "").trim();
  const code = String(classified?.code || "").trim();
  const args = step?.args && typeof step.args === "object" ? { ...step.args } : {};

  if (["mine_resource", "gather_wood", "collect_block"].includes(actionId)) {
    if (["target_not_found", "resource_not_found", "timeout", "executor_stalled", "step_timeout"].includes(code)) {
      args.maxDistance = clamp(Math.max(Number(args.maxDistance) || 24, 40) + 12, 8, 128);
    }
    if (["no_path", "movement_preempted"].includes(code)) {
      args.maxDistance = clamp(Math.max(Number(args.maxDistance) || 24, 36) + 8, 8, 128);
      args.searchStrategy = "prefer_near_standable";
    }
  }

  if (actionId === "go_to_position" || actionId === "follow_player") {
    if (["no_path", "timeout", "executor_stalled", "movement_preempted"].includes(code)) {
      args.range = clamp(Math.max(Number(args.range) || Number(args.distance) || 1, 2) + 1, 1, 6);
      args.repath = true;
    }
  }

  if (actionId === "escort_player" || actionId === "attack_hostile") {
    if (["no_path", "timeout", "executor_stalled", "movement_preempted"].includes(code)) {
      args.hostileRadius = clamp(Math.max(Number(args.hostileRadius) || 10, 8) + 2, 6, 18);
      args.leashDistance = clamp(Math.max(Number(args.leashDistance) || 8, 8) + 2, 6, 24);
    }
    if (["target_not_found", "no_hostile_in_range"].includes(code)) {
      args.hostileRadius = clamp(Math.max(Number(args.hostileRadius) || 10, 10) + 3, 6, 24);
      args.leashDistance = clamp(Math.max(Number(args.leashDistance) || 8, 8) + 2, 6, 28);
      args.guardScanMode = "wide_then_hold";
      args.repath = true;
    }
  }

  if (actionId === "build_structure") {
    if (["timeout", "step_timeout", "executor_stalled", "no_path", "generic_failure"].includes(code)) {
      args.position = null;
      args.width = clamp(Math.max(3, Number(args.width) || 3) - 1, 3, 6);
      args.depth = clamp(Math.max(3, Number(args.depth) || 3) - 1, 3, 6);
      args.height = clamp(Math.max(2, Number(args.height) || 2), 2, 3);
      args.resumeMode = "phase_checkpoint";
    }
    if (code === "insufficient_material") {
      args.width = clamp(Math.max(3, Number(args.width) || 3) - 1, 3, 6);
      args.depth = clamp(Math.max(3, Number(args.depth) || 3) - 1, 3, 6);
      args.resumeMode = "after_material_bootstrap";
    }
  }

  if (actionId === "build_small_house_phase") {
    if (["timeout", "step_timeout", "executor_stalled", "no_path", "generic_failure"].includes(code)) {
      args.resumeMode = "phase_checkpoint";
    }
    if (code === "insufficient_material") {
      args.phase = "prepare_materials";
      args.resumeMode = "material_checkpoint";
    }
  }

  if (actionId === "harvest_crops") {
    if (["crop_not_ready", "resource_not_found", "timeout", "executor_stalled", "step_timeout"].includes(code)) {
      args.maxDistance = clamp(Math.max(Number(args.maxDistance) || 20, 24) + 8, 8, 64);
      args.count = clamp(Math.max(Number(args.count) || 6, 1), 1, 12);
    }
  }

  if (actionId === "plant_crops") {
    if (["planting_input_missing", "timeout", "executor_stalled", "step_timeout"].includes(code)) {
      args.maxDistance = clamp(Math.max(Number(args.maxDistance) || 20, 24) + 8, 8, 64);
      args.count = clamp(Math.max(1, Number(args.count) || 6) - 1, 1, 12);
    }
  }

  if (actionId === "maintain_self" && ["no_path", "timeout", "executor_stalled", "movement_preempted"].includes(code)) {
    if (Number.isFinite(Number(args.maxDistance))) {
      args.maxDistance = clamp(Math.max(Number(args.maxDistance) || 0, 8) + 4, 4, 128);
    }
    if (Number.isFinite(Number(args.range))) {
      args.range = clamp(Math.max(Number(args.range) || 0, 2) + 1, 1, 8);
    }
    if (Number.isFinite(Number(args.waitMs))) {
      args.waitMs = clamp(Math.max(Number(args.waitMs) || 0, 800) + 400, 400, 30000);
    }
  }

  const revisedStep = {
    ...step,
    args,
  };
  return {
    ...revisedStep,
    action: compileStep(revisedStep),
  };
}

function buildStageRevisionPrepSteps(step = {}, classified = {}, context = {}) {
  const compiled = step?.action && typeof step.action === "object" ? step.action : compileStep(step);
  const actionId = String(compiled?.actionId || step?.skill || "").trim();
  const code = String(classified?.code || "").trim();
  const args = step?.args && typeof step.args === "object" ? { ...step.args } : {};
  const revision = compiled?.revision || null;
  const prepStrategy = String(revision?.prepStrategy || "").trim();
  const prepSteps = [];

  if (prepStrategy === "none") {
    return prepSteps;
  }

  if (code !== "insufficient_material") {
    return prepSteps;
  }

  if (prepStrategy === "build_material_bootstrap") {
    const resolveBuildMaterial =
      typeof context.resolveBuildMaterial === "function" ? context.resolveBuildMaterial : (value) => String(value || "").trim();
    const material = resolveBuildMaterial(args.material || "wood");
    const anyPlanks = Array.isArray(context.anyPlanks) ? context.anyPlanks : [];
    const getLearnedSearchRadius =
      typeof context.getLearnedSearchRadius === "function"
        ? context.getLearnedSearchRadius
        : (_resourceKey, fallback) => Number(fallback) || 24;

    if (anyPlanks.includes(material)) {
      prepSteps.push({
        skill: "gather_wood",
        args: {
          block: "wood",
          count: 6,
          label: "木头",
          maxDistance: getLearnedSearchRadius("wood", 64, 128),
        },
      });
    } else if (material === "cobblestone") {
      prepSteps.push({
        skill: "mine_resource",
        args: {
          block: "stone",
          count: 16,
          label: "圆石",
          maxDistance: getLearnedSearchRadius("stone", 48, 96),
        },
      });
    }
    return prepSteps;
  }

  if (actionId === "plant_crops" && code === "planting_input_missing") {
    prepSteps.push(
      createActionStep("harvest_crops", {
        crops: Array.isArray(args.crops) ? args.crops : undefined,
        count: Math.max(2, Math.min(Number(args.count) || 4, 6)),
        maxDistance: Math.max(Number(args.maxDistance) || 20, 20),
        replant: true,
      })
    );
    return prepSteps;
  }

  if (actionId === "maintain_self" && code === "insufficient_material") {
    const maintainAction = String(args.action || "").trim();
    if (["eat_if_needed", "restock_food"].includes(maintainAction)) {
      prepSteps.push(
        createActionStep("harvest_crops", {
          crops: ["wheat", "carrots", "potatoes"],
          count: 4,
          maxDistance: 20,
          replant: true,
        })
      );
    }
    return prepSteps;
  }

  if (["mine_resource", "collect_block"].includes(actionId)) {
    const getResourceLearningKey =
      typeof context.getResourceLearningKey === "function"
        ? context.getResourceLearningKey
        : (value) => String(value || "").trim().toLowerCase();
    prepSteps.push(
      createActionStep("craft_item", {
        item: getResourceLearningKey(args.block || "") === "wood" ? "wooden_axe" : "stone_pickaxe",
        count: 1,
      })
    );
  }

  return prepSteps;
}

function adaptPlanForLearning(plan = {}, learningStats = {}) {
  if (!plan || typeof plan !== "object") {
    return plan;
  }
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const timeoutCount = Number(learningStats.timeout || 0);
  const noPathCount = Number(learningStats.no_path || 0);
  const targetNotFoundCount = Number(learningStats.target_not_found || 0);
  const resourceNotFoundCount = Number(learningStats.resource_not_found || 0);
  const insufficientMaterialCount = Number(learningStats.insufficient_material || 0);
  const genericFailureCount = Number(learningStats.generic_failure || 0);
  const cropNotReadyCount = Number(learningStats.crop_not_ready || 0);
  const plantingInputMissingCount = Number(learningStats.planting_input_missing || 0);

  const adaptedSteps = steps.map((step) => {
    const compiled = step?.action && typeof step.action === "object" ? step.action : compileStep(step);
    const actionId = String(compiled?.actionId || step?.skill || "").trim();
    const learningStrategy = String(compiled?.learning?.strategy || "").trim();
    const args = step?.args && typeof step.args === "object" ? { ...step.args } : {};

    if (learningStrategy === "gather_adaptation" && (targetNotFoundCount >= 2 || resourceNotFoundCount >= 2 || timeoutCount >= 2)) {
      args.maxDistance = clamp(
        Math.max(Number(args.maxDistance) || 24, 36) +
          targetNotFoundCount * 8 +
          resourceNotFoundCount * 6 +
          timeoutCount * 4,
        8,
        128
      );
    }

    if (learningStrategy === "move_adaptation" && actionId === "go_to_position" && noPathCount >= 2) {
      args.range = clamp(Math.max(Number(args.range) || 1, 2) + 1, 1, 6);
    }

    if (learningStrategy === "escort_adaptation" && actionId === "escort_player" && noPathCount >= 2) {
      args.leashDistance = clamp(Math.max(Number(args.leashDistance) || 8, 6) - 1, 4, 10);
      args.hostileRadius = clamp(Math.max(Number(args.hostileRadius) || 10, 8) - 1, 6, 12);
    }

    if (learningStrategy === "build_adaptation" && actionId === "build_structure") {
      if (timeoutCount >= 2 || genericFailureCount >= 2 || noPathCount >= 2) {
        args.width = clamp(Math.max(3, Number(args.width) || 3) - 1, 3, 6);
        args.depth = clamp(Math.max(3, Number(args.depth) || 3) - 1, 3, 6);
        args.height = clamp(Math.max(2, Number(args.height) || 2), 2, 3);
        args.position = null;
      }
      if (insufficientMaterialCount >= 2) {
        args.width = clamp(Math.max(3, Number(args.width) || 3) - 1, 3, 6);
        args.depth = clamp(Math.max(3, Number(args.depth) || 3) - 1, 3, 6);
      }
    }

    if (learningStrategy === "crop_harvest_adaptation" && actionId === "harvest_crops") {
      if (cropNotReadyCount >= 2 || timeoutCount >= 2) {
        args.maxDistance = clamp(Math.max(Number(args.maxDistance) || 20, 24) + 8, 8, 64);
      }
    }

    if (learningStrategy === "crop_planting_adaptation" && actionId === "plant_crops") {
      if (plantingInputMissingCount >= 2 || timeoutCount >= 2) {
        args.maxDistance = clamp(Math.max(Number(args.maxDistance) || 20, 24) + 8, 8, 64);
        args.count = clamp(Math.max(1, Number(args.count) || 6) - 1, 1, 12);
      }
    }

    const adaptedStep = {
      ...step,
      args,
    };
    return {
      ...adaptedStep,
      action: compileStep(adaptedStep),
    };
  });

  return {
    ...plan,
    steps: adaptedSteps,
  };
}

function revisePlanForFailure(plan = {}, classified = {}) {
  if (!plan || typeof plan !== "object") {
    return plan;
  }
  const code = String(classified?.code || "").trim();
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const revisedSteps = steps.map((step) => reviseStepForFailure(step, classified));
  return compilePlan({
    ...plan,
    steps: revisedSteps,
    replyText: [
      String(plan.replyText || "").trim(),
      code ? `我会按 ${code} 这个失败原因把脚本再收紧一版。` : "",
    ]
      .filter(Boolean)
      .join(" "),
  });
}

function buildStageRevisionPlan(task = null, classified = {}, context = {}) {
  const getStageScriptKeyValue =
    typeof context.getStageScriptKey === "function"
      ? context.getStageScriptKey
      : (intent, step) => getStageScriptKey(intent, step, context);
  const resolveBuildMaterial =
    typeof context.resolveBuildMaterial === "function"
      ? context.resolveBuildMaterial
      : (value) => String(value || "").trim().toLowerCase();
  const anyPlanks = Array.isArray(context.anyPlanks) ? context.anyPlanks : [];
  const getLearnedSearchRadius =
    typeof context.getLearnedSearchRadius === "function"
      ? context.getLearnedSearchRadius
      : (_resourceKey, fallback) => Number(fallback || 24);
  const getResourceLearningKey =
    typeof context.getResourceLearningKey === "function"
      ? context.getResourceLearningKey
      : (value) => String(value || "").trim().toLowerCase();

  const activeStep = task?.plan?.steps?.[Number(task?.currentStepIndex) || 0] || null;
  if (!task?.plan || !activeStep) {
    return null;
  }
  const code = String(classified?.code || "").trim();
  const activeSkill = String(activeStep.skill || "");
  const intent = String(task.intent || task.plan.intent || "");
  if (activeSkill === 'build_estate' || intent === 'build_estate' ||
    activeSkill === 'build_furnished_house_phase' || intent === 'build_furnished_house' ||
    activeSkill === "build_small_house_phase" || intent === "mine_diamond_resource" ||
    (intent === "build_small_house" && activeSkill === "build_structure")) {
    return null;
  }
  if (shouldSkipStageRevision(activeStep, code)) {
    return null;
  }

  const revisedStep = reviseStepForFailure(activeStep, classified);
  if (String(activeStep.skill || "") === "craft_item") return null;
  const noEffectRevision =
    JSON.stringify({
      skill: String(activeStep.skill || "").trim(),
      args: cloneSerializable(activeStep.args || {}, {}) || {},
    }) ===
    JSON.stringify({
      skill: String(revisedStep.skill || "").trim(),
      args: cloneSerializable(revisedStep.args || {}, {}) || {},
    });

  if (noEffectRevision) {
    return {
      mode: "task",
      intent: `${task.intent || task.plan.intent || "task"}_revision_stopped`,
      goal: task.plan.goal || "",
      steps: [cloneSerializable(activeStep, {}) || activeStep],
      postTaskMode: task.plan.postTaskMode || null,
      postTaskArgs: task.plan.postTaskArgs || null,
      replyText: "这次修订没有带来有效变化，已停止重复重试。",
      scriptMeta: {
        ...(task.plan.scriptMeta || {}),
        activeStageKey: getStageScriptKeyValue(task.intent || task.plan.intent || "", activeStep),
        revisionReason: "no_effect_revision",
        stageSource: "stage_revision",
      },
      noEffectRevision: true,
    };
  }

  const stageKind = getStageKind(activeStep);
  const skill = String(activeStep.skill || "").trim();
  if (skill === "craft_item") {
    return null;
  }

  const prepSteps = buildStageRevisionPrepSteps(activeStep, classified, {
    resolveBuildMaterial,
    anyPlanks,
    getLearnedSearchRadius,
    getResourceLearningKey,
  });

  return continueTaskPlan(task, [...prepSteps, revisedStep], {
    replyText:
      code === "no_hostile_in_range"
        ? "当前没有怪需要处理，我继续在你附近护卫待命。"
        : `我只修订 ${stageKind} 阶段：${code || "unknown"}，不会把整条任务推倒重来。`,
    scriptMeta: {
      activeStageKey: getStageScriptKeyValue(task.intent || task.plan.intent || "", activeStep),
      revisionReason: code || "unknown",
      stageSource: "stage_revision",
    },
  });
}

function buildRecoveryPlan(task = null, classified = {}, context = {}) {
  if (!task || !task.plan || typeof task.plan !== "object") {
    return null;
  }
  const code = String(classified?.code || "").trim();
  const activeIndex = Number(task?.currentStepIndex) || 0;
  const activeStep = task?.plan?.steps?.[activeIndex] || null;
  const activeSkill = String(activeStep?.skill || "").trim();
  const activeItemName = String(activeStep?.args?.item || "").trim();
  const intent = String(task?.intent || task?.plan?.intent || "").trim();
  const recoveryPolicy = getRecoveryPolicy(activeStep, code);

  if (recoveryPolicy?.skipRecovery) {
    return null;
  }

  if (intent === 'build_estate' || activeSkill === 'build_estate') {
    // The original objective owns the profile and supply permission. A retry
    // reconstructs the complete estate rather than learning a smaller house.
    const originalStep = getEstateStep(task.completionPlan) || getEstateStep(task.plan) || activeStep;
    if (originalStep?.skill !== 'build_estate' || !validateStep(originalStep).valid) return null;
    const args = cloneSerializable(compileStep(originalStep).args, {});
    const checkpoint = task.stepCheckpoint?.estate || {};
    if (checkpoint.sourceProfile && checkpoint.sourceProfile !== args.profile) return null;
    if (checkpoint.materialSource !== undefined && checkpoint.materialSource !== getConstructionMaterialSource(originalStep)) return null;
    if (checkpoint.anchor != null) {
      if (!isIntegerPosition(checkpoint.anchor)) return null;
      if (args.anchor && ['x', 'y', 'z'].some((key) => args.anchor[key] !== checkpoint.anchor[key])) return null;
      args.anchor = cloneSerializable(checkpoint.anchor);
    }
    if (args.depots === undefined && checkpoint.depots !== undefined) args.depots = cloneSerializable(checkpoint.depots);
    const resumed = createActionStep('build_estate', args);
    if (!resumed.action.valid) return null;
    const suffix = task.plan.steps.slice(activeIndex + (activeSkill === 'build_estate' ? 1 : 0));
    return { ...task.plan, mode: 'task', intent: 'build_estate',
      goal: task.completionPlan?.goal || task.plan.goal || task.userCommand || '',
      steps: [resumed, ...suffix],
      replyText: '我会保留原定庄园款式、建造点和补给权限，从实际世界检查点继续完整建造并重新核验。' };
  }

  if (intent === 'build_furnished_house') {
    const originalStep = getConstructionStep(task.completionPlan) || getConstructionStep(task.plan);
    if (originalStep?.skill !== 'build_furnished_house_phase' || !validateStep(originalStep).valid) return null;
    const originalSteps = task.plan.steps || [];
    const activePhase = activeSkill === 'build_furnished_house_phase' ? activeStep.args.phase : 'verify';
    const checkpoint = task.stepCheckpoint?.furnishedHouse || {};
    const profile = originalStep.args.profile;
    const materialSource = originalStep.args.materialSource;
    const anchor = originalStep.args.anchor || checkpoint.anchor || null;
    if ((checkpoint.sourceProfile && checkpoint.sourceProfile !== profile) ||
        (checkpoint.materialSource !== undefined && checkpoint.materialSource !== getConstructionMaterialSource(originalStep)) ||
        (anchor && !isIntegerPosition(anchor)) ||
        (originalStep.args.anchor && checkpoint.anchor && ['x', 'y', 'z'].some((key) => originalStep.args.anchor[key] !== checkpoint.anchor[key]))) return null;
    let steps;
    if (code === 'insufficient_material' || activePhase === 'verify') {
      let suffixIndex = activeIndex + (activeSkill === 'build_furnished_house_phase' ? 1 : 0);
      while (activePhase !== 'verify' && originalSteps[suffixIndex]?.skill === 'build_furnished_house_phase') {
        if (originalSteps[suffixIndex++].args?.phase === 'verify') break;
      }
      steps = [...createFurnishedHousePlaybookSteps({ profile, anchor, materialSource })
        .filter((step) => !['inspect_inventory', 'select_site'].includes(step.args.phase)), ...originalSteps.slice(suffixIndex)];
    } else {
      steps = originalSteps.slice(activeIndex).map((step, index) => index === 0
        ? createActionStep('build_furnished_house_phase', { ...step.args, profile, materialSource,
          ...(anchor ? { anchor } : {}), resumeMode: 'world_checkpoint' })
        : step.skill === 'build_furnished_house_phase'
          ? createActionStep(step.skill, { ...step.args, profile, materialSource, ...(anchor ? { anchor } : {}) }) : step);
    }
    return { ...task.plan, intent: 'build_furnished_house', goal: task.completionPlan?.goal || task.plan.goal, steps, replyText: '我会保留已建成的结构和原定家具，从已记录的位置补齐未完成阶段，再重新核验。' };
  }

  if ((intent === "craft_item" || activeSkill === "craft_item") && typeof context.buildCraftRecoveryPlan === "function") {
    const repair = context.buildCraftRecoveryPlan(activeItemName, task);
    if (repair?.steps?.length) {
      const steps = repair.steps.map((value) => cloneSerializable(value, value));
      for (let index = steps.length - 1; index >= 0; index -= 1) {
        if (steps[index].skill === "craft_item" && steps[index].args?.item === activeItemName) {
          steps[index] = { ...steps[index], args: { ...steps[index].args, ...activeStep.args } };
          break;
        }
      }
      return continueTaskPlan(task, steps, { replyText: repair.replyText });
    }
  }

  if (intent === "build_small_house") {
    if (activeSkill === "build_small_house_phase") {
      const originalSteps = Array.isArray(task.plan?.steps) ? task.plan.steps : [];
      const activePhase = String(activeStep.args?.phase || "").trim();
      const needsMaterialOrRepair = code === "insufficient_material" || activePhase === "verify";
      // Recreate the repair phases even after an earlier recovery removed them.
      // The world checkpoint fixes the anchor and completed blueprint blocks are retained.
      let steps;
      if (needsMaterialOrRepair) {
        let suffixIndex = activeIndex + 1;
        if (activePhase !== "verify") {
          while (originalSteps[suffixIndex]?.skill === "build_small_house_phase") {
            const phase = originalSteps[suffixIndex].args?.phase;
            suffixIndex += 1;
            if (phase === "verify") break;
          }
        }
        steps = [
          ...createSmallHousePlaybookSteps(activeStep.args)
            .filter((item) => !["inspect_inventory", "select_site"].includes(item.args.phase))
            .map((item) => ({ ...item, args: { ...item.args, anchor: activeStep.args?.anchor || task.stepCheckpoint?.anchor || task.stepCheckpoint?.buildAnchor || null } })),
          ...originalSteps.slice(suffixIndex),
        ];
      } else {
        steps = originalSteps.slice(Math.max(0, activeIndex)).map((item, index) =>
          index === 0 ? reviseStepForFailure(item, classified) : item
        );
      }
      if (!steps.length) {
        return null;
      }
      return {
        ...task.plan,
        mode: "task",
        intent: task.plan.intent || "build_small_house",
        goal: task.plan.goal || "continue the deterministic small-house playbook from the last safe checkpoint",
        steps,
        replyText:
          code === "insufficient_material"
            ? "材料不够，我回到备木材阶段补齐以后继续盖。"
            : activePhase === "verify"
              ? "校验发现缺块，我会保留已经建好的部分，补齐材料和缺块后再检查。"
            : "这次从当前小木屋阶段重新续跑，不再重跑整段黑盒建造。",
      };
    }
    const step = activeSkill === "build_structure" ? activeStep : null;
    if (!step) {
      return null;
    }
    return continueTaskPlan(task, [createActionStep("build_structure", {
      ...step.args,
      position: step.args?.position || task.stepCheckpoint?.anchor || task.stepCheckpoint?.buildAnchor || null,
      resumeMode: "phase_checkpoint",
    })], {
      replyText:
        code === "insufficient_material"
          ? "我会补齐材料，保留原来的建造目标和位置继续盖。"
          : "我会从当前建造位置恢复，保留原来的尺寸和后续任务。",
    });
  }

  if (
    intent === "mine_diamond_resource" &&
    typeof context.hasDiamondMiningPickaxe === "function" &&
    (typeof context.buildToolProgressionPlan === "function" ||
      typeof context.buildIronPickaxeProgressionSteps === "function") &&
    typeof context.getLearnedSearchRadius === "function"
  ) {
    const diamondIndex = (task.plan.steps || []).findIndex((item) =>
      String(item?.skill || "").trim() === "mine_resource" &&
      ["diamond", "diamond_ore", "deepslate_diamond_ore"].includes(String(item.args?.block || "").trim().toLowerCase())
    );
    if (diamondIndex < 0) return null;
    if (activeIndex > diamondIndex) return continueTaskPlan(task, [reviseStepForFailure(activeStep, classified)]);
    const diamondStep = task.plan.steps[diamondIndex];
    const prerequisiteSteps = context.hasDiamondMiningPickaxe()
      ? []
      : typeof context.buildIronPickaxeProgressionSteps === "function"
        ? context.buildIronPickaxeProgressionSteps({
            includeFinalCraft: true,
            requiredIronIngots: 3,
          })
        : context.buildToolProgressionPlan("iron_pickaxe_progression", {
            includeFinalCraft: true,
            requiredIronIngots: 3,
            deferFuelPreparation: true,
          });
    const widenedDiamondStep = diamondStep
      ? {
          ...diamondStep,
          args: {
            ...diamondStep.args,
            maxDistance: context.getLearnedSearchRadius(
              "diamond",
              Math.max(Number(diamondStep.args?.maxDistance) || 48, 64),
              96
            ),
          },
        }
      : null;
    if (!prerequisiteSteps.length && !widenedDiamondStep) {
      return null;
    }
    return continueTaskPlan(task, [...prerequisiteSteps, ...(widenedDiamondStep ? [widenedDiamondStep] : [])], {
      resumeAfterIndex: diamondIndex,
      replyText:
        prerequisiteSteps.length
          ? "我先把铁镐前置链补齐，再继续找钻石。"
          : "我换一个更远一点、更可能有钻石的区域继续找。",
    });
  }

  if (intent === "mine_resource" || intent === "gather_wood") {
    const step = ["mine_resource", "gather_wood", "collect_block"].includes(activeSkill) ? activeStep : null;
    if (!step) {
      return null;
    }
    const widenedDistance = clamp(Math.max(Number(step.args?.maxDistance) || 24, 48), 24, 96);
    const recoverySteps = [];
    if (code === "insufficient_material" && intent !== "gather_wood") {
      recoverySteps.push({
        ...createActionStep("craft_item", {
          item: "stone_pickaxe",
          count: 1,
        }),
      });
    }
    recoverySteps.push({
      ...step,
      args: {
        ...step.args,
        maxDistance: widenedDistance,
      },
    });
    return continueTaskPlan(task, recoverySteps, {
      replyText:
        code === "insufficient_material"
          ? intent === "gather_wood"
            ? "我先补一把斧子，再换棵更顺手的树继续砍。"
            : "我先把镐子补稳，再换一个更容易到达的采集点继续挖。"
          : intent === "gather_wood"
            ? "我换远一点、好挖一点的树继续收集。"
            : "我换一个更容易到达的采集点继续挖。",
    });
  }

  if (intent === "harvest_crops" || activeSkill === "harvest_crops") {
    const step = Array.isArray(task.plan?.steps)
      ? task.plan.steps.find((item) => String(item?.skill || "").trim() === "harvest_crops")
      : null;
    if (!step) {
      return null;
    }
    if (code === "crop_not_ready") {
      return null;
    }
    return continueTaskPlan(task, [
        createActionStep("harvest_crops", {
          ...step.args,
          maxDistance: clamp(Math.max(Number(step.args?.maxDistance) || 20, 24) + 8, 8, 64),
        }),
      ], {
      replyText: "我先换一片更可能成熟的农田继续收作物。",
    });
  }

  if (intent === "plant_crops" || activeSkill === "plant_crops") {
    const step = Array.isArray(task.plan?.steps)
      ? task.plan.steps.find((item) => String(item?.skill || "").trim() === "plant_crops")
      : null;
    if (!step) {
      return null;
    }
    const recoverySteps = [];
    if (code === "planting_input_missing") {
      recoverySteps.push(
        createActionStep("harvest_crops", {
          crops: Array.isArray(step.args?.crops) ? step.args.crops : undefined,
          count: Math.max(2, Math.min(Number(step.args?.count) || 4, 6)),
          maxDistance: Math.max(Number(step.args?.maxDistance) || 20, 20),
          replant: true,
        })
      );
    }
    recoverySteps.push(
      createActionStep("plant_crops", {
        ...step.args,
        maxDistance: clamp(Math.max(Number(step.args?.maxDistance) || 20, 24) + 8, 8, 64),
        count: clamp(Math.max(1, Number(step.args?.count) || 6) - (code === "planting_input_missing" ? 1 : 0), 1, 12),
      })
    );
    return continueTaskPlan(task, recoverySteps, {
      replyText:
        code === "planting_input_missing"
          ? "我先补一点能当种子的作物，再继续把这片农田种回去。"
          : "我先换一片更容易补种的农田继续种。",
    });
  }

  if (activeStep) {
    return {
      ...task.plan,
      intent,
      goal: task.plan?.goal || "",
      steps: task.plan.steps.slice(activeIndex),
      replyText: "我不会从头乱跑，先从卡住的阶段检查点重试，并用真实动作心跳确认它真的动起来。",
    };
  }

  return null;
}

function compilePlan(plan = {}) {
  if (!plan || typeof plan !== "object") {
    return plan;
  }
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const compiledSteps = steps.map((step) => {
    const compiledAction = compileStep(step);
    return {
      ...step,
      action: compiledAction,
    };
  });
  return {
    ...plan,
    steps: compiledSteps,
  };
}

function listActions() {
  return Object.values(ACTION_DEFINITIONS).map((definition) => cloneSerializable(definition, {}) || {});
}

module.exports = {
  createMinecraftActionRegistry(options = {}) {
    const gates = Object.fromEntries(['wholeLearningGate', 'legacyBucketGate'].filter(key => typeof options[key] === 'function').map(key => [key, options[key]]));
    const hostContext = context => ({ ...context, ...gates });
    return {
      getActionDefinition,
      getConstructionMaterialSource,
      getActionContractType,
      validateStep,
      createActionStep,
      createSmallHousePlaybookSteps,
      createFurnishedHousePlaybookSteps,
      createPostTaskDirective,
      getPreparationDescriptor,
      getExecutionDescriptor,
      getExecutionRuntimeGroup,
      getExecutionRuntimeKey,
      getExecutionRuntimeArgs,
      compileStep,
      compilePlan,
      getStageKind,
      getStageResourceKey,
      getStageTargetKey,
      getTaskScriptKey,
      tokenizeTaskCommand,
      extractTaskScriptFeatures,
      getTaskScriptPlanTemplate: (bucket, plan, context = {}) => getTaskScriptPlanTemplate(bucket, plan, hostContext(context)),
      scoreTaskScriptBucket: (bucket, plan, command = '', context = {}) => scoreTaskScriptBucket(bucket, plan, command, hostContext(context)),
      findBestLearnedTaskScript: (plan, command = '', scripts = {}, context = {}) => findBestLearnedTaskScript(plan, command, scripts, hostContext(context)),
      createTaskScriptBucket,
      ensureTaskScriptBucket,
      getTaskScriptReasonCount,
      createIntentLearningBucket,
      createResourceLearningBucket,
      getTaskScriptStepSignature,
      getStepObjectiveKey,
      pickTaskScriptDynamicArgs,
      rememberTaskScriptOutcome: (bucket, task, outcome = '', note = '', context = {}) => rememberTaskScriptOutcome(bucket, task, outcome, note, hostContext(context)),
      mergeTaskScriptPlan,
      pickStepExecutionTuning,
      continueTaskPlan,
      getTaskScriptPlanningHints: (command, plan, scripts = {}, context = {}) => getTaskScriptPlanningHints(command, plan, scripts, hostContext(context)),
      buildHeuristicTaskPlan,
      buildAutonomousTaskPlan,
      compileTaskScriptPlan: (command, plan, scripts = {}, stages = {}, context = {}) => compileTaskScriptPlan(command, plan, scripts, stages, hostContext(context)),
      createStageScriptBucket,
      ensureStageScriptBucket,
      getStageScriptKey,
      scoreStageScriptBucket,
      findBestLearnedStageScript,
      applyLearnedStageScripts,
      rememberStageScriptOutcome,
      recordTaskLearningOutcome: (state, task, outcome = '', context = {}) => recordTaskLearningOutcome(state, task, outcome, hostContext(context)),
      annotateTaskScriptRevision,
      getTaskLearningResourceKey,
      getStageScriptLibrarySummary,
      buildLearningSnapshot,
      normalizeLearningTaskScripts: (scripts, context = {}) => normalizeLearningTaskScripts(scripts, hostContext(context)),
      normalizeLearningStageScripts,
      normalizeLearningState: (state, context = {}) => normalizeLearningState(state, hostContext(context)),
      getWatchdogProfile,
      classifyErrorForStep,
      shouldResetRuntimeFor,
      getRecoveryPolicy,
      shouldSkipStageRevision,
      reviseStepForFailure,
      buildStageRevisionPrepSteps,
      buildCraftRecoveryPlan,
      buildToolProgressionPlan,
      adaptPlanForLearning,
      revisePlanForFailure,
      buildStageRevisionPlan,
      buildRecoveryPlan,
      listActions,
    };
  },
};
