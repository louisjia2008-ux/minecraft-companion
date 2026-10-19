const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createMinecraftActionRegistry } = require("./action/actionRegistry");
const {
  createLearningKeyTools,
  getResourceLearningKey,
  isWoodBlockName,
  normalizeLearningIntent,
} = require("./minecraft/learningKeys");
const { createLearningStateTools } = require("./minecraft/learningState");
const {
  createLearningStateStore,
  migrateLegacyLearningStateIfNeeded,
} = require("./minecraft/learningStore");
const {
  createPlannerSafety,
  normalizePlannerResult,
  rejectPlannerScriptlet,
} = require("./minecraft/plannerSafety");
const {
  createPlannerPromptTools,
  stringifyPlannerPayload,
} = require("./minecraft/plannerPrompts");
const {
  createNetherPortalBlueprint,
  createSmallHouseBlueprint,
  createSmallHousePlaybookBlueprint,
  finalizeBlueprintBlocks,
  getBlueprintPhaseGroups,
  getBlueprintExpectedBlockNames,
  getSmallHousePlaybookDimensions,
  getSmallHousePlaybookMaterial,
  getSmallHousePlaybookRequiredBlocks,
  isAnyPlankMaterial,
  resolveBuildMaterial,
} = require("./minecraft/buildingBlueprints");
const {
  createBackgroundAgenda,
  getAutonomousGoalText,
  getPassiveEscortGoalText,
  isBackgroundAgendaFresh,
  publicBackgroundAgenda,
} = require("./minecraft/autonomyPresentation");
const {
  CancellationToken,
  ReflexManager,
} = require("./minecraft/agentControl");
const {
  createRuleReloadEvent,
  createRuleReloadWatcher,
} = require("./minecraft/ruleReload");
const { PerceptionRuleEngine, ReflexRuleEngine } = require("./minecraft/ruleEngine");
const { createTaskDiagnostics } = require("./minecraft/taskDiagnostics");
const {
  createTaskPublicStateTools,
  publicPhysicalAction,
  publicTaskLogs,
} = require("./minecraft/taskPublicState");
const { limitArray } = require("./minecraft/taskUtils");
const {
  classifyDisconnectDetailSource,
  createDisconnectRaceError,
  getConnectionFailureTaskCode,
  getDisconnectPath,
} = require("./minecraft/disconnectClassification");
const {
  createRuntimeDiagnostics,
  describeRuntimeFaultMessage,
} = require("./minecraft/runtimeDiagnostics");
const {
  buildDisconnectedWorldContext,
  buildExecutorContext,
  buildPlannerContext,
  buildStatusFields,
  formatDisconnectReasonText,
  publicWorldContext,
} = require("./minecraft/worldContextView");
const {
  buildRecoveryPlan,
  classifyTaskError,
} = require("./minecraft/taskRecovery");
const { TaskState } = require("./minecraft/taskState");
const taskCatalog = require("./minecraft/taskCatalog");

test("task catalog exports stable resource aliases and item priorities", () => {
  assert.equal(taskCatalog.HOSTILE_MOB_NAMES.has("creeper"), true);
  assert.equal(taskCatalog.HOSTILE_PRIORITY.creeper < taskCatalog.HOSTILE_PRIORITY.zombie, true);
  assert.deepEqual(taskCatalog.RESOURCE_ALIASES.cobblestone.blocks, ["stone", "cobblestone"]);
  assert.equal(taskCatalog.BUILD_MATERIAL_ALIASES.wood, "oak_planks");
  assert.equal(taskCatalog.LOG_TO_PLANK.oak_log, "oak_planks");
  assert.equal(taskCatalog.PLANK_TO_LOG.oak_planks, "oak_log");
  assert.equal(taskCatalog.ANY_PLANKS.includes("oak_planks"), true);
  assert.equal(taskCatalog.WEAPON_ITEM_PRIORITY[0], "netherite_sword");
  assert.equal(taskCatalog.CROP_HARVEST_CONFIG.wheat.replantItem, "wheat_seeds");
  assert.equal(taskCatalog.CROP_ITEM_TO_BLOCK.wheat_seeds, "wheat");
});

test("building blueprints generate deterministic portal and house block plans", () => {
  const portal = createNetherPortalBlueprint({ x: 10, y: 64, z: -3 });
  assert.equal(portal.length, 10);
  assert.deepEqual(portal[0], {
    position: { x: 11, y: 64, z: -3 },
    item: "obsidian",
  });
  assert.deepEqual(portal.at(-1), {
    position: { x: 13, y: 67, z: -3 },
    item: "obsidian",
  });

  const tinyHouse = createSmallHouseBlueprint({ x: 10, y: 64, z: -3 }, "oak_planks", 3, 3, 2);
  assert.equal(tinyHouse.length, 31);
  assert.deepEqual(
    getBlueprintPhaseGroups({ x: 10, y: 64, z: -3 }, tinyHouse, 2).map((group) => [
      group.label,
      group.blocks.length,
    ]),
    [
      ["地板", 9],
      ["墙体", 13],
      ["屋顶", 9],
    ]
  );
  assert.equal(
    tinyHouse.some((block) => block.position.x === 11 && block.position.y === 65 && block.position.z === -3),
    false
  );
  assert.equal(
    tinyHouse.some((block) => block.position.x === 11 && block.position.y === 67 && block.position.z === -2),
    true
  );
});

