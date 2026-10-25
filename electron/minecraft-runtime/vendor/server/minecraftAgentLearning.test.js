const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createMinecraftActionRegistry } = require("./action/actionRegistry");
const { createMinecraftTaskAgent } = require("./minecraftTaskAgent");

function createTestAgent(t, deps) {
  const agent = createMinecraftTaskAgent(deps);
  t.after(() => agent.dispose());
  return agent;
}

test("learned task script scoring prefers successful similar plans", () => {
  const registry = createMinecraftActionRegistry();
  const taskScripts = {};
  const plan = {
    mode: "task",
    intent: "build_small_house",
    goal: "build a wooden cottage",
    steps: [
      registry.createActionStep("build_structure", {
        material: "wood",
        width: 3,
        depth: 3,
        height: 2,
      }),
    ],
  };
  const bucket = registry.ensureTaskScriptBucket(taskScripts, "build_small_house:oak_planks", "build_small_house");
  registry.rememberTaskScriptOutcome(
    bucket,
    {
      userCommand: "在附近造一个小木屋",
      plan,
      errorCode: "",
    },
    "completed",
    "ok"
  );

  const match = registry.findBestLearnedTaskScript(
    plan,
    "帮我在旁边盖一个木屋",
    taskScripts
  );

  assert.equal(match.key, "build_small_house:oak_planks");
  assert.equal(match.bucket.lastSuccessfulPlan.intent, "build_small_house");
  assert.ok(Number(match.score) > 0);
});

test("small house heuristic expands into deterministic human-like playbook", () => {
  const registry = createMinecraftActionRegistry();
  const plan = registry.buildHeuristicTaskPlan("build_small_house", {});
  const phases = plan.steps.map((step) => step.args.phase);

  assert.equal(plan.intent, "build_small_house");
  assert.deepEqual(phases, [
    "inspect_inventory",
    "select_site",
    "prepare_materials",
    "clear_site",
    "place_floor",
    "place_walls",
    "place_roof",
    "verify",
  ]);
  assert.ok(plan.steps.every((step) => step.skill === "build_small_house_phase"));
  assert.ok(plan.steps.every((step) => step.args.material === "any_planks"));
  assert.equal(registry.getTaskScriptKey(plan, "在附近造一个小木屋"), "build_small_house:wood_playbook_v1");
  assert.equal(registry.getStageKind(plan.steps[0]), "prepare");
  assert.equal(registry.getStageKind(plan.steps[4]), "build");
  assert.equal(registry.getStageKind(plan.steps[7]), "verify");
});

test("blocked small house scripts are not reusable until a full success is recorded", () => {
  const registry = createMinecraftActionRegistry();
  const taskScripts = {};
  const plan = registry.buildHeuristicTaskPlan("build_small_house", {});
  const bucket = registry.ensureTaskScriptBucket(taskScripts, "build_small_house:wood_playbook_v1", "build_small_house");

  registry.rememberTaskScriptOutcome(
    bucket,
    {
      userCommand: "在附近造一个小木屋",
      plan,
      errorCode: "no_effect_revision",
    },
    "blocked",
    "blocked"
  );

  assert.equal(bucket.reusable, false);
  assert.equal(registry.findBestLearnedTaskScript(plan, "造小木屋", taskScripts), null);

  registry.rememberTaskScriptOutcome(
    bucket,
    {
      userCommand: "在附近造一个小木屋",
      plan,
      errorCode: "",
    },
    "completed",
    "ok"
  );

  assert.equal(bucket.reusable, true);
  assert.equal(registry.findBestLearnedTaskScript(plan, "造小木屋", taskScripts).key, "build_small_house:wood_playbook_v1");
});

test("legacy single-step small house success does not override playbook plan", () => {
  const registry = createMinecraftActionRegistry();
  const taskScripts = {};
  const legacyPlan = {
    mode: "task",
    intent: "build_small_house",
    goal: "legacy one-step house",
    steps: [
      registry.createActionStep("build_structure", {
        material: "wood",
        width: 3,
        depth: 3,
        height: 2,
      }),
    ],
  };
  const playbookPlan = registry.buildHeuristicTaskPlan("build_small_house", {});
  const bucket = registry.ensureTaskScriptBucket(taskScripts, "build_small_house:oak_planks", "build_small_house");

  registry.rememberTaskScriptOutcome(
    bucket,
    {
      userCommand: "在附近造一个小木屋",
      plan: legacyPlan,
      errorCode: "",
    },
    "completed",
    "legacy"
  );

  assert.equal(registry.findBestLearnedTaskScript(playbookPlan, "在附近造一个小木屋", taskScripts), null);
});

test("dynamic pathfinder goals do not repeatedly reset movement state", (t) => {
  process.env.MC_AGENT_LEARNING_PATH = path.join(
    os.tmpdir(),
    `live2d-mc-agent-hotpath-test-${process.pid}.json`
  );
  const agent = createTestAgent(t, {
    appPaths: {
      appDataDir: os.tmpdir(),
    },
    readConfig: () => ({}),
    broadcast: () => {},
    broadcastMinecraftError: () => {},
    parseJsonObjectFromText: (text) => JSON.parse(text),
    requestPlannerCompletion: async () => "{}",
  });

  const result = agent.__testPathfinderDynamicGoalHotPath();

  assert.equal(result.setMovementsCalls, 1);
  assert.equal(result.setGoalCalls, 1);
  assert.equal(result.loadPluginCalls, 0);
  assert.equal(result.movementSessionGoalSignature, "entity:42:2:d");
});