test("building blueprint finalization filters invalid blocks, dedupes, and sorts by world position", () => {
  assert.deepEqual(
    finalizeBlueprintBlocks(
      { x: 5, y: 10, z: -2 },
      [
        { x: 1, y: 1, z: 1, item: "oak_planks" },
        { x: 1, y: 1, z: 1, item: "birch_planks" },
        { x: 0, y: 0, z: 2, item: "oak_planks" },
        { x: "bad", y: 0, z: 0, item: "oak_planks" },
        { x: 0, y: 0, z: 1 },
      ]
    ),
    [
      { position: { x: 5, y: 10, z: 0 }, item: "oak_planks" },
      { position: { x: 6, y: 11, z: -1 }, item: "birch_planks" },
    ]
  );
});

test("building blueprint material helpers keep small-house playbook constraints stable", () => {
  assert.equal(resolveBuildMaterial("wood"), "oak_planks");
  assert.equal(resolveBuildMaterial(" Stone "), "cobblestone");
  assert.equal(resolveBuildMaterial("birch_planks"), "birch_planks");
  assert.equal(isAnyPlankMaterial("any_planks"), true);
  assert.deepEqual(getBlueprintExpectedBlockNames("any_planks"), taskCatalog.ANY_PLANKS);
  assert.deepEqual(getBlueprintExpectedBlockNames("oak_planks"), ["oak_planks"]);

  const requestedLarge = {
    args: {
      width: 8,
      depth: 9,
      height: 6,
      material: "stone",
    },
  };
  assert.deepEqual(getSmallHousePlaybookDimensions(requestedLarge), {
    width: 3,
    depth: 3,
    height: 2,
  });
  assert.equal(getSmallHousePlaybookMaterial(requestedLarge), "any_planks");
  assert.equal(
    getSmallHousePlaybookMaterial({ args: { material: "spruce_planks" } }),
    "spruce_planks"
  );
  assert.equal(getSmallHousePlaybookRequiredBlocks(requestedLarge), 31);
  assert.equal(
    createSmallHousePlaybookBlueprint({ x: 0, y: 0, z: 0 }, requestedLarge).length,
    31
  );
});

test("learning state tools normalize through an explicit action registry", () => {
  const registry = createMinecraftActionRegistry();
  const tools = createLearningStateTools(registry);
  const normalized = tools.normalizeLearningState({
    schemaVersion: 1,
    taskScripts: {
      "build_small_house:wood_playbook_v1": {
        intent: "build_small_house",
        reusable: true,
        lastSuccessfulPlan: {
          mode: "task",
          intent: "build_small_house",
          steps: [
            registry.createActionStep("build_small_house_phase", {
              phase: "inspect_inventory",
            }),
          ],
        },
      },
    },
  });

  assert.equal(normalized.schemaVersion, 2);
  assert.ok(normalized.taskScripts["build_small_house:wood_playbook_v1"]);
  assert.equal(
    normalized.taskScripts["build_small_house:wood_playbook_v1"].lastSuccessfulPlan.intent,
    "build_small_house"
  );
});

test("learning key helpers normalize resources and registry-backed script keys", () => {
  const registry = createMinecraftActionRegistry();
  const tools = createLearningKeyTools(registry, { resolveBuildMaterial });
  const housePlan = registry.buildHeuristicTaskPlan("build_small_house", {});
  const buildStep = housePlan.steps.find(
    (step) => step.args?.phase === "prepare_materials"
  );

  assert.equal(normalizeLearningIntent("build_small_house_recovery"), "build_small_house");
  assert.equal(isWoodBlockName("oak_log"), true);
  assert.equal(getResourceLearningKey("deepslate_diamond_ore"), "diamond");
  assert.equal(getResourceLearningKey("birch_planks"), "wood");
  assert.equal(tools.getTaskScriptKey(housePlan, "造小木屋"), "build_small_house:wood_playbook_v1");
  assert.equal(tools.getStageKindForStep(buildStep), "prepare");
  assert.equal(tools.getStageScriptResourceKey(buildStep), "wood");
  assert.match(
    tools.getStageScriptKey(housePlan.intent, buildStep),
    /^build_small_house:prepare:/
  );
});

test("learning store owns migration, save scheduling, and error fallback", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "live2d-mc-learning-store-"));
  const legacyPath = path.join(tempDir, "legacy.json");
  const nextPath = path.join(tempDir, "nested", "minecraft-agent-learning.json");
  fs.writeFileSync(
    legacyPath,
    JSON.stringify({ schemaVersion: 1, taskScripts: {}, stageScripts: {} }),
    "utf8"
  );

  assert.equal(
    migrateLegacyLearningStateIfNeeded({
      learningStatePath: nextPath,
      legacyLearningStatePath: legacyPath,
    }),
    true
  );
  assert.equal(fs.existsSync(nextPath), true);
  assert.equal(
    fs.existsSync(path.join(path.dirname(nextPath), "minecraft-agent-learning.legacy-backup.json")),
    true
  );
  assert.equal(
    migrateLegacyLearningStateIfNeeded({
      learningStatePath: nextPath,
      legacyLearningStatePath: legacyPath,
    }),
    false
  );

  const registry = createMinecraftActionRegistry();
  const { normalizeLearningState } = createLearningStateTools(registry);
  const errors = [];
  const timers = [];
  const clearedTimers = [];
  const store = createLearningStateStore({
    learningStatePath: nextPath,
    legacyLearningStatePath: legacyPath,
    normalizeLearningState,
    now: () => 1234,
    broadcastMinecraftError: (message) => errors.push(message),
    setTimer(callback, ms) {
      const timer = { callback, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      clearedTimers.push(timer);
    },
  });

  const loaded = store.load();
  assert.equal(loaded.shouldSave, true);
  assert.equal(loaded.state.schemaVersion, 2);
  assert.equal(loaded.state.migratedAt, 1234);
  store.scheduleSave(() => ({ ok: true }));
  assert.equal(timers[0].ms, 250);
  store.dispose();
  assert.deepEqual(clearedTimers, [timers[0]]);

  const invalidPath = path.join(tempDir, "invalid.json");
  fs.writeFileSync(invalidPath, "{", "utf8");
  const fallbackStore = createLearningStateStore({
    learningStatePath: invalidPath,
    normalizeLearningState,
    broadcastMinecraftError: (message) => errors.push(message),
  });
  const fallback = fallbackStore.load();
  assert.equal(fallback.state.schemaVersion, 2);
  assert.match(errors.at(-1), /Minecraft 学习档读取失败/);
});

test("default rule engines produce perception events and command reflex plans", () => {
  const perception = new PerceptionRuleEngine();
  const reflex = new ReflexRuleEngine();

  const events = perception.evaluate({
    self: { health: 6 },
    nearbyHostiles: [{ entityId: 7, distance: 3.2 }],
    nearbyItems: [],
  });
  assert.ok(events.some((event) => event.type === "signal.low_health"));
  assert.ok(events.some((event) => event.type === "signal.hostile_nearby"));

  const eventRules = reflex.evaluateEvent(
    { type: "signal.hostile_nearby", payload: { distance: 3.2 } },
    { hasUserTask: false }
  );
  assert.equal(eventRules[0].reflex, "evade_hostile");
  assert.equal(reflex.evaluateCommand("跟着我", {})?.reflexPlan, "follow_player");
});

test("agent control helpers isolate cancellation and reflex planning state", async () => {
  const token = new CancellationToken();
  token.pause();
  assert.throws(() => token.throwIfRequested(), /paused/);
  token.resume();
  token.cancel("manual_cancel");
  assert.throws(
    () => token.throwIfRequested(),
    (error) => error.code === "manual_cancel"
  );

  const registry = createMinecraftActionRegistry();
  const notices = [];
  const reflex = new ReflexManager({
    actionRegistry: registry,
    ruleEngine: {
      evaluateCommand(command, context) {
        assert.equal(command, "跟着我");
        assert.equal(context.playerName, "Alex");
        return {
          reflexPlan: "follow_player",
          intent: "reflex_follow_player",
          replyText: "我直接跟上。",
          args: { distance: 3 },
        };
      },
    },
    onReflexNotice: (message) => notices.push(message),
  });

  const plan = reflex.maybeBuildReflexPlan("跟着我", { playerName: "Alex" });
  assert.equal(plan.intent, "reflex_follow_player");
  assert.deepEqual(plan.steps, [
    registry.createActionStep("follow_player", {
      playerName: "Alex",
      distance: 3,
    }),
  ]);

  assert.equal(
    await reflex.runReflex(
      "test_reflex",
      { type: "signal.test", payload: { entityId: 1 } },
      async () => true,
      { cooldownKey: "test:1", cooldownMs: 1000 }
    ),
    true
  );
  assert.equal(reflex.shouldInhibitAI(), false);
  assert.deepEqual(notices, ["触发快速反应：test_reflex"]);
  assert.equal(reflex.isCooldownReady("test:1", 1000), false);

  const missingRegistryPlan = new ReflexManager({
    ruleEngine: {
      evaluateCommand: () => ({ reflexPlan: "follow_player" }),
    },
  }).maybeBuildReflexPlan("跟着我", {});
  assert.equal(missingRegistryPlan, null);
});