test("small house recovery resumes from material phase when materials run out", () => {
  const registry = createMinecraftActionRegistry();
  const plan = registry.buildHeuristicTaskPlan("build_small_house", {});
  const task = {
    intent: "build_small_house",
    currentStepIndex: 5,
    plan,
  };
  const recovery = registry.buildRecoveryPlan(task, {
    code: "insufficient_material",
  });

  assert.equal(recovery.intent, "build_small_house");
  assert.equal(recovery.steps[0].skill, "build_small_house_phase");
  assert.equal(recovery.steps[0].args.phase, "prepare_materials");
  assert.ok(recovery.steps.some((step) => step.args.phase === "verify"));
});

function createReconnectTestAgent(t) {
  process.env.MC_AGENT_LEARNING_PATH = path.join(
    os.tmpdir(),
    `live2d-mc-agent-reconnect-${process.pid}-${Math.random().toString(36).slice(2)}.json`
  );
  return createTestAgent(t, {
    appPaths: { appDataDir: os.tmpdir() },
    readConfig: () => ({ mcAgentAutoReconnect: true }),
    broadcast: () => {},
    broadcastMinecraftError: () => {},
    parseJsonObjectFromText: (text) => JSON.parse(text),
    requestPlannerCompletion: async () => "{}",
  });
}

function makeParkedTask() {
  return {
    taskId: "reconnect-test-1",
    source: "user",
    status: "paused",
    intent: "generic_task",
    userCommand: "去挖点石头",
    plan: { goal: "去挖点石头", steps: [] },
    logs: [],
    currentStepIndex: 2,
    currentStep: "mine_block",
    movementLease: null,
    reconnectState: {
      enabled: true,
      status: "waiting_supervisor",
      attempts: 0,
      maxAttempts: 6,
    },
  };
}

test("parked reconnect task fails cleanly after the supervisor gives up", (t) => {
  const agent = createReconnectTestAgent(t);
  const task = makeParkedTask();
  agent.__testSetReconnectTask(task);

  assert.equal(agent.hasParkedReconnectTask(), true);
  const failed = agent.failParkedTaskAfterReconnectGiveUp("bot_connection_lost");
  assert.equal(failed, true);
  assert.equal(task.status, "failed");
  assert.equal(task.errorCode, "bot_connection_lost");
  assert.equal(agent.hasParkedReconnectTask(), false);
  assert.equal(agent.__testGetReconnectTask(), null);

});

test("resumeAfterReconnect refuses to resume while no live bot is attached", (t) => {
  const agent = createReconnectTestAgent(t);
  const task = makeParkedTask();
  agent.__testSetReconnectTask(task);

  // No bot entity attached, so resume must defer rather than run a dead plan.
  assert.equal(agent.resumeAfterReconnect(), false);
  assert.equal(task.status, "paused");
  assert.equal(task.reconnectState.status, "waiting_supervisor");

});

test("planner JavaScript scriptlets are rejected without evaluation", (t) => {
  process.env.MC_AGENT_LEARNING_PATH = path.join(
    os.tmpdir(),
    `live2d-mc-agent-test-${process.pid}.json`
  );
  const agent = createTestAgent(t, {
    appPaths: {
      appDataDir: os.tmpdir(),
    },
    readConfig: () => ({
      mcAgentAutoJsScripts: true,
    }),
    broadcast: () => {},
    broadcastMinecraftError: () => {},
    parseJsonObjectFromText: (text) => JSON.parse(text),
    requestPlannerCompletion: async () => "{}",
  });

  assert.throws(
    () =>
      agent.__testRejectPlannerScriptlet(
        'const host = skill["con" + "structor"]("return this[\'pro\' + \'cess\']")();'
      ),
    /不再支持 JavaScript scriptlet/
  );
  assert.doesNotThrow(() => agent.__testRejectPlannerScriptlet(""));
});

test("AI safety metadata creates explicit approval reasons", (t) => {
  process.env.MC_AGENT_LEARNING_PATH = path.join(
    os.tmpdir(),
    `live2d-mc-agent-approval-test-${process.pid}.json`
  );
  const agent = createTestAgent(t, {
    appPaths: { appDataDir: os.tmpdir() },
    readConfig: () => ({}),
    broadcast: () => {},
    broadcastMinecraftError: () => {},
    parseJsonObjectFromText: (text) => JSON.parse(text),
    requestPlannerCompletion: async () => "{}",
  });

  assert.deepEqual(agent.__testGetPlanApprovalReasons({}), []);
  assert.deepEqual(
    agent.__testGetPlanApprovalReasons({
      requiresConfirmation: true,
      safetyRisk: "可能掉入岩浆",
      missingResources: ["水桶", "食物"],
    }),
    ["模型要求用户确认", "安全风险：可能掉入岩浆", "缺少资源：水桶、食物"]
  );

});