test("rule reload watcher centralizes reload event formatting and file watch cleanup", () => {
  assert.deepEqual(
    createRuleReloadEvent(
      "rules_reloaded",
      "感知",
      { source: "file", rules: [{ id: "a" }, { id: "b" }] },
      { taskId: "task-1", timestamp: 123 }
    ),
    {
      type: "mc_task_event",
      event: {
        eventType: "rules_reloaded",
        taskId: "task-1",
        timestamp: 123,
        message: "感知规则已热重载，当前来源：YAML 文件",
        ruleSet: "感知",
        rulesCount: 2,
        rulesSource: "file",
      },
    }
  );

  const broadcasts = [];
  const errors = [];
  const watched = [];
  const unwatched = [];
  const watcher = createRuleReloadWatcher({
    debounceMs: 1,
    now: () => 456,
    getCurrentTaskId: () => "task-live",
    broadcast: (event) => broadcasts.push(event),
    broadcastMinecraftError: (message) => errors.push(message),
    watchFile(filePath, options, listener) {
      watched.push({ filePath, options, listener });
    },
    unwatchFile(filePath, listener) {
      unwatched.push({ filePath, listener });
    },
    setTimer(callback) {
      callback();
      return 1;
    },
    clearTimer() {},
  });

  watcher.watchRuleFile("reflex", "reflex.yaml", () => ({
    changed: true,
    source: "default",
    rules: [{ id: "follow" }],
  }));
  watched[0].listener(
    { mtimeMs: 1, size: 1, ctimeMs: 1 },
    { mtimeMs: 1, size: 1, ctimeMs: 1 }
  );
  assert.equal(broadcasts.length, 0);
  watched[0].listener(
    { mtimeMs: 2, size: 1, ctimeMs: 2 },
    { mtimeMs: 1, size: 1, ctimeMs: 1 }
  );
  assert.equal(broadcasts[0].event.message, "reflex规则已热重载，当前来源：内建默认规则");
  assert.equal(broadcasts[0].event.taskId, "task-live");

  watcher.watchRuleFile("感知", "perception.yaml", () => {
    throw new Error("bad yaml");
  });
  watched[1].listener(
    { mtimeMs: 2, size: 1, ctimeMs: 2 },
    { mtimeMs: 1, size: 1, ctimeMs: 1 }
  );
  assert.equal(errors[0], "Minecraft 感知规则热重载失败：bad yaml");
  assert.equal(broadcasts[1].event.eventType, "rules_reload_failed");
  assert.equal(broadcasts[1].event.errorMessage, "bad yaml");

  watcher.dispose();
  assert.deepEqual(
    unwatched.map((item) => item.filePath),
    ["reflex.yaml", "perception.yaml"]
  );
});

test("planner safety normalizes bounded plans and rejects executable scriptlets", () => {
  const registry = createMinecraftActionRegistry();
  const safety = createPlannerSafety(registry);
  const payload = {
    mode: "task",
    intent: "test_plan",
    steps: Array.from({ length: 40 }, (_, index) => ({
      skill: index % 2 === 0 ? "follow_player" : "missing_skill",
      args: {
        index,
        nested: { ok: true },
      },
    })),
    missingResources: Array.from({ length: 20 }, (_, index) => `资源${index}`),
    resume_step_index: 99,
    jsScript: "process.exit(1)",
  };
  const normalized = normalizePlannerResult(payload);

  assert.equal(normalized.steps.length, 32);
  assert.equal(normalized.missingResources.length, 16);
  assert.equal(normalized.resumeFromStepIndex, 31);
  assert.equal(normalized.scriptlet, "process.exit(1)");
  payload.steps[0].args.nested.ok = false;
  assert.equal(normalized.steps[0].args.nested.ok, true);
  assert.deepEqual(safety.collectInvalidPlanStepSkills(normalized), ["missing_skill"]);
  assert.throws(() => rejectPlannerScriptlet(normalized.scriptlet), /不再支持 JavaScript scriptlet/);
});

test("planner prompt tools encode skills, safety constraints, and bounded revision payloads", () => {
  const registry = createMinecraftActionRegistry();
  const prompts = createPlannerPromptTools(registry, { maxUserContentLength: 40 });

  const plannerMessages = prompts.buildAiPlannerPromptMessages({
    command: "跟着我",
    contextSnapshot: { inventory: { items: [] } },
  });
  assert.equal(plannerMessages.length, 2);
  assert.match(plannerMessages[0].content, /禁止输出 JavaScript、scriptlet/);
  assert.match(plannerMessages[0].content, /follow_player/);
  assert.equal(JSON.parse(plannerMessages[1].content).command, "跟着我");

  const revisionMessages = prompts.buildAiRevisionPromptMessages({
    userPayload: { userCommand: "修一下", context: { detail: "x".repeat(200) } },
  });
  assert.match(revisionMessages[0].content, /禁止输出 JavaScript、scriptlet/);
  assert.match(revisionMessages[1].content, /\(truncated\)$/);
  assert.ok(revisionMessages[1].content.length < 80);

  const circular = {};
  circular.self = circular;
  assert.equal(stringifyPlannerPayload(circular), "{}");
});

test("autonomy presentation formats agenda and companion goal text without runtime state", () => {
  const agenda = createBackgroundAgenda(
    {
      intent: " autonomous_stock_wood ",
      goal: "补木头",
      phase: "stock",
      replyText: "我去补木头",
    },
    { phase: " gather ", now: 1000 }
  );

  assert.deepEqual(publicBackgroundAgenda(agenda, { strictExecutor: true }), {
    intent: "autonomous_stock_wood",
    goal: "补木头",
    phase: "gather",
    replyText: "我去补木头",
    updatedAt: 1000,
    suppressed: true,
  });
  assert.equal(isBackgroundAgendaFresh(agenda, { mode: "task" }, { now: 1000 + 179000 }), true);
  assert.equal(isBackgroundAgendaFresh(agenda, { mode: "task" }, { now: 1000 + 181000 }), false);
  assert.equal(
    getPassiveEscortGoalText({ playerName: "Alex", lastHostileName: "zombie" }),
    "正在自动护卫 Alex，并处理 zombie"
  );
  assert.equal(
    getAutonomousGoalText({
      autonomousState: { lastPhase: "stock" },
      phaseLabels: { stock: "补给" },
    }),
    "正在自动发育：补给"
  );
  assert.equal(
    getAutonomousGoalText({
      currentTask: { source: "autonomous", progressText: "正在回家" },
      autonomousState: { lastPhase: "stock" },
      phaseLabels: { stock: "补给" },
    }),
    "正在回家"
  );
});

test("task diagnostics writes JSONL traces and exposes the latest public snapshot", () => {
  const diagnosticsDir = fs.mkdtempSync(path.join(os.tmpdir(), "live2d-mc-diagnostics-"));
  const diagnostics = createTaskDiagnostics({
    diagnosticsDir,
    getBotWriteSnapshot: () => ({ primitive: "test.write" }),
  });
  const task = {
    taskId: "diag-test",
    status: "running",
    source: "user",
    intent: "follow_player",
    userCommand: "跟着我",
    currentStepIndex: 0,
  };

  diagnostics.startTaskDiagnostics(task);
  diagnostics.recordTaskDiagnostic(task, "step_started", { message: "ok" });
  diagnostics.finishTaskDiagnostics(task, "completed");

  const snapshot = diagnostics.getLastTaskDiagnostics();
  assert.equal(snapshot.traceId.startsWith("diag-test-"), true);
  assert.equal(snapshot.eventCount, 3);
  assert.equal(snapshot.lastEvent, "task_finished");
  const lines = fs.readFileSync(snapshot.tracePath, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[1]).lastWrite.primitive, "test.write");
});

test("task public state serializes logs, script meta, and summaries without runtime handles", () => {
  const activeAction = {
    id: "action-1",
    kind: "move",
    primitive: "pathfinder_goto",
    stageKind: "travel",
    ownerTaskId: "task-public",
    stepIndex: 0,
    startedAt: 100,
    firstSignalAt: 110,
    lastSignalAt: 120,
    physicalSignal: "distance_decreased",
    lastPositionDelta: 1.23456,
    lastDistanceDelta: 0.98765,
    recoveryReason: "executor_stalled",
  };
  const publicState = createTaskPublicStateTools({
    turnPhaseLabels: {
      executing: "执行中",
    },
    getTaskDiagnostics: (task) => ({
      traceId: `trace-${task.taskId}`,
      eventCount: 2,
    }),
    getActivePhysicalAction: () => activeAction,
  });
  const task = {
    taskId: "task-public",
    source: "user",
    userCommand: "造木屋",
    intent: "build_small_house",
    status: "running",
    createdAt: 100,
    startedAt: 120,
    progressText: "正在搭建",
    replyText: "交给我",
    recoveryCount: 1,
    aiMidTaskRevisionCount: 2,
    turnPhase: "executing",
    currentRegistryAction: { skill: "place_block", nested: { safe: true } },
    plan: {
      goal: "small house",
      scriptMeta: { revisionReason: "learned" },
    },
    activeStageScript: {
      key: "stage-1",
      revision: 3,
      stageKind: "build",
      source: "learning",
      revisionReason: "stuck",
    },
    logs: [
      { id: "1", taskId: "task-public", level: "info", message: "one", timestamp: 1 },
      { id: "2", taskId: "task-public", level: "warn", message: "two", timestamp: 2, stepIndex: 0 },
    ],
  };

  const summary = publicState.publicTaskSummary(task);
  assert.equal(summary.turnPhaseLabel, "执行中");
  assert.deepEqual(summary.plan, { goal: "small house" });
  assert.equal(summary.scriptMeta.activeStageKey, "stage-1");
  assert.equal(summary.scriptMeta.revisionReason, "stuck");
  assert.equal(summary.diagnostics.traceId, "trace-task-public");
  assert.deepEqual(summary.currentRegistryAction, {
    skill: "place_block",
    nested: { safe: true },
  });

  task.currentRegistryAction.nested.safe = false;
  assert.equal(summary.currentRegistryAction.nested.safe, true);
  const fullTask = publicState.publicTask(task);
  assert.equal(fullTask.turnPhaseLabel, "执行中");
  assert.equal(fullTask.diagnostics.traceId, "trace-task-public");
  assert.equal(fullTask.scriptMeta.activeStageKey, "stage-1");
  assert.deepEqual(fullTask.activeAction, {
    id: "action-1",
    kind: "move",
    primitive: "pathfinder_goto",
    stageKind: "travel",
    ownerTaskId: "task-public",
    stepIndex: 0,
    startedAt: 100,
    firstSignalAt: 110,
    lastSignalAt: 120,
    physicalSignal: "distance_decreased",
    lastPositionDelta: 1.235,
    lastDistanceDelta: 0.988,
    recoveryReason: "executor_stalled",
  });
  assert.deepEqual(publicPhysicalAction({ ...activeAction, ownerTaskId: "" }).ownerTaskId, null);
  assert.deepEqual(publicTaskLogs(task.logs, 1), [
    {
      id: "2",
      taskId: "task-public",
      level: "warn",
      message: "two",
      timestamp: 2,
      stepIndex: 0,
    },
  ]);
  assert.deepEqual(limitArray([1, 2, 3], 2), [2, 3]);
});

test("disconnect classification keeps transport and task failure semantics stable", () => {
  assert.equal(classifyDisconnectDetailSource("write EPIPE"), "socket_write_epipe");
  assert.equal(classifyDisconnectDetailSource("runtime_fault: idle tick"), "runtime_fault");
  assert.equal(classifyDisconnectDetailSource("disconnect requested by user"), "manual_disconnect");
  assert.equal(classifyDisconnectDetailSource("config switched"), "transport_restart");
  assert.equal(classifyDisconnectDetailSource("bot death"), "bot_death");
  assert.equal(classifyDisconnectDetailSource("kicked by server"), "server_kick");
  assert.equal(classifyDisconnectDetailSource("server_disconnected"), "server_disconnected");

  assert.equal(getDisconnectPath("socket_write_epipe"), "socket_write_epipe");
  assert.equal(getDisconnectPath("unknown"), "server_disconnected");
  assert.equal(
    getConnectionFailureTaskCode("manual_disconnect", "manual_disconnect"),
    "manual_disconnect"
  );
  assert.equal(
    getConnectionFailureTaskCode("socket_write_epipe", "write EPIPE"),
    "bot_connection_lost"
  );
  assert.equal(createDisconnectRaceError(new Error("write EPIPE")).code, "socket_write_epipe");
  assert.equal(createDisconnectRaceError(new Error("boom")).code, "bot_connection_lost");
});

test("runtime diagnostics isolate fault, bot write, and disconnect trail state", () => {
  const diagnosticsDir = fs.mkdtempSync(path.join(os.tmpdir(), "live2d-mc-runtime-diag-"));
  let currentNow = 1000;
  const task = {
    taskId: "runtime-task",
    currentStep: "pathfinder.goto",
    actionState: "moving",
    lastRecoveryReason: "executor_stalled",
  };
  const diagnostics = createRuntimeDiagnostics({
    disconnectTracePath: path.join(diagnosticsDir, "disconnect-trace.jsonl"),
    getCurrentTask: () => task,
    now: () => currentNow,
  });

  const fault = diagnostics.recordRuntimeFault("runtime_fault", new Error("boom"));
  assert.equal(describeRuntimeFaultMessage(new Error("boom")), "boom");
  assert.equal(fault.reason, "runtime_fault: boom");
  assert.deepEqual(diagnostics.getRuntimeFaultSnapshot(), {
    reason: "runtime_fault: boom",
    at: 1000,
  });

  currentNow = 1100;
  const writeSnapshot = diagnostics.rememberBotWrite("pathfinder.goto", {
    target: { x: 1, y: 2, z: 3 },
  });
  assert.equal(writeSnapshot.primitive, "pathfinder.goto");
  assert.equal(writeSnapshot.context.taskId, "runtime-task");
  assert.equal(writeSnapshot.context.currentStep, "pathfinder.goto");
  writeSnapshot.context.target.x = 99;
  assert.equal(diagnostics.getBotWriteSnapshot().context.target.x, 1);

  currentNow = 1200;
  const event = diagnostics.rememberDisconnectEvent("socket.close", "closed", {
    context: { primitive: "pathfinder.goto" },
  });
  assert.equal(event.taskId, "runtime-task");
  assert.equal(event.lastBotWritePrimitive, "pathfinder.goto");
  assert.equal(diagnostics.getDisconnectEventTrail().length, 1);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(diagnosticsDir, "disconnect-trace.jsonl"), "utf8").trim()).type,
    "socket.close"
  );

  const exported = diagnostics.exportState();
  diagnostics.resetRuntimeFault();
  diagnostics.resetBotWrite();
  diagnostics.resetDisconnectEventTrail();
  assert.deepEqual(diagnostics.getRuntimeFaultSnapshot(), { reason: "", at: 0 });
  assert.deepEqual(diagnostics.getBotWriteSnapshot(), { primitive: "", at: 0, context: null });
  assert.deepEqual(diagnostics.getDisconnectEventTrail(), []);
  diagnostics.importState(exported);
  assert.equal(diagnostics.getRuntimeFaultSnapshot().reason, "runtime_fault: boom");
  assert.equal(diagnostics.getBotWriteSnapshot().context.target.x, 1);
  assert.equal(diagnostics.getDisconnectEventTrail()[0].type, "socket.close");
});

test("world context view models trim heavy payloads and expose only safe planner fields", () => {
  const heavyContext = {
    connected: true,
    players: Array.from({ length: 9 }, (_, index) => ({ username: `p${index}` })),
    hostiles: Array.from({ length: 9 }, (_, index) => ({ name: `h${index}` })),
    nearbyBlocks: Array.from({ length: 13 }, (_, index) => ({ name: `b${index}` })),
    inventory: Array.from({ length: 33 }, (_, index) => ({ name: `i${index}` })),
    learning: { taskScriptCount: 1 },
    dragonProgression: { phase: "end" },
    recentMemories: [{ taskId: "memory" }],
  };

  const light = publicWorldContext(heavyContext, { includeHeavy: false });
  assert.equal(light.players.length, 4);
  assert.equal(light.hostiles.length, 4);
  assert.equal(light.nearbyBlocks.length, 6);
  assert.equal(light.inventory.length, 12);
  assert.equal("learning" in light, false);
  assert.equal("dragonProgression" in light, false);
  assert.equal("recentMemories" in light, false);

  const full = publicWorldContext(heavyContext, { includeHeavy: true });
  assert.equal(full.players.length, 8);
  assert.equal(full.hostiles.length, 8);
  assert.equal(full.nearbyBlocks.length, 12);
  assert.equal(full.inventory.length, 32);
  assert.deepEqual(full.learning, { taskScriptCount: 1 });

  const planner = buildPlannerContext(
    {
      aiProvider: "openai",
      aiModel: "gpt-5",
      aiProviderSource: "saved",
      openaiApiKey: "sk-secret",
      apiKey: "secret",
    },
    {
      currentTask: {
        plan: {
          scriptMeta: {
            plannerMode: "ai_refined",
          },
        },
      },
    }
  );
  assert.deepEqual(planner, {
    effectiveAiProvider: "openai",
    effectiveAiModel: "gpt-5",
    providerSource: "saved",
    mode: "ai_refined",
  });
  assert.equal("openaiApiKey" in planner, false);
  assert.equal("apiKey" in planner, false);
});

test("world context view models isolate executor diagnostics and status fields", () => {
  const botWriteSnapshot = {
    primitive: "pathfinder.goto",
    at: 200,
    context: {
      target: { x: 1, y: 2, z: 3 },
    },
  };
  const executor = buildExecutorContext({
    mode: "experimental-autonomy",
    modeSource: "runtime",
    autonomyArmedAt: 10,
    autonomySafeUntil: 20,
    lastDisconnectPath: "socket_write_epipe",
    disconnectDetailSource: "server_disconnected",
    lastDisconnectEventTrail: [{ type: "socket.close" }],
    runtimeFaultSnapshot: { reason: "runtime_fault: boom", at: 100 },
    botWriteSnapshot,
    lastSurvivalInterruptAt: 300,
    activeMovementSession: { id: "move-1", kind: "goto", stable: true },
    foregroundTask: {
      actionState: "moving",
      lastHeartbeatAt: 400,
      lastRecoveryReason: "timeout",
      waitingForPhysicalSignalSince: 500,
      recoveryCount: 2,
      escortState: "guarding",
      combatReadiness: "ready",
      lastGuardScanResult: "clear",
      lastHostileSeenAt: 600,
      scriptMeta: {
        activeStageRevision: 7,
      },
    },
    activeActionSnapshot: {
      id: "action-1",
      kind: "move",
      primitive: "pathfinder.goto",
      physicalSignal: "distance_decreased",
      lastPositionDelta: 1.2,
      lastDistanceDelta: 0.4,
    },
  });

  assert.equal(formatDisconnectReasonText("server_disconnected", "socket_write_epipe"), "server_disconnected：socket_write_epipe");
  assert.equal(executor.lastRuntimeFault, "runtime_fault: boom");
  assert.equal(executor.lastBotWriteContext.target.x, 1);
  assert.equal(executor.movementSessionStable, true);
  assert.equal(executor.activeActionId, "action-1");
  assert.equal(executor.stageRevision, 7);
  botWriteSnapshot.context.target.x = 99;
  assert.equal(executor.lastBotWriteContext.target.x, 1);

  const disconnected = buildDisconnectedWorldContext({
    brainSnapshot: {
      turnState: "idle",
      currentRegistryAction: { actionId: "follow_player" },
      actionContractType: "continuous",
    },
  });
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.brain.turnState, "idle");
  assert.deepEqual(disconnected.action.currentRegistryAction, { actionId: "follow_player" });

  const status = buildStatusFields({
    agentMode: "running",
    foregroundTask: { taskId: "task-1", progressText: "正在移动" },
    backgroundTask: { plan: { goal: "背景任务" } },
    inhibitAI: true,
    activeReflex: "evade_hostile",
    runtimeFaultSnapshot: { reason: "runtime_fault: boom", at: 100 },
    botWriteSnapshot,
    lastDisconnectEventTrail: [{ type: "socket.close" }],
    diagnostics: { traceId: "trace-1" },
  });
  assert.equal(status.currentTaskId, "task-1");
  assert.equal(status.currentGoal, "正在移动");
  assert.equal(status.inhibitAI, true);
  assert.equal(status.lastRuntimeFault, "runtime_fault: boom");
  assert.equal(status.lastDisconnectEventTrail[0].type, "socket.close");
  assert.equal(status.diagnostics.traceId, "trace-1");
});

test("task recovery classifies transport failures and normalizes registry statuses", () => {
  const task = {
    currentStepIndex: 0,
    plan: {
      steps: [{ skill: "follow_player" }],
    },
  };
  const registry = {
    classifyErrorForStep(step, error) {
      assert.equal(step.skill, "follow_player");
      return { status: "blocked", code: error.code, message: "blocked" };
    },
  };

  const transport = classifyTaskError({
    task,
    error: { code: "socket_write_epipe", message: "socket_write_epipe" },
    actionRegistry: registry,
    disconnectDetailSource: "socket_write_epipe",
  });
  assert.equal(transport.status, TaskState.FAILED);
  assert.equal(transport.code, "socket_write_epipe");
  assert.match(transport.message, /连接已中断/);

  const blocked = classifyTaskError({
    task,
    error: { code: "no_path" },
    actionRegistry: registry,
  });
  assert.equal(blocked.status, TaskState.BLOCKED);
});

test("task recovery gates retries and delegates recovery plans in stable order", () => {
  const task = {
    recoveryCount: 0,
    maxRecoveryAttempts: 2,
    source: "user",
    intent: "mine_iron",
    currentStepIndex: 0,
    plan: {
      steps: [{ skill: "mine_resource" }],
    },
  };
  const registry = {
    buildToolProgressionPlan: () => ({ mode: "task", steps: [] }),
    getRecoveryPolicy(step, code) {
      assert.equal(step.skill, "mine_resource");
      assert.equal(code, "timeout");
      return { skipRecovery: false };
    },
    buildRecoveryPlan(receivedTask, classified, context) {
      assert.equal(receivedTask, task);
      assert.equal(classified.code, "timeout");
      assert.equal(typeof context.buildCraftRecoveryPlan, "function");
      assert.equal(typeof context.buildIronPickaxeProgressionSteps, "function");
      return { mode: "task", intent: "fallback_recovery", steps: [{ skill: "follow_player" }] };
    },
  };

  assert.deepEqual(
    buildRecoveryPlan(task, { code: "timeout" }, {
      actionRegistry: registry,
      buildStageRevisionPlan: () => null,
      buildCraftRecoveryPlan: () => null,
      hasDiamondMiningPickaxe: () => false,
      buildIronPickaxeProgressionSteps: () => [],
      getLearnedSearchRadius: () => 48,
    }),
    { mode: "task", intent: "fallback_recovery", steps: [{ skill: "follow_player" }] }
  );

  assert.equal(
    buildRecoveryPlan(
      { ...task, recoveryCount: 2, maxRecoveryAttempts: 2 },
      { code: "timeout" },
      { actionRegistry: registry }
    ),
    null
  );

  const autonomousPlan = { mode: "task", intent: "alt", steps: [{ skill: "wait" }] };
  assert.equal(
    buildRecoveryPlan(
      { ...task, source: "autonomous" },
      { code: "timeout" },
      {
        actionRegistry: registry,
        buildAutonomousMaintenancePlan(options) {
          assert.deepEqual(options.excludeIntents, ["mine_iron"]);
          return autonomousPlan;
        },
      }
    ),
    autonomousPlan
  );
});
