const { AsyncLocalStorage } = require("async_hooks");
const os = require("os");
const path = require("path");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { Vec3 } = require("vec3");
const { createMinecraftBrain } = require("./cognitive/brain");
const { createMinecraftActionRegistry } = require("./action/actionRegistry");
const { createMinecraftQueryRuntime } = require("./conscious/queryRuntime");
const {
  isDroppedItemEntity,
  isHostileMobEntity,
  isThreateningMobEntity,
  getObservedEntityHealth,
  distanceBetweenPositions,
} = require("./minecraft/entitySemantics");
const {
  createDefaultLearningState,
  createLearningStateTools,
} = require("./minecraft/learningState");
const { createLearningStateStore } = require("./minecraft/learningStore");
const { canDirectDispatch } = require('./minecraft/skillReusePolicy');
const { createSkillCatalog } = require('./minecraft/skillCatalog');
const { createApprovedSkillVerifier } = require('./minecraft/skillApproval');
const { skillSourceDigest } = require('./minecraft/skillSourceDigest');
const { createLearningKeyTools } = require("./minecraft/learningKeys");
const {
  EventManager,
  WorldQuery,
} = require("./minecraft/eventSystem");
const {
  CancellationToken,
  ReflexManager,
} = require("./minecraft/agentControl");
const { createRuleReloadWatcher } = require("./minecraft/ruleReload");
const { createTaskDiagnostics } = require("./minecraft/taskDiagnostics");
const { classifyMiningBlock } = require("./minecraft/miningNavigation");
const { createFurnishedHouseBlueprint } = require("./minecraft/furnishedHouseBlueprints");
const { createFurnishedHouseBuilder, matchesFurnishedHouseBlock } = require("./minecraft/furnishedHouseBuilder");
const { createEstateBlueprint } = require("./minecraft/estateBlueprints");
const { createEstateBuilder } = require("./minecraft/estateBuilder");
const { createEstateMaterialSupply } = require("./minecraft/estateMaterials");
const { createEstatePlacement } = require("./minecraft/estatePlacement");
const { createEstateDockPlacement } = require("./minecraft/estateDockPlacement");
const { assertHouseExternalWithdrawalAllowed } = require("./minecraft/houseSelfSupplyPolicy");
const { createHouseSelfSupplyRuntime } = require("./minecraft/houseSelfSupplyRuntime");
const { createHouseResourceGatherer } = require("./minecraft/houseResourceGatherer");
const { foodReturnTimeoutMs } = require("./minecraft/houseFoodReturnBudget");
const { createHouseResourceReach } = require("./minecraft/houseResourceReach");
const { approachHouseMelee, approachHouseRanged } = require("./minecraft/houseMeleeApproach");
const {isHouseRangedThreatEntity,findExposedHouseRangedThreat:findHouseRangedThreat,findHouseRangedThreat:findObservedHouseRangedThreat,rangedCoverConfirmed,seekHouseRangedCover}=require("./minecraft/houseRangedCover");
const {shouldPressHouseRanged,shouldAvoidHouseRangedThreat}=require("./minecraft/houseRangedCombat");
const { planHouseLocalRoute } = require("./minecraft/houseLocalRoute");
const { createMiningNavigator } = require("./minecraft/miningNavigation");
const { meleeReachDistance, meleeAttackReadyAt, retainMeleeTargetAfterKnockback } = require("./minecraft/combatGeometry");
const { strikeCreeperBeforeRetreat, strikeImmediateCloseCreeper } = require("./minecraft/houseCreeperKnockback");
const { createSurvivalScheduler, selectSurvivalJob, surfaceReserveTarget, shouldBootstrapField, restoreLocalSurvivalMeal, selectBootstrapFood } = require("./minecraft/survivalScheduler");
const { prepareHouseRecovery } = require("./minecraft/houseRecoveryPreparation");
const { planEmergencyShelter, planEmergencyRoof, selectEmergencyExit, emergencyShelterConfirmed, requiredEmergencyCoverCell, emergencyCoverThreatSupported } = require("./minecraft/houseEmergencyShelter");
const { appendObservedCampPoint } = require("./minecraft/houseCampTrace");
const { createHouseSurfaceGraph, dryFoot, naturalWalkingFoot, inspectSurfaceBody, hasGroundedBodySupport, getSurfaceGraphProtectedPositions, createSurfaceHazardEdgePolicy } = require("./minecraft/houseSurfaceGraph");
const { createNaturalShallowWaterTraversal, validateRoute: validateShallowWaterRoute } = require("./minecraft/houseShallowWaterTraversal");
const { createLoadedShallowWaterFinder, routeIdentity: shallowRouteIdentity } = require("./minecraft/houseShallowWaterFinder");
const { createNaturalSurfaceSwim, validateSurfaceRoute } = require("./minecraft/houseSurfaceSwim");
const { createDryBankAlignment } = require("./minecraft/houseDryBankAlignment");
const { createBankAlignedWaterSession } = require("./minecraft/houseBankAlignedWaterSession");
const { createLoadedSurfaceSwimFinder, routeIdentity: surfaceRouteIdentity } = require("./minecraft/houseSurfaceSwimFinder");
const { createHouseCreeperEscape } = require("./minecraft/houseCreeperEscape");
const { createEmergencyBuoyancy } = require("./minecraft/houseEmergencyBuoyancy");
const { createHouseNativeDigSession, isOwnedHouseNativeDigCancel } = require("./minecraft/houseNativeDigSession");
const { createNaturalHouseSiteSearch, validateNaturalSiteReservation } = require("./minecraft/houseNaturalSiteSearch");
const { withHouseNativeSourceGuard } = require("./minecraft/houseNativeSourceGuard");
const { createHouseFluidResources } = require("./minecraft/houseFluidResources");
const { createHouseObservedResourceMemory } = require("./minecraft/houseObservedResourceMemory");
const { createHouseQuarryEntry } = require("./minecraft/houseQuarryEntry");
const { createHouseFluidMaterialProvider, isOwnedFluidNativeCancel } = require("./minecraft/houseFluidNativeBridge");
const { createEstateNativeAdapter } = require("./minecraft/estateNativeAdapter");
const { withEstateNativeInteractionGuard } = require("./minecraft/estateNativeInteractions");
const { createTaskPublicStateTools } = require("./minecraft/taskPublicState");
const { createPlannerSafety } = require("./minecraft/plannerSafety");
const { createHeuristicPlanner } = require("./minecraft/commandPlanner");
const { createPlannerPromptTools } = require("./minecraft/plannerPrompts");
const {
  createNetherPortalBlueprint,
  createSmallHouseBlueprint,
  createSmallHousePlaybookBlueprint,
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
  getAutonomousGoalText: formatAutonomousGoalText,
  getPassiveEscortGoalText: formatPassiveEscortGoalText,
  isBackgroundAgendaFresh,
  publicBackgroundAgenda: formatPublicBackgroundAgenda,
} = require("./minecraft/autonomyPresentation");
const {
  AUTONOMOUS_PHASE_LABELS,
  TASK_TURN_PHASE_LABELS,
} = require("./minecraft/taskLabels");
const {
  ANY_PLANKS,
  AXE_ITEM_PRIORITY,
  BED_ITEM_NAMES,
  CONTAINER_BLOCK_NAMES,
  CROP_HARVEST_CONFIG,
  CROP_ITEM_TO_BLOCK,
  DEFAULT_FOOD_RESERVE_COUNT,
  END_PORTAL_BLOCK_NAMES,
  END_PORTAL_FRAME_BLOCK_NAMES,
  END_SAFE_SURFACE_BLOCK_NAMES,
  END_VICTORY_BLOCK_NAMES,
  FOOD_ITEM_PRIORITY,
  FURNACE_BLOCK_NAMES,
  HOSTILE_PRIORITY,
  IRON_ORE_ITEM_NAMES,
  LOG_TO_PLANK,
  NETHER_FORTRESS_BLOCK_NAMES,
  NETHER_PORTAL_BLOCK_NAMES,
  PICKAXE_ITEM_NAMES,
  PLANK_TO_LOG,
  REPLACEABLE_BLOCK_KEYWORDS,
  RESOURCE_ALIASES,
  SMELT_FUEL_ITEM_PRIORITY,
  STRONGHOLD_BLOCK_NAMES,
  TORCH_BLOCK_NAMES,
  TORCH_FUEL_ITEM_NAMES,
  WEAPON_ITEM_PRIORITY,
  WOOL_ITEM_NAMES,
} = require("./minecraft/taskCatalog");
const {
  PerceptionRuleEngine,
  ReflexRuleEngine,
} = require("./minecraft/ruleEngine");
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
  buildStatusFields: buildWorldStatusFields,
  formatActionContext,
  formatBrainContext,
  publicWorldContext: formatPublicWorldContext,
} = require("./minecraft/worldContextView");
const { TaskState } = require("./minecraft/taskState");
const { createTaskRecoveryTools } = require("./minecraft/taskRecovery");
const { createDiamondExpedition } = require("./minecraft/diamondExpedition");
const {
  clamp,
  cloneSerializable,
  createAbortError,
  limitArray,
  normalizeVec3Input,
  sleep,
  withTimeout,
} = require("./minecraft/taskUtils");

const { createNaturalHouseXPHost, isOwnedNaturalHouseXPCancel, getNaturalXPProtectedPositions } = require("./minecraft/houseNaturalXPHost");
const { isSelfGatheredLibraryFinish, readNaturalXPStageBudget } = require("./minecraft/houseNaturalXPStagePolicy");

const LEGACY_AGENT_DATA_DIR = path.join(os.homedir(), ".live2d-mc-companion");
const LEGACY_LEARNING_STATE_PATH = path.join(LEGACY_AGENT_DATA_DIR, "minecraft-agent-learning.json");

const PLAYER_MEMORY_TTL_MS = 2 * 60 * 1000;
const RULE_RELOAD_DEBOUNCE_MS = 250;
const DEFAULT_PATHFIND_TIMEOUT_MS = 20000;
const DEFAULT_DIG_TIMEOUT_MS = 12000;
const DEFAULT_EQUIP_TIMEOUT_MS = 6000;
const DEFAULT_CONTAINER_TIMEOUT_MS = 8000;
const PHYSICAL_ACTION_SAMPLE_MS = 350;
const PHYSICAL_ACTION_STARTUP_GRACE_MS = 3200;
const PHYSICAL_ACTION_STALL_MS = 6500;
const TASK_STATUS_BROADCAST_THROTTLE_MS = 260;
const CONTEXT_BROADCAST_THROTTLE_MS = 650;
const WORLD_CONTEXT_CACHE_MS = 450;
const ENTITY_SCAN_CACHE_MS = 120;
const BLOCK_QUERY_CACHE_MS = 180;
const PERCEPTION_RULES_PATH = path.join(__dirname, "minecraft-perception-rules.yaml");
const REFLEX_RULES_PATH = path.join(__dirname, "minecraft-reflex-rules.yaml");

/**
 * @typedef {"pending"|"planning"|"running"|"paused"|"cancelled"|"completed"|"failed"|"blocked"} TaskStateValue
 */

/**
 * @typedef {{
 *   id: string,
 *   type: string,
 *   source: string,
 *   priority: number,
 *   timestamp: number,
 *   payload: Record<string, any>,
 *   tags: string[],
 * }} AgentEvent
 */

const furnishedDoorMovements = new WeakSet();
const furnishedDoorPathAdapters = new WeakMap();

function configureFurnishedHouseDoorTraversal(movements) {
  if (furnishedDoorMovements.has(movements)) return movements;
  furnishedDoorMovements.add(movements);
  const originalGetBlock = movements.getBlock.bind(movements);
  const bot = movements.bot;
  const clearCenter = (block) => {
    const half = (Number(bot.entity?.width) || 0.6) / 2 + 0.005;
    return Array.isArray(block?.shapes) && block.shapes.length > 0 && block.shapes.every((shape) =>
      shape.length === 6 && shape.every(Number.isFinite) &&
      (0.5 + half <= shape[0] || 0.5 - half >= shape[3] ||
       0.5 + half <= shape[2] || 0.5 - half >= shape[5]));
  };
  movements.getBlock = (position, dx, dy, dz) => {
    const block = originalGetBlock(position, dx, dy, dz);
    const properties = block.getProperties?.();
    if (!block.name?.endsWith("_door") || properties?.open !== true ||
        !["lower", "upper"].includes(properties.half) || properties.waterlogged === true || !clearCenter(block)) return block;
    const other = bot.blockAt(block.position.offset(0, properties.half === "lower" ? 1 : -1, 0));
    const otherProperties = other?.getProperties?.();
    if (other?.name !== block.name || otherProperties?.open !== true || otherProperties.waterlogged === true ||
        otherProperties.half !== (properties.half === "lower" ? "upper" : "lower") ||
        otherProperties.facing !== properties.facing || otherProperties.hinge !== properties.hinge || !clearCenter(other)) return block;
    // Pathfinder treats every door as a full block even when its actual panel
    // is open against the wall. Only this validated center column is passable;
    // the native world, collision shapes and physics remain authoritative.
    block.safe = !movements.blocksToAvoid.has(block.type);
    block.physical = false;
    block.replaceable = false;
    block.openable = false;
    block.height = position.y + dy;
    return block;
  };
  if (!furnishedDoorPathAdapters.has(bot)) {
    const adjustDoorWaypoints = (result) => {
      const active = bot.pathfinder?.movements;
      if (!furnishedDoorMovements.has(active)) return;
      for (const node of result.path || []) {
        if (node.toBreak?.length || node.toPlace?.length) continue;
        const actual = bot.blockAt(new Vec3(node.x, node.y, node.z));
        if (!actual?.name?.endsWith("_door")) continue;
        const properties = actual.getProperties?.();
        const lower = actual.position.offset(0, properties?.half === "upper" ? -1 : 0, 0);
        const door = active.getBlock(lower, 0, 0, 0);
        const floor = active.getBlock(lower, 0, -1, 0);
        if (!door.safe || door.physical || !floor.physical || active.blocksToAvoid.has(floor.type) ||
            floor.getProperties?.().waterlogged === true || Math.abs(floor.height - lower.y) > 0.001) continue;
        // The pinned pathfinder's postprocessor otherwise puts the waypoint
        // on top of the thin panel. Use the center of its actual clear opening
        // at floor height, without changing any server block or collision.
        let minX = 0; let maxX = 1; let minZ = 0; let maxZ = 1;
        for (const shape of door.shapes) {
          if (shape[3] <= 0.5) minX = Math.max(minX, shape[3]);
          else if (shape[0] >= 0.5) maxX = Math.min(maxX, shape[0]);
          if (shape[5] <= 0.5) minZ = Math.max(minZ, shape[5]);
          else if (shape[2] >= 0.5) maxZ = Math.min(maxZ, shape[2]);
        }
        node.x = lower.x + (minX + maxX) / 2;
        node.y = lower.y;
        node.z = lower.z + (minZ + maxZ) / 2;
      }
    };
    furnishedDoorPathAdapters.set(bot, adjustDoorWaypoints);
    bot.on("path_update", adjustDoorWaypoints);
    bot.once("end", () => {
      bot.removeListener("path_update", adjustDoorWaypoints);
      furnishedDoorPathAdapters.delete(bot);
    });
  }
  return movements;
}

function createMinecraftTaskAgent(deps) {
  const executionContextStorage = new AsyncLocalStorage();
  const appDataDir = String(deps?.appPaths?.appDataDir || "").trim();
  const agentDataDir = path.resolve(
    process.env.MC_AGENT_DATA_DIR ||
      (appDataDir ? path.join(appDataDir, "minecraft-agent") : LEGACY_AGENT_DATA_DIR)
  );
  const learningStatePath = path.resolve(
    process.env.MC_AGENT_LEARNING_PATH || path.join(agentDataDir, "minecraft-agent-learning.json")
  );
  const diagnosticsDir = path.resolve(
    process.env.MC_AGENT_DIAGNOSTICS_DIR || path.join(agentDataDir, "diagnostics")
  );
  const disconnectTracePath = path.resolve(
    process.env.MC_AGENT_DISCONNECT_TRACE_PATH || path.join(diagnosticsDir, "disconnect-trace.jsonl")
  );
  const taskCheckpointStore=require('./minecraft/taskCheckpointStore').createTaskCheckpointStore({file:path.join(agentDataDir,'task-checkpoint.json')});
  let lastCheckpointAt=0;
  const checkpointIdentity=()=>{
    if(!currentBot?.entity)return null;
    const server=deps.getWorldIdentity?.()||`${currentBot._client?.socket?.remoteAddress||''}:${currentBot._client?.socket?.remotePort||''}`;
    return server?JSON.stringify({server,username:currentBot.username,dimension:currentBot.game?.dimension}):null;
  };
  let currentBot = null;
  let defaultMovements = null;
  let defaultMovementsHouseMode = false;
  let currentTask = null;
  let agentDrivenReconnectActive = false;
  let supervisedResumeInFlight = false;
  let foregroundTaskState = null;
  let backgroundAgenda = null;
  let backgroundAgendaPlan = null;
  let taskHistory = [];
  let taskMemory = [];
  let learningState = createDefaultLearningState();
  let learningSnapshotCache = null;
  let learningSnapshotDirty = true;
  let agentMode = "idle";
  let worldContextCache = null;
  let worldContextCacheAt = 0;
  let entityScanCache = {
    allEntities: null,
    allEntitiesAt: 0,
    players: null,
    playersAt: 0,
    nearbyPlayers: null,
    nearbyPlayersAt: 0,
    nearbyHostiles: null,
    nearbyHostilesAt: 0,
  };
  let blockQueryCache = new Map();
  let pendingTaskStatusBroadcastTimer = null;
  let lastTaskStatusBroadcastAt = 0;
  let pendingContextBroadcastTimer = null;
  let lastContextBroadcastAt = 0;
  let passiveEscort = null;
  let passiveEscortSessionCounter = 1;
  let movementLeaseCounter = 1;
  let activeMovementLease = null;
  let appliedMovementsBot = null;
  let appliedMovementsInstance = null;
  let movementSessionCounter = 1;
  let activeMovementSession = null;
  let activeMovementMonitor = null;
  let lastPathfinderGoalSignature = "";
  /** Throttle rapid pathfinder goal / goto writes to reduce server-side rubber-band feel */
  let lastPathfinderMotorWriteAt = 0;
  const PATHFINDER_GOAL_MIN_INTERVAL_MS = 160;
  let lastSoftResetAt = 0;
  let lastSoftResetReasonKey = "";
  let physicalActionCounter = 1;
  let activePhysicalAction = null;
  let runtimeExecutorMode = null;
  let runtimeExecutorModeSource = "saved";
  let autonomyArmedAt = 0;
  let autonomySafeUntil = 0;
  let lastSurvivalInterruptAt = 0;
  let survivalInterruptRunning = false;
  let activeSurvivalInterrupt = null;
  let activeMiningNavigationMove = null;
  const foodConsumptionFlights = new WeakMap();
  const nutritionFlights = new WeakMap();
  let activeHouseSurfaceNavigationMove = null;
  let retainedHouseSurfaceDefenseFailure = null;
  const houseOriginDefenseRelocations = new WeakSet();
  const houseLocalRouteDefenseRelocations = new WeakSet();
  let activeHouseResourceWork = null;
  let detachHouseThreatWarning = () => {};
  let activeHouseSurfaceWater = null;
  let activeEmergencyShore = null;
  let activeHouseRangedRetreat = null;
  const houseCampGroundedTraces = new WeakMap();
  const naturalXPStepWatchdogFrames = new WeakMap();
  let lastDisconnectPath = "";
  let lastDisconnectDetailSource = "";
  let lastDisconnectObservedAt = 0;
  let lastHeavyContextBroadcastAt = 0;
  let autonomousState = {
    running: false,
    nextAllowedAt: 0,
    lastPhase: "",
    lastDecisionAt: 0,
    workAreaCenter: null,
    suppressedByForeground: false,
  };

  function hasBlockingForegroundTask() {
    if (!currentTask) {
      return false;
    }
    if (currentTask.source === "autonomous") {
      return false;
    }
    const st = String(currentTask.status || "").trim();
    return [TaskState.PENDING, TaskState.PLANNING, TaskState.RUNNING, TaskState.PAUSED].includes(st);
  }

  function scheduleIdleTransportFlush() {
    queueMicrotask(() => {
      if (hasBlockingForegroundTask()) {
        return;
      }
      try {
        deps.onForegroundTaskIdle?.();
      } catch (error) {
        console.warn("onForegroundTaskIdle failed", error);
      }
    });
  }

  let infrastructureRegistry = {
    crafting_table: null,
    furnace: null,
    container: null,
  };
  let combatMemory = {
    lastBotHurtAt: 0,
    lastBotHealth: null,
    lastProtectedPlayerHurtAt: 0,
    lastProtectedPlayerName: "",
  };
  let runtimeToken = null;
  let knownPlayers = new Map();
  let dragonRunState = {
    locateAttempts: 0,
    lastLocateAt: 0,
    lastEyeTrace: null,
    netherScoutIndex: 0,
    lastNetherScoutAt: 0,
    lastStrongholdAdvanceAt: 0,
    completedAt: 0,
    completionMarker: null,
  };
  let taskCounter = 1;
  let logCounter = 1;
  const runtimeDiagnostics = createRuntimeDiagnostics({
    disconnectTracePath,
    getCurrentTask: () => currentTask,
  });
  const eventManager = new EventManager({
    logger: (message) => deps.broadcastMinecraftError?.(`Minecraft 事件处理异常：${message}`),
  });
  const perceptionRuleEngine = new PerceptionRuleEngine({
    rulesPath: PERCEPTION_RULES_PATH,
    label: "感知",
    logger: (message) => deps.broadcastMinecraftError?.(`Minecraft 感知规则异常：${message}`),
  });
  const reflexRuleEngine = new ReflexRuleEngine({
    rulesPath: REFLEX_RULES_PATH,
    label: "reflex",
    logger: (message) => deps.broadcastMinecraftError?.(`Minecraft reflex 规则异常：${message}`),
  });
  const actionRegistry = createMinecraftActionRegistry({
    // Optional host authority only. Missing issuers retain candidate/component
    // records; public task status and native execution remain unchanged.
    wholeLearningGate: task => typeof deps.wholeLearningGate === 'function'
      ? deps.wholeLearningGate(task) : { eligible: false, classification: 'pending' },
    legacyBucketGate: (bucket, plan) => typeof deps.legacyBucketGate === 'function'
      ? deps.legacyBucketGate(bucket, plan) : { eligible: false, classification: 'legacy_unverified' },
  });
  const worldQuery = new WorldQuery({
    getBot: () => currentBot,
    getCurrentTask: () => publicTask(currentTask),
    getNearbyPlayers: () => getNearbyPlayers(),
    getNearbyHostiles: () => getNearbyHostiles(),
    getNearbyBlocks: () => getNearbyBlocks(),
    getInventorySnapshot: () => getInventorySnapshot(),
    getTaskHistory: () => taskHistory,
    getTaskMemory: () => taskMemory,
    getLearningSnapshot: () => getLearningSnapshot(),
    getKnownPlayers: () => [...knownPlayers.values()],
    getPerceptionRules: () => perceptionRuleEngine.rules,
    getReflexRules: () => reflexRuleEngine.rules,
  });
  const reflexManager = new ReflexManager({
    actionRegistry,
    ruleEngine: reflexRuleEngine,
    getBot: () => currentBot,
    claimMovementLease: (kind, ownerId) => claimMovementLease(kind, ownerId),
    releaseMovementLease: (lease) => releaseMovementLease(lease),
    setPathfinderGoal: (goal, dynamic, lease) => setPathfinderGoal(goal, dynamic, lease),
    clearPathfinderGoal: (lease) => clearPathfinderGoal(lease),
    pathfinderGoto: (goal, timeoutMs, timeoutLabel, lease) =>
      pathfinderGoto(goal, timeoutMs, timeoutLabel, lease),
    hasUserTask: () =>
      Boolean(
        currentTask &&
          [TaskState.PENDING, TaskState.PLANNING, TaskState.RUNNING, TaskState.PAUSED].includes(
            currentTask.status
          )
      ),
    onReflexNotice: (message) => {
      deps.broadcast({
        type: "mc_task_event",
        event: {
          eventType: "reflex",
          taskId: currentTask?.taskId || null,
          timestamp: Date.now(),
          message,
        },
      });
    },
  });
  const {
    getResourceLearningKey,
    getStageKindForStep,
    getStageScriptKey,
    getStageScriptResourceKey,
    getStageScriptTargetKey,
    getTaskScriptKey,
    getTaskScriptStepSignature,
    normalizeLearningIntent,
    tokenizeTaskCommand,
  } = createLearningKeyTools(actionRegistry, {
    resolveBuildMaterial,
  });
  const {
    normalizeLearningState,
    normalizeLearningStageScripts,
    normalizeLearningTaskScripts,
    normalizeTaskScriptPlan,
  } = createLearningStateTools(actionRegistry);
  const learningStateStore = createLearningStateStore({
    learningStatePath,
    legacyLearningStatePath: LEGACY_LEARNING_STATE_PATH,
    normalizeLearningState,
    broadcastMinecraftError: (message) => deps.broadcastMinecraftError?.(message),
    getEnvLearningPath: () => process.env.MC_AGENT_LEARNING_PATH || "",
  });
  const skillCatalog = createSkillCatalog({
    file: `${learningStatePath}.skills.json`, registry: actionRegistry,
    sourceDigest: skillSourceDigest(path.resolve(__dirname, '../..')),
    validateEvidence: typeof deps.validateSkillEvidence === 'function' ? deps.validateSkillEvidence
      : createApprovedSkillVerifier({ file: `${learningStatePath}.skill-approvals.json` }),
    onError: (error) => deps.broadcastMinecraftError?.(`Minecraft 技能档校验失败：${error.message}`),
  });
  const plannerSafety = createPlannerSafety(actionRegistry);
  const plannerPrompts = createPlannerPromptTools(actionRegistry);
  const brain = createMinecraftBrain({
    onStateChange: () => {
      invalidateWorldContextCache();
    },
  });
  const queryRuntime = createMinecraftQueryRuntime({
    worldQuery,
    getWorldContext: () => getWorldContext(true),
    getProtectedPlayerName: () => getProtectedPlayerNameForEscort(),
  });
  const taskDiagnostics = createTaskDiagnostics({
    diagnosticsDir,
    broadcastMinecraftError: (message) => deps.broadcastMinecraftError?.(message),
    getBotWriteSnapshot: () => getBotWriteSnapshot(),
  });
  const taskPublicState = createTaskPublicStateTools({
    turnPhaseLabels: TASK_TURN_PHASE_LABELS,
    getTaskDiagnostics: (task) => publicTaskDiagnostics(task),
    getActivePhysicalAction: () => activePhysicalAction,
  });
  const taskRecovery = createTaskRecoveryTools({
    actionRegistry,
    getCurrentTask: () => currentTask,
    getDisconnectDetailSource: () => lastDisconnectDetailSource,
    getDisconnectPath: () => lastDisconnectPath,
    buildAutonomousMaintenancePlan: (options) => buildAutonomousMaintenancePlan(options),
    buildStageRevisionPlan: (task, classified) => buildStageRevisionPlan(task, classified),
    buildCraftRecoveryPlan: (itemName, task) => buildCraftRecoveryPlan(itemName, task),
    hasDiamondMiningPickaxe: () => hasDiamondMiningPickaxe(),
    buildIronPickaxeProgressionSteps: (options) => buildIronPickaxeProgressionSteps(options),
    getLearnedSearchRadius: (resourceKey, fallback, max) =>
      getLearnedSearchRadius(resourceKey, fallback, max),
  });
  const ruleReloadWatcher = createRuleReloadWatcher({
    debounceMs: RULE_RELOAD_DEBOUNCE_MS,
    broadcast: (event) => deps.broadcast(event),
    broadcastMinecraftError: (message) => deps.broadcastMinecraftError?.(message),
    getCurrentTaskId: () => currentTask?.taskId || null,
  });

  function setAgentMode(nextMode) {
    agentMode = String(nextMode || "idle");
    deps.broadcast({
      type: "mc_agent_mode",
      agentMode,
      currentTaskId: currentTask?.taskId || null,
    });
  }

  eventManager.on({
    type: "perception.player_left",
    priority: 30,
    filter: (event) => Boolean(event.payload?.username),
    handler: async (event) => {
      knownPlayers.delete(String(event.payload.username || "").trim().toLowerCase());
    },
  });
  eventManager.on({
    type: "perception.entity_hurt",
    priority: 60,
    handler: async (event) => {
      const entityId = Number(event.payload?.entityId || 0);
      const username = String(event.payload?.username || "").trim();
      if(entityId&&entityId===combatMemory.lastOwnAttackTargetId&&Date.now()-Number(combatMemory.lastOwnAttackAt||0)<1500
        &&currentTask?.materialSupply?.materialSource==="self_gathered"){
        const target=currentBot?.entities?.[entityId],index=currentBot?.registry?.entitiesByName?.[target?.name]?.metadataKeys?.indexOf("health");
        recordTaskDiagnostic(currentTask,"house_target_hurt_observed",{targetId:entityId,targetName:target?.name||null,
          actualTargetHealth:index>=0&&Number.isFinite(target?.metadata?.[index])?target.metadata[index]:null,
          playerHealth:currentBot?.health,attackLatencyMs:Date.now()-combatMemory.lastOwnAttackAt,damageAttribution:"not_proven"});
      }
      if (entityId && currentBot?.entity && entityId === Number(currentBot.entity.id || 0)) {
        combatMemory.lastBotHurtAt = Date.now();
        require("./minecraft/houseRangedCover").clearHouseRangedPursuits(currentBot);
        void safeAsyncTick("combat_interrupt_fault", () => maybeHandleSurvivalCritical("entity_hurt"), {
          broadcastError: false,
        });
      }
      if (username) {
        const protectedName = String(
          currentTask?.intent === "escort_player"
            ? currentTask?.plan?.steps?.find((step) => String(step?.skill || "").trim() === "escort_player")?.args?.playerName ||
                currentTask?.plan?.postTaskArgs?.playerName ||
                getBestKnownPlayerName()
            : passiveEscort?.playerName || getBestKnownPlayerName()
        )
          .trim()
          .toLowerCase();
        if (protectedName && username.toLowerCase() === protectedName) {
          combatMemory.lastProtectedPlayerHurtAt = Date.now();
          combatMemory.lastProtectedPlayerName = username;
        }
      }
    },
  });
  eventManager.on({
    type: "perception.bot_health",
    priority: 75,
    handler: async (event) => {
      const nextHealth = Number(event.payload?.health);
      if (
        Number.isFinite(nextHealth) &&
        Number.isFinite(combatMemory.lastBotHealth) &&
        nextHealth < Number(combatMemory.lastBotHealth)
      ) {
        combatMemory.lastBotHurtAt = Date.now();
        require("./minecraft/houseRangedCover").clearHouseRangedPursuits(currentBot);
        void safeAsyncTick("combat_interrupt_fault", () => maybeHandleSurvivalCritical("health_drop"), {
          broadcastError: false,
        });
      }
      if (Number.isFinite(nextHealth)) {
        combatMemory.lastBotHealth = nextHealth;
      }
    },
  });
  eventManager.on({
    type: "perception.bot_death",
    priority: 80,
    handler: async () => {
      combatMemory.lastBotHurtAt = 0;
      combatMemory.lastProtectedPlayerHurtAt = 0;
    },
  });
  reflexManager.bind(eventManager);

  let ruleReloadWatching = false;

  function startRuleReloadWatchers() {
    if (ruleReloadWatching) {
      return;
    }
    ruleReloadWatcher.watchRuleFile("感知", PERCEPTION_RULES_PATH, () => perceptionRuleEngine.reloadRules());
    ruleReloadWatcher.watchRuleFile("reflex", REFLEX_RULES_PATH, () => reflexRuleEngine.reloadRules());
    ruleReloadWatching = true;
  }

  function dispose() {
    detachHouseThreatWarning();
    ruleReloadWatcher.dispose();
    learningStateStore.dispose();
    if (pendingTaskStatusBroadcastTimer) clearTimeout(pendingTaskStatusBroadcastTimer);
    if (pendingContextBroadcastTimer) clearTimeout(pendingContextBroadcastTimer);
    pendingTaskStatusBroadcastTimer = null;
    pendingContextBroadcastTimer = null;
    clearMovementMonitor();
    ruleReloadWatching = false;
  }

  startRuleReloadWatchers();

  function loadLearningState() {
    const result = learningStateStore.load();
    learningState = result.state || createDefaultLearningState();
    if (result.raw) {
      refreshLearningIndexes();
    }
    if (result.shouldSave) {
      scheduleLearningStateSave();
    }
    learningSnapshotDirty = true;
  }

  function scheduleLearningStateSave() {
    learningStateStore.scheduleSave(() => learningState);
  }

  loadLearningState();

  function publicTaskDiagnostics(task = null) {
    return taskDiagnostics.publicTaskDiagnostics(task);
  }

  function getLastTaskDiagnostics() {
    return taskDiagnostics.getLastTaskDiagnostics();
  }

  function startTaskDiagnostics(task, trigger = "task_created") {
    return taskDiagnostics.startTaskDiagnostics(task, trigger);
  }

  function recordTaskDiagnostic(task, eventType = "", details = {}) {
    return taskDiagnostics.recordTaskDiagnostic(task, eventType, details);
  }

  function finishTaskDiagnostics(task, outcome = "") {
    return taskDiagnostics.finishTaskDiagnostics(task, outcome);
  }

  function getAgentRuntimeConfig() {
    const cfg = deps.readConfig?.() || {};
    return {
      autoReconnect: cfg.mcAgentAutoReconnect !== false,
      reconnectMaxAttempts: clamp(Number(cfg.mcAgentReconnectMaxAttempts) || 6, 0, 10),
      autoJsScripts: false,
    };
  }

  function initializeTaskRuntimeMetadata(task, trigger = "task_created") {
    if (!task) {
      return;
    }
    const runtimeCfg = getAgentRuntimeConfig();
    task.scriptEngine = {
      mode: "json",
      autoJsEnabled: false,
      sandbox: null,
      lastReason: null,
    };
    task.scriptMatch = null;
    task.reconnectState = {
      enabled: runtimeCfg.autoReconnect,
      status: "idle",
      attempts: 0,
      maxAttempts: runtimeCfg.reconnectMaxAttempts,
      lastReason: null,
      lastAttemptAt: null,
      resumedAt: null,
    };
    startTaskDiagnostics(task, trigger);
  }

  function isConnectionFailureCode(code = "") {
    return [
      "socket_not_writable",
      "bot_connection_lost",
      "socket_write_epipe",
      "server_disconnected",
    ].includes(String(code || "").trim());
  }

  async function waitForBotReady(timeoutMs = 24000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (currentBot?.entity) {
        try {
          initializeBotRuntime();
        } catch (_) {}
        return true;
      }
      await sleep(500);
    }
    return false;
  }

  async function attemptReconnectForTask(task, classified = {}) {
    if (!task?.reconnectState?.enabled) {
      return false;
    }
    const maxAttempts = clamp(
      Number(task.reconnectState.maxAttempts ?? getAgentRuntimeConfig().reconnectMaxAttempts) || 0,
      0,
      10
    );
    const attempts = Number(task.reconnectState.attempts || 0) || 0;
    if (attempts >= maxAttempts) {
      task.reconnectState.status = "exhausted";
      task.reconnectState.lastReason = String(classified.code || classified.message || "").trim();
      recordTaskDiagnostic(task, "reconnect_exhausted", {
        attempts,
        maxAttempts,
        reason: task.reconnectState.lastReason,
      });
      return false;
    }
    if (typeof deps.requestMinecraftReconnect !== "function") {
      return false;
    }
    agentDrivenReconnectActive = true;
    task.reconnectState.status = "reconnecting";
    task.reconnectState.attempts = attempts + 1;
    task.reconnectState.maxAttempts = maxAttempts;
    task.reconnectState.lastAttemptAt = Date.now();
    task.reconnectState.lastReason = String(classified.code || classified.message || "").trim();
    task.status = TaskState.PLANNING;
    task.actionState = "recovering";
    task.lastRecoveryReason = "auto_reconnect";
    task.progressText = `Minecraft 连接中断，正在自动重连（${task.reconnectState.attempts}/${maxAttempts}）`;
    recordTaskDiagnostic(task, "reconnect_started", {
      code: classified.code,
      message: classified.message,
      attempts: task.reconnectState.attempts,
      maxAttempts,
    });
    broadcastTaskStatus(true);
    try {
      await Promise.resolve(deps.requestMinecraftReconnect({
        reason: "task_auto_reconnect",
        taskId: task.taskId,
      }));
      const ready = await waitForBotReady(24000);
      if (!ready) {
        throw new Error("重连后角色没有在限定时间内进入世界");
      }
      task.reconnectState.status = "resumed";
      task.reconnectState.resumedAt = Date.now();
      task.cancellationToken = createRuntimeToken();
      runtimeToken = task.cancellationToken;
      task.status = TaskState.PLANNING;
      task.actionState = "queued";
      task.progressText = "Minecraft 已重连，正在从最近步骤继续执行";
      recordTaskDiagnostic(task, "reconnect_resumed", {
        stepIndex: task.currentStepIndex,
        step: task.currentStep,
      });
      addTaskLog("info", "Minecraft 已自动重连，我会从最近的安全步骤继续执行。");
      broadcastTaskStatus(true);
      return true;
    } catch (error) {
      task.reconnectState.status = "failed";
      task.reconnectState.lastReason = error?.message || String(error || "");
      recordTaskDiagnostic(task, "reconnect_failed", {
        error: task.reconnectState.lastReason,
      });
      return false;
    } finally {
      agentDrivenReconnectActive = false;
    }
  }

  function resumeAfterReconnect(meta = {}) {
    const task = currentTask;
    if (!task || !task.reconnectState?.enabled) {
      return false;
    }
    if (agentDrivenReconnectActive || supervisedResumeInFlight) {
      return false;
    }
    if (String(task.reconnectState.status || "").trim() !== "waiting_supervisor") {
      return false;
    }
    if (task.status === TaskState.RUNNING) {
      return false;
    }
    if (!currentBot?.entity) {
      return false;
    }
    supervisedResumeInFlight = true;
    try {
      task.reconnectState.status = "resumed";
      task.reconnectState.attempts = 0;
      task.reconnectState.resumedAt = Date.now();
      task.cancellationToken = createRuntimeToken();
      runtimeToken = task.cancellationToken;
      task.status = TaskState.PLANNING;
      task.actionState = "queued";
      task.lastRecoveryReason = "auto_reconnect";
      task.errorCode = "";
      task.error = "";
      task.finishedAt = null;
      task.progressText = "Minecraft 已重连，正在从最近步骤继续执行";
      setTaskTurnPhase(task, "recovering", {
        progressText: "已重连，正在从最近步骤继续执行",
      });
      addTaskLog("info", "Minecraft 已自动重连，我会从最近的安全步骤继续执行。");
      recordTaskDiagnostic(task, "reconnect_resumed_by_supervisor", {
        stepIndex: task.currentStepIndex,
        step: task.currentStep,
        reason: String(meta.reason || "").trim() || null,
      });
      setAgentMode(TaskState.RUNNING);
      broadcastTaskStatus(true);
      void safeAsyncTick("task_execution_fault", () => runTaskExecution(task), {
        task,
        broadcastError: false,
        onFailure: (error) => failRunTaskExecutionIfStillActive(task.taskId, error),
      });
      return true;
    } finally {
      supervisedResumeInFlight = false;
    }
  }

  function hasParkedReconnectTask() {
    return Boolean(
      currentTask &&
        currentTask.status === TaskState.PAUSED &&
        String(currentTask.reconnectState?.status || "").trim() === "waiting_supervisor"
    );
  }

  function failParkedTaskAfterReconnectGiveUp(reason = "bot_connection_lost") {
    const task = currentTask;
    if (!task || task.status !== TaskState.PAUSED) {
      return false;
    }
    if (String(task.reconnectState?.status || "").trim() !== "waiting_supervisor") {
      return false;
    }
    const message = "连接持续中断，多次自动重连都没成功，已停止当前任务。";
    brain.failTurn(task, "bot_connection_lost", {
      status: "failed",
    });
    task.status = TaskState.FAILED;
    task.error = message;
    task.errorCode = String(reason || "bot_connection_lost").trim() || "bot_connection_lost";
    task.progressText = message;
    task.finishedAt = Date.now();
    task.actionState = "recovering";
    task.lastRecoveryReason = "reconnect_exhausted";
    if (task.reconnectState) {
      task.reconnectState.status = "exhausted";
    }
    setTaskTurnPhase(task, "failed", {
      progressText: message,
    });
    addTaskLog("error", message);
    clearPassiveEscort();
    releaseMovementLease(task.movementLease);
    recordTaskMemory(task, TaskState.FAILED);
    taskHistory = [...limitArray(taskHistory, 19), { ...task, logs: [...task.logs] }];
    if (task.source !== "autonomous") {
      setForegroundTaskState(task);
    } else {
      clearBackgroundAgenda();
    }
    currentTask = null;
    autonomousState.running = false;
    autonomousState.suppressedByForeground = false;
    autonomousState.nextAllowedAt = Date.now() + 8000;
    setAgentMode("idle");
    broadcastTaskEvent("failed", {
      taskId: task.taskId,
      message,
      reason: "reconnect_exhausted",
    });
    broadcastTaskStatus(true);
    broadcastContextSnapshot();
    return true;
  }

  function invalidateWorldContextCache() {
    worldContextCache = null;
    worldContextCacheAt = 0;
  }

  function invalidateScanCaches() {
    entityScanCache = {
      allEntities: null,
      allEntitiesAt: 0,
      players: null,
      playersAt: 0,
      nearbyPlayers: null,
      nearbyPlayersAt: 0,
      nearbyHostiles: null,
      nearbyHostilesAt: 0,
    };
    blockQueryCache.clear();
  }

  function markLearningSnapshotDirty() {
    learningSnapshotDirty = true;
    invalidateWorldContextCache();
  }

  function refreshLearningIndexes() {
    if (!learningState.indexes || typeof learningState.indexes !== "object") {
      learningState.indexes = { taskFeatures: {} };
    }
    if (!learningState.indexes.taskFeatures || typeof learningState.indexes.taskFeatures !== "object") {
      learningState.indexes.taskFeatures = {};
    }
    const nextTaskFeatures = {};
    for (const [key, bucket] of Object.entries(learningState.taskScripts || {})) {
      if (!bucket || typeof bucket !== "object") {
        continue;
      }
      if (!bucket.features && bucket.lastSuccessfulPlan) {
        bucket.features = actionRegistry.extractTaskScriptFeatures(
          bucket.lastSuccessfulPlan,
          bucket.recentCommands?.slice(-1)?.[0] || ""
        );
      }
      if (bucket.features) {
        bucket.planHash = String(bucket.planHash || bucket.features.planHash || "").trim();
        nextTaskFeatures[key] = {
          intent: String(bucket.features.intent || bucket.intent || "").trim(),
          skillSequence: Array.isArray(bucket.features.skillSequence)
            ? bucket.features.skillSequence
            : [],
          tokens: Array.isArray(bucket.features.tokens) ? bucket.features.tokens.slice(0, 80) : [],
          resourceKeys: Array.isArray(bucket.features.resourceKeys)
            ? bucket.features.resourceKeys.slice(0, 24)
            : [],
          planHash: String(bucket.features.planHash || bucket.planHash || "").trim(),
          success: Number(bucket.success || 0) || 0,
          reusable: Boolean(actionRegistry.getTaskScriptPlanTemplate(bucket, bucket.lastSuccessfulPlan)),
          wholeLearningStatus: bucket.wholeLearningStatus || null,
          componentSuccess: Number(bucket.componentSuccess || 0) || 0,
          failed: Number(bucket.failed || 0) || 0,
          blocked: Number(bucket.blocked || 0) || 0,
        };
      }
    }
    learningState.indexes.taskFeatures = nextTaskFeatures;
  }

  function getPositionCacheKey(position = null) {
    const plain = toPlainPosition(position);
    if (!plain) {
      return "none";
    }
    return [
      Math.floor(Number(plain.x) || 0),
      Math.floor(Number(plain.y) || 0),
      Math.floor(Number(plain.z) || 0),
    ].join(",");
  }

  function getCachedBlockQuery(cacheKey, compute, ttlMs = BLOCK_QUERY_CACHE_MS) {
    const key = String(cacheKey || "").trim();
    if (!key) {
      return compute();
    }
    const cached = blockQueryCache.get(key);
    if (cached && Date.now() - Number(cached.at || 0) < ttlMs) {
      return cached.value;
    }
    const value = compute();
    blockQueryCache.set(key, {
      at: Date.now(),
      value,
    });
    if (blockQueryCache.size > 128) {
      const oldestKey = blockQueryCache.keys().next().value;
      if (oldestKey) {
        blockQueryCache.delete(oldestKey);
      }
    }
    return value;
  }

  function getCachedEntityList() {
    if (!currentBot?.entities || !currentBot?.entity) {
      return [];
    }
    if (
      entityScanCache.allEntities &&
      Date.now() - entityScanCache.allEntitiesAt < ENTITY_SCAN_CACHE_MS
    ) {
      return entityScanCache.allEntities;
    }
    entityScanCache.allEntities = Object.values(currentBot.entities || {}).filter(
      (entity) => entity && entity !== currentBot.entity && entity.position
    );
    entityScanCache.allEntitiesAt = Date.now();
    return entityScanCache.allEntities;
  }

  function getCachedPlayerEntries() {
    if (!currentBot?.players || !currentBot?.entity) {
      return [];
    }
    if (entityScanCache.players && Date.now() - entityScanCache.playersAt < ENTITY_SCAN_CACHE_MS) {
      return entityScanCache.players;
    }
    entityScanCache.players = Object.values(currentBot.players || {}).filter(
      (player) => player?.entity && player.username && player.username !== currentBot.username
    );
    entityScanCache.playersAt = Date.now();
    return entityScanCache.players;
  }

  function ensureLearningTaskScriptBucket(scriptKey = "", intent = "") {
    return actionRegistry.ensureTaskScriptBucket(learningState.taskScripts || {}, scriptKey, intent, {
      normalizeLearningIntent,
    });
  }

  function getTaskScriptReasonCount(bucket, reason = "") {
    return actionRegistry.getTaskScriptReasonCount(bucket, reason);
  }

  function scoreTaskScriptBucket(bucket, plan, command = "") {
    return actionRegistry.scoreTaskScriptBucket(bucket, plan, command, {
      normalizeLearningIntent,
    });
  }

  function findBestLearnedTaskScript(plan, command = "") {
    return actionRegistry.findBestLearnedTaskScript(plan, command, learningState.taskScripts || {}, {
      normalizeLearningIntent,
      getTaskScriptKey,
      ensureLearningTaskScriptBucket,
    });
  }

  function rankLearnedTaskScriptCandidates(plan, command = "", limit = 5) {
    return Object.values(learningState.taskScripts || {})
      .map((bucket) => ({
        key: String(bucket?.key || "").trim(),
        bucket,
        score: scoreTaskScriptBucket(bucket, plan, command),
      }))
      .filter((item) => item.key && item.bucket?.lastSuccessfulPlan && item.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Number(limit) || 5));
  }

  async function chooseLearnedTaskScriptWithAi(command = "", plan = {}) {
    const validated = skillCatalog.find(plan, { minecraftVersion: currentBot?.version,
      dimension: currentBot?.game?.dimension });
    if (validated) {
      plan.scriptMeta = { ...(plan.scriptMeta || {}), catalogSkillId: validated.id,
        catalogStatus: 'enabled', rerankMode: 'validated_catalog_direct' };
      // Execute the current registered plan; never replay archived coordinates,
      // counts, or JavaScript from the catalog.
      return null;
    }
    const exact = findBestLearnedTaskScript(plan, command);
    // An exact compatible registered template needs no model ranking. Always
    // keep the fresh command's parameters when compiling this template.
    if (exact?.rerankMode === 'exact' && exact.score >= 0) return exact;
    const candidates = rankLearnedTaskScriptCandidates(plan, command, 5);
    if (!candidates.length) {
      return exact || null;
    }
    if (isStrictExecutorMode() || candidates.length === 1 || typeof deps.requestPlannerCompletion !== "function") {
      return {
        key: candidates[0].key,
        bucket: candidates[0].bucket,
        score: candidates[0].score,
        rerankMode: exact?.rerankMode || "local_features",
      };
    }
    const config = deps.readConfig?.() || {};
    try {
      const raw = await deps.requestPlannerCompletion({
        config,
        temperature: 0.05,
        promptMessages: [
          {
            role: "system",
            content:
              "你是 Minecraft 任务脚本检索器。只输出 JSON：{\"key\":\"候选 key 或空字符串\",\"reason\":\"一句中文\"}。选择最适合复用的成功脚本；如果都不像，key 为空。",
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                command,
                freshPlan: {
                  intent: plan.intent,
                  goal: plan.goal,
                  steps: Array.isArray(plan.steps)
                    ? plan.steps.map((step) => ({ skill: step.skill, args: step.args || {} }))
                    : [],
                },
                candidates: candidates.map((item) => ({
                  key: item.key,
                  score: item.score,
                  intent: item.bucket.intent,
                  summary: item.bucket.summary || "",
                  success: item.bucket.success,
                  failed: item.bucket.failed,
                  blocked: item.bucket.blocked,
                  features: item.bucket.features || null,
                })),
              },
              null,
              2
            ),
          },
        ],
      });
      const parsed = deps.parseJsonObjectFromText?.(raw) || {};
      const key = String(parsed.key || "").trim();
      const selected = candidates.find((item) => item.key === key);
      if (selected) {
        selected.bucket.lastMatchScore = selected.score;
        selected.bucket.lastRerankMode = "ai_topk";
        selected.bucket.recentNotes = limitArray(
          [
            ...(selected.bucket.recentNotes || []),
            String(parsed.reason || "AI rerank selected this script").trim(),
          ].filter(Boolean),
          8
        );
        markLearningSnapshotDirty();
        scheduleLearningStateSave();
        return {
          key: selected.key,
          bucket: selected.bucket,
          score: selected.score,
          rerankMode: "ai_topk",
        };
      }
    } catch (error) {
      recordTaskDiagnostic(currentTask, "script_rerank_fallback", {
        error: error?.message || String(error || ""),
      });
    }
    return {
      key: candidates[0].key,
      bucket: candidates[0].bucket,
      score: candidates[0].score,
      rerankMode: "local_features",
    };
  }

  function getStageEnvironmentTags(step = {}) {
    const tags = [];
    const bot = currentBot;
    const dimension = String(bot?.game?.dimension || "").trim();
    if (dimension) {
      tags.push(`dimension:${dimension}`);
    }
    if (bot?.entity) {
      if (Number.isFinite(bot.health) && bot.health <= 10) {
        tags.push("low_health");
      }
      if (Number.isFinite(bot.food) && bot.food <= 10) {
        tags.push("low_food");
      }
      if (findNearbyCraftingTable(12)) {
        tags.push("has_crafting_table_nearby");
      }
      if (findNearbyFurnace(12)) {
        tags.push("has_furnace_nearby");
      }
      if (findNearbyContainer(12)) {
        tags.push("has_container_nearby");
      }
    }
    const resourceKey = getStageScriptResourceKey(step);
    if (resourceKey) {
      tags.push(`resource:${resourceKey}`);
    }
    return Array.from(new Set(tags)).slice(0, 12);
  }

  function ensureLearningStageScriptBucket(intent = "", step = {}) {
    if (!learningState.stageScripts || typeof learningState.stageScripts !== "object") {
      learningState.stageScripts = {};
    }
    return actionRegistry.ensureStageScriptBucket(learningState.stageScripts, intent, step, {
      getStageScriptKey,
      normalizeLearningIntent,
      getTaskScriptStepSignature,
      getStageEnvironmentTags,
      getResourceLearningKey,
      resolveBuildMaterial,
    });
  }

  function getStageScriptDynamicArgs(args = {}) {
    return pickTaskScriptDynamicArgs(args);
  }

  function scoreStageScriptBucket(bucket, intent = "", step = {}) {
    return actionRegistry.scoreStageScriptBucket(bucket, intent, step, {
      normalizeLearningIntent,
      getStageEnvironmentTags,
      getResourceLearningKey,
      resolveBuildMaterial,
    });
  }

  function findBestLearnedStageScript(intent = "", step = {}) {
    return actionRegistry.findBestLearnedStageScript(intent, step, learningState.stageScripts || {}, {
      getStageScriptKey,
      normalizeLearningIntent,
      getStageEnvironmentTags,
      getResourceLearningKey,
      resolveBuildMaterial,
    });
  }

  function applyLearnedStageScripts(plan) {
    return actionRegistry.applyLearnedStageScripts(plan, learningState.stageScripts || {}, {
      normalizeTaskScriptPlan,
      ensureLearningStageScriptBucket,
      findBestLearnedStageScript,
      getStageScriptDynamicArgs,
      getStageKindForStep,
    });
  }

  function rememberStageScriptOutcome(task, step, outcome = TaskState.COMPLETED, reason = "", telemetry = {}) {
    if (!task || !step) {
      return;
    }
    const bucket = ensureLearningStageScriptBucket(task.intent || task.plan?.intent || "", step);
    if (!bucket) {
      return;
    }
    actionRegistry.rememberStageScriptOutcome(bucket, task, step, outcome, reason, telemetry, {
      normalizeLearningIntent,
      getTaskScriptStepSignature,
      getStageEnvironmentTags,
      getResourceLearningKey,
      resolveBuildMaterial,
      reviseStepForFailure: reviseStageStepForFailure,
    });
    if (
      normalizeLearningIntent(task.intent || task.plan?.intent || "") === "build_small_house" &&
      String(step?.skill || "").trim() === "build_small_house_phase"
    ) {
      if (!learningState.builds || typeof learningState.builds !== "object") {
        learningState.builds = {};
      }
      if (!learningState.builds.smallHousePhaseStats || typeof learningState.builds.smallHousePhaseStats !== "object") {
        learningState.builds.smallHousePhaseStats = {};
      }
      const phase = String(step.args?.phase || "unknown").trim() || "unknown";
      const stats = learningState.builds.smallHousePhaseStats[phase] || {
        success: 0,
        blocked: 0,
        failed: 0,
        lastOutcome: null,
        lastReason: null,
      };
      if (outcome === TaskState.COMPLETED || outcome === "completed") {
        stats.success = Number(stats.success || 0) + 1;
      } else if (outcome === TaskState.BLOCKED || outcome === "blocked") {
        stats.blocked = Number(stats.blocked || 0) + 1;
      } else if (outcome !== TaskState.CANCELLED && outcome !== "cancelled") {
        stats.failed = Number(stats.failed || 0) + 1;
      }
      stats.lastOutcome = String(outcome || "").trim() || null;
      stats.lastReason = String(reason || "").trim() || null;
      stats.lastUsedAt = Date.now();
      learningState.builds.smallHousePlaybookVersion = 1;
      learningState.builds.smallHousePhaseStats[phase] = stats;
    }
    markLearningSnapshotDirty();
    scheduleLearningStateSave();
  }

  function pickTaskScriptDynamicArgs(args = {}) {
    return actionRegistry.pickTaskScriptDynamicArgs(args);
  }

  function mergeTaskScriptPlan(scriptPlan, freshPlan) {
    return actionRegistry.mergeTaskScriptPlan(scriptPlan, freshPlan, {
      normalizeTaskScriptPlan,
      getTaskScriptStepSignature,
      pickTaskScriptDynamicArgs,
    });
  }

  function reviseStageStepForFailure(step = {}, classified = {}) {
    return actionRegistry.reviseStepForFailure(step, classified);
  }

  function buildStageRevisionPlan(task, classified = {}) {
    if (!task?.plan || !task?.plan?.steps?.[Number(task?.currentStepIndex) || 0]) {
      return null;
    }
    if (normalizeLearningIntent(task.intent || task.plan.intent || "") === "mine_diamond_resource") {
      return null;
    }
    if (
      normalizeLearningIntent(task.intent || task.plan.intent || "") === "build_small_house" &&
      String(task.plan.steps[Number(task.currentStepIndex) || 0]?.skill || "").trim() === "build_small_house_phase"
    ) {
      return null;
    }
    return actionRegistry.buildStageRevisionPlan(task, classified, {
      getStageScriptKey,
      resolveBuildMaterial,
      anyPlanks: ANY_PLANKS,
      getLearnedSearchRadius,
      getResourceLearningKey,
    });
  }

  function compileTaskScriptPlan(command, plan, options = {}) {
    if (plan?.scriptMeta?.catalogSkillId) {
      const record = skillCatalog.find(plan, { minecraftVersion: currentBot?.version,
        dimension: currentBot?.game?.dimension });
      if (record?.id === plan.scriptMeta.catalogSkillId) {
        return actionRegistry.compilePlan({ ...plan, scriptMeta: { ...plan.scriptMeta,
          source: 'validated_catalog', rerankMode: 'validated_catalog_direct' } });
      }
    }
    const forcedScriptMatch = options?.scriptMatch || null;
    return actionRegistry.compilePlan(
      actionRegistry.compileTaskScriptPlan(command, plan, learningState.taskScripts || {}, learningState.stageScripts || {}, {
        normalizeTaskScriptPlan,
        getTaskScriptKey,
        ensureLearningTaskScriptBucket,
        findBestLearnedTaskScript: Object.prototype.hasOwnProperty.call(options, 'scriptMatch')
          ? () => forcedScriptMatch
          : findBestLearnedTaskScript,
        mergeTaskScriptPlan,
        applyLearnedStageScripts,
      })
    );
  }

  function getTaskScriptPlanningHints(command, plan) {
    return actionRegistry.getTaskScriptPlanningHints(command, plan, learningState.taskScripts || {}, {
      normalizeTaskScriptPlan,
      limitArray,
      normalizeLearningIntent,
      getTaskScriptKey,
      ensureLearningTaskScriptBucket,
    });
  }

  function annotateTaskScriptRevision(plan, revisionMeta = {}) {
    return actionRegistry.annotateTaskScriptRevision(plan, revisionMeta, {
      normalizeTaskScriptPlan,
    });
  }

  function rememberTaskScript(task, outcome = TaskState.COMPLETED, note = "") {
    if (!task?.plan) {
      return;
    }
    const scriptKey =
      String(task.plan?.scriptMeta?.key || "").trim() || getTaskScriptKey(task.plan, task.userCommand);
    const bucket = ensureLearningTaskScriptBucket(scriptKey, task.intent || task.plan?.intent || "");
    if (!bucket) {
      return;
    }
    actionRegistry.rememberTaskScriptOutcome(bucket, task, outcome, note, {
      normalizeTaskScriptPlan,
      limitArray,
    });
    if (outcome === TaskState.COMPLETED) {
      try {
        skillCatalog.recordCandidate(task.plan, { minecraftVersion: currentBot?.version,
          dimension: currentBot?.game?.dimension, taskId: task.taskId, outcome,
          wholeStatus: bucket.wholeLearningStatus || bucket.lastWholeOutcome || 'not_applicable' });
      } catch (error) {
        deps.broadcastMinecraftError?.(`Minecraft 候选技能保存失败：${error.message}`);
      }
    }
  }

  function ensureLearningIntentBucket(intent = "") {
    const key = normalizeLearningIntent(intent);
    if (!key) {
      return null;
    }
    if (!learningState.intents[key] || typeof learningState.intents[key] !== "object") {
      learningState.intents[key] = actionRegistry.createIntentLearningBucket();
    }
    return learningState.intents[key];
  }

  function ensureLearningResourceBucket(resourceKey = "") {
    const key = getResourceLearningKey(resourceKey);
    if (!key) {
      return null;
    }
    if (!learningState.resources[key] || typeof learningState.resources[key] !== "object") {
      learningState.resources[key] = actionRegistry.createResourceLearningBucket();
    }
    return learningState.resources[key];
  }

  function addLearningInsight(message = "", meta = {}) {
    const text = String(message || "").trim();
    if (!text) {
      return;
    }
    learningState.recentInsights = limitArray(
      [
        ...learningState.recentInsights,
        {
          message: text,
          timestamp: Date.now(),
          ...meta,
        },
      ],
      20
    );
  }

  function getLearnedSearchRadius(resourceKey = "", fallback = 24, max = 96) {
    const bucket = ensureLearningResourceBucket(resourceKey);
    const base = clamp(Number(fallback) || 24, 4, max);
    if (!bucket) {
      return base;
    }
    return clamp(base + clamp(Number(bucket.searchRadiusBonus) || 0, 0, 48), 4, max);
  }

  function getLearnedSmallHouseDimensions(width = 5, depth = 4) {
    const penalty = clamp(Number(learningState.builds?.smallHouseScalePenalty) || 0, 0, 3);
    return {
      width: clamp(Number(width) - penalty, 4, 7),
      depth: clamp(Number(depth) - penalty, 4, 6),
      penalty,
    };
  }

  function convertSmallHousePlanToPlaybook(plan) {
    if (!plan || plan.mode !== "task" || normalizeLearningIntent(plan.intent || "") !== "build_small_house") {
      return plan;
    }
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    if (steps.some((step) => String(step?.skill || "").trim() === "build_small_house_phase")) {
      return plan;
    }
    const buildStep = steps.find((step) => String(step?.skill || "").trim() === "build_structure");
    if (!buildStep) {
      return plan;
    }
    const rawMaterial = String(buildStep.args?.material || "wood").trim().toLowerCase();
    const material = resolveBuildMaterial(rawMaterial || "wood");
    if (!["", "wood", "oak", "plank", "planks"].includes(rawMaterial) && !ANY_PLANKS.includes(material)) {
      return plan;
    }
    return {
      ...plan,
      goal: "build a minimal wooden cottage near the player with a deterministic survival playbook",
      steps: actionRegistry.createSmallHousePlaybookSteps({
        material: "any_planks",
        width: 3,
        depth: 3,
        height: 2,
      }),
      replyText:
        plan.replyText ||
        "我会按真人式步骤来盖：先看背包和地形，再备木材、清地、铺地板、搭墙、封顶并检查。",
      scriptMeta: {
        ...(plan.scriptMeta && typeof plan.scriptMeta === "object" ? cloneSerializable(plan.scriptMeta, {}) || {} : {}),
        playbook: "small_house_v1",
        playbookMode: "deterministic",
      },
    };
  }

  function getStageScriptLibrarySummary() {
    return actionRegistry.getStageScriptLibrarySummary(learningState.stageScripts || {}, currentTask);
  }

  function getTaskLearningResourceKey(task) {
    return actionRegistry.getTaskLearningResourceKey(task, {
      normalizeLearningIntent,
      getResourceLearningKey,
    });
  }

  function getLearningSnapshot() {
    if (!learningSnapshotDirty && learningSnapshotCache) {
      return learningSnapshotCache;
    }
    learningSnapshotCache = actionRegistry.buildLearningSnapshot(learningState, currentTask, {
      clamp,
    });
    learningSnapshotDirty = false;
    return learningSnapshotCache;
  }

  function getLearningLibrarySummary() {
    refreshLearningIndexes();
    const taskScripts = Object.values(learningState.taskScripts || {});
    const stageScripts = Object.values(learningState.stageScripts || {});
    return {
      schemaVersion: Number(learningState.schemaVersion || 2) || 2,
      learningStatePath,
      diagnosticsDir,
      taskScriptCount: taskScripts.length,
      successfulTaskScriptCount: taskScripts.filter((bucket) => actionRegistry.getTaskScriptPlanTemplate(bucket, bucket.lastSuccessfulPlan)).length,
      stageScriptCount: stageScripts.length,
      successfulStageScriptCount: stageScripts.filter((bucket) => Number(bucket?.success || 0) > 0).length,
      topTaskScripts: taskScripts
        .filter((bucket) => bucket?.key)
        .sort((a, b) => Number(b.success || 0) - Number(a.success || 0))
        .slice(0, 8)
        .map((bucket) => ({
          key: String(bucket.key || "").trim(),
          intent: String(bucket.intent || "").trim(),
          success: Number(bucket.success || 0) || 0,
          failed: Number(bucket.failed || 0) || 0,
          blocked: Number(bucket.blocked || 0) || 0,
          summary: String(bucket.summary || "").trim() || null,
          planHash: String(bucket.planHash || "").trim() || null,
          lastReason: String(bucket.lastReason || "").trim() || null,
        })),
      lastTaskDiagnostics: getLastTaskDiagnostics(),
    };
  }

  function recordTaskLearning(task, outcome = TaskState.COMPLETED) {
    if (!task) {
      return;
    }
    const learningMeta = actionRegistry.recordTaskLearningOutcome(learningState, task, outcome, {
      normalizeLearningIntent,
      getTaskLearningResourceKey,
      addLearningInsight,
      clamp,
    });
    const scriptNote = String(learningMeta?.scriptNote || "").trim();
    rememberTaskScript(task, outcome, scriptNote);
    refreshLearningIndexes();

    markLearningSnapshotDirty();
    scheduleLearningStateSave();
  }

  function getExecutorMode() {
    return (runtimeExecutorMode || deps.readConfig?.().mcExecutorMode) === "experimental-autonomy"
      ? "experimental-autonomy"
      : "strict-executor";
  }

  function setRuntimeOptions(options = {}) {
    const nextMode =
      options.mcExecutorMode === "experimental-autonomy"
        ? "experimental-autonomy"
        : options.mcExecutorMode === "strict-executor"
          ? "strict-executor"
          : null;
    if (nextMode && nextMode !== getExecutorMode()) {
      runtimeExecutorMode = nextMode;
      runtimeExecutorModeSource = "runtime";
      if (nextMode === "experimental-autonomy") {
        autonomyArmedAt = Date.now() + 5000;
        autonomySafeUntil = autonomyArmedAt;
        autonomousState.nextAllowedAt = Math.max(
          Number(autonomousState.nextAllowedAt || 0),
          autonomySafeUntil
        );
      } else {
        autonomyArmedAt = 0;
        autonomySafeUntil = 0;
      }
      broadcastContextSnapshot(true);
      broadcastTaskStatus(true);
    } else if (nextMode) {
      runtimeExecutorMode = nextMode;
      runtimeExecutorModeSource = "runtime";
    }
  }

  function isStrictExecutorMode() {
    return getExecutorMode() === "strict-executor";
  }

  function reportRuntimeFault(code = "runtime_fault", error = null, options = {}) {
    const fault = runtimeDiagnostics.recordRuntimeFault(code, error);
    if (options.task && options.task !== currentTask) {
      options.task.lastRecoveryReason = fault.code;
    } else if (currentTask) {
      currentTask.lastRecoveryReason = fault.code;
    }
    if (options.broadcastError !== false) {
      deps.broadcastMinecraftError?.(`Minecraft 执行器异常：${fault.message}`);
    }
    deps.broadcast({
      type: "mc_task_event",
      event: {
        eventType: "runtime_fault",
        taskId: options.task?.taskId || currentTask?.taskId || null,
        timestamp: fault.at,
        reason: fault.code,
        message: fault.message,
      },
    });
    broadcastTaskStatus();
    broadcastContextSnapshot(true);
    return fault.reason;
  }

  function getRuntimeFaultSnapshot() {
    return runtimeDiagnostics.getRuntimeFaultSnapshot();
  }

  function getBotWriteSnapshot() {
    return runtimeDiagnostics.getBotWriteSnapshot();
  }

  function getDisconnectEventTrail() {
    return runtimeDiagnostics.getDisconnectEventTrail();
  }

  function resetDisconnectEventTrail() {
    runtimeDiagnostics.resetDisconnectEventTrail();
  }

  function rememberDisconnectEvent(eventType = "", detail = "", extra = {}) {
    return runtimeDiagnostics.rememberDisconnectEvent(eventType, detail, extra);
  }

  function rememberBotWrite(primitive = "", context = {}) {
    return runtimeDiagnostics.rememberBotWrite(primitive, context);
  }

  function isBotConnectionWritable() {
    const bot = currentBot;
    if (!bot?.entity) {
      return false;
    }
    const client = bot._client;
    if (!client) {
      return false;
    }
    if (bot.player?.ping === -1) {
      return false;
    }
    if (client.ended === true || client.ended === "true") {
      return false;
    }
    if (client.wait_connect === false && client.state == null) {
      return false;
    }
    const socket = client.socket || client.stream || client._socket || null;
    if (socket) {
      if (socket.destroyed === true) {
        return false;
      }
      if (socket.writable === false) {
        return false;
      }
      if ("readyState" in socket && String(socket.readyState || "").toLowerCase() === "closed") {
        return false;
      }
    }
    if (lastDisconnectObservedAt && Date.now() - Number(lastDisconnectObservedAt || 0) < 1500) {
      return false;
    }
    return true;
  }

  function ensureBotConnectionWritable(primitive = "", context = {}) {
    rememberBotWrite(primitive, context);
    if (!isBotConnectionWritable()) {
      const error = new Error("Minecraft 底层连接已断开，当前不能继续发送动作");
      error.code = "socket_not_writable";
      throw error;
    }
    return true;
  }

  function raceBotDisconnect(primitive = "", context = {}, options = {}) {
    const bot = ensureBotReady();
    const client = bot?._client || null;
    const socket = client?.socket || client?.stream || client?._socket || null;
    let settled = false;
    let cleanup = () => {};
    const promise = new Promise((_, reject) => {
      const rejectDisconnect = (error = null, source = "client.error") => {
        if (settled) {
          return;
        }
        settled = true;
        const disconnectError = createDisconnectRaceError(error);
        rememberDisconnectEvent(source, disconnectError.message, {
          primitive,
          context,
        });
        void quarantineBotRuntimeOnDisconnect(
          disconnectError.message,
          String(disconnectError.code || "").trim() === "socket_write_epipe"
            ? "socket_write_epipe"
            : "server_disconnected",
          {
            source,
            closeWindow: options.closeWindow !== false,
          }
        );
        reject(disconnectError);
      };
      const onClientEnd = () => rejectDisconnect(null, "client.end");
      const onClientError = (error) => rejectDisconnect(error, "client.error");
      const onSocketClose = (hadError) =>
        rejectDisconnect(
          hadError ? new Error("Minecraft 底层 socket 提前关闭（带错误）") : new Error("Minecraft 底层 socket 提前关闭"),
          "socket.close"
        );
      if (client?.on) {
        client.on("end", onClientEnd);
        client.on("error", onClientError);
      }
      if (socket?.on) {
        socket.on("close", onSocketClose);
      }
      cleanup = () => {
        settled = true;
        client?.removeListener?.("end", onClientEnd);
        client?.removeListener?.("error", onClientError);
        socket?.removeListener?.("close", onSocketClose);
      };
    });
    return {
      promise,
      cleanup: () => cleanup(),
    };
  }

  async function runBotWritableAction(primitive = "", context = {}, operation, options = {}) {
    ensureBotConnectionWritable(primitive, context);
    const disconnectRace = raceBotDisconnect(primitive, context, options);
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          if (getExecutionContext()?.task) {
            checkTaskSignal();
            const defenseFailure = getHouseSurfaceDefenseFailure();
            if (defenseFailure) throw defenseFailure;
          }
          return operation();
        }),
        disconnectRace.promise,
      ]);
    } finally {
      disconnectRace.cleanup();
    }
  }

  async function quarantineBotRuntimeOnDisconnect(reason = "", detailSource = "", extra = {}) {
    const normalizedReason = String(reason || "").trim() || "server_disconnected";
    const normalizedSource =
      String(detailSource || "").trim() || classifyDisconnectDetailSource(normalizedReason);
    const now = Date.now();
    if (
      lastDisconnectObservedAt &&
      now - Number(lastDisconnectObservedAt || 0) < 250 &&
      String(lastDisconnectDetailSource || "").trim() === normalizedSource
    ) {
      return false;
    }
    lastDisconnectObservedAt = now;
    lastDisconnectDetailSource = normalizedSource;
    lastDisconnectPath = getDisconnectPath(normalizedSource);
    const taskFailureCode = getConnectionFailureTaskCode(normalizedSource, normalizedReason);
    const bot = currentBot;
    activeMovementLease = null;
    endMovementSession();
    clearPassiveEscort({
      stopBot: false,
    });
    if (runtimeToken) {
      runtimeToken.cancel(taskFailureCode);
    }
    if (currentTask?.cancellationToken) {
      currentTask.cancellationToken.cancel(taskFailureCode);
      currentTask.actionState = "recovering";
      currentTask.lastRecoveryReason = taskFailureCode;
      currentTask.progressText = normalizedReason;
    }
    brain.clearRegistryAction();
    if (currentTask) {
      addTaskLog("warn", normalizedReason);
    }
    if (bot) {
      try {
        bot.pathfinder?.setGoal?.(null);
        lastPathfinderGoalSignature = "";
        lastPathfinderMotorWriteAt = Date.now();
      } catch (_) {}
      try {
        bot.clearControlStates?.();
      } catch (_) {}
      try {
        bot.stopDigging?.();
      } catch (_) {}
      try {
        bot.deactivateItem?.();
      } catch (_) {}
      try {
        if (extra?.closeWindow !== false && bot.currentWindow) {
          bot.closeWindow?.(bot.currentWindow);
        }
      } catch (_) {}
    }
    invalidateScanCaches();
    invalidateWorldContextCache();
    broadcastTaskStatus();
    broadcastContextSnapshot();
    return true;
  }

  function safeAsyncTick(code, operation, options = {}) {
    return Promise.resolve()
      .then(() => operation())
      .catch((error) => {
        reportRuntimeFault(code, error, options);
        if (typeof options.onFailure === "function") {
          try {
            options.onFailure(error);
          } catch (_) {}
        }
        return options.fallbackValue ?? false;
      });
  }

  function clearMovementMonitor() {
    if (activeMovementMonitor?.intervalId) {
      clearInterval(activeMovementMonitor.intervalId);
    }
    activeMovementMonitor = null;
  }

  function startMovementSession(kind = "movement", meta = {}) {
    activeMovementSession = {
      id: `move-session-${movementSessionCounter++}`,
      kind: String(kind || "movement").trim() || "movement",
      ownerTaskId: String(meta.ownerTaskId || currentTask?.taskId || "").trim() || null,
      goalSignature: String(meta.goalSignature || "").trim() || "",
      targetLabel: String(meta.targetLabel || "").trim() || null,
      startedAt: Date.now(),
      lastGoalSetAt: Date.now(),
      lastObservedAt: Date.now(),
      stable: false,
    };
    return activeMovementSession;
  }

  function touchMovementSession(meta = {}) {
    if (!activeMovementSession) {
      return null;
    }
    activeMovementSession = {
      ...activeMovementSession,
      ...meta,
      stable:
        meta.stable === undefined
          ? activeMovementSession.stable
          : meta.stable === true,
      lastObservedAt: Date.now(),
    };
    return activeMovementSession;
  }

  function markMovementSessionStable(meta = {}) {
    return touchMovementSession({
      ...meta,
      stable: true,
    });
  }

  function shouldRefreshContinuousGoal(goal, dynamic = false) {
    const goalSignature = getPathGoalSignature(goal, dynamic);
    if (!goalSignature) {
      return true;
    }
    if (!activeMovementSession) {
      return true;
    }
    if (String(activeMovementSession.goalSignature || "").trim() !== goalSignature) {
      return true;
    }
    const lastGoalSetAt = Number(activeMovementSession.lastGoalSetAt || 0) || 0;
    return Date.now() - lastGoalSetAt >= 1800;
  }

  function endMovementSession() {
    clearMovementMonitor();
    activeMovementSession = null;
  }

  function isAutonomyExecutionHealthy() {
    if (!currentBot?.entity) {
      return false;
    }
    if (activePhysicalAction || survivalInterruptRunning) {
      return false;
    }
    if (Date.now() - Number(getRuntimeFaultSnapshot().at || 0) < 8000) {
      return false;
    }
    return true;
  }

  function updateTaskCheckpoint(task = currentTask, patch = null) {
    if (!task || !patch || typeof patch !== "object") {
      return;
    }
    task.stepCheckpoint = {
      ...(task.stepCheckpoint && typeof task.stepCheckpoint === "object"
        ? cloneSerializable(task.stepCheckpoint, {}) || {}
        : {}),
      ...(cloneSerializable(patch, {}) || {}),
    };
    broadcastTaskStatus();
    broadcastContextSnapshot();
  }

  function setTaskRegistryAction(task = currentTask, step = null, options = {}) {
    if (!task || !step) {
      return null;
    }
    const compiledAction =
      step?.action && typeof step.action === "object"
        ? cloneSerializable(step.action, {}) || {}
        : actionRegistry.compileStep(step);
    task.currentRegistryAction = compiledAction;
    task.actionContractType = String(
      options.contractType || compiledAction.contractType || ""
    ).trim() || null;
    brain.setRegistryAction(compiledAction, {
      contractType: task.actionContractType,
    });
    if (compiledAction.valid === false && Array.isArray(compiledAction.validationErrors) && compiledAction.validationErrors.length) {
      throw new Error(`动作参数无效：${compiledAction.validationErrors.join("；")}`);
    }
    return compiledAction;
  }

  function setTaskActionState(task = currentTask, actionState = "", options = {}) {
    if (!task) {
      return;
    }
    const nextState = String(actionState || "").trim() || null;
    task.actionState = nextState;
    if (typeof options.progressText === "string" && options.progressText.trim()) {
      task.progressText = options.progressText.trim();
    }
    if (options.checkpoint && typeof options.checkpoint === "object") {
      updateTaskCheckpoint(task, options.checkpoint);
    }
    if (options.recoveryReason === null) {
      task.lastRecoveryReason = null;
    } else if (typeof options.recoveryReason === "string" && options.recoveryReason.trim()) {
      task.lastRecoveryReason = options.recoveryReason.trim();
    }
    touchTaskActivity(task);
    broadcastTaskStatus();
    broadcastContextSnapshot();
  }

  function recordTaskHeartbeat(task = currentTask, options = {}) {
    if (!task) {
      return;
    }
    task.lastHeartbeatAt = Date.now();
    if (typeof options.actionState === "string" && options.actionState.trim()) {
      task.actionState = options.actionState.trim();
    }
    if (options.checkpoint && typeof options.checkpoint === "object") {
      task.stepCheckpoint = {
        ...(task.stepCheckpoint && typeof task.stepCheckpoint === "object"
          ? cloneSerializable(task.stepCheckpoint, {}) || {}
          : {}),
        ...(cloneSerializable(options.checkpoint, {}) || {}),
      };
    }
    if (options.clearRecoveryReason === true) {
      task.lastRecoveryReason = null;
    }
    touchTaskActivity(task);
    broadcastTaskStatus();
    broadcastContextSnapshot();
  }

  function markTaskRecovery(task = currentTask, reason = "", options = {}) {
    if (!task) {
      return;
    }
    task.lastRecoveryReason = String(reason || "").trim() || null;
    task.actionState = "recovering";
    if (options.checkpoint && typeof options.checkpoint === "object") {
      updateTaskCheckpoint(task, options.checkpoint);
    }
    touchTaskActivity(task);
    broadcastTaskStatus();
    broadcastContextSnapshot();
  }

  function publicPhysicalAction(action = activePhysicalAction) {
    return taskPublicState.publicPhysicalAction(action);
  }

  function getPhysicalActionTask(options = {}) {
    return options.task || getExecutionContext()?.task || currentTask || null;
  }

  function markPhysicalActionSignal(action, signal = "signal", meta = {}) {
    if (!action || action.cancelled) {
      return;
    }
    const now = Date.now();
    action.physicalSignal = String(signal || "signal").trim() || "signal";
    action.firstSignalAt = action.firstSignalAt || now;
    action.lastSignalAt = now;
    if (Number.isFinite(meta.positionDelta)) {
      action.lastPositionDelta = Number(meta.positionDelta);
    }
    if (Number.isFinite(meta.distanceDelta)) {
      action.lastDistanceDelta = Number(meta.distanceDelta);
    }
    const task = getPhysicalActionTask({ task: action.task });
    if (task) {
      task.lastPhysicalHeartbeatAt = now;
      task.waitingForPhysicalSignalSince = 0;
      recordTaskHeartbeat(task, {
        actionState: action.kind === "move" ? "moving" : "acting",
        checkpoint: {
          ...(task.stepCheckpoint && typeof task.stepCheckpoint === "object" ? task.stepCheckpoint : {}),
          activeActionId: action.id,
          activePrimitive: action.primitive,
          physicalSignal: action.physicalSignal,
          stageKind: action.stageKind || null,
        },
        clearRecoveryReason: true,
      });
    }
  }

  function createPhysicalAction(kind = "act", primitive = "unknown", options = {}) {
    const task = getPhysicalActionTask(options);
    const activeStep =
      task?.plan?.steps?.[Number.isFinite(task?.currentStepIndex) ? task.currentStepIndex : 0] || null;
    const action = {
      id: `action-${physicalActionCounter++}`,
      kind: String(kind || "act").trim() || "act",
      primitive: String(primitive || "unknown").trim() || "unknown",
      stageKind: String(options.stageKind || getStageKindForStep(activeStep) || "").trim() || "act",
      ownerTaskId: task?.taskId || null,
      stepIndex: Number.isFinite(task?.currentStepIndex) ? task.currentStepIndex : null,
      task,
      startedAt: Date.now(),
      firstSignalAt: 0,
      lastSignalAt: 0,
      physicalSignal: "",
      lastPositionDelta: null,
      lastDistanceDelta: null,
      recoveryReason: "",
      cancelled: false,
      isOwnerCurrent: typeof options.isOwnerCurrent === "function" ? options.isOwnerCurrent : null,
      capturedContext: getExecutionContext(), capturedBot: currentBot, capturedClient: currentBot?._client,
      capturedGeneration: task?.executionGeneration, capturedLease: getCurrentMovementLease(),
    };
    activePhysicalAction = action;
    if (task) {
      task.stageKind = action.stageKind;
      task.lastPrimitiveStartedAt = action.startedAt;
      task.waitingForPhysicalSignalSince = action.startedAt;
      task.actionState = "waiting_for_physical_signal";
      broadcastTaskStatus();
      broadcastContextSnapshot();
    }
    return action;
  }

  async function recoverPhysicalAction(action, reason = "executor_stalled", options = {}) {
    if (!action || action.cancelled || activePhysicalAction !== action || currentBot!==action.capturedBot
      ||currentBot?._client!==action.capturedClient||currentTask!==action.task
      ||action.task?.executionGeneration!==action.capturedGeneration
      ||action.capturedLease&&!isMovementLeaseActive(action.capturedLease)) return false;
    if (action.isOwnerCurrent && action.isOwnerCurrent() !== true) return false;
    action.recoveryReason = String(reason || "").trim() || "executor_stalled";
    const task = getPhysicalActionTask({ task: action.task });
    if (task) {
      // Resetting one failed primitive is separate from replacing a task plan.
      task.physicalRecoveryCount = Math.max(0, Number(task.physicalRecoveryCount) || 0) + 1;
      markTaskRecovery(task, action.recoveryReason, {
        checkpoint: {
          ...(task.stepCheckpoint && typeof task.stepCheckpoint === "object" ? task.stepCheckpoint : {}),
          activeActionId: action.id,
          activePrimitive: action.primitive,
          stageKind: action.stageKind || null,
        },
      });
    }
    await executionContextStorage.run(action.capturedContext||{},()=>softResetBotRuntime(`真实动作 ${action.primitive} 停滞`, {
      closeWindow: true,
      cooldownMs: options.hard === true ? 360 : 180,
    }));
    return true;
  }

  async function runPhysicalAction(kind, primitive, operation, options = {}) {
    if (getExecutionContext()?.task) checkTaskSignal();
    if (options.isOwnerCurrent && options.isOwnerCurrent() !== true) throw createAbortError("movement_preempted");
    const action = createPhysicalAction(kind, primitive, options);
    const task = getPhysicalActionTask({ task: action.task });
    const timeoutMs = clamp(Number(options.timeoutMs) || DEFAULT_PATHFIND_TIMEOUT_MS, 600, 300000);
    const startupGraceMs = clamp(
      Number(options.startupGraceMs) || PHYSICAL_ACTION_STARTUP_GRACE_MS,
      600,
      Math.max(800, timeoutMs)
    );
    const stallMs = clamp(Number(options.stallMs) || PHYSICAL_ACTION_STALL_MS, 1200, Math.max(1500, timeoutMs));
    const requireStartupSignal =
      options.requireStartupSignal === true ||
      (options.requireStartupSignal !== false && String(kind || "") === "move");
    const startedAt = Date.now();
    let intervalId = null;
    let lastPosition = currentBot?.entity?.position?.clone?.() || null;
    let lastDistance =
      typeof options.getDistance === "function" ? Number(options.getDistance()) : Number.POSITIVE_INFINITY;
    let settled = false;
    const fail = (code, message) => {
      const error = createAbortError(code);
      error.message = message || code;
      return error;
    };
    const stallPromise = new Promise((_, reject) => {
      intervalId = setInterval(() => {
        if (settled || action.cancelled) {
          return;
        }
        if (options.isOwnerCurrent && options.isOwnerCurrent() !== true) {
          reject(fail("movement_preempted", "真实动作执行归属已改变")); return;
        }
        const now = Date.now();
        const position = currentBot?.entity?.position?.clone?.() || null;
        if (position && lastPosition) {
          const positionDelta = position.distanceTo(lastPosition);
          let distanceDelta = 0;
          if (typeof options.getDistance === "function") {
            const nextDistance = Number(options.getDistance());
            if (Number.isFinite(nextDistance) && Number.isFinite(lastDistance)) {
              distanceDelta = lastDistance - nextDistance;
            }
            if (Number.isFinite(nextDistance)) {
              lastDistance = nextDistance;
            }
          }
          if (
            positionDelta >= Number(options.minPositionDelta || 0.08) ||
            distanceDelta >= Number(options.minDistanceDelta || 0.15)
          ) {
            markPhysicalActionSignal(action, positionDelta >= 0.08 ? "position_delta" : "distance_decreased", {
              positionDelta,
              distanceDelta,
            });
          }
          lastPosition = position;
        } else if (position) {
          lastPosition = position;
        }
        if (requireStartupSignal && !action.firstSignalAt && now - startedAt >= startupGraceMs) {
          reject(fail("executor_stalled", `${primitive} 没有检测到真实动作`));
          return;
        }
        const lastSignalAt = Number(action.lastSignalAt || action.firstSignalAt || 0) || 0;
        if (requireStartupSignal && lastSignalAt && now - lastSignalAt >= stallMs) {
          reject(fail("executor_stalled", `${primitive} 长时间没有真实动作`));
        }
      }, PHYSICAL_ACTION_SAMPLE_MS);
    });
    let timeoutId = null;
    try {
      const result = await Promise.race([
        Promise.resolve(operation((signal, meta = {}) => markPhysicalActionSignal(action, signal, meta))),
        stallPromise,
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(fail("step_timeout", `${primitive} 超时`)), timeoutMs);
        }),
      ]);
      if (action.cancelled && action.recoveryReason === "survival_critical" && action.survivalInterrupt &&
          activeHouseResourceWork?.task === action.task) {
        const interrupted = createAbortError("movement_preempted");
        interrupted.survivalInterrupt = action.survivalInterrupt;
        throw interrupted;
      }
      if (!action.firstSignalAt && options.allowCompleteAsSignal !== false) {
        markPhysicalActionSignal(action, "primitive_completed", {});
      }
      return result;
    } catch (error) {
      // A user control or superseded execution is not a physical failure to repair.
      if (getExecutionContext()?.task) checkTaskSignal();
      const interruption = action.survivalInterrupt || activeSurvivalInterrupt;
      const actionContext = getExecutionContext();
      const ownsInterruption = interruption && interruption.task === actionContext?.task &&
        interruption.runGeneration === actionContext?.runGeneration && (interruption.workToken || interruption.token) === actionContext?.token &&
        interruption.previousLease === actionContext?.movementLease && isSurvivalOwnerCurrent(interruption);
      if ((action.cancelled && action.recoveryReason === "survival_critical" && action.survivalInterrupt) ||
          (error.code === "movement_preempted" && ownsInterruption)) {
        // The survival owner deliberately stopped this primitive. A generic
        // soft reset here would cancel the self-defense action as it starts.
        const preempted = createAbortError("movement_preempted");
        preempted.survivalInterrupt = interruption;
        throw preempted;
      }
      if (options.isOwnerCurrent && options.isOwnerCurrent() !== true) throw error;
      // Only a captured site graph's observed native noPath may retain its
      // goal until that graph stops and validates the actual partial landing.
      if(error?.name==='NoPath'&&options.isExpectedNativeNoPath?.()===true)throw error;
      // A bounded escape deliberately clears its exact native goal after
      // observing a grounded safe distance. Native goto still rejects and must
      // settle; that expected rejection is not a stalled primitive to reset.
      if (["GoalChanged", "PathStopped"].includes(error?.name) &&
          options.isExpectedNativeStop?.() === true) throw error;
      const code = String(error?.code || error?.message || "executor_stalled").trim();
      if (!["socket_not_writable", "bot_connection_lost"].includes(code)) {
        await recoverPhysicalAction(action, code, {
          hard: Number(task?.physicalRecoveryCount || 0) >= 2,
        });
      } else if (task) {
        markTaskRecovery(task, code, {
          checkpoint: {
            ...(task.stepCheckpoint && typeof task.stepCheckpoint === "object" ? task.stepCheckpoint : {}),
            activeActionId: action.id,
            activePrimitive: action.primitive,
            stageKind: action.stageKind || null,
          },
        });
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      settled = true;
      action.cancelled = true;
      if (intervalId) {
        clearInterval(intervalId);
      }
      if (activePhysicalAction?.id === action.id) {
        activePhysicalAction = null;
      }
      broadcastContextSnapshot();
      broadcastTaskStatus();
    }
  }

  function publicTask(task) {
    return taskPublicState.publicTask(task);
  }

  function publicBackgroundAgenda() {
    return formatPublicBackgroundAgenda(backgroundAgenda, {
      strictExecutor: isStrictExecutorMode(),
      suppressedByForeground: autonomousState.suppressedByForeground,
    });
  }

  function rememberBackgroundAgenda(plan = null, options = {}) {
    if (!plan || typeof plan !== "object") {
      backgroundAgenda = null;
      backgroundAgendaPlan = null;
      return;
    }
    backgroundAgendaPlan = normalizeTaskScriptPlan(plan);
    backgroundAgenda = createBackgroundAgenda(plan, {
      phase: options.phase || plan.phase || autonomousState.lastPhase || "wait",
      now: Date.now(),
    });
  }

  function clearBackgroundAgenda() {
    backgroundAgenda = null;
    backgroundAgendaPlan = null;
  }

  function getProtectedPlayerNameForEscort() {
    if (currentTask?.intent === "escort_player") {
      for (const step of currentTask.plan?.steps || []) {
        if (String(step?.skill || "").trim() === "escort_player") {
          const name = String(step?.args?.playerName || "").trim();
          if (name) {
            return name;
          }
        }
      }
    }
    return (
      String(passiveEscort?.playerName || "").trim() ||
      String(currentTask?.plan?.postTaskArgs?.playerName || "").trim() ||
      getBestKnownPlayerName()
    );
  }

  function getForegroundTaskPublic() {
    if (currentTask && currentTask.source !== "autonomous") {
      return publicTask(currentTask);
    }
    if (foregroundTaskState) {
      return publicTask(foregroundTaskState);
    }
    return null;
  }

  function getBackgroundTaskPublic() {
    if (currentTask?.source === "autonomous") {
      return publicTask(currentTask);
    }
    return null;
  }

  function setForegroundTaskState(task = null) {
    foregroundTaskState = task
      ? {
          ...task,
          logs: [...(task.logs || [])],
        }
      : null;
  }

  function recordTaskMemory(task, outcome = TaskState.COMPLETED) {
    if (!task) {
      return;
    }
    const memoryEntry = {
      taskId: task.taskId,
      intent: task.intent,
      goal: task.plan?.goal || "",
      userCommand: task.userCommand,
      outcome,
      finishedAt: task.finishedAt || Date.now(),
      summary: [
        task.userCommand ? `指令：${task.userCommand}` : "",
        task.plan?.goal ? `目标：${task.plan.goal}` : "",
        outcome === TaskState.COMPLETED
          ? "结果：完成"
          : task.error
            ? `结果：${task.error}`
            : `结果：${outcome}`,
      ]
        .filter(Boolean)
        .join("；"),
    };
    taskMemory = [memoryEntry, ...taskMemory].slice(0, 20);
    recordTaskLearning(task, outcome);
  }

  function flushTaskStatusBroadcast() {
    try {
      if(currentTask&&['completed','cancelled','failed'].includes(currentTask.status)
        &&currentTask.error!=='manual_disconnect'&&currentTask.errorCode!=='manual_disconnect')taskCheckpointStore.clear();
      else if(currentTask?.status==='paused'||Date.now()-lastCheckpointAt>=2000){
        if(taskCheckpointStore.save(currentTask,checkpointIdentity()))lastCheckpointAt=Date.now();
      }
    }catch(error){deps.broadcastMinecraftError?.(`任务检查点保存失败：${error.message}`);}
    lastTaskStatusBroadcastAt = Date.now();
    pendingTaskStatusBroadcastTimer = null;
    deps.broadcast({
      type: "mc_task_status",
      task: getForegroundTaskPublic() || getBackgroundTaskPublic(),
      foregroundTask: getForegroundTaskPublic(),
      backgroundTask: getBackgroundTaskPublic(),
      backgroundAgenda: publicBackgroundAgenda(),
      history: taskHistory.map(taskPublicState.publicTaskSummary).filter(Boolean),
    });
  }

  function broadcastTaskStatus(force = false) {
    if (force) {
      invalidateWorldContextCache();
      if (pendingTaskStatusBroadcastTimer) {
        clearTimeout(pendingTaskStatusBroadcastTimer);
        pendingTaskStatusBroadcastTimer = null;
      }
      flushTaskStatusBroadcast();
      return;
    }
    const elapsed = Date.now() - lastTaskStatusBroadcastAt;
    if (elapsed >= TASK_STATUS_BROADCAST_THROTTLE_MS) {
      flushTaskStatusBroadcast();
      return;
    }
    if (pendingTaskStatusBroadcastTimer) {
      return;
    }
    pendingTaskStatusBroadcastTimer = setTimeout(() => {
      flushTaskStatusBroadcast();
    }, TASK_STATUS_BROADCAST_THROTTLE_MS - elapsed);
  }

  function touchTaskActivity(task = currentTask) {
    if (!task) {
      return;
    }
    task.lastProgressAt = Date.now();
  }

  function addTaskLog(level, message) {
    if (!currentTask) {
      return;
    }
    const entry = {
      id: `log-${logCounter++}`,
      taskId: currentTask.taskId,
      level: String(level || "info"),
      message: String(message || "").trim(),
      timestamp: Date.now(),
      stepIndex: Number.isFinite(currentTask.currentStepIndex)
        ? currentTask.currentStepIndex
        : null,
    };
    touchTaskActivity(currentTask);
    currentTask.logs.push(entry);
    currentTask.logs = limitArray(currentTask.logs, 80);
    deps.broadcast({
      type: "mc_task_log",
      log: taskPublicState.publicTaskLog(entry),
    });
    broadcastTaskStatus();
  }

  function broadcastTaskEvent(eventType, extra = {}) {
    deps.broadcast({
      type: "mc_task_event",
      event: {
        eventType,
        taskId: currentTask?.taskId || extra.taskId || null,
        timestamp: Date.now(),
        ...extra,
      },
    });
  }

  function getItemCount(names = []) {
    if (!currentBot?.inventory?.items) {
      return 0;
    }
    const wanted = new Set(names.map((name) => String(name || "").trim()).filter(Boolean));
    return currentBot.inventory.items().reduce((sum, item) => {
      if (wanted.has(item.name)) {
        return sum + Number(item.count || 0);
      }
      return sum;
    }, 0);
  }

  function getItemCountByName(name) {
    return getItemCount([name]);
  }

  function getInventorySnapshot() {
    if (!currentBot?.inventory?.items) {
      return [];
    }
    return currentBot.inventory
      .items()
      .map((item) => ({
        name: item.name,
        displayName: item.displayName || item.name,
        count: Number(item.count || 0),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 32);
  }

  function getNearbyPlayers() {
    if (!currentBot?.players) {
      return [];
    }
    rememberVisiblePlayers();
    if (
      entityScanCache.nearbyPlayers &&
      Date.now() - entityScanCache.nearbyPlayersAt < ENTITY_SCAN_CACHE_MS
    ) {
      return entityScanCache.nearbyPlayers;
    }
    entityScanCache.nearbyPlayers = getCachedPlayerEntries()
      .map((player) => ({
        username: player.username,
        distance: Number(currentBot.entity.position.distanceTo(player.entity.position).toFixed(1)),
        position: {
          x: Number(player.entity.position.x.toFixed(1)),
          y: Number(player.entity.position.y.toFixed(1)),
          z: Number(player.entity.position.z.toFixed(1)),
        },
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);
    entityScanCache.nearbyPlayersAt = Date.now();
    return entityScanCache.nearbyPlayers;
  }

  function getNearbyHostiles() {
    if (!currentBot?.entities || !currentBot?.entity) {
      return [];
    }
    if (
      entityScanCache.nearbyHostiles &&
      Date.now() - entityScanCache.nearbyHostilesAt < ENTITY_SCAN_CACHE_MS
    ) {
      return entityScanCache.nearbyHostiles;
    }
    entityScanCache.nearbyHostiles = getCachedEntityList()
      .map((entity) => {
        if (!isHostileMobEntity(entity, currentBot.registry)) {
          return null;
        }
        return {
          entityId: Number(entity.id || 0),
          name: entity.name,
          displayName: entity.displayName || entity.name,
          distance: Number(currentBot.entity.position.distanceTo(entity.position).toFixed(1)),
          position: {
            x: Number(entity.position.x.toFixed(1)),
            y: Number(entity.position.y.toFixed(1)),
            z: Number(entity.position.z.toFixed(1)),
          },
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);
    entityScanCache.nearbyHostilesAt = Date.now();
    return entityScanCache.nearbyHostiles;
  }

  function getNearbyBlocks() {
    if (!currentBot?.findBlocks || !currentBot?.registry?.blocksArray) {
      return [];
    }
    return getCachedBlockQuery(
      `nearbyBlocks:${getPositionCacheKey(currentBot.entity?.position)}`,
      () => {
        const positions = currentBot.findBlocks({
          maxDistance: 16,
          count: 12,
          matching: (block) => {
            if (!block || !block.name) {
              return false;
            }
            if (block.name === "air" || block.name.includes("water") || block.name.includes("lava")) {
              return false;
            }
            return true;
          },
        });
        return positions
          .map((position) => {
            const block = currentBot.blockAt(position);
            if (!block) {
              return null;
            }
            return {
              name: block.name,
              position: {
                x: block.position.x,
                y: block.position.y,
                z: block.position.z,
              },
              distance: Number(currentBot.entity.position.distanceTo(block.position).toFixed(1)),
            };
          })
          .filter(Boolean);
      }
    );
  }

  function getNearestVisiblePlayerName() {
    if (!currentBot?.players || !currentBot?.entity) {
      return "";
    }
    const nearest = Object.values(currentBot.players)
      .filter((player) => player?.entity && player.username !== currentBot.username)
      .sort(
        (a, b) =>
          currentBot.entity.position.distanceTo(a.entity.position) -
          currentBot.entity.position.distanceTo(b.entity.position)
      )[0];
    return String(nearest?.username || "").trim();
  }

  function normalizePositionLike(value) {
    if (!value) {
      return null;
    }
    if (value.position && typeof value.position === "object") {
      return value.position;
    }
    if (
      Number.isFinite(value.x) &&
      Number.isFinite(value.y) &&
      Number.isFinite(value.z)
    ) {
      return value;
    }
    return null;
  }

  function toPlainPosition(value) {
    const position = normalizePositionLike(value);
    if (!position) {
      return null;
    }
    return {
      x: Number(position.x),
      y: Number(position.y),
      z: Number(position.z),
    };
  }

  function toVec3(value) {
    const position = toPlainPosition(value);
    if (!position) {
      return null;
    }
    return new Vec3(position.x, position.y, position.z);
  }

  function rememberVisiblePlayers() {
    if (!currentBot?.players || !currentBot?.entity) {
      return;
    }
    const now = Date.now();
    for (const player of Object.values(currentBot.players)) {
      if (!player?.entity || !player?.username || player.username === currentBot.username) {
        continue;
      }
      knownPlayers.set(player.username.toLowerCase(), {
        username: player.username,
        position: toPlainPosition(player.entity.position),
        seenAt: now,
        dimension: currentBot.game?.dimension || null,
      });
    }
    for (const [key, info] of knownPlayers.entries()) {
      if (!info || now - Number(info.seenAt || 0) > PLAYER_MEMORY_TTL_MS) {
        knownPlayers.delete(key);
      }
    }
  }

  function getTrackedPlayerInfo(preferredName = "") {
    rememberVisiblePlayers();
    const normalizedName = String(preferredName || "").trim().toLowerCase();
    if (normalizedName) {
      return knownPlayers.get(normalizedName) || null;
    }
    return (
      [...knownPlayers.values()]
        .sort((a, b) => Number(b.seenAt || 0) - Number(a.seenAt || 0))[0] || null
    );
  }

  function getBestKnownPlayerName() {
    if (typeof deps?.getPreferredPlayerName === "function") {
      return String(deps.getPreferredPlayerName() || "").trim();
    }
    return getNearestVisiblePlayerName() || String(getTrackedPlayerInfo()?.username || "").trim();
  }

  function getTimeOfDayInfo() {
    const timeOfDay = Number(currentBot?.time?.timeOfDay);
    if (!Number.isFinite(timeOfDay)) {
      return {
        timeOfDay: null,
        isNight: false,
        isLate: false,
      };
    }
    return {
      timeOfDay,
      isNight: timeOfDay >= 13000 && timeOfDay <= 23000,
      isLate: timeOfDay >= 11000 && timeOfDay <= 23999,
    };
  }

  function getInventoryEntryCount() {
    if (!currentBot?.inventory?.items) {
      return 0;
    }
    return currentBot.inventory.items().length;
  }

  function hasRecentTaskOutcome(intent = "", outcomes = [], withinMs = 15 * 60 * 1000) {
    const normalizedIntent = normalizeLearningIntent(intent);
    const wantedOutcomes = new Set(
      (Array.isArray(outcomes) ? outcomes : [outcomes]).map((item) => String(item || "").trim())
    );
    const cutoff = Date.now() - Math.max(1000, Number(withinMs) || 0);
    return taskMemory.some((entry) => {
      if (!entry) {
        return false;
      }
      if (normalizeLearningIntent(entry.intent) !== normalizedIntent) {
        return false;
      }
      if (wantedOutcomes.size && !wantedOutcomes.has(String(entry.outcome || "").trim())) {
        return false;
      }
      return Number(entry.finishedAt || 0) >= cutoff;
    });
  }

  function findPlayerTarget(preferredName = "") {
    preferredName = String(preferredName || "").trim() || getBestKnownPlayerName();
    if (typeof deps?.getPreferredPlayerName === "function" && !preferredName) {
      return null;
    }
    const entity = findPlayerEntity(preferredName);
    if (entity) {
      return {
        username: entity.username || String(preferredName || "").trim() || "玩家",
        entity,
        position: entity.position,
        source: "visible",
      };
    }
    const tracked = getTrackedPlayerInfo(preferredName);
    if (!tracked?.position) {
      return null;
    }
    return {
      username: tracked.username || String(preferredName || "").trim() || "玩家",
      entity: null,
      position: toVec3(tracked.position),
      source: "memory",
      seenAt: Number(tracked.seenAt || 0),
    };
  }

  function getPassiveEscortGoalText() {
    return formatPassiveEscortGoalText(passiveEscort);
  }

  function getAutonomousGoalText() {
    return formatAutonomousGoalText({
      currentTask,
      autonomousState,
      phaseLabels: AUTONOMOUS_PHASE_LABELS,
    });
  }

  function getDistance(a, b) {
    return distanceBetweenPositions(a, b);
  }

  function getWorldContext(forceRefresh = false) {
    if (
      !forceRefresh &&
      worldContextCache &&
      Date.now() - worldContextCacheAt < WORLD_CONTEXT_CACHE_MS
    ) {
      return worldContextCache;
    }
    if (!currentBot?.entity) {
      const brainSnapshot = brain.getSnapshot();
      worldContextCache = buildDisconnectedWorldContext({ brainSnapshot });
      worldContextCacheAt = Date.now();
      return worldContextCache;
    }
    const workAreaCenter = getCompanionWorkAreaCenter();
    const nearbyCraftingTable = findNearbyCraftingTable(12);
    const nearbyFurnace = findNearbyFurnace(12);
    const nearbyContainer = findNearbyContainer(12);
    const nearbyBed = findNearbyBed(12);
    const nearbyPortal = findNearbyNetherPortal(12);
    const foregroundTask = getForegroundTaskPublic();
    const backgroundTask = getBackgroundTaskPublic();
    const backgroundAgendaPublic = publicBackgroundAgenda();
    const effectiveAiConfig = deps.readConfig?.() || {};
    const brainSnapshot = brain.getSnapshot();
    const activeRegistryAction =
      foregroundTask?.currentRegistryAction ||
      backgroundTask?.currentRegistryAction ||
      currentTask?.currentRegistryAction ||
      brainSnapshot.currentRegistryAction ||
      null;
    const runtimeFaultSnapshot = getRuntimeFaultSnapshot();
    const botWriteSnapshot = getBotWriteSnapshot();
    const activeActionSnapshot = publicPhysicalAction();
    worldContextCache = {
      connected: true,
      players: getNearbyPlayers(),
      hostiles: getNearbyHostiles(),
      nearbyBlocks: getNearbyBlocks(),
      inventory: getInventorySnapshot(),
      self: {
        username: currentBot.username,
        health: Number.isFinite(currentBot.health) ? Number(currentBot.health) : null,
        food: Number.isFinite(currentBot.food) ? Number(currentBot.food) : null,
        dimension: currentBot.game?.dimension || null,
        position: {
          x: Number(currentBot.entity.position.x.toFixed(1)),
          y: Number(currentBot.entity.position.y.toFixed(1)),
          z: Number(currentBot.entity.position.z.toFixed(1)),
        },
      },
      currentTaskId: currentTask?.taskId || null,
      foregroundTaskId: foregroundTask?.taskId || null,
      currentGoal:
        foregroundTask?.progressText ||
        foregroundTask?.plan?.goal ||
        backgroundTask?.progressText ||
        backgroundTask?.plan?.goal ||
        backgroundAgendaPublic?.goal ||
        getPassiveEscortGoalText() ||
        getAutonomousGoalText(),
      reflex: reflexManager.getState(),
      autonomous: {
        running: autonomousState.running,
        phase: autonomousState.lastPhase || null,
        phaseLabel:
          autonomousState.lastPhase
            ? AUTONOMOUS_PHASE_LABELS[autonomousState.lastPhase] || autonomousState.lastPhase
            : null,
        nextAllowedAt: Number(autonomousState.nextAllowedAt || 0) || null,
        workAreaCenter,
        suppressedByForeground: autonomousState.suppressedByForeground === true,
        backgroundIntent: backgroundTask?.intent || backgroundAgendaPublic?.intent || null,
        backgroundPhase: backgroundAgendaPublic?.phase || null,
      },
      workArea: {
        center: workAreaCenter,
        hasCraftingTable: Boolean(nearbyCraftingTable),
        hasFurnace: Boolean(nearbyFurnace),
        hasContainer: Boolean(nearbyContainer),
        hasBed: Boolean(nearbyBed),
        hasNetherPortal: Boolean(nearbyPortal),
        torchCount: workAreaCenter ? countNearbyBlocksByNames(TORCH_BLOCK_NAMES, workAreaCenter, 6, 4) : 0,
      },
      taskTurn: currentTask
        ? {
            phase: String(currentTask.turnPhase || "").trim() || null,
            phaseLabel:
              currentTask.turnPhase && TASK_TURN_PHASE_LABELS[currentTask.turnPhase]
                ? TASK_TURN_PHASE_LABELS[currentTask.turnPhase]
                : null,
          }
        : null,
      brain: formatBrainContext(brainSnapshot),
      action: formatActionContext(
        activeRegistryAction,
        foregroundTask?.actionContractType ||
          backgroundTask?.actionContractType ||
          currentTask?.actionContractType ||
          brainSnapshot.actionContractType ||
          ""
      ),
      executor: buildExecutorContext({
        mode: getExecutorMode(),
        modeSource: runtimeExecutorMode ? runtimeExecutorModeSource : "saved",
        autonomyArmedAt,
        autonomySafeUntil,
        lastDisconnectPath,
        disconnectDetailSource: lastDisconnectDetailSource,
        lastDisconnectEventTrail: getDisconnectEventTrail(),
        runtimeFaultSnapshot,
        botWriteSnapshot,
        lastSurvivalInterruptAt,
        activeMovementSession,
        foregroundTask,
        backgroundTask,
        currentTask,
        activeActionSnapshot,
      }),
      planner: buildPlannerContext(effectiveAiConfig, {
        currentTask,
        backgroundTask,
      }),
      learning: getLearningSnapshot(),
      dragonProgression: getDragonProgressionSnapshot(),
      recentMemories: taskMemory.slice(0, 5),
    };
    worldContextCacheAt = Date.now();
    return worldContextCache;
  }

  function publicWorldContext(context, options = {}) {
    return formatPublicWorldContext(context, options);
  }

  function flushContextSnapshotBroadcast(forceRefresh = false) {
    lastContextBroadcastAt = Date.now();
    pendingContextBroadcastTimer = null;
    const survivalLightweight=Boolean(activeSurvivalInterrupt&&!activeSurvivalInterrupt.finished&&currentBot?.entity);
    const includeHeavy = !survivalLightweight &&
      (forceRefresh === true || Date.now() - lastHeavyContextBroadcastAt >= 4000);
    if (includeHeavy) {
      lastHeavyContextBroadcastAt = Date.now();
    }
    deps.broadcast({
      type: "mc_inventory_snapshot",
      inventory: getInventorySnapshot(),
    });
    deps.broadcast({
      type: "mc_world_context",
      context: publicWorldContext(survivalLightweight?{
        ...(worldContextCache||{}),connected:true,players:getNearbyPlayers(),hostiles:getNearbyHostiles(),inventory:getInventorySnapshot(),
        self:{username:currentBot.username,health:currentBot.health,food:currentBot.food,dimension:currentBot.game?.dimension||null,
          position:toPlainPosition(currentBot.entity.position)},
        currentTaskId:currentTask?.taskId||null,currentGoal:currentTask?.progressText||null,
        observationScope:"survival_lightweight",terrainObservedAt:worldContextCacheAt||null,
      }:getWorldContext(forceRefresh), {
        includeHeavy,
      }),
    });
  }

  function broadcastContextSnapshot(force = false) {
    if (force) {
      invalidateWorldContextCache();
      if (pendingContextBroadcastTimer) {
        clearTimeout(pendingContextBroadcastTimer);
        pendingContextBroadcastTimer = null;
      }
      flushContextSnapshotBroadcast(true);
      return;
    }
    const elapsed = Date.now() - lastContextBroadcastAt;
    if (elapsed >= CONTEXT_BROADCAST_THROTTLE_MS) {
      flushContextSnapshotBroadcast(false);
      return;
    }
    if (pendingContextBroadcastTimer) {
      return;
    }
    pendingContextBroadcastTimer = setTimeout(() => {
      flushContextSnapshotBroadcast(false);
    }, CONTEXT_BROADCAST_THROTTLE_MS - elapsed);
  }

  function sendSnapshot(ws) {
    if (!ws || typeof ws.send !== "function") {
      return;
    }
    ws.send(
      JSON.stringify({
        type: "mc_agent_mode",
        agentMode,
        currentTaskId: currentTask?.taskId || null,
      })
    );
    ws.send(
      JSON.stringify({
        type: "mc_task_status",
        task: getForegroundTaskPublic() || getBackgroundTaskPublic(),
        foregroundTask: getForegroundTaskPublic(),
        backgroundTask: getBackgroundTaskPublic(),
        backgroundAgenda: publicBackgroundAgenda(),
        history: taskHistory.map(taskPublicState.publicTaskSummary).filter(Boolean),
      })
    );
    ws.send(
      JSON.stringify({
        type: "mc_inventory_snapshot",
        inventory: getInventorySnapshot(),
      })
    );
    ws.send(
      JSON.stringify({
        type: "mc_world_context",
        context: publicWorldContext(getWorldContext(true), {
          includeHeavy: true,
        }),
      })
    );
  }

  function getStatusFields() {
    const foregroundTask = getForegroundTaskPublic();
    const backgroundTask = getBackgroundTaskPublic();
    const backgroundAgendaPublic = publicBackgroundAgenda();
    return buildWorldStatusFields({
      agentMode,
      currentTask,
      foregroundTask,
      backgroundTask,
      backgroundAgenda: backgroundAgendaPublic,
      passiveEscortGoalText: getPassiveEscortGoalText(),
      autonomousGoalText: getAutonomousGoalText(),
      inhibitAI: reflexManager.shouldInhibitAI(),
      activeReflex: reflexManager.getState().activeReflex,
      runtimeFaultSnapshot: getRuntimeFaultSnapshot(),
      botWriteSnapshot: getBotWriteSnapshot(),
      lastDisconnectEventTrail: getDisconnectEventTrail(),
      diagnostics: publicTaskDiagnostics(currentTask) || getLastTaskDiagnostics() || null,
    });
  }

  function setTaskProgress(text = "") {
    if (!currentTask) {
      return;
    }
    currentTask.progressText = String(text || "").trim();
    touchTaskActivity(currentTask);
    broadcastTaskStatus();
  }

  function setTaskTurnPhase(task, phase, options = {}) {
    if (!task) {
      return;
    }
    const nextPhase = String(phase || "").trim();
    if (!nextPhase) {
      return;
    }
    const changed = task.turnPhase !== nextPhase;
    task.turnPhase = nextPhase;
    if (typeof options.progressText === "string" && options.progressText.trim()) {
      task.progressText = options.progressText.trim();
    }
    touchTaskActivity(task);
    if (changed && options.logMessage) {
      addTaskLog("info", String(options.logMessage).trim());
    }
    if (changed) {
      broadcastTaskEvent("turn_phase", {
        taskId: task.taskId,
        phase: nextPhase,
        phaseLabel: TASK_TURN_PHASE_LABELS[nextPhase] || nextPhase,
      });
    }
    broadcastTaskStatus();
    broadcastContextSnapshot();
  }

  function getStepWatchdogProfile(step = {}) {
    const compiledAction =
      step?.action && typeof step.action === "object"
        ? step.action
        : actionRegistry.compileStep(step);
    const profile =
      compiledAction?.watchdog && typeof compiledAction.watchdog === "object"
        ? cloneSerializable(compiledAction.watchdog, {}) || {}
        : null;
    if (profile) {
      if (step.args?.materialSource === "self_gathered" &&
        (step.skill === "build_estate" || step.skill === "build_furnished_house_phase" && step.args?.phase === "prepare_materials")) {
        profile.hardTimeoutMs = 6 * 60 * 60 * 1000;
        profile.idleTimeoutMs = 30000;
        profile.label = "自给采料与完整建造";
      }
      if (isSelfGatheredLibraryFinish(currentTask, step)) {
        profile.hardTimeoutMs = 4 * 60 * 60 * 1000;
        profile.idleTimeoutMs = 30000;
        profile.continuous = false;
        profile.label = "自采高级屋：有限自然经验与附魔收尾";
      }
      if (step?.args?.expedition === true && getResourceLearningKey(step.args?.block) === "diamond") {
        profile.hardTimeoutMs = 2 * 60 * 60 * 1000;
        profile.idleTimeoutMs = 30000;
        profile.label = "钻石远征";
      }
      if (String(compiledAction?.actionId || "").trim() === "smelt_item") {
        profile.hardTimeoutMs = Math.max(Number(profile.hardTimeoutMs) || 120000,
          clamp(Number(step?.args?.count) || 1, 1, 32) * 12000 + 60000);
      }
      if (
        String(compiledAction?.actionId || "").trim() === "follow_player" &&
        step?.args?.once === true
      ) {
        profile.continuous = false;
        profile.label = "回位步骤";
        profile.hardTimeoutMs = Math.min(Number(profile.hardTimeoutMs || 45000) || 45000, 45000);
      }
      return profile;
    }
    return {
      idleTimeoutMs: isStrictExecutorMode() ? 15000 : 22000,
      hardTimeoutMs: 120000,
      label: "任务步骤",
      continuous: false,
    };
  }

  async function executeStepWithWatchdog(task, step, callbacks = {}) {
    const executionGeneration = getExecutionContext()?.runGeneration;
    const isCurrentRun = () => executionGeneration == null || task.executionGeneration === executionGeneration;
    const profile = getStepWatchdogProfile(step);
    const runner = async () => {
      const registryAction = setTaskRegistryAction(task, step);
      updateTaskCheckpoint(task, {
        skill: String(step?.skill || "").trim() || null,
        stepIndex: Number.isFinite(task?.currentStepIndex) ? task.currentStepIndex : null,
        registryActionId: String(registryAction?.actionId || "").trim() || null,
        actionContractType: String(registryAction?.contractType || "").trim() || null,
      });
      setTaskActionState(task, "preparing");
      if (typeof callbacks.beforePrepare === "function") {
        await callbacks.beforePrepare();
      }
      await prepareForSkillStep(step);
      checkTaskSignal();
      if (typeof callbacks.beforeExecute === "function") {
        await callbacks.beforeExecute();
      }
      setTaskActionState(task, "waiting_for_physical_signal");
      await executeSkill(step);
      checkTaskSignal();
      setTaskActionState(task, "completed");
    };
    if (!profile) {
      return runner();
    }
    const startedAt = Date.now();
    const stepContext = getExecutionContext() || {};
    const naturalXPFrame = {
      task, step, stepIndex: task.currentStepIndex, bot: currentBot, client: currentBot?._client,
      token: stepContext.token || task.cancellationToken, lease: getCurrentMovementLease(), generation: executionGeneration,
      startedAt, hardTimeoutMs: profile.hardTimeoutMs, deadline: startedAt + profile.hardTimeoutMs,
    };
    naturalXPStepWatchdogFrames.set(task, naturalXPFrame);
    const nativeMotion=step.args?.materialSource==='self_gathered'
      &&(step.skill==='build_estate'||step.skill==='build_furnished_house_phase'&&step.args?.phase==='prepare_materials')
      &&currentBot?.entity?require('./minecraft/houseTaskNativeMotion').createHouseTaskNativeMotion({
        getBot:()=>currentBot,getTask:()=>currentTask,getDefense:()=>activeSurvivalInterrupt,
        isDefenseCurrent:isSurvivalOwnerCurrent,isLeaseActive:isMovementLeaseActive},
        {...naturalXPFrame,generation:executionGeneration??task.executionGeneration}):null;
    let nativeMotionReported=false,defenseHoldReported=false;
    const startupGraceMs = profile.continuous === true
      ? Math.min(8000, Math.max(2800, Math.floor(profile.idleTimeoutMs / 2)))
      : isStrictExecutorMode()
        ? Math.min(6500, Math.max(2400, Math.floor(profile.idleTimeoutMs / 2)))
        : Math.min(6000, Math.max(2200, Math.floor(profile.idleTimeoutMs / 2)));
    let intervalId = null;
    task.watchdogAbortCode = "";
    task.watchdogAbortMessage = "";
    task.lastHeartbeatAt = Number(task.lastHeartbeatAt || 0) || null;
    intervalId = setInterval(() => {
      if (!currentTask || currentTask.taskId !== task.taskId || !isCurrentRun()) {
        clearInterval(intervalId);
        intervalId = null;
        return;
      }
      if (task.watchdogAbortMessage) {
        return;
      }
      const now = Date.now();
      const lastProgressAt = Number(task.lastProgressAt || task.startedAt || startedAt);
      const lastHeartbeatAt = Number(task.lastHeartbeatAt || 0) || 0;
      const movementObservedAt =
        profile.continuous === true ? Number(activeMovementSession?.lastObservedAt || 0) || 0 : 0;
      const nativeObservedAt=nativeMotion?.lastObservedAt()||0;
      const effectiveHeartbeatAt = Math.max(lastHeartbeatAt, movementObservedAt,nativeObservedAt);
      if(nativeObservedAt&&!nativeMotionReported){nativeMotionReported=true;
        recordTaskDiagnostic(task,'step_owned_native_motion_observed',{observedAt:nativeObservedAt,originalDeadline:naturalXPFrame.deadline,
          materialCredit:false,goalArrivalCredit:false,taskProgressWritten:false});}

      if (profile.continuous !== true && now - startedAt >= profile.hardTimeoutMs) {
        task.watchdogAbortCode = "step_timeout";
        task.watchdogAbortMessage = `${profile.label} 超时`;
        markTaskRecovery(task, "step_timeout");
        void softResetBotRuntime(`${profile.label} 长时间没有结束`, {
          closeWindow: true,
          cooldownMs: 220,
        });
        return;
      }
      if(nativeMotion?.ownedDefense()){
        if(!defenseHoldReported){defenseHoldReported=true;recordTaskDiagnostic(task,'step_watchdog_waits_owned_defense',{
          originalDeadline:naturalXPFrame.deadline,defenseDeadline:activeSurvivalInterrupt.deadline,heartbeatInvented:false});}
        return;
      }
      if (
        isStrictExecutorMode() &&
        ["waiting_for_motion", "waiting_for_physical_signal"].includes(String(task.actionState || "").trim()) &&
        !effectiveHeartbeatAt &&
        now - startedAt >= startupGraceMs
      ) {
        task.watchdogAbortCode = "executor_stalled";
        task.watchdogAbortMessage = `${profile.label} 没有真正开始动作`;
        addTaskLog("warn", `${profile.label} 迟迟没有检测到真实动作，准备重置执行器`);
        markTaskRecovery(task, "executor_stalled");
        void softResetBotRuntime(`${profile.label} 启动后没有真实动作`, {
          closeWindow: true,
          cooldownMs: 220,
        });
        return;
      }
      const heartbeatDriven = isStrictExecutorMode() || profile.continuous === true;
      const idleReferenceAt =
        heartbeatDriven && effectiveHeartbeatAt ? effectiveHeartbeatAt : lastProgressAt;
      if (now - idleReferenceAt >= profile.idleTimeoutMs) {
        task.watchdogAbortCode = heartbeatDriven ? "executor_stalled" : "step_timeout";
        task.watchdogAbortMessage = heartbeatDriven
          ? `${profile.label} 停滞：长时间没有真实动作`
          : `${profile.label} 超时：长时间没有新进展`;
        addTaskLog(
          "warn",
          heartbeatDriven
            ? `${profile.label}已经 ${Math.round((now - idleReferenceAt) / 1000)} 秒没有检测到真实动作，准备重置执行器`
            : `${profile.label}已经 ${Math.round((now - idleReferenceAt) / 1000)} 秒没有新进展，准备中断当前步骤`
        );
        markTaskRecovery(task, String(task.watchdogAbortCode || "step_timeout"));
        void softResetBotRuntime(`${profile.label} 长时间没有新进展`, {
          closeWindow: true,
          cooldownMs: 220,
        });
      }
    }, 1000);
    try {
      return await runner();
    } finally {
      nativeMotion?.close();
      if (naturalXPStepWatchdogFrames.get(task) === naturalXPFrame) naturalXPStepWatchdogFrames.delete(task);
      if (task && isCurrentRun()) {
        task.currentRegistryAction = null;
        task.actionContractType = null;
      }
      if (isCurrentRun()) brain.clearRegistryAction();
      if (intervalId) {
        clearInterval(intervalId);
      }
      if (task && isCurrentRun()) {
        task.watchdogAbortCode = "";
        task.watchdogAbortMessage = "";
      }
    }
  }

  async function emitPerceptionSignals() {
    if (!currentBot?.entity) {
      return;
    }
    const snapshot = worldQuery.createPlanningContext({
      nearbyItems: worldQuery.listNearbyItems(),
      rawWorldContext: getWorldContext(),
    });
    if (!snapshot.self?.connected) {
      return;
    }
    const signalEvents = perceptionRuleEngine.evaluate(snapshot);
    for (const event of signalEvents) {
      await eventManager.emit(event);
    }
  }

  function createRuntimeToken() {
    runtimeToken = new CancellationToken();
    return runtimeToken;
  }

  function getExecutionContext() {
    return executionContextStorage.getStore() || null;
  }

  function getActiveCancellationToken() {
    return getExecutionContext()?.token || runtimeToken || null;
  }

  function ensureBotReady() {
    if (!currentBot?.entity) {
      throw new Error("Minecraft bot 尚未完全进入世界");
    }
    return currentBot;
  }

  function ensureMovements(bot) {
    if (activeHouseSurfaceWater?.isPhysicalOwner() && (activeHouseSurfaceWater.session?.isActive()
      || activeHouseSurfaceWater.session?.isHolding() || activeHouseSurfaceWater.cleanupPending)) return;
    if (!bot.pathfinder) {
      bot.loadPlugin(pathfinder);
      appliedMovementsBot = null;
      appliedMovementsInstance = null;
    }
    if (!bot.registry?.blocksByName) {
      throw new Error("Minecraft bot 还没完成方块注册表初始化，请等待角色真正进入游戏");
    }
    const houseDefault=require('./minecraft/houseAutomaticRecovery').selfGatheredHouseWork(currentTask);
    if(defaultMovements&&defaultMovementsHouseMode!==houseDefault)defaultMovements=null;
    if (!defaultMovements) {
      defaultMovementsHouseMode=houseDefault;
      defaultMovements = new Movements(bot);
      defaultMovements.allow1by1towers = false;
      defaultMovements.allowFreeMotion = true;
      defaultMovements.allowParkour = true;
      defaultMovements.allowSprinting = true;
      defaultMovements.canOpenDoors = true;
      if(houseDefault){
        defaultMovements.canDig=false;defaultMovements.scafoldingBlocks=[];defaultMovements.allowParkour=false;
        defaultMovements.allowFreeMotion=false;defaultMovements.allowSprinting=false;defaultMovements.maxDropDown=2;
        defaultMovements.infiniteLiquidDropdownDistance=false;
      }
      // Ice can release water after a break. Generic walking cannot authorize
      // that terrain mutation; explicit resource operations have their own guard.
      for(const name of ['ice','frosted_ice']){const id=bot.registry.blocksByName[name]?.id;if(id!=null)defaultMovements.blocksCantBreak.add(id);}
    }
    const movements = getExecutionContext()?.miningMovements || defaultMovements;
    if (appliedMovementsBot === bot && appliedMovementsInstance === movements && bot.pathfinder.movements === movements) {
      return;
    }
    bot.pathfinder.setMovements(movements);
    appliedMovementsBot = bot;
    appliedMovementsInstance = movements;
  }

  function claimMovementLease(kind = "task", ownerId = "") {
    const lease = {
      token: movementLeaseCounter++,
      kind: String(kind || "task").trim() || "task",
      ownerId: String(ownerId || "").trim() || null,
    };
    activeMovementLease = lease;
    return lease;
  }

  function isMovementLeaseActive(lease) {
    return Boolean(
      lease &&
        activeMovementLease &&
        activeMovementLease.token === lease.token
    );
  }

  function ensureMovementLeaseActive(lease) {
    if (!lease) {
      return;
    }
    if (!isMovementLeaseActive(lease)) {
      throw createAbortError("movement_preempted");
    }
  }

  function releaseMovementLease(lease) {
    if (!lease) {
      return;
    }
    if (activeHouseSurfaceWater?.lease === lease && (activeHouseSurfaceWater.session?.isActive()
      || activeHouseSurfaceWater.session?.isHolding() || activeHouseSurfaceWater.cleanupPending)
      && activeHouseSurfaceWater.isPhysicalOwner()) return;
    if (isMovementLeaseActive(lease)) {
      activeMovementLease = null;
    }
  }

  const developmentRespawnInventory=require("./minecraft/developmentRespawnInventory").createDevelopmentRespawnInventory({
    getBot:()=>currentBot,getTask:()=>currentTask,
    canReconnect:()=>!activeMovementLease||activeMovementLease.kind==="task"&&
      (activeMovementLease.ownerId===currentTask?.taskId||activeMovementLease.ownerId?.startsWith(`${currentTask?.taskId}:development-`))||
      activeSurvivalInterrupt?.task===currentTask&&activeSurvivalInterrupt?.bot===currentBot&&activeMovementLease===activeSurvivalInterrupt.lease,
    reconnect:bot=>bot.quit("Refresh native respawn inventory; owned world retained"),
    record:(type,facts)=>recordTaskDiagnostic(currentTask,type,facts),
  });

  function claimDevelopmentMovementLease(kind, ownerId) {
    developmentRespawnInventory.beforeClaim(kind,ownerId);
    const frame=activeSurvivalInterrupt;
    // The retained private runner mutates token/status BEFORE invoking its
    // resource callback. Refuse its old preflight at the first control write,
    // while the exact same independently owned defense is still running.
    if(kind==="task"&&ownerId===`${currentTask?.taskId}:development-survival`
      &&frame&&!frame.finished&&frame.task===currentTask&&frame.bot===currentBot
      &&frame.client===currentBot?._client&&frame.runGeneration===currentTask?.executionGeneration
      &&isMovementLeaseActive(frame.lease)&&frame.workToken&&!frame.workToken.cancelled){
      currentTask.cancellationToken=frame.workToken;
      currentTask.status=currentTask.automaticSurvivalRecovery===true?TaskState.PAUSED:TaskState.RUNNING;
      recordTaskDiagnostic(currentTask,"development_recovery_waits_active_survival",{survivalLease:frame.lease.token,workLease:currentTask.movementLease?.token});
      throw Object.assign(Error("原自卫仍在执行，开发恢复不得替换其任务令牌和移动控制权"),{code:"house_survival_recovery_in_progress"});
    }
    return claimMovementLease(kind,ownerId);
  }

  function getCurrentMovementLease() {
    return getExecutionContext()?.movementLease || currentTask?.movementLease || null;
  }

  function observePathfinderGoal(goal, primitive = "pathfinder.setGoal", options = {}) {
    if (!currentBot?.entity) {
      return;
    }
    clearMovementMonitor();
    const action = createPhysicalAction("move", primitive, options);
    const sessionId = activeMovementSession?.id || null;
    let lastPosition = currentBot.entity.position.clone();
    let lastDistance = getDistanceToPathGoal(currentBot, goal);
    const startedAt = Date.now();
    const monitorMs = clamp(
      Number(options.monitorMs) || (options.allowStationary === true ? 30000 : 9000),
      1200,
      60000
    );
    const intervalId = setInterval(() => {
      if (!currentBot?.entity || action.cancelled) {
        clearInterval(intervalId);
        return;
      }
      const now = Date.now();
      const nextPosition = currentBot.entity.position.clone();
      const positionDelta = nextPosition.distanceTo(lastPosition);
      const nextDistance = getDistanceToPathGoal(currentBot, goal);
      const distanceDelta =
        Number.isFinite(lastDistance) && Number.isFinite(nextDistance)
          ? lastDistance - nextDistance
          : 0;
      const withinDynamicRange =
        options.allowStationary === true &&
        Number.isFinite(nextDistance) &&
        nextDistance <= getPathGoalRange(goal) + 0.75;
      const continuousStable =
        options.continuous === true &&
        withinDynamicRange &&
        activeMovementSession?.stable === true &&
        String(activeMovementSession.goalSignature || "").trim() ===
          String(options.goalSignature || activeMovementSession?.goalSignature || "").trim();
      if (positionDelta >= 0.08 || distanceDelta >= 0.15 || withinDynamicRange) {
        markMovementSessionStable({
          id: sessionId || activeMovementSession?.id || null,
          goalSignature: String(options.goalSignature || activeMovementSession?.goalSignature || "").trim() || "",
        });
        markPhysicalActionSignal(action, withinDynamicRange ? "within_goal_range" : positionDelta >= 0.08 ? "position_delta" : "distance_decreased", {
          positionDelta,
          distanceDelta,
        });
        if (action.task) {
          recordTaskHeartbeat(action.task, {
            actionState: "moving",
            checkpoint: {
              movementSessionId: sessionId || activeMovementSession?.id || null,
              movementSessionKind: activeMovementSession?.kind || null,
            },
            clearRecoveryReason: true,
          });
        }
      }
      if (continuousStable && action.task) {
        recordTaskHeartbeat(action.task, {
          actionState: "acting",
          checkpoint: {
            movementSessionId: sessionId || activeMovementSession?.id || null,
            movementSessionKind: activeMovementSession?.kind || null,
            withinRange: true,
          },
          clearRecoveryReason: true,
        });
      }
      lastPosition = nextPosition;
      if (Number.isFinite(nextDistance)) {
        lastDistance = nextDistance;
      }
      if (
        !withinDynamicRange &&
        !continuousStable &&
        !action.firstSignalAt &&
        now - startedAt >= PHYSICAL_ACTION_STARTUP_GRACE_MS
      ) {
        clearInterval(intervalId);
        void safeAsyncTick("movement_monitor_fault", () => recoverPhysicalAction(action, "executor_stalled"), {
          broadcastError: false,
        });
        if (activePhysicalAction?.id === action.id) {
          activePhysicalAction = null;
        }
        return;
      }
      if (
        !withinDynamicRange &&
        !continuousStable &&
        action.firstSignalAt &&
        now - Number(action.lastSignalAt || action.firstSignalAt) >= PHYSICAL_ACTION_STALL_MS
      ) {
        clearInterval(intervalId);
        void safeAsyncTick("movement_monitor_fault", () => recoverPhysicalAction(action, "executor_stalled"), {
          broadcastError: false,
        });
        if (activePhysicalAction?.id === action.id) {
          activePhysicalAction = null;
        }
        return;
      }
      if (options.continuous !== true && now - startedAt >= monitorMs) {
        clearInterval(intervalId);
        action.cancelled = true;
        if (activePhysicalAction?.id === action.id) {
          activePhysicalAction = null;
        }
        broadcastContextSnapshot();
        broadcastTaskStatus();
      }
    }, PHYSICAL_ACTION_SAMPLE_MS);
    activeMovementMonitor = {
      intervalId,
      sessionId,
      goalSignature: String(options.goalSignature || "").trim() || "",
    };
  }

  function setPathfinderGoal(goal, dynamic = false, lease = getCurrentMovementLease()) {
    const bot = ensureBotReady();
    ensureMovementLeaseActive(lease);
    const goalSignature = getPathGoalSignature(goal, dynamic);
    if (
      goal &&
      dynamic === true &&
      goalSignature &&
      goalSignature === lastPathfinderGoalSignature &&
      activeMovementSession?.goalSignature === goalSignature
    ) {
      touchMovementSession({
        goalSignature,
        kind: activeMovementSession?.kind || String(currentTask?.currentStep || lease?.kind || "movement"),
        lastGoalSetAt: Date.now(),
      });
      return;
    }
    ensureMovements(bot);
    ensureBotConnectionWritable("pathfinder.setGoal", {
      dynamic,
      goalType: goal?.constructor?.name || null,
      leaseKind: lease?.kind || null,
    });
    if (goal) {
      startMovementSession(String(currentTask?.currentStep || lease?.kind || "movement"), {
        ownerTaskId: currentTask?.taskId || null,
        goalSignature,
        targetLabel: goal.entity?.name || goal.constructor?.name || "goal",
      });
    } else {
      endMovementSession();
    }
    bot.pathfinder.setGoal(goal, dynamic);
    lastPathfinderMotorWriteAt = Date.now();
    touchMovementSession({
      goalSignature,
      lastGoalSetAt: Date.now(),
    });
    lastPathfinderGoalSignature = goal ? goalSignature : "";
    if (goal) {
      observePathfinderGoal(goal, "pathfinder.setGoal", {
        stageKind: "move",
        allowStationary: dynamic === true,
        continuous: dynamic === true,
        goalSignature,
      });
    }
  }

  function clearPathfinderGoal(lease = getCurrentMovementLease()) {
    const bot = ensureBotReady();
    if (!bot?.pathfinder) {
      return;
    }
    if (lease) {
      ensureMovementLeaseActive(lease);
    }
    rememberBotWrite("pathfinder.clearGoal", {
      leaseKind: lease?.kind || null,
    });
    bot.pathfinder.setGoal(null);
    lastPathfinderMotorWriteAt = Date.now();
    lastPathfinderGoalSignature = "";
    endMovementSession();
  }

  function getDistanceToPathGoal(bot, goal) {
    if (!bot?.entity || !goal) {
      return Number.POSITIVE_INFINITY;
    }
    if (goal.entity?.position) {
      return bot.entity.position.distanceTo(goal.entity.position);
    }
    const x = Number(goal.x);
    const y = Number(goal.y);
    const z = Number(goal.z);
    if ([x, y, z].every(Number.isFinite)) {
      return bot.entity.position.distanceTo(new Vec3(x, y, z));
    }
    return Number.POSITIVE_INFINITY;
  }

  function getPathGoalRange(goal) {
    const candidates = [goal?.range, goal?.distance, goal?.wantedDistance, goal?.radius];
    for (const candidate of candidates) {
      const value = Number(candidate);
      if (Number.isFinite(value) && value >= 0) {
        return value;
      }
    }
    return 2;
  }

  function getPathGoalSignature(goal, dynamic = false) {
    if (!goal) {
      return "";
    }
    if (goal.entity?.id) {
      return `entity:${goal.entity.id}:${getPathGoalRange(goal)}:${dynamic ? "d" : "s"}`;
    }
    const x = Number(goal.x);
    const y = Number(goal.y);
    const z = Number(goal.z);
    if ([x, y, z].every(Number.isFinite)) {
      return `pos:${Math.floor(x)}:${Math.floor(y)}:${Math.floor(z)}:${getPathGoalRange(goal)}:${dynamic ? "d" : "s"}`;
    }
    return `${goal.constructor?.name || "goal"}:${getPathGoalRange(goal)}:${dynamic ? "d" : "s"}`;
  }

  async function pathfinderGoto(goal, timeoutMs, timeoutLabel, lease = getCurrentMovementLease(), options = {}) {
    const executionContext = getExecutionContext();
    const bot = ensureBotReady();
    const assertLease = () => {
      try { ensureMovementLeaseActive(lease); } catch (error) {
        const interrupt = activeSurvivalInterrupt;
        if (interrupt?.previousLease === lease &&
          ((interrupt.miningMove === activeMiningNavigationMove && interrupt.miningMove?.bot === bot) ||
           (interrupt.surfaceMove === activeHouseSurfaceNavigationMove && interrupt.surfaceMove?.bot === bot) ||
           (interrupt.resourceWork === activeHouseResourceWork && interrupt.resourceWork?.bot === bot))) {
          error.survivalInterrupt = interrupt;
        }
        throw error;
      }
    };
    if (options.preserveMovements !== true) ensureMovements(bot);
    assertLease();
    ensureBotConnectionWritable("pathfinder.goto", {
      goalType: goal?.constructor?.name || null,
      leaseKind: lease?.kind || null,
    });
    const throttleWait = PATHFINDER_GOAL_MIN_INTERVAL_MS - (Date.now() - lastPathfinderMotorWriteAt);
    if (throttleWait > 0) {
      await sleep(throttleWait);
    }
    if (executionContext?.task) checkTaskSignal();
    assertLease();
    const goalSignature = getPathGoalSignature(goal, false);
    const client = bot?._client || null;
    startMovementSession(String(currentTask?.currentStep || lease?.kind || "goto"), {
      ownerTaskId: currentTask?.taskId || null,
      goalSignature,
      targetLabel: goal.entity?.name || goal.constructor?.name || "goal",
    });
    try {
      return await runPhysicalAction(
        "move",
        "pathfinder.goto",
        async (signal) => {
          const result = await runBotWritableAction(
            "pathfinder.goto",
            {
              goalType: goal?.constructor?.name || null,
              goalSignature,
              leaseKind: lease?.kind || null,
              targetLabel: goal.entity?.name || goal.constructor?.name || "goal",
            },
            async () => require('./minecraft/houseNativeGotoSettlement').settleNativeGoto({
              getBot:()=>currentBot,assertActive:()=>{assertLease();if(executionContext?.task)checkTaskSignal();
                if(currentBot!==bot||bot._client!==client)throw createAbortError('movement_preempted');
                if(options.isOwnerCurrent&&options.isOwnerCurrent()!==true)throw createAbortError('movement_preempted');},
              isExpectedStop:options.isExpectedNativeStop,allowPendingTimeout:options.isExpectedNativeTimeout,
              record:facts=>recordTaskDiagnostic(currentTask,facts.nativeTimeoutWithGoalEndpoint?'house_native_timeout_endpoint_waited':'house_native_early_partial_resolution_waited',facts),
            },{goal,deadline:Date.now()+(Number(timeoutMs)||DEFAULT_PATHFIND_TIMEOUT_MS)}),
            {
              closeWindow: false,
            }
          );
          // Installed pathfinder2.4.5 can resolve goto on an empty noPath
          // update. A resolved promise alone is never an arrival receipt.
          const controlledStop = options.isExpectedNativeStop?.() === true;
          if(!controlledStop&&typeof goal?.isEnd==="function"&&!goal.isEnd(bot.entity.position.floored())){
            throw Object.assign(new Error("原生寻路结束但实际位置未到达目标"),{name:"NoPath",code:"NoPath",actualPosition:toPlainPosition(bot.entity.position)});
          }
          signal(controlledStop ? "controlled_stop" : "goal_reached", {
            distanceDelta: 0,
            positionDelta: 0,
          });
          return result;
        },
        {
          timeoutMs: Number(timeoutMs) || DEFAULT_PATHFIND_TIMEOUT_MS,
          startupGraceMs: 2600,
          stallMs: 5500,
          getDistance: () => getDistanceToPathGoal(bot, goal),
          ...(options.isOwnerCurrent ? { isOwnerCurrent: options.isOwnerCurrent } : {}),
          ...(options.isExpectedNativeStop ? { isExpectedNativeStop: options.isExpectedNativeStop } : {}),
          ...(options.isExpectedNativeNoPath ? { isExpectedNativeNoPath: options.isExpectedNativeNoPath } : {}),
        }
      );
    } catch (error) {
      if (executionContext?.task) checkTaskSignal();
      const defenseFailure=getHouseSurfaceDefenseFailure();if(defenseFailure)throw defenseFailure;
      if (lease && !isMovementLeaseActive(lease)) {
        const preempted = createAbortError("movement_preempted"),frame=activeSurvivalInterrupt;
        const captured=frame&&frame.previousLease===lease&&frame.bot===bot&&frame.client===client
          &&frame.task===executionContext?.task&&frame.runGeneration===executionContext?.runGeneration
          &&(frame.workToken||frame.token)===executionContext?.token&&isSurvivalOwnerCurrent(frame);
        preempted.survivalInterrupt = error.survivalInterrupt || (captured?frame:null);
        throw preempted;
      }
      if (String(error?.code || "").trim() === "step_timeout") {
        const timedOut=new Error(timeoutLabel || error.message || "移动超时");
        if(options.resourceApproachTimeout===true)timedOut.code='house_resource_native_approach_timeout';
        throw timedOut;
      }
      throw error;
    } finally {
      if ((!lease || isMovementLeaseActive(lease)) &&
        (!executionContext?.task || executionContext.task.executionGeneration === executionContext.runGeneration)) {
        lastPathfinderMotorWriteAt = Date.now();
        endMovementSession();
      }
    }
  }

  function ownsSurvivalTemporaryProfile(bot,lease) {
    return [activeEmergencyShore,activeHouseRangedRetreat].some(frame=>frame?.bot===bot
      &&frame.profile===bot.pathfinder.movements&&frame.lease===lease
      &&(!frame.interrupt||frame.interrupt===activeSurvivalInterrupt));
  }

  function isSurvivalOwnerCurrent(interrupt) {
    return currentBot === interrupt.bot && currentBot?._client === interrupt.client &&
      isBotConnectionWritable() && !interrupt.token?.cancelled && !interrupt.token?.pauseRequested &&
      currentTask === interrupt.task && (!interrupt.task ||
        (interrupt.task.executionGeneration === interrupt.runGeneration &&
          (interrupt.task.status === TaskState.RUNNING||interrupt.automaticRecovery===true&&interrupt.task.status===TaskState.PAUSED
            &&interrupt.task.automaticSurvivalRecovery===true)));
  }

  async function miningPathfinderGoto(goal) {
    const bot = ensureBotReady();
    const context = getExecutionContext();
    const task = context?.task || currentTask;
    const lease = getCurrentMovementLease();
    const move = { bot, client: bot._client, task, lease,
      runGeneration: task?.executionGeneration, movements: bot.pathfinder.movements,
      from: bot.entity.position.floored(), target: new Vec3(goal.x, goal.y, goal.z),
      deadline: Date.now() + 10000 };
    activeMiningNavigationMove = move;
    const assertOwner = (recovering = false, defense = null) => {
      checkTaskSignal();
      if (currentBot !== bot || bot._client !== move.client || !isBotConnectionWritable()) {
        throw createAbortError("bot_connection_lost");
      }
      if (currentTask !== task || task?.executionGeneration !== move.runGeneration ||
        task?.movementLease !== lease || (bot.pathfinder.movements !== move.movements &&
          !(defense && !defense.finished && defense.miningMove === move && activeSurvivalInterrupt === defense
            && defense.previousLease === lease && (defense.workToken || defense.token) === context?.token
            && isSurvivalOwnerCurrent(defense) && isMovementLeaseActive(defense.lease)
            && ownsSurvivalTemporaryProfile(bot,defense.lease)))) {
        throw createAbortError("movement_preempted");
      }
      if (recovering && Number(bot.health) < 6) {
        const error = new Error("自卫后生命值过低，已停止矿道移动并保留进度");
        error.code = "mining_low_health";
        throw error;
      }
      if (Date.now() >= move.deadline) throw createAbortError("MINING_MOVEMENT_TIMEOUT");
    };
    try {
      for (let retries = 0; ; retries += 1) {
        assertOwner(retries > 0);
        try {
          if(retries===0&&!context?.pausedSurvivalOwner&&task?.materialSupply?.materialSource==='self_gathered'){
            const preflight=maybeHandleSurvivalCritical('mining_navigation_preflight');
            preflight.catch(()=>{});
            const frame=activeSurvivalInterrupt;
            if(frame&&frame.miningMove===move&&frame.previousLease===lease&&!frame.finished){
              throw Object.assign(createAbortError('movement_preempted'),{survivalInterrupt:frame});
            }
            await preflight;assertOwner();
          }
          return await pathfinderGoto(goal, Math.max(600, move.deadline - Date.now()),
            "采矿安全路线移动超时", lease, { preserveMovements: true });
        } catch (error) {
          const interrupt = error.survivalInterrupt;
          if (error.code !== "movement_preempted" || retries >= 2 || !interrupt ||
            interrupt.consumed || interrupt.miningMove !== move || interrupt.previousLease !== lease) throw error;
          interrupt.consumed = true;
          const waitDeadline = Math.min(move.deadline, Date.now() + 8000);
          while (!interrupt.finished) {
            // The interrupted work cannot apply its low-health retry gate
            // while the higher-priority defense still owns the body.
            assertOwner(false, interrupt);
            if (activeMovementLease !== interrupt.lease || Date.now() >= waitDeadline) throw error;
            await sleep(50);
          }
          assertOwner(true);
          if (interrupt.error) throw interrupt.error;
          ensureMovementLeaseActive(lease);
          if(context?.houseLocalRouteRecovery===task){
            if(bot.entity.onGround===false&&inspectSurfaceBody(bot).dry){await waitForSurfaceGround('局部开路自卫交接');assertOwner(true);}
            if(hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry&&Date.now()<context.houseLocalRouteDeadline){
              const retired=createAbortError('house_local_route_defense_relocated');
              houseLocalRouteDefenseRelocations.add(retired);throw retired;
            }
          }
          // Knockback may displace the player while self-defense owns controls.
          // Resume only inside the same checked pair of columns, on safe ground.
          let feet = bot.entity.position.floored();
          if(interrupt.rangedCover?.confirmed&&interrupt.miningRetreatThreat
            &&![move.from,move.target].some(p=>feet.x===p.x&&feet.y===p.y&&feet.z===p.z)){
            const retired=createAbortError('movement_preempted');retired.survivalInterrupt=interrupt;
            retired.observedMiningRetreat=true;throw retired;
          }
          if (task?.materialSupply?.materialSource === 'self_gathered' &&
              ![move.from, move.target].some(p => feet.x===p.x && feet.z===p.z)) {
            // Shore escape is a real displacement, not completion of the old
            // checked step. Rejoin only a freshly loaded dry original endpoint
            // using a short native no-dig path inside the ORIGINAL move budget.
            const endpoint=[move.from,move.target].find(p=>naturalWalkingFoot(bot,p));
            if(endpoint && bot.entity.position.distanceTo(endpoint)<=6 && Date.now()<move.deadline){
              const rejoinGoal=new goals.GoalBlock(endpoint.x,endpoint.y,endpoint.z);
              const native=bot.pathfinder.getPathTo(move.movements,rejoinGoal,Math.min(200,move.deadline-Date.now()));
              assertOwner(true);ensureMovementLeaseActive(lease);
              if(native.status==='success' && native.path?.length>0 && native.path.length<=8
                &&native.path.every(p=>naturalWalkingFoot(bot,new Vec3(p.x,p.y,p.z)))){
                const displaced=toPlainPosition(bot.entity.position);
                await pathfinderGoto(rejoinGoal,Math.max(1,move.deadline-Date.now()),'自卫后接回原矿道超时',lease,{preserveMovements:true});
                assertOwner(true);ensureMovementLeaseActive(lease);
                feet=bot.entity.position.floored();
                if(feet.equals(endpoint)&&hasGroundedBodySupport(bot))recordTaskDiagnostic(task,'house_mining_defense_rejoined',{
                  displaced,actual:toPlainPosition(bot.entity.position),endpoint:toPlainPosition(endpoint),originalDeadline:move.deadline,
                  originalStepCompleted:false,materialCredit:false});
              }
            }
          }
          const sameColumn = (point) => feet.x === point.x && feet.z === point.z;
          const footCell = classifyMiningBlock(bot.blockAt(feet));
          const headCell = classifyMiningBlock(bot.blockAt(feet.offset(0, 1, 0)));
          const floorCell = classifyMiningBlock(bot.blockAt(feet.offset(0, -1, 0)));
          if ((!sameColumn(move.from) && !sameColumn(move.target)) ||
            Math.abs(feet.y - move.from.y) > 1 || !footCell.passable || !headCell.passable || !floorCell.support) {
            throw createAbortError("MINING_ROUTE_CHANGED");
          }
          recordTaskHeartbeat(task, { actionState: "moving", clearRecoveryReason: true });
        }
      }
    } finally {
      if (activeMiningNavigationMove === move) activeMiningNavigationMove = null;
    }
  }

  function isHouseSurfaceDefenseCurrent(move = activeHouseSurfaceNavigationMove) {
    const interrupt = activeSurvivalInterrupt;
    return Boolean(move && !move.closed && interrupt?.surfaceMove === move && !interrupt.finished &&
      interrupt.previousLease === move.lease && isMovementLeaseActive(interrupt.lease) &&
      isSurvivalOwnerCurrent(interrupt) && (move.bot.pathfinder.movements === move.movements
        ||ownsSurvivalTemporaryProfile(move.bot,interrupt.lease)));
  }

  function getHouseSurfaceDefenseFailure(move = activeHouseSurfaceNavigationMove) {
    // A closed native movement frame cannot grant writes. It may retain only
    // its own first failure for the still-identical original execution.
    const retained=retainedHouseSurfaceDefenseFailure,context=getExecutionContext();
    if(retained?.error&&(retained.surfaceMove||retained.resourceWork||retained.miningMove)&&context?.task===retained.task&&currentTask===retained.task
      &&currentBot===retained.bot&&currentBot?._client===retained.client
      &&context.runGeneration===retained.runGeneration&&currentTask.executionGeneration===retained.runGeneration
      &&context.token===(retained.workToken||retained.token)&&currentTask.cancellationToken===context.token
      &&context.movementLease===retained.previousLease&&currentTask.movementLease===retained.previousLease
      &&!context.token?.cancelled&&!context.token?.pauseRequested&&currentTask.status===TaskState.RUNNING)
      return retained.error;
    const interrupt = move?.defenseFailure;
    // A fast failed interrupt releases its lease before the original native
    // goto settles. Keep its captured reason through that gap, never through
    // a replacement actor, task, connection, profile or user cancellation.
    return move && !move.closed && interrupt?.error && interrupt.surfaceMove === move &&
      interrupt.previousLease === move.lease && isSurvivalOwnerCurrent(interrupt) &&
      interrupt.runGeneration === move.runGeneration && (interrupt.workToken||interrupt.token) === move.token &&
      (move.task?.cancellationToken || runtimeToken) === move.token &&
      move.task?.movementLease === move.lease && move.bot.pathfinder.movements === move.movements &&
      (!activeMovementLease || activeMovementLease === interrupt.lease) ? interrupt.error : null;
  }

  async function houseSurfacePathfinderGoto(goal, timeoutMs = 20000, options = {}) {
    const bot = ensureBotReady(), context = getExecutionContext();
    const task = context?.task || currentTask, lease = getCurrentMovementLease();
    const defense = context?.pausedSurvivalOwner;
    const ownsCapturedDefense = () => Boolean(defense && activeSurvivalInterrupt===defense && !defense.finished
      && defense.bot===bot && defense.client===bot._client && defense.task===task && currentTask===task
      && defense.runGeneration===task?.executionGeneration && context?.runGeneration===defense.runGeneration
      && context.token===defense.token && lease===defense.lease && context.movementLease===lease
      && (task.movementLease===defense.previousLease || task.status===TaskState.PAUSED
        &&task.movementLease==null&&task.automaticSurvivalRecovery===true&&defense.automaticRecovery===true)
      && task.cancellationToken===defense.workToken
      && isSurvivalOwnerCurrent(defense) && isMovementLeaseActive(lease));
    const ownsTaskOrCapturedDefense = () => defense ? ownsCapturedDefense() : task?.movementLease===lease;
    context?.token?.throwIfRequested();checkTaskSignal();ensureMovementLeaseActive(lease);
    // Local recovery can leave its own movement profile installed. Re-enter
    // the caller's captured restrictions before starting the next dry leg.
    if(context?.miningMovements)ensureMovements(bot);
    const move = { bot, client: bot._client, task, lease, runGeneration: task?.executionGeneration,
      token: context?.token || getActiveCancellationToken(), movements: bot.pathfinder.movements,
      deadline: Math.min(Date.now() + timeoutMs, Number.isFinite(options.deadline) ? options.deadline : Infinity, defense?.deadline ?? Infinity), closed: false };
    if (activeHouseSurfaceNavigationMove) throw createAbortError("movement_preempted");
    activeHouseSurfaceNavigationMove = move;
    const siteAssertion = typeof context?.houseSiteSearchAssertActive === "function" ? context.houseSiteSearchAssertActive : null;
    let siteFailure = null;
    const siteScopeCurrent = () => {
      if (!siteAssertion) return true;
      try { siteAssertion(); return true; } catch (error) { siteFailure = error; return false; }
    };
    const assertOwner = (defending = false) => {
      move.token?.throwIfRequested(); checkTaskSignal();
      if (move.closed || currentBot !== bot || bot._client !== move.client || !isBotConnectionWritable() ||
          currentTask !== task || task?.executionGeneration !== move.runGeneration || !ownsTaskOrCapturedDefense() ||
          bot.pathfinder.movements !== move.movements && !(defending&&isHouseSurfaceDefenseCurrent(move))) throw createAbortError("movement_preempted");
      if (!siteScopeCurrent()) throw siteFailure;
      if (Date.now() >= move.deadline) throw createAbortError("house_surface_movement_timeout");
      if (!defending) ensureMovementLeaseActive(lease);
    };
    move.assertActive = () => assertOwner(true);
    const ownsMoveOrDefense = () => !move.closed && currentBot === bot && bot._client === move.client &&
      currentTask === task && task?.executionGeneration === move.runGeneration && ownsTaskOrCapturedDefense() &&
      !move.token?.cancelled && !move.token?.pauseRequested && (bot.pathfinder.movements === move.movements||isHouseSurfaceDefenseCurrent(move)) &&
      (isMovementLeaseActive(lease) || isHouseSurfaceDefenseCurrent(move)) && siteScopeCurrent();
    try {
      for (let retries = 0; ; retries += 1) {
        assertOwner();
        try {
          if(retries===0&&!defense&&task?.materialSupply?.materialSource==='self_gathered'){
            const preflight=maybeHandleSurvivalCritical('house_surface_preflight');
            preflight.catch(()=>{});
            const frame=activeSurvivalInterrupt;
            if(frame&&frame.surfaceMove===move&&frame.previousLease===lease&&!frame.finished){
              throw Object.assign(createAbortError('movement_preempted'),{survivalInterrupt:frame});
            }
            await preflight;assertOwner();
          }
          return await pathfinderGoto(goal, Math.max(600, move.deadline - Date.now()),
            "自给沿岸地表探索超时", lease, { preserveMovements: true, isOwnerCurrent: ownsMoveOrDefense,
              ...(typeof options.isExpectedNativeStop === "function" ? { isExpectedNativeStop: options.isExpectedNativeStop } : {}),
              ...(typeof options.isExpectedNativeNoPath === "function" ? { isExpectedNativeNoPath: options.isExpectedNativeNoPath } : {}),
              ...(typeof options.isExpectedNativeTimeout === "function" ? { isExpectedNativeTimeout: options.isExpectedNativeTimeout } : {}) });
        } catch (error) {
          if (siteFailure && currentBot === bot && bot._client === move.client && currentTask === task &&
              task?.executionGeneration === move.runGeneration && task?.movementLease === lease &&
              bot.pathfinder.movements === move.movements) throw siteFailure;
          const defenseFailure = getHouseSurfaceDefenseFailure(move);
          if (defenseFailure) throw defenseFailure;
          let interrupt = error.survivalInterrupt;
          if (error.code !== "movement_preempted" || retries >= 8 || !interrupt ||
              interrupt.surfaceMove !== move || interrupt.previousLease !== lease ||
              interrupt.consumed || !(isHouseSurfaceDefenseCurrent(move) ||
                interrupt.finished && isSurvivalOwnerCurrent(interrupt) &&
                  (isMovementLeaseActive(lease) || interrupt.error && !activeMovementLease))) throw error;
          interrupt.consumed = true;
          const waitDeadline = Math.min(move.deadline, Number.isFinite(interrupt.deadline)
            ?interrupt.deadline+250:Date.now()+(interrupt.rangedEngagement?32500:8500));
          for(let chained=0;;chained++){
            while (!interrupt.finished) {
              assertOwner(true);
              if (!isMovementLeaseActive(interrupt.lease) || Date.now() >= waitDeadline) throw error;
              await sleep(25);
            }
            if (interrupt.error) throw interrupt.error;
            if(isMovementLeaseActive(lease))break;
            const next=activeSurvivalInterrupt;
            if(chained>=7||!next||next===interrupt||next.consumed||next.surfaceMove!==move
              ||next.previousLease!==lease||!isSurvivalOwnerCurrent(next)
              ||!isMovementLeaseActive(next.lease)||next.runGeneration!==move.runGeneration
              ||next.workToken!==move.token||Date.now()>=waitDeadline)throw error;
            // A second native threat may claim defense before this awaited
            // continuation gets its turn. Drain only this exact work owner;
            // retain the original absolute movement deadline and no arrival credit.
            next.consumed=true;interrupt=next;
            recordTaskDiagnostic(task,'house_surface_chained_defense_wait',{
              chained:chained+1,originalDeadline:move.deadline,arrivalCredit:false});
          }
          assertOwner();
          if(interrupt.creeperEscape?.confirmed===true&&(options.fieldExploration===true||options.siteExploration===true)){
            const coastDeadline=Math.min(move.deadline,Date.now()+3000);
            // Native goto clears its controls before ice friction reaches zero.
            // Register the final stand only after actual no-input settling;
            // otherwise the next physics frame crosses the saved graph cell.
            while(Math.hypot(bot.entity.velocity.x,bot.entity.velocity.z)>0){
              assertOwner();
              if(Date.now()>=coastDeadline||bot.pathfinder.goal!==null
                ||['forward','back','left','right','jump','sprint','sneak'].some(k=>bot.controlState[k]!==false)
                ||!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry)
                throw Object.assign(Error('自卫后原生惯性尚未在原预算内停稳'),{code:'house_surface_defense_coast_unconfirmed'});
              await sleep(20);
            }
            assertOwner();
            recordTaskDiagnostic(task,'house_surface_defense_coast_settled',{actual:toPlainPosition(bot.entity.position),
              originalDeadline:move.deadline,velocityWritten:false,oldTargetReached:false});
          }
          const p = bot.entity.position, start = interrupt.surfacePosition;
          const shoreRecovery=interrupt.shoreRecovery?.confirmed===true&&p.distanceTo(toVec3(interrupt.shoreRecovery.actual))<=.5?interrupt.shoreRecovery:null;
          const rangedRecovery=interrupt.rangedCover?.confirmed===true?interrupt.rangedCover:interrupt.rangedEscape?.confirmed===true?interrupt.rangedEscape:interrupt.threatGoneRecovery?.confirmed===true?interrupt.threatGoneRecovery:shoreRecovery;
          const displacementLimit = rangedRecovery ? rangedRecovery.maximumDisplacement+.05 : interrupt.creeperEscape?.confirmed === true ? 12 : interrupt.meleeApproach?.confirmed === true ? interrupt.meleeApproach.maximumDisplacement+.05 : 1.75;
          const verticalLimit=rangedRecovery?rangedRecovery.maximumVerticalDisplacement+.05
            :interrupt.meleeApproach?.confirmed===true?(interrupt.meleeApproach.maximumVerticalDisplacement??1.2)+.05
            :interrupt.creeperEscape?.confirmed===true&&start&&p.y<=start.y?2.05:1.25;
          if (!start || Math.hypot(p.x - start.x, p.z - start.z) > displacementLimit || Math.abs(p.y - start.y) > verticalLimit ||
              !inspectSurfaceBody(bot).dry || !hasGroundedBodySupport(bot) || (options.foodProvisioning?bot.health<=0:bot.health<6) || bot.food < (options.foodProvisioning?0:6)) {
            throw Object.assign(new Error("自卫后未确认原地干燥落稳，保留自采路线"), { code: "house_surface_defense_unconfirmed" });
          }
          if(options.actualOriginAlignment===true&&(rangedRecovery||interrupt.creeperEscape?.confirmed===true)
            &&naturalWalkingFoot(bot,p.floored())&&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry){
            const relocated=Object.assign(Error('对齐期间自卫已落到新的真实干地，原对齐目标未到达'),{
              code:'house_origin_defense_relocated',actual:toPlainPosition(p),originalGoalReached:false,originalDeadline:move.deadline});
            houseOriginDefenseRelocations.add(relocated);throw relocated;
          }
          const transientExploration=options.siteExploration===true&&task.siteSearch?.kind==='loaded_natural_house_site_search'
            &&task.siteSearch.ownerIdentity?.taskId===task.taskId&&!task.siteSearch.reservation
            ||options.fieldExploration===true&&task.materialSupply?.materialSource==='self_gathered';
          if(transientExploration&&task?.status===TaskState.RUNNING&&task.currentStep==='build_furnished_house_phase'
            &&(interrupt.creeperEscape?.confirmed===true||shoreRecovery)&&p.distanceTo(toVec3(start))>.1&&!goal.isEnd(p.floored())){
            // A successful escape is not arrival at the threatened old goal.
            // The site graph may validate this real safe observation and pick
            // another frontier; explicit camp returns retain their old target.
            throw Object.assign(Error('选址自卫已实际撤离，保留旧目标未到达并从真实站位改选路线'),{
              code:'house_site_defense_relocated',siteDefenseRelocation:{kind:'actual_owned_site_defense_relocation',
                actual:toPlainPosition(p),from:{...start},nativeShoreRecovery:Boolean(shoreRecovery),
                maximumDisplacement:shoreRecovery?16.1:12.05,maximumVerticalDisplacement:shoreRecovery?8.05:2.05,originalGoal:{x:goal.x,y:goal.y,z:goal.z},
                originalDeadline:move.deadline,observedAt:Date.now(),arrivalConfirmed:true,oldTargetReached:false}});
          }
          recordTaskDiagnostic(task, "house_surface_self_defense_resumed", {
            goal: { x: goal.x, y: goal.y, z: goal.z }, retry: retries + 1,
            position: { x: p.x, y: p.y, z: p.z }, originalDeadline: move.deadline });
        }
      }
    } finally {
      move.closed = true;
      if (activeHouseSurfaceNavigationMove === move) activeHouseSurfaceNavigationMove = null;
    }
  }

  async function physicalEquip(item, destination = "hand", label = "") {
    const bot = ensureBotReady();
    return runPhysicalAction(
      "act",
      "bot.equip",
      async (signal) => {
        const result = await runBotWritableAction(
          "bot.equip",
          {
            itemName: item?.name || null,
            destination,
          },
          async () => bot.equip(item, destination)
        );
        signal("equipment_changed");
        return result;
      },
      {
        timeoutMs: DEFAULT_EQUIP_TIMEOUT_MS,
        startupGraceMs: 1200,
        stallMs: 3000,
        stageKind: "prepare",
      }
    ).catch((error) => {
      if (String(error?.code || "").trim() === "step_timeout") {
        throw new Error(`切换到 ${label || item?.displayName || item?.name || "目标物品"} 超时`);
      }
      throw error;
    });
  }

  async function physicalCraft(recipe, count = 1, craftingTableBlock = null, label = "") {
    const bot = ensureBotReady();
    const beforeCount = getItemCountByName(label);
    return runPhysicalAction(
      "act",
      "bot.craft",
      async (signal) => {
        const result = await runBotWritableAction(
          "bot.craft",
          {
            itemName: label || null,
            count,
          },
          async () => require("./minecraft/nativeWindowActivation").withNativeWindowActivation(bot,()=>bot.craft(recipe, count, craftingTableBlock || null))
        );
        signal("inventory_changed", {
          distanceDelta: Number.isFinite(beforeCount) ? Math.max(0, getItemCountByName(label) - beforeCount) : 0,
        });
        return result;
      },
      {
        timeoutMs: 12000,
        startupGraceMs: 1800,
        stallMs: 4500,
        stageKind: "prepare",
      }
    );
  }

  function houseResourcePositionExcluded(position) {
    if (!position) return false;
    const context = getExecutionContext();
    const clearance=context?.houseCampVegetationClear;
    if(clearance&&clearance.bot===currentBot&&clearance.task===currentTask&&clearance.generation===currentTask?.executionGeneration
      &&clearance.position.x===position.x&&clearance.position.y===position.y&&clearance.position.z===position.z){
      const b=currentBot.blockAt(toVec3(position));
      if(require("./minecraft/houseSelfSupplyRuntime").isCampReplaceablePlant(b)||["air","cave_air","void_air"].includes(b?.name))return false;
    }
    const construction = (context?.houseResourceExclusionBounds || []).some((bounds) =>
      position.x >= bounds.minX && position.x <= bounds.maxX && position.y >= bounds.minY && position.y <= bounds.maxY &&
      position.z >= bounds.minZ && position.z <= bounds.maxZ);
    const ownerTask=context?.task||currentTask;
    const ownPreparationCover=context?.houseSelfSupply&&ownerTask?.stepCheckpoint?.furnishedHouse?.phase==="prepare_materials"
      &&ownerTask.materialSupply?.defensiveCover?.placed?.some(spec=>spec.position.x===position.x&&spec.position.y===position.y&&spec.position.z===position.z
        &&matchesFurnishedHouseBlock(ensureBotReady().blockAt(toVec3(position)),spec));
    if (construction&&!ownPreparationCover) return true;
    if (!context?.houseSelfSupply) return false;
    const task = context.task || currentTask;
    if(task?.materialSupply?.campRepairs?.some(p=>p.position?.x===position.x&&p.position.y===position.y&&p.position.z===position.z))return true;
    if(task?.materialSupply?.retiredCamps?.some(entry=>[
      ...Object.values(entry.ownedStations||{}),...(entry.storage?.chests||[])
    ].some(p=>p.position?.x===position.x&&p.position.y===position.y&&p.position.z===position.z)))return true;
    if (getNaturalXPProtectedPositions(task?.materialSupply?.naturalXPHost).some(p => p.x === position.x && p.y === position.y && p.z === position.z)) return true;
    return Object.values(task?.materialSupply?.surfaceGraphs || {}).some(graph =>
      getSurfaceGraphProtectedPositions(graph).some(p => p.x === position.x && p.y === position.y && p.z === position.z));
  }

  function assertHouseResourceDigAllowed(position) {
    if(getExecutionContext()?.houseSelfSupply&&position&&['ice','frosted_ice'].includes(currentBot?.blockAt(toVec3(position))?.name))
      throw Object.assign(Error('自然建房通路不能破坏会释放水的冰面'),{code:'house_resource_ice_opening',position:toPlainPosition(position)});
    if (houseResourcePositionExcluded(position)) {
      throw Object.assign(new Error("建房补料不能破坏房屋、营地或已记录的地表运输支撑"), {
        code: "house_resource_protected", position: toPlainPosition(position) });
    }
  }

  async function physicalDigBlock(block, label = "") {
    const bot = ensureBotReady();
    const targetPos = block?.position?.clone?.() || null;
    const beforeName = String(block?.name || "").trim();
    assertHouseResourceDigAllowed(targetPos);
    if (getExecutionContext()?.houseSelfSupply) {
      const context = getExecutionContext(), task = context.task || currentTask;
      const owner = { bot, client: bot._client, task, generation: task?.executionGeneration,
        lease: getCurrentMovementLease(), token: context.token || getActiveCancellationToken() };
      const isOwnerCurrent = () => currentBot === bot && bot._client === owner.client && currentTask === task
        && task?.executionGeneration === owner.generation && task?.movementLease === owner.lease
        && isMovementLeaseActive(owner.lease) && !owner.token?.cancelled && !owner.token?.pauseRequested;
      const assertOwner = () => {
        owner.token?.throwIfRequested(); checkTaskSignal();
        if (!isOwnerCurrent()) throw createAbortError("movement_preempted");
        ensureBotConnectionWritable("bot.dig.house");
      };
      const session = createHouseNativeDigSession({ getBot: () => currentBot, captureOwner: () => owner,
        assertOwner, isOwnerCurrent, isOwnerContext: () => getExecutionContext() === context,
        abortOwner: error => {
          if (isOwnerCurrent()) {
            task.watchdogAbortCode = error.code; task.watchdogAbortMessage = error.message; owner.token?.pause?.();
          }
        },
        runPhysicalAction: (kind, primitive, operation, options) => runPhysicalAction(kind, primitive,
          signal => runBotWritableAction(primitive, { blockName: beforeName, position: toPlainPosition(targetPos) }, () => operation(signal)), options),
      });
      return session.dig(block, { assertActive: assertOwner, beforeSend: () => assertHouseResourceDigAllowed(targetPos),
        forceLook: true, timeoutMs: DEFAULT_DIG_TIMEOUT_MS });
    }
    return runPhysicalAction(
      "act",
      "bot.dig",
      async (signal) => {
        const result = await runBotWritableAction(
          "bot.dig",
          {
            blockName: beforeName || null,
            position: targetPos ? toPlainPosition(targetPos) : null,
          },
          async () => { assertHouseResourceDigAllowed(targetPos); return bot.dig(block, true); }
        );
        const after = targetPos ? bot.blockAt(targetPos) : null;
        if (!after || String(after.name || "").trim() !== beforeName) {
          signal("block_changed");
        } else {
          signal("dig_completed");
        }
        return result;
      },
      {
        timeoutMs: DEFAULT_DIG_TIMEOUT_MS,
        startupGraceMs: 1600,
        stallMs: 5000,
        stageKind: isWoodBlockName(beforeName) ? "gather" : "gather",
      }
    ).catch((error) => {
      if (String(error?.code || "").trim() === "step_timeout") {
        throw new Error(`挖掘 ${label || block?.displayName || block?.name || "方块"} 超时`);
      }
      throw error;
    });
  }

  async function physicalPlaceBlock(anchorBlock, faceVector, targetPos = null, itemName = "", options = {}) {
    const bot = ensureBotReady();
    const beforeName = targetPos ? String(bot.blockAt(targetPos)?.name || "").trim() : "";
    const placementTask = currentTask;
    const placementContext = getExecutionContext();
    const placementToken = getActiveCancellationToken();
    const previousSneak = bot.getControlState?.("sneak") ?? bot.controlState?.sneak ?? false;
    const previousWindow = bot.currentWindow;
    try {
      return await runPhysicalAction(
        "act",
        "bot.placeBlock",
        async (signal) => {
          const result = await runBotWritableAction(
            "bot.placeBlock",
            {
              itemName: itemName || null,
              position: targetPos ? toPlainPosition(targetPos) : null,
            },
            async () => {
              // Secondary use places against interactive anchors (workbenches,
              // furnaces, chests) rather than opening their window. Mineflayer
              // sends the version-correct sneak input synchronously, before the
              // subsequent look/use packets on this same ordered connection.
              if (options.isOwnerCurrent && options.isOwnerCurrent() !== true) throw createAbortError("movement_preempted");
              bot.setControlState?.("sneak", true);
              checkTaskSignal();
              if (options.yaw != null) {
                // A forced look only mutates Mineflayer's local angle. Wait
                // for native physics to send the rotation before the ordered
                // placement packet, whose direction the server calculates.
                await bot.look(options.yaw, Number(options.pitch) || 0, false);
                // look() returns immediately for an unchanged local angle,
                // including one set by a prior forced look. One native tick
                // also flushes that pending rotation before block placement.
                if (bot.waitForTicks) await bot.waitForTicks(1);
                checkTaskSignal();
              }
              const placed = await (options.placementOptions
                ? bot._placeBlockWithOptions(anchorBlock, faceVector, options.placementOptions)
                : bot.placeBlock(anchorBlock, faceVector));
              options.onPlaced?.();
              return placed;
            }
          );
          const afterName = targetPos ? String(bot.blockAt(targetPos)?.name || "").trim() : "";
          if (!targetPos || afterName !== beforeName) {
            signal("block_changed");
          }
          return result;
        },
        {
          timeoutMs: DEFAULT_EQUIP_TIMEOUT_MS,
          startupGraceMs: 1300,
          stallMs: 4200,
          stageKind: "build",
          isOwnerCurrent: options.isOwnerCurrent,
        }
      ).catch((error) => {
        if (String(error?.code || "").trim() === "step_timeout") {
          throw new Error(`摆放 ${itemName || "方块"} 超时`);
        }
        throw error;
      });
    } finally {
      const sameExecution = currentBot === bot && currentTask === placementTask &&
        (placementContext?.runGeneration == null ||
          placementContext.task?.executionGeneration === placementContext.runGeneration);
      if (sameExecution && (!options.isOwnerCurrent || options.isOwnerCurrent() === true)) {
        const interrupted = placementToken?.cancelled || placementToken?.pauseRequested ||
          [TaskState.PAUSED, TaskState.CANCELLED].includes(placementTask?.status);
        try {
          bot.setControlState?.("sneak", interrupted ? false : previousSneak);
        } catch (_) {}
        if (bot.currentWindow && bot.currentWindow !== previousWindow) {
          try {
            bot.closeWindow?.(bot.currentWindow);
          } catch (_) {}
        }
      }
    }
  }

  async function physicalOpenContainer(block, label = "容器") {
    const bot = ensureBotReady();
    return runPhysicalAction(
      "act",
      "bot.openContainer",
      async (signal) => {
        const opened = await runBotWritableAction(
          "bot.openContainer",
          {
            label,
            position: block?.position ? toPlainPosition(block.position) : null,
          },
          async () => require("./minecraft/nativeWindowActivation").withNativeWindowActivation(bot,()=>bot.openContainer(block))
        );
        signal("window_opened");
        return opened;
      },
      {
        timeoutMs: DEFAULT_CONTAINER_TIMEOUT_MS,
        startupGraceMs: 1600,
        stallMs: 4200,
        stageKind: "prepare",
      }
    ).catch((error) => {
      if (String(error?.code || "").trim() === "step_timeout") {
        throw new Error(`打开${label}超时`);
      }
      throw error;
    });
  }

  async function physicalOpenFurnace(block) {
    const bot = ensureBotReady();
    return runPhysicalAction(
      "act",
      "bot.openFurnace",
      async (signal) => {
        const opened = await runBotWritableAction(
          "bot.openFurnace",
          {
            position: block?.position ? toPlainPosition(block.position) : null,
          },
          async () => require("./minecraft/nativeWindowActivation").withNativeWindowActivation(bot,()=>bot.openFurnace(block))
        );
        signal("window_opened");
        return opened;
      },
      {
        timeoutMs: DEFAULT_CONTAINER_TIMEOUT_MS,
        startupGraceMs: 1600,
        stallMs: 4200,
        stageKind: "prepare",
      }
    );
  }

  async function physicalAttack(target, label = "") {
    const bot = ensureBotReady();
    const requestedAt=Date.now();
    if(currentTask?.materialSupply?.materialSource==='self_gathered'&&!WEAPON_ITEM_PRIORITY.includes(bot.heldItem?.name)){
      const replacement=findUsableCombatWeapon();
      if(replacement){
        await equipBestWeapon();checkTaskSignal();
        if(!WEAPON_ITEM_PRIORITY.includes(bot.heldItem?.name))throw Object.assign(Error('备用武器尚未实际拿到手上'),{code:'house_combat_weapon_unconfirmed'});
        const wait=meleeAttackReadyAt(combatMemory.lastOwnAttackAt,bot.heldItem.name)-Date.now();
        if(wait>0){await sleep(wait);checkTaskSignal();}
        recordTaskDiagnostic(currentTask,'house_combat_weapon_replaced',{weapon:bot.heldItem.name,unarmedAttackSent:false});
      }
    }
    const action = createPhysicalAction("act", "bot.attack", {
      stageKind: "combat",
    });
    try {
      await runBotWritableAction(
        "bot.attack",
        {
          targetName: label || target?.name || null,
          targetId: target?.id || target?.entityId || null,
        },
        () => {combatMemory.lastOwnAttackTargetId=target?.id;combatMemory.lastOwnAttackAt=Date.now();return bot.attack(target);}
      );
      markPhysicalActionSignal(action, "attack_sent", {
        distanceDelta: target?.position ? Math.max(0, 4.5 - bot.entity.position.distanceTo(target.position)) : 0,
      });
      if(currentTask?.materialSupply?.materialSource==="self_gathered")recordTaskDiagnostic(currentTask,"house_defense_attack_sent",{
        targetId:target?.id,targetName:target?.name,weapon:bot.heldItem?.name||null,
        distance:target?.position?bot.entity.position.distanceTo(target.position):null,health:bot.health,
        requestedAt,sentAt:combatMemory.lastOwnAttackAt,prepareMs:combatMemory.lastOwnAttackAt-requestedAt,
        publishMs:Date.now()-combatMemory.lastOwnAttackAt});
    } catch (error) {
      if (getExecutionContext()?.task) checkTaskSignal();
      void safeAsyncTick("combat_interrupt_fault", () => recoverPhysicalAction(action, "attack_failed"), {
        broadcastError: false,
      });
      throw error;
    } finally {
      action.cancelled = true;
      if (activePhysicalAction?.id === action.id) {
        activePhysicalAction = null;
      }
    }
    return true;
  }

  async function safeBotLookAt(target, force = true, context = {}) {
    const bot = ensureBotReady();
    return runBotWritableAction("bot.lookAt", context, async () => bot.lookAt(target, force));
  }

  async function safeBotActivateBlock(block, faceVector = null, context = {}) {
    const bot = ensureBotReady();
    return runBotWritableAction("bot.activateBlock", context, async () => {
      if (faceVector) {
        return bot.activateBlock(block, faceVector);
      }
      return bot.activateBlock(block);
    });
  }

  async function safeBotSetControlState(control, state, context = {}) {
    const bot = ensureBotReady();
    return runBotWritableAction(
      "bot.setControlState",
      {
        control: String(control || "").trim() || null,
        state: state === true,
        ...context,
      },
      () => bot.setControlState(control, state)
    );
  }

  async function physicalActivateItem(label = "使用物品") {
    const bot = ensureBotReady();
    return runPhysicalAction(
      "act",
      "bot.activateItem",
      async (signal) => {
        const result = await runBotWritableAction(
          "bot.activateItem",
          {
            label,
          },
          async () => bot.activateItem()
        );
        signal("item_activated");
        return result;
      },
      {
        timeoutMs: DEFAULT_EQUIP_TIMEOUT_MS,
        startupGraceMs: 1200,
        stallMs: 3500,
        stageKind: "prepare",
      }
    ).catch((error) => {
      if (String(error?.code || "").trim() === "step_timeout") {
        throw new Error(`${label}超时`);
      }
      throw error;
    });
  }

  function physicalConsume(label = "食物", expectedName) {
    checkTaskSignal();
    const bot=ensureBotReady(),context=getExecutionContext(),task=context?.task||currentTask;
    const expected=expectedName||bot.heldItem?.name,token=getActiveCancellationToken(),lease=getCurrentMovementLease();
    ensureMovementLeaseActive(lease);
    const previous=foodConsumptionFlights.get(bot);
    if(previous){
      if(previous.client===bot._client&&previous.task===task&&previous.generation===task?.executionGeneration
        &&previous.token===token&&previous.lease===lease&&previous.expected===expected){
        if(previous.finished&&!previous.nativeSettled)return previous.nativeSettlement.then(()=>physicalConsume(label,expected));
        return previous.promise;
      }
      throw Object.assign(Error('当前客户端已有另一归属的进食动作，保留食物并等待重新观察'),{code:'food_consumption_busy'});
    }
    const flight={client:bot._client,task,generation:task?.executionGeneration,token,lease,expected,promise:null,finished:false,nativeSettled:true,nativeSettlement:Promise.resolve()};
    foodConsumptionFlights.set(bot,flight);
    flight.promise=physicalConsumeOnce(label,expected,flight).finally(()=>{
      flight.finished=true;
      if(flight.nativeSettled&&foodConsumptionFlights.get(bot)===flight)foodConsumptionFlights.delete(bot);
    });
    return flight.promise;
  }
  async function physicalConsumeOnce(label = "食物", expectedName, flight) {
    const bot = ensureBotReady();
    const expected=expectedName||bot.heldItem?.name;
    if(!expected||!bot.registry.foodsByName?.[expected])throw Object.assign(Error('进食前没有确认食物'),{code:'food_hand_changed'});
    for(let retry=0;retry<2;retry++){
      checkTaskSignal();
      if(bot.heldItem?.name!==expected)await equipInventoryItem(findInventoryItem([expected]),'hand',label);
      await sleep(100);checkTaskSignal();
      if(bot.heldItem?.name===expected)break;
    }
    return runPhysicalAction(
      "act",
      "bot.consume",
      async (signal) => {
        const previousFood = Number(bot.food);
        const previousCount=bot.inventory.items().filter(i=>i.name===expected).reduce((n,i)=>n+i.count,0);
        if(previousCount<=0)throw Object.assign(Error('进食前食物已不在实际背包中'),{code:'food_hand_changed'});
        if (!Number.isFinite(previousFood)) throw new Error("无法确认当前饥饿值，已停止食用");
        const result = await runBotWritableAction("bot.consume", { label, itemName: bot.heldItem?.name },
          async () => {
            checkTaskSignal();
            if(bot.heldItem?.name!==expected)throw Object.assign(Error('进食被装备切换打断，保留食物'),{code:'food_hand_changed'});
            if(flight)ensureMovementLeaseActive(flight.lease);
            const native=bot.consume();
            if(flight){
              flight.nativeSettled=false;
              // A canceled physical wrapper does not imply that Mineflayer's
              // original eating task settled. Fence native calls independently.
              const settled=()=>{flight.nativeSettled=true;if(flight.finished&&foodConsumptionFlights.get(bot)===flight)foodConsumptionFlights.delete(bot);};
              flight.nativeSettlement=Promise.resolve(native).then(settled,settled);
            }
            return native;
          });
        // Mineflayer also resolves consume() on heldItemChanged/set_cooldown.
        // A late equip-slot acknowledgement can therefore resolve in milliseconds,
        // while Vanilla still needs its normal eating duration. Keep the same use
        // action alive until the server's update_health actually raises food.
        const deadline = Date.now() + 4000;
        while (true) {
          checkTaskSignal();
          if (currentBot !== bot || !isBotConnectionWritable()) throw createAbortError("bot_connection_lost");
          const actualCount=bot.inventory.items().filter(i=>i.name===expected).reduce((n,i)=>n+i.count,0);
          if (bot.food > previousFood&&actualCount<previousCount) break;
          if (Date.now() >= deadline) {
            throw new Error("食用后没有确认饥饿值恢复，已停止重复消耗食物");
          }
          await sleep(50);
        }
        signal("item_consumed");
        return result;
      },
      {
        timeoutMs: DEFAULT_EQUIP_TIMEOUT_MS,
        startupGraceMs: 1400,
        stallMs: 4500,
        stageKind: "prepare",
      }
    ).catch((error) => {
      if (String(error?.code || "").trim() === "step_timeout") {
        throw new Error(`食用 ${label} 超时`);
      }
      throw error;
    });
  }

  function stopBotActions(options = {}) {
    if (!currentBot) {
      return;
    }
    if (activeHouseSurfaceWater?.isPhysicalOwner() && (activeHouseSurfaceWater.session?.isActive()
      || activeHouseSurfaceWater.session?.isHolding() || activeHouseSurfaceWater.cleanupPending)) {
      // A blocked retreat keeps only its captured safety controls. A different
      // actor revokes that identity and remains free to take over normally.
      activeHouseSurfaceWater.session.requestCancel(String(options.reason || "water_runtime_reset")); return;
    }
    if (activePhysicalAction) {
      activePhysicalAction.cancelled = true;
      activePhysicalAction.recoveryReason = String(options.reason || "runtime_reset").trim() || "runtime_reset";
      activePhysicalAction.survivalInterrupt = options.survivalInterrupt || null;
      activePhysicalAction = null;
    }
    try {
      // setGoal(null) cancels immediately. Pathfinder.stop() is deferred until
      // a path node is reached; calling it while idle leaves a stop request
      // which aborts the next gathering trip after a craft or soft reset.
      currentBot.pathfinder?.setGoal(null);
      lastPathfinderGoalSignature = "";
    } catch (_) {}
    endMovementSession();
    try {
      currentBot.clearControlStates?.();
    } catch (_) {}
    try {
      currentBot.stopDigging?.();
    } catch (_) {}
    try {
      if(!options.preserveOffhandShield)currentBot.deactivateItem?.();
    } catch (_) {}
    if (options.closeWindow && currentBot.currentWindow) {
      try {
        currentBot.closeWindow(currentBot.currentWindow);
      } catch (_) {}
    }
    if (options.invalidateCaches) {
      invalidateScanCaches();
      invalidateWorldContextCache();
    }
  }

  function softResetDedupeBucket(reasonKey) {
    const s = String(reasonKey || "");
    if (/超时|timeout/i.test(s)) {
      return "timeout";
    }
    if (
      /停滞|stall|卡住|不动|真实动作|没有新进展|没有结束|没有真正动作|启动后没有|没有检测到真实动作|长时间没有/i.test(s)
    ) {
      return "stall";
    }
    return "";
  }

  async function softResetBotRuntime(reason = "", options = {}) {
    if (!currentBot) {
      return false;
    }
    const message = String(reason || "").trim();
    const now = Date.now();
    const reasonKey = message.slice(0, 80);
    const bucket = softResetDedupeBucket(reasonKey);
    const prevBucket = softResetDedupeBucket(lastSoftResetReasonKey);
    if (bucket && bucket === prevBucket && lastSoftResetAt > 0 && now - lastSoftResetAt < 280) {
      await sleep(clamp(Number(options.cooldownMs) || 180, 60, 400) * 0.35);
      lastSoftResetAt = Date.now();
      return true;
    }
    lastSoftResetAt = now;
    lastSoftResetReasonKey = reasonKey;
    if (message && currentTask) {
      addTaskLog("warn", `${message}，我先做一次软重置再继续。`);
    }
    stopBotActions({
      closeWindow: options.closeWindow !== false,
      invalidateCaches: true,
    });
    if (currentBot?.entity) {
      try {
        defaultMovements = null;
        appliedMovementsBot = null;
        appliedMovementsInstance = null;
        ensureMovements(currentBot);
      } catch (_) {}
    }
    await sleep(clamp(Number(options.cooldownMs) || 180, 80, 800));
    return true;
  }

  function clearPassiveEscort(options = {}) {
    const shouldStopBot = options.stopBot === true;
    passiveEscortSessionCounter += 1;
    releaseMovementLease(passiveEscort?.movementLease);
    passiveEscort = null;
    if (shouldStopBot && !currentTask) {
      stopBotActions();
    }
    broadcastContextSnapshot();
    broadcastTaskStatus();
  }

  function activatePassiveEscort(args = {}) {
    const playerName =
      String(args.playerName || "").trim() || getBestKnownPlayerName();
    if (!playerName) {
      return false;
    }
    passiveEscort = {
      sessionId: passiveEscortSessionCounter++,
      movementLease: claimMovementLease("passive_escort", playerName),
      playerName,
      distance: clamp(Number(args.distance) || 3, 2, 6),
      hostileRadius: clamp(Number(args.hostileRadius) || 12, 8, 18),
      leashDistance: clamp(Number(args.leashDistance) || 12, 6, 24),
      lastHostileName: "",
      running: false,
    };
    broadcastContextSnapshot();
    broadcastTaskStatus();
    return true;
  }

  function isPassiveEscortSessionActive(sessionId) {
    return Boolean(
      !currentTask &&
        passiveEscort &&
        passiveEscort.sessionId === sessionId
    );
  }

  async function tickIdleBehavior() {
    const recovering=currentTask;
    if(recovering?.status===TaskState.PAUSED&&recovering.automaticWorkRecovery?.enabled){
      const bot=currentBot,recovery=recovering.automaticWorkRecovery;
      const foreignLease=activeMovementLease&&!(activeMovementLease.kind==='task'&&activeMovementLease.ownerId===recovering.taskId)
        &&!(activeSurvivalInterrupt?.task===recovering&&activeSurvivalInterrupt.lease===activeMovementLease);
      const threatPresent=bot&&nearbyHouseResourceThreats(bot).some(e=>!terrainSeparatedHouseMelee(bot,e)
        &&e.position.distanceTo(bot.entity.position)<=(e.name==='creeper'?8.5:isHouseRangedThreatEntity(e)?24:4.5))||Boolean(bot&&findHouseRangedThreat(bot));
      const decision=require('./minecraft/houseAutomaticRecovery').houseRecoveryDecision(recovery,{
        now:Date.now(),ownerCurrent:Boolean(bot?.entity&&currentTask===recovering&&!foreignLease),
        health:bot?.health||0,food:bot?.food||0,grounded:Boolean(bot?.entity&&hasGroundedBodySupport(bot)),
        dry:Boolean(bot?.entity&&inspectSurfaceBody(bot).dry),goalActive:Boolean(bot?.pathfinder?.goal||activeSurvivalInterrupt),
        controlsActive:Object.values(bot?.controlState||{}).some(Boolean),threatPresent,
        carriedEmergencyMeal:Boolean(bot&&selectBootstrapFood(bot.inventory.items(),{health:bot.health,food:bot.food})),
        provisionInOriginalTask:recovering.currentStep==='build_furnished_house_phase'
          &&recovering.plan?.steps?.[recovering.currentStepIndex]?.args?.phase==='prepare_materials'
          &&recovering.materialSupply?.materialSource==='self_gathered'});
      if(decision==='expired'||decision==='foreign'){
        recovery.enabled=false;recordTaskDiagnostic(recovering,'house_automatic_recovery_closed',{decision,attempts:recovery.attempts});broadcastTaskStatus(true);
      }else if(decision==='ready'||decision==='provision'){
        recovery.enabled=false;recovery.attempts++;
        recordTaskDiagnostic(recovering,'house_automatic_original_task_resume',{attempt:recovery.attempts,taskId:recovering.taskId,
          actual:toPlainPosition(bot.entity.position),nativeSafetyReconfirmed:true,
          nextAction:decision==='provision'?'natural_nutrition_recovery':'original_work'});
        await handleMessage({type:'mc_command_resume'});return;
      }
    }
    if (await maybeHandleSurvivalCritical("idle_tick")) {
      autonomousState.nextAllowedAt = Date.now() + 2500;
      return;
    }
    const foregroundCooldownMs =
      foregroundTaskState && foregroundTaskState.source !== "autonomous"
        ? ["failed", "blocked", "cancelled"].includes(String(foregroundTaskState.status || "").trim())
          ? 15000
          : String(foregroundTaskState.status || "").trim() === "completed"
            ? 6000
            : 0
        : 0;
    const foregroundRecentlyEnded =
      foregroundCooldownMs > 0 &&
      Date.now() - Number(foregroundTaskState?.finishedAt || 0) < foregroundCooldownMs;
    if (!currentBot?.entity || currentTask) {
      autonomousState.suppressedByForeground = Boolean(
        currentTask && currentTask.source !== "autonomous"
      );
      return;
    }
    if (foregroundRecentlyEnded) {
      autonomousState.suppressedByForeground = true;
      return;
    }
    autonomousState.suppressedByForeground = false;
    await emitPerceptionSignals();
    if (reflexManager.shouldInhibitAI()) {
      broadcastContextSnapshot();
      return;
    }
    if (currentTask || !currentBot?.entity) {
      return;
    }
    if (!passiveEscort) {
      // DeskPet permits host AI planning without arming spontaneous world changes.
      if (deps.allowAutonomousMaintenance?.() === false) return;
      if (autonomousState.running || Date.now() < Number(autonomousState.nextAllowedAt || 0)) {
        return;
      }
      if (getExecutorMode() === "experimental-autonomy" && Date.now() < Number(autonomySafeUntil || 0)) {
        autonomousState.lastPhase = "wait";
        autonomousState.lastDecisionAt = Date.now();
        autonomousState.nextAllowedAt = Number(autonomySafeUntil || 0);
        broadcastContextSnapshot();
        broadcastTaskStatus();
        return;
      }
      if (getExecutorMode() === "experimental-autonomy" && !isAutonomyExecutionHealthy()) {
        autonomousState.lastPhase = "wait";
        autonomousState.lastDecisionAt = Date.now();
        autonomousState.nextAllowedAt = Date.now() + 2500;
        broadcastContextSnapshot();
        broadcastTaskStatus();
        return;
      }
      const queuedAgendaIsFresh = isBackgroundAgendaFresh(backgroundAgenda, backgroundAgendaPlan, {
        now: Date.now(),
        maxAgeMs: 3 * 60 * 1000,
      });
      if (queuedAgendaIsFresh) {
        if (isStrictExecutorMode()) {
          autonomousState.lastPhase =
            String(backgroundAgenda?.phase || autonomousState.lastPhase || "wait").trim() || "wait";
          autonomousState.lastDecisionAt = Date.now();
          autonomousState.nextAllowedAt = Date.now() + 4000;
          broadcastContextSnapshot();
          return;
        }
        if (submitAutonomousPlan(backgroundAgendaPlan, { reuseAgenda: true })) {
          autonomousState.nextAllowedAt = Date.now() + 7000;
          return;
        }
      }
      const plan = buildAutonomousMaintenancePlan();
      if (!plan) {
        clearBackgroundAgenda();
        autonomousState.lastPhase = "wait";
        autonomousState.lastDecisionAt = Date.now();
        autonomousState.nextAllowedAt = Date.now() + 4000;
        return;
      }
      rememberBackgroundAgenda(plan, {
        phase: plan.phase || autonomousState.lastPhase || "wait",
      });
      if (isStrictExecutorMode()) {
        autonomousState.lastPhase = String(plan.phase || autonomousState.lastPhase || "wait").trim() || "wait";
        autonomousState.lastDecisionAt = Date.now();
        autonomousState.nextAllowedAt = Date.now() + 4000;
        broadcastContextSnapshot();
        broadcastTaskStatus();
        return;
      }
      submitAutonomousPlan(plan);
      autonomousState.nextAllowedAt = Date.now() + 7000;
      return;
    }
    if (passiveEscort.running) {
      return;
    }
    passiveEscort.running = true;
    const escortSessionId = passiveEscort.sessionId;
    try {
      const bot = ensureBotReady();
      ensureMovements(bot);
      const target = findPlayerTarget(passiveEscort.playerName);
      if (!target?.position) {
        passiveEscort.lastHostileName = "";
        return;
      }
      const rendezvous = getPlayerRendezvousPosition(target);
      if (!rendezvous) {
        passiveEscort.lastHostileName = "";
        return;
      }
      passiveEscort.playerName = target.username || passiveEscort.playerName;
      const playerDistance = target.entity
        ? getDistance(bot.entity.position, target.position)
        : getHorizontalDistance(bot.entity.position, rendezvous);
      const hostile = target.entity
        ? findPriorityEscortHostile(target.entity, {
            searchRadius: passiveEscort.hostileRadius,
            maxBotDistance: Math.max(
              passiveEscort.leashDistance + 10,
              playerDistance + passiveEscort.hostileRadius + 4
            ),
          })
        : null;
      if (!isPassiveEscortSessionActive(escortSessionId)) {
        return;
      }
      if (hostile) {
        passiveEscort.lastHostileName = hostile.displayName || hostile.name || "敌对生物";
        if (playerDistance > passiveEscort.leashDistance && getDistance(bot.entity.position, hostile.position) > 4) {
          if (!isPassiveEscortSessionActive(escortSessionId)) {
            return;
          }
          setPathfinderGoal(
            new goals.GoalNear(
              rendezvous.x,
              rendezvous.y,
              rendezvous.z,
              passiveEscort.distance
            ),
            true,
            passiveEscort.movementLease
          );
          return;
        }
        await equipBestWeapon();
        if (!isPassiveEscortSessionActive(escortSessionId)) {
          return;
        }
        const hostileDistance = bot.entity.position.distanceTo(hostile.position);
        if (hostileDistance > 3.8) {
          const followGoal = new goals.GoalFollow(hostile, 2);
          if (shouldRefreshContinuousGoal(followGoal, true)) {
            setPathfinderGoal(followGoal, true, passiveEscort.movementLease);
          } else {
            touchMovementSession({
              goalSignature: getPathGoalSignature(followGoal, true),
              kind: "passive_escort",
            });
          }
        } else {
          markMovementSessionStable({
            kind: "passive_escort",
          });
        }
        if (bot.entity.position.distanceTo(hostile.position) <= 4.5) {
          try {
            await safeBotLookAt(hostile.position.offset(0, hostile.height || 1, 0), true, {
              targetName: hostile?.name || null,
              reason: "self_defense",
            });
          } catch (_) {}
          if (!isPassiveEscortSessionActive(escortSessionId)) {
            return;
          }
          await physicalAttack(hostile, hostile.displayName || hostile.name);
        }
      } else {
        passiveEscort.lastHostileName = "";
        if (playerDistance > passiveEscort.distance + 1) {
          if (!isPassiveEscortSessionActive(escortSessionId)) {
            return;
          }
          const followGoal = target.entity
            ? new goals.GoalFollow(target.entity, passiveEscort.distance)
            : new goals.GoalNear(
                rendezvous.x,
                rendezvous.y,
                rendezvous.z,
                Math.max(1, passiveEscort.distance - 1)
              );
          if (shouldRefreshContinuousGoal(followGoal, true)) {
            setPathfinderGoal(followGoal, true, passiveEscort.movementLease);
          } else {
            touchMovementSession({
              goalSignature: getPathGoalSignature(followGoal, true),
              kind: "passive_escort",
            });
          }
        } else {
          if (!isPassiveEscortSessionActive(escortSessionId)) {
            return;
          }
          markMovementSessionStable({
            kind: "passive_escort",
          });
        }
      }
      broadcastContextSnapshot();
    } catch (_) {
      // Passive escort is best-effort; task execution remains the authoritative path for hard failures.
    } finally {
      if (passiveEscort) {
        passiveEscort.running = false;
      }
    }
  }

  async function cancelCurrentTask(reason = "cancelled", nextStatus = "cancelled") {
    if(currentTask){currentTask.automaticSurvivalRecovery=false;if(currentTask.automaticWorkRecovery)currentTask.automaticWorkRecovery.enabled=false;}
    if (!currentTask) {
      // Completed escort tasks can leave a passive companion running without a foreground task.
      clearPassiveEscort({ stopBot: true });
      runtimeToken?.cancel?.("cancelled");
      await softResetBotRuntime("停止陪伴时清理执行残留", {
        closeWindow: true,
        cooldownMs: 180,
      });
      if (currentTask) return;
      clearBackgroundAgenda();
      autonomousState.running = false;
      autonomousState.suppressedByForeground = false;
      autonomousState.nextAllowedAt = Date.now() + 5000;
      setAgentMode("idle");
      broadcastTaskStatus(true);
      broadcastContextSnapshot();
      return;
    }
    const cancelledTask = currentTask;
    let preserveForeignWaterActor = false;
    currentTask.status = nextStatus;
    if (activeHouseSurfaceWater?.task === cancelledTask) {
      runtimeToken?.cancel?.(nextStatus === "cancelled" ? "cancelled" : reason);
      const outcome = await settleHouseSurfaceWater(cancelledTask, "cancelled");
      if (currentTask !== cancelledTask) return;
      preserveForeignWaterActor = outcome.foreignLease || !outcome.capturedTaskCurrent;
      if (!preserveForeignWaterActor && (outcome.holding || !outcome.actualDry)) {
        markHouseWaterPausePending(cancelledTask, true); return;
      }
    }
    currentTask.executionGeneration = Number(currentTask.executionGeneration || 0) + 1;
    currentTask.planningGeneration = Number(currentTask.planningGeneration || 0) + 1;
    const wasAutonomous = currentTask.source === "autonomous";
    clearPassiveEscort();
    if (runtimeToken) {
      runtimeToken.cancel(nextStatus === "cancelled" ? "cancelled" : reason);
    }
    releaseMovementLease(currentTask.movementLease);
    if (!preserveForeignWaterActor) {
      await softResetBotRuntime("停止当前任务时清理执行残留", {
        closeWindow: true,
        cooldownMs: 180,
      });
    }
    if (currentTask?.taskId !== cancelledTask.taskId) return;
    currentTask.status = nextStatus;
    currentTask.error = reason === "cancelled" ? "" : reason;
    currentTask.errorCode = nextStatus === "paused" ? "paused" : reason === "cancelled" ? "cancelled" : "manual_stop";
    setTaskTurnPhase(currentTask, nextStatus === "paused" ? "paused" : "failed", {
      progressText:
        nextStatus === "paused" ? "任务已暂停" : nextStatus === "cancelled" ? "任务已取消" : reason,
    });
    currentTask.finishedAt = Date.now();
    addTaskLog(nextStatus === "paused" ? "warn" : "info", currentTask.progressText);
    if (nextStatus !== TaskState.PAUSED && nextStatus !== "paused") {
      recordTaskMemory(currentTask, nextStatus || TaskState.CANCELLED);
    }
    taskHistory = [...limitArray(taskHistory, 19), { ...currentTask, logs: [...currentTask.logs] }];
    if (currentTask.source !== "autonomous") {
      setForegroundTaskState(currentTask);
    } else {
      clearBackgroundAgenda();
    }
    currentTask = null;
    autonomousState.running = false;
    autonomousState.suppressedByForeground = false;
    autonomousState.nextAllowedAt = Date.now() + (wasAutonomous ? 5000 : 5000);
    setAgentMode("idle");
    broadcastTaskStatus();
    broadcastContextSnapshot();
    scheduleIdleTransportFlush();
  }

  async function pauseCurrentTask() {
    const stoppingAutomaticRecovery=currentTask?.status===TaskState.PAUSED&&currentTask.automaticSurvivalRecovery===true;
    if(currentTask){currentTask.automaticSurvivalRecovery=false;if(currentTask.automaticWorkRecovery)currentTask.automaticWorkRecovery.enabled=false;}
    if (!currentTask || ![TaskState.RUNNING, TaskState.PLANNING].includes(currentTask.status)&&!stoppingAutomaticRecovery) {
      return false;
    }
    const pausedTask = currentTask;
    const wasPlanning = currentTask.status === TaskState.PLANNING;
    currentTask.status = TaskState.PAUSED;
    if (activeHouseSurfaceWater?.task === pausedTask) {
      runtimeToken?.pause?.();
      const outcome = await settleHouseSurfaceWater(pausedTask, "paused");
      if (currentTask !== pausedTask) return true;
      if (outcome.foreignLease || !outcome.capturedTaskCurrent) {
        setTaskTurnPhase(pausedTask, "paused", { progressText: "任务已暂停" });
        broadcastTaskStatus(true); return true;
      }
      if (outcome.holding || !outcome.actualDry) {
        markHouseWaterPausePending(pausedTask, false); return true;
      }
    }
    currentTask.executionGeneration = Number(currentTask.executionGeneration || 0) + 1;
    if (wasPlanning) {
      currentTask.planningPaused = true;
      currentTask.planningGeneration = Number(currentTask.planningGeneration || 0) + 1;
    }
    clearPassiveEscort();
    if (runtimeToken) {
      runtimeToken.pause();
    }
    releaseMovementLease(currentTask.movementLease);
    autonomousState.running = false;
    autonomousState.suppressedByForeground = true;
    autonomousState.nextAllowedAt = Date.now() + 6000;
    if (!wasPlanning) {
      await softResetBotRuntime("暂停当前任务时清理执行残留", {
        closeWindow: true,
        cooldownMs: 160,
      });
    }
    if (currentTask?.taskId !== pausedTask.taskId) return true;
    currentTask.status = TaskState.PAUSED;
    setTaskTurnPhase(currentTask, "paused", {
      progressText: "任务已暂停",
    });
    addTaskLog("warn", "任务已暂停");
    setAgentMode(TaskState.PAUSED);
    if (currentTask.source !== "autonomous") {
      setForegroundTaskState(currentTask);
    } else {
      clearBackgroundAgenda();
    }
    broadcastTaskStatus(true);
    broadcastContextSnapshot();
    return true;
  }

  function findPlayerEntity(preferredName = "") {
    const bot = ensureBotReady();
    rememberVisiblePlayers();
    const normalizedName = String(preferredName || "").trim().toLowerCase();
    if (normalizedName) {
      const preferred = Object.values(bot.players).find((player) => {
        return (
          player?.username &&
          player.username.toLowerCase() === normalizedName &&
          player.entity
        );
      });
      if (preferred?.entity) {
        return preferred.entity;
      }
      // An explicit owner who is out of view is not interchangeable with a nearby stranger.
      return null;
    }
    const nearest = Object.values(bot.players)
      .filter((player) => player?.entity && player.username !== bot.username)
      .sort(
        (a, b) =>
          bot.entity.position.distanceTo(a.entity.position) -
          bot.entity.position.distanceTo(b.entity.position)
      )[0];
    return nearest?.entity || null;
  }

  function getHostilePriority(name = "") {
    return Number.isFinite(HOSTILE_PRIORITY[name]) ? HOSTILE_PRIORITY[name] : 3;
  }

  function isHostileEntityRelevant(entity, anchorEntity = null, options = {}) {
    const bot = ensureBotReady();
    const origin = anchorEntity?.position || bot.entity.position;
    if (!entity || entity === bot.entity || !isThreateningMobEntity(entity, bot.registry)) {
      return false;
    }
    const maxDistance = clamp(Number(options.maxDistance) || 12, 4, 32);
    const maxBotDistance = clamp(
      Number(options.maxBotDistance) || maxDistance + 4,
      4,
      40
    );
    const anchorDistance = getDistance(origin, entity.position);
    if (anchorDistance > maxDistance) {
      return false;
    }
    const botDistance = getDistance(bot.entity.position, entity.position);
    if (botDistance > maxBotDistance) {
      return false;
    }
    const verticalDelta = Math.abs((origin?.y || 0) - entity.position.y);
    if (verticalDelta > 5) {
      return false;
    }
    return true;
  }

  function scoreHostileEntity(entity, anchorEntity = null, options = {}) {
    const bot = ensureBotReady();
    const origin = anchorEntity?.position || bot.entity.position;
    const anchorDistance = getDistance(origin, entity.position);
    const botDistance = getDistance(bot.entity.position, entity.position);
    const verticalPenalty = Math.abs((origin?.y || 0) - entity.position.y) * 6;
    const typePriority = getHostilePriority(entity.name) * 100;
    const protectEntity = options.protectEntity || null;
    const protectDistance = protectEntity?.position
      ? getDistance(protectEntity.position, entity.position)
      : anchorDistance;
    const threatBonus =
      (entity.name === "creeper" ? -40 : 0) +
      (["skeleton", "stray", "blaze", "witch"].includes(entity.name) ? -18 : 0) +
      (protectDistance <= 2.5 ? -120 : protectDistance <= 4.5 ? -56 : protectDistance <= 7 ? -20 : 0) +
      (botDistance <= 2.5 ? -42 : botDistance <= 4.5 ? -18 : 0);
    const protectBias = options.protectEntity ? protectDistance * 18 : anchorDistance * 4;
    return typePriority + protectBias + botDistance * 3 + verticalPenalty + threatBonus;
  }

  function findPriorityEscortHostile(protectEntity = null, options = {}) {
    if (!protectEntity?.position) {
      return null;
    }
    const bot = ensureBotReady();
    const searchRadius = clamp(Number(options.searchRadius) || 14, 6, 24);
    const maxBotDistance = clamp(
      Number(options.maxBotDistance) || Math.max(searchRadius + 8, getDistance(bot.entity.position, protectEntity.position) + 8),
      8,
      40
    );
    return findHostileEntity(protectEntity, searchRadius, {
      protectEntity,
      maxBotDistance,
    });
  }

  function findHostileEntity(anchorEntity = null, maxDistance = 12, options = {}) {
    return getCachedEntityList()
      .filter((entity) =>
        isHostileEntityRelevant(entity, anchorEntity, {
          ...options,
          maxDistance,
        })
      )
      .sort(
        (a, b) =>
          scoreHostileEntity(a, anchorEntity, options) -
          scoreHostileEntity(b, anchorEntity, options)
      )[0];
  }

  function findSpecificHostileEntity(names = [], anchorEntity = null, maxDistance = 12, options = {}) {
    const wanted = new Set(
      (Array.isArray(names) ? names : [names]).map((name) => String(name || "").trim()).filter(Boolean)
    );
    if (!wanted.size) {
      return null;
    }
    return getCachedEntityList()
      .filter(
        (entity) =>
          wanted.has(String(entity?.name || "").trim()) &&
          isHostileEntityRelevant(entity, anchorEntity, {
            ...options,
            maxDistance,
          })
      )
      .sort(
        (a, b) =>
          scoreHostileEntity(a, anchorEntity, options) -
          scoreHostileEntity(b, anchorEntity, options)
      )[0] || null;
  }

  function findNearestEntityByNames(names = [], maxDistance = 24, options = {}) {
    const bot = ensureBotReady();
    const wanted = new Set(
      (Array.isArray(names) ? names : [names]).map((name) => String(name || "").trim()).filter(Boolean)
    );
    if (!wanted.size) {
      return null;
    }
    const origin = options.origin?.position || options.origin || bot.entity?.position;
    return (
      getCachedEntityList()
        .filter((entity) => {
          if (!wanted.has(String(entity.name || "").trim())) {
            return false;
          }
          return getDistance(origin, entity.position) <= clamp(Number(maxDistance) || 24, 2, 128);
        })
        .sort(
          (a, b) =>
            getDistance(origin, a.position) - getDistance(origin, b.position)
        )[0] || null
    );
  }

  function getAliasSpec(name) {
    const normalized = String(name || "").trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    return (
      RESOURCE_ALIASES[normalized] || {
        blocks: [normalized],
        items: [normalized],
      }
    );
  }

  function findInventoryItem(names = []) {
    const bot = ensureBotReady();
    const wanted = new Set(names.map((name) => String(name || "").trim()).filter(Boolean));
    return (
      bot.inventory
        .items()
        .find((item) => wanted.has(item.name)) || null
    );
  }

  function getRegistryItem(name) {
    const bot = ensureBotReady();
    return bot.registry?.itemsByName?.[String(name || "").trim()] || null;
  }

  function findNearestInfrastructureLocally(names = [], maxDistance = 16) {
    return findNearestBlockByNames(names, maxDistance);
  }

  function findNearestBlockByNamesAround(centerPosition = null, names = [], horizontalRadius = 16, verticalRange = 6) {
    const bot = ensureBotReady();
    const center = toPlainPosition(centerPosition);
    const wanted = new Set(names.map((name) => String(name || "").trim()).filter(Boolean));
    if (!center || !wanted.size) {
      return null;
    }
    const baseX = Math.floor(center.x);
    const baseY = Math.floor(center.y);
    const baseZ = Math.floor(center.z);
    const radius = clamp(Number(horizontalRadius) || 16, 4, 32);
    const vertical = clamp(Number(verticalRange) || 6, 2, 12);
    const cacheKey = `nearestAround:${baseX},${baseY},${baseZ}:${radius}:${vertical}:${[...wanted].sort().join(",")}`;
    return getCachedBlockQuery(cacheKey, () => {
      let best = null;
      let bestScore = Number.POSITIVE_INFINITY;
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          for (let dy = vertical; dy >= -vertical; dy -= 1) {
            const position = new Vec3(baseX + dx, baseY + dy, baseZ + dz);
            const block = bot.blockAt(position);
            if (!block?.name || !wanted.has(block.name)) {
              continue;
            }
            const horizontalPenalty = getHorizontalDistance(position, center);
            const verticalPenalty = Math.abs(dy) * 2;
            const botPenalty = getHorizontalDistance(position, bot.entity?.position || center);
            const score = horizontalPenalty * 5 + verticalPenalty + botPenalty;
            if (score < bestScore) {
              best = block;
              bestScore = score;
            }
          }
        }
      }
      return best;
    });
  }

  function findCompanionInfrastructureBlock(names = [], maxDistance = 16) {
    const local = findNearestInfrastructureLocally(names, maxDistance);
    if (local) {
      return local;
    }
    const workAreaCenter = getCompanionWorkAreaCenter({ maxDistance: 12 });
    if (!workAreaCenter) {
      return null;
    }
    return findNearestBlockByNamesAround(
      workAreaCenter,
      names,
      Math.max(16, Number(maxDistance) || 16),
      6
    );
  }

  function findNearbyCraftingTable(maxDistance = 12) {
    return findCompanionInfrastructureBlock(["crafting_table"], maxDistance);
  }

  function findNearbyFurnace(maxDistance = 12) {
    return findCompanionInfrastructureBlock(FURNACE_BLOCK_NAMES, maxDistance);
  }

  function findNearbyContainer(maxDistance = 16) {
    return findCompanionInfrastructureBlock(CONTAINER_BLOCK_NAMES, maxDistance);
  }

  function findNearbyNetherPortal(maxDistance = 16) {
    return findCompanionInfrastructureBlock(NETHER_PORTAL_BLOCK_NAMES, maxDistance);
  }

  function findNearbyNetherFortressBlock(maxDistance = 48) {
    const bot = ensureBotReady();
    const local = bot.findBlock({
      maxDistance: clamp(Number(maxDistance) || 48, 8, 96),
      matching: (block) => Boolean(block?.name && NETHER_FORTRESS_BLOCK_NAMES.includes(block.name)),
    });
    if (local) {
      return local;
    }
    const workAreaCenter = getCompanionWorkAreaCenter({ maxDistance: 20 });
    return workAreaCenter
      ? findNearestBlockByNamesAround(
          workAreaCenter,
          NETHER_FORTRESS_BLOCK_NAMES,
          Math.max(24, Number(maxDistance) || 48),
          12
        )
      : null;
  }

  function findNearbyStrongholdBlock(maxDistance = 64) {
    const bot = ensureBotReady();
    const local = bot.findBlock({
      maxDistance: clamp(Number(maxDistance) || 64, 8, 128),
      matching: (block) => Boolean(block?.name && STRONGHOLD_BLOCK_NAMES.includes(block.name)),
    });
    if (local) {
      return local;
    }
    return findNearestBlockByNamesAround(
      toPlainPosition(bot.entity?.position),
      STRONGHOLD_BLOCK_NAMES,
      Math.max(24, Number(maxDistance) || 64),
      16
    );
  }

  function findNearbyEndPortalFrame(maxDistance = 64) {
    const bot = ensureBotReady();
    const local = bot.findBlock({
      maxDistance: clamp(Number(maxDistance) || 64, 8, 128),
      matching: (block) => Boolean(block?.name && END_PORTAL_FRAME_BLOCK_NAMES.includes(block.name)),
    });
    if (local) {
      return local;
    }
    return findNearestBlockByNamesAround(
      toPlainPosition(bot.entity?.position),
      END_PORTAL_FRAME_BLOCK_NAMES,
      Math.max(24, Number(maxDistance) || 64),
      16
    );
  }

  function findNearbyEndPortalBlock(maxDistance = 32) {
    const bot = ensureBotReady();
    const local = bot.findBlock({
      maxDistance: clamp(Number(maxDistance) || 32, 4, 96),
      matching: (block) => Boolean(block?.name && END_PORTAL_BLOCK_NAMES.includes(block.name)),
    });
    if (local) {
      return local;
    }
    return findNearestBlockByNamesAround(
      toPlainPosition(bot.entity?.position),
      END_PORTAL_BLOCK_NAMES,
      Math.max(16, Number(maxDistance) || 32),
      12
    );
  }

  function getNearbyEndPortalFrameStats(maxDistance = 48) {
    const bot = ensureBotReady();
    const normalizedDistance = clamp(Number(maxDistance) || 48, 8, 96);
    const cacheKey = `endPortalFrameStats:${getPositionCacheKey(bot.entity?.position)}:${normalizedDistance}`;
    return getCachedBlockQuery(cacheKey, () => {
      const positions = bot.findBlocks({
        maxDistance: normalizedDistance,
        count: 24,
        matching: (block) => Boolean(block?.name && END_PORTAL_FRAME_BLOCK_NAMES.includes(block.name)),
      });
      const frames = positions
        .map((position) => bot.blockAt(position))
        .filter((block) => block && END_PORTAL_FRAME_BLOCK_NAMES.includes(block.name));
      const frameEntries = frames
        .map((frame) => {
          const eyeProperty = getBlockPropertyValue(frame, "eye");
          const hasEye = eyeProperty === true || eyeProperty === "true" || Number(eyeProperty) === 1;
          return {
            frame,
            hasEye,
          };
        })
        .sort(
          (a, b) =>
            bot.entity.position.distanceTo(a.frame.position) -
            bot.entity.position.distanceTo(b.frame.position)
        );
      return {
        total: frameEntries.length,
        filled: frameEntries.filter((entry) => entry.hasEye).length,
        emptyFrames: frameEntries.filter((entry) => !entry.hasEye).map((entry) => entry.frame),
        allFrames: frameEntries.map((entry) => entry.frame),
      };
    });
  }

  function findNearbyEndCrystal(maxDistance = 48) {
    return findNearestEntityByNames(["end_crystal"], maxDistance);
  }

  function findNearbyEnderDragon(maxDistance = 96) {
    return findNearestEntityByNames(["ender_dragon"], maxDistance);
  }

  function getEndCrystalWindowState(options = {}) {
    const bot = ensureBotReady();
    const crystals = Object.values(bot.entities || {})
      .filter((entity) => {
        if (!entity || entity === bot.entity || !entity.position) {
          return false;
        }
        return String(entity.name || "").trim() === "end_crystal";
      })
      .sort((a, b) => {
        const aHorizontal = getHorizontalDistance(bot.entity.position, a.position);
        const bHorizontal = getHorizontalDistance(bot.entity.position, b.position);
        const aVertical = Math.abs(Number(a.position.y) - Number(bot.entity.position.y));
        const bVertical = Math.abs(Number(b.position.y) - Number(bot.entity.position.y));
        return aVertical * 4 + aHorizontal - (bVertical * 4 + bHorizontal);
      });
    const crystal = crystals.find(
      (entity) => getDistance(bot.entity.position, entity.position) <= clamp(Number(options.maxDistance) || 48, 4, 128)
    );
    if (!crystal) {
      return {
        visible: false,
        attackable: false,
        horizontalDistance: null,
        verticalGap: null,
        crystal: null,
      };
    }
    const horizontalDistance = getHorizontalDistance(bot.entity.position, crystal.position);
    const verticalGap = Math.abs(Number(crystal.position.y) - Number(bot.entity.position.y));
    const attackable =
      horizontalDistance <= clamp(Number(options.maxHorizontalDistance) || 12, 4, 32) &&
      verticalGap <= clamp(Number(options.maxVerticalGap) || 8, 2, 20);
    return {
      visible: true,
      attackable,
      horizontalDistance,
      verticalGap,
      crystal,
    };
  }

  function getEndCrystalApproachTarget(options = {}) {
    const crystalWindow = getEndCrystalWindowState({
      maxDistance: Number(options.maxDistance) || 64,
      maxHorizontalDistance: Number(options.maxHorizontalDistance) || 12,
      maxVerticalGap: Number(options.maxVerticalGap) || 8,
    });
    if (!crystalWindow.visible || !crystalWindow.crystal?.position) {
      return null;
    }
    const standable =
      getNearbyStandablePosition(crystalWindow.crystal.position, {
        horizontalRadius: 4,
        upwardSearch: 8,
        downwardSearch: 12,
      }) || toPlainPosition(crystalWindow.crystal.position);
    if (!standable) {
      return null;
    }
    return {
      x: Number(standable.x.toFixed(1)),
      y: Number(standable.y.toFixed(1)),
      z: Number(standable.z.toFixed(1)),
      horizontalDistance: crystalWindow.horizontalDistance,
      verticalGap: crystalWindow.verticalGap,
    };
  }

  function findEndFightSafeAnchor(maxDistance = 24) {
    const bot = ensureBotReady();
    const candidates = findNearestBlocksByNames(
      END_SAFE_SURFACE_BLOCK_NAMES,
      clamp(Number(maxDistance) || 24, 6, 64),
      24
    );
    for (const block of candidates) {
      const standable = getNearbyStandablePosition(block.position, {
        horizontalRadius: 3,
        upwardSearch: 6,
        downwardSearch: 10,
      });
      if (!standable) {
        continue;
      }
      return {
        x: Number(standable.x.toFixed(1)),
        y: Number(standable.y.toFixed(1)),
        z: Number(standable.z.toFixed(1)),
        blockName: block.name,
      };
    }
    return null;
  }

  function findEndVictoryMarker(maxDistance = 64) {
    const bot = ensureBotReady();
    if (!String(bot.game?.dimension || "").includes("the_end")) {
      return null;
    }
    const marker = findNearestBlockByNames(END_VICTORY_BLOCK_NAMES, clamp(Number(maxDistance) || 64, 8, 128));
    if (marker) {
      return marker;
    }
    return findNearestBlockByNamesAround(
      toPlainPosition(bot.entity?.position),
      END_VICTORY_BLOCK_NAMES,
      Math.max(24, Number(maxDistance) || 64),
      20
    );
  }

  function isEndFightPositionUnsafe(options = {}) {
    const bot = ensureBotReady();
    if (!String(bot.game?.dimension || "").includes("the_end")) {
      return false;
    }
    const currentPos = bot.entity?.position;
    if (!currentPos) {
      return true;
    }
    if (Number(currentPos.y) <= clamp(Number(options.minY) || 45, 20, 80)) {
      return true;
    }
    const belowBlock = bot.blockAt(currentPos.offset(0, -1, 0));
    if (!belowBlock?.name || !END_SAFE_SURFACE_BLOCK_NAMES.includes(belowBlock.name)) {
      return true;
    }
    const safeAnchor = findEndFightSafeAnchor(Number(options.maxDistance) || 16);
    if (!safeAnchor) {
      return true;
    }
    return getHorizontalDistance(currentPos, safeAnchor) > clamp(Number(options.maxSafeDistance) || 8, 3, 20);
  }

  function getEnderDragonWindowState(options = {}) {
    const bot = ensureBotReady();
    const dragon = findNearbyEnderDragon(Number(options.maxDistance) || 128);
    if (!dragon?.position || !bot.entity?.position) {
      return {
        visible: false,
        attackable: false,
        horizontalDistance: null,
        verticalGap: null,
        dragon: null,
      };
    }
    const horizontalDistance = getHorizontalDistance(bot.entity.position, dragon.position);
    const verticalGap = Math.abs(Number(dragon.position.y) - Number(bot.entity.position.y));
    const attackable =
      horizontalDistance <= clamp(Number(options.maxHorizontalDistance) || 18, 6, 40) &&
      verticalGap <= clamp(Number(options.maxVerticalGap) || 10, 3, 24);
    return {
      visible: true,
      attackable,
      horizontalDistance,
      verticalGap,
      dragon,
    };
  }

  function isBedName(name = "") {
    return /_bed$/.test(String(name || "").trim());
  }

  function findNearbyBed(maxDistance = 16) {
    const bot = ensureBotReady();
    const local = bot.findBlock({
      maxDistance: clamp(Number(maxDistance) || 16, 2, 64),
      matching: (block) => Boolean(block?.name && isBedName(block.name)),
    });
    if (local) {
      return local;
    }
    const workAreaCenter = getCompanionWorkAreaCenter({ maxDistance: 12 });
    return workAreaCenter
      ? findNearestBlockByNamesAround(
          workAreaCenter,
          BED_ITEM_NAMES,
          Math.max(16, Number(maxDistance) || 16),
          6
        )
      : null;
  }

  function getCraftableBedItemName() {
    for (const bedName of BED_ITEM_NAMES) {
      const woolName = bedName.replace(/_bed$/, "_wool");
      if (getItemCountByName(woolName) >= 3) {
        return bedName;
      }
    }
    return "";
  }

  function findNearbyContainers(maxDistance = 16, limit = 8) {
    const bot = ensureBotReady();
    const wanted = new Set(CONTAINER_BLOCK_NAMES);
    const positions = bot.findBlocks({
      maxDistance: clamp(Number(maxDistance) || 16, 2, 64),
      count: clamp(Number(limit) || 8, 1, 16),
      matching: (block) => Boolean(block?.name && wanted.has(block.name)),
    });
    return positions
      .map((position) => bot.blockAt(position))
      .filter((block) => block && wanted.has(block.name))
      .sort(
        (a, b) =>
          bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position)
      );
  }

  function findNearbyNetherPortalAnchor(centerPosition = null) {
    const bot = ensureBotReady();
    const center =
      toPlainPosition(centerPosition) ||
      getCompanionWorkAreaCenter() ||
      toPlainPosition(bot.entity.position);
    if (!center) {
      return null;
    }
    const base = new Vec3(Math.floor(center.x), Math.floor(center.y), Math.floor(center.z));
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let dx = -8; dx <= 8; dx += 1) {
      for (let dz = -8; dz <= 8; dz += 1) {
        const distancePenalty = Math.abs(dx) + Math.abs(dz);
        if (distancePenalty < 2 || distancePenalty > 12) {
          continue;
        }
        const standable = getNearbyStandablePosition(
          { x: base.x + dx, y: base.y, z: base.z + dz },
          { horizontalRadius: 0, upwardSearch: 4, downwardSearch: 8 }
        );
        const candidate = standable
          ? {
              x: Math.floor(standable.x),
              y: Math.floor(standable.y),
              z: Math.floor(standable.z),
            }
          : {
              x: base.x + dx,
              y: base.y,
              z: base.z + dz,
            };
        let penalty = 0;
        for (let x = 0; x < 4; x += 1) {
          const support = bot.blockAt(new Vec3(candidate.x + x, candidate.y - 1, candidate.z));
          if (!isSafeSupportBlock(support)) {
            penalty += 10;
          }
          for (let y = 0; y <= 4; y += 1) {
            const pos = new Vec3(candidate.x + x, candidate.y + y, candidate.z);
            const block = bot.blockAt(pos);
            const isFrameSpot =
              ((x === 1 || x === 2) && (y === 0 || y === 4)) ||
              ((x === 0 || x === 3) && y >= 1 && y <= 3);
            if (isFrameSpot) {
              if (block && !isReplaceableBlock(block) && String(block.name || "").trim() !== "obsidian") {
                penalty += 6;
              }
            } else if (block && !isReplaceableBlock(block)) {
              penalty += 5;
            }
          }
        }
        const totalScore = penalty + distancePenalty * 1.5;
        if (totalScore < bestScore) {
          best = candidate;
          bestScore = totalScore;
        }
      }
    }
    return best && bestScore < 120 ? best : null;
  }

  function averagePlainPositions(positions = []) {
    const normalized = positions.map(toPlainPosition).filter(Boolean);
    if (!normalized.length) {
      return null;
    }
    const totals = normalized.reduce(
      (acc, position) => {
        acc.x += Number(position.x);
        acc.y += Number(position.y);
        acc.z += Number(position.z);
        return acc;
      },
      { x: 0, y: 0, z: 0 }
    );
    return {
      x: totals.x / normalized.length,
      y: totals.y / normalized.length,
      z: totals.z / normalized.length,
    };
  }

  function roundPlainPosition(position) {
    const plain = toPlainPosition(position);
    if (!plain) {
      return null;
    }
    return {
      x: Number(plain.x.toFixed(1)),
      y: Number(plain.y.toFixed(1)),
      z: Number(plain.z.toFixed(1)),
    };
  }

  function rememberAutonomousWorkAreaCenter(position) {
    autonomousState.workAreaCenter = roundPlainPosition(position);
  }

  function rememberInfrastructureBlock(kind = "", blockOrPosition = null) {
    const normalizedKind = String(kind || "").trim();
    const position = roundPlainPosition(
      blockOrPosition?.position ? blockOrPosition.position : blockOrPosition
    );
    if (!normalizedKind || !position) {
      return;
    }
    infrastructureRegistry[normalizedKind] = position;
  }

  function getRegisteredInfrastructureBlock(kind = "", blockNames = []) {
    const bot = ensureBotReady();
    const normalizedKind = String(kind || "").trim();
    const remembered = toPlainPosition(infrastructureRegistry[normalizedKind]);
    if (!remembered) {
      return null;
    }
    const block = bot.blockAt(new Vec3(Math.floor(remembered.x), Math.floor(remembered.y), Math.floor(remembered.z)));
    if (!block?.name) {
      infrastructureRegistry[normalizedKind] = null;
      return null;
    }
    if (blockNames.length && !blockNames.includes(block.name) && !(normalizedKind === "container" && CONTAINER_BLOCK_NAMES.includes(block.name))) {
      infrastructureRegistry[normalizedKind] = null;
      return null;
    }
    return block;
  }

  async function ensureSupportPlacementItem(preferredNames = []) {
    const preferred = (Array.isArray(preferredNames) ? preferredNames : [preferredNames])
      .map((name) => String(name || "").trim())
      .filter(Boolean);
    for (const itemName of preferred) {
      if (getItemCountByName(itemName) > 0) {
        return itemName;
      }
    }
    if (getItemCountByName("cobblestone") > 0) {
      return "cobblestone";
    }
    if (getItemCount(ANY_PLANKS) > 0 || getTotalLogCount() > 0) {
      await ensurePlanks(1);
      const plankName = getAvailablePlankName();
      if (getItemCountByName(plankName) > 0) {
        return plankName;
      }
    }
    if (getItemCountByName("dirt") > 0) {
      return "dirt";
    }
    return "";
  }

  async function placeInfrastructureWithFallback(centerPosition = null, itemName = "", kind = "") {
    const bot = ensureBotReady();
    const placement = findNearbyPlacementTarget(centerPosition || getCompanionWorkAreaCenter(), {
      radius: 6,
      minDistance: 0,
      verticalRange: 4,
    });
    if (placement) {
      await executePlaceBlock({
        args: {
          position: placement.targetPos,
          item: itemName,
        },
      });
      await sleep(300);
      rememberInfrastructureBlock(kind, placement.targetPos);
      rememberAutonomousWorkAreaCenter(placement.targetPos);
      return bot.blockAt(placement.targetPos);
    }
    const fallbackCenter = toVec3(centerPosition || getCompanionWorkAreaCenter() || bot.entity.position)?.floored();
    if (!fallbackCenter) {
      throw new Error(`附近没有合适的位置摆放${itemName}`);
    }
    const supportPos = fallbackCenter.offset(0, -1, 0);
    const supportBlock = bot.blockAt(supportPos);
    if (!isSafeSupportBlock(supportBlock)) {
      const supportItem = await ensureSupportPlacementItem([
        getAvailablePlankName(),
        "cobblestone",
      ]);
      if (!supportItem) {
        throw new Error(`附近没有合适的位置摆放${itemName}，而且当前也没有可用支撑方块`);
      }
      await executePlaceBlock({
        args: {
          position: supportPos,
          item: supportItem,
        },
      });
    }
    await executePlaceBlock({
      args: {
        position: fallbackCenter,
        item: itemName,
      },
    });
    await sleep(300);
    rememberInfrastructureBlock(kind, fallbackCenter);
    rememberAutonomousWorkAreaCenter(fallbackCenter);
    return bot.blockAt(fallbackCenter);
  }

  function getNearbyInfrastructureBlocks(maxDistance = 12) {
    const blocks = [
      findNearestInfrastructureLocally(["crafting_table"], maxDistance),
      findNearestInfrastructureLocally(FURNACE_BLOCK_NAMES, maxDistance),
      findNearestInfrastructureLocally(CONTAINER_BLOCK_NAMES, maxDistance),
      (() => {
        const bot = ensureBotReady();
        return bot.findBlock({
          maxDistance: clamp(Number(maxDistance) || 12, 2, 64),
          matching: (block) => Boolean(block?.name && isBedName(block.name)),
        });
      })(),
    ].filter(Boolean);
    const seen = new Set();
    return blocks.filter((block) => {
      const key = `${Math.floor(block.position.x)},${Math.floor(block.position.y)},${Math.floor(block.position.z)}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function getCompanionWorkAreaCenter(options = {}) {
    if (!currentBot?.entity) {
      return null;
    }
    const playerTarget =
      options.playerTarget || findPlayerTarget(String(options.playerName || getBestKnownPlayerName() || "").trim());
    const playerPosition = toPlainPosition(playerTarget?.position);
    const rememberedCenter = toPlainPosition(autonomousState.workAreaCenter);
    if (
      rememberedCenter &&
      (!playerPosition || getHorizontalDistance(rememberedCenter, playerPosition) <= 12)
    ) {
      return rememberedCenter;
    }

    const infrastructurePositions = getNearbyInfrastructureBlocks(Number(options.maxDistance) || 12)
      .map((block) => toPlainPosition(block.position))
      .filter(Boolean)
      .filter((position) => {
        if (!playerPosition) {
          return true;
        }
        return getHorizontalDistance(position, playerPosition) <= 12;
      });

    const averaged = averagePlainPositions(
      playerPosition ? [...infrastructurePositions, playerPosition] : infrastructurePositions
    );
    if (averaged) {
      return roundPlainPosition(averaged);
    }
    if (playerPosition) {
      return roundPlainPosition(playerPosition);
    }
    return roundPlainPosition(currentBot.entity.position);
  }

  function isPassableBlock(block) {
    if (!block) {
      return true;
    }
    if (block.name === "air") {
      return true;
    }
    return Boolean(block.boundingBox === "empty");
  }

  function isReplaceableBlock(block) {
    if (!block) {
      return true;
    }
    const name = String(block.name || "").trim();
    if (!name || name === "air") {
      return true;
    }
    if (name.includes("water") || name.includes("lava")) {
      return false;
    }
    if (isPassableBlock(block)) {
      return true;
    }
    return REPLACEABLE_BLOCK_KEYWORDS.some((keyword) => name.includes(keyword));
  }

  function isSafeSupportBlock(block) {
    if (!block) {
      return false;
    }
    if (block.name === "air" || block.name.includes("water") || block.name.includes("lava")) {
      return false;
    }
    return !isPassableBlock(block);
  }

  function isStandableAt(position) {
    const bot = ensureBotReady();
    if (!position) {
      return false;
    }
    const feet = bot.blockAt(position);
    const head = bot.blockAt(position.offset(0, 1, 0));
    const below = bot.blockAt(position.offset(0, -1, 0));
    if (!feet || !head || !below) {
      return false;
    }
    return isPassableBlock(feet) && isPassableBlock(head) && isSafeSupportBlock(below);
  }

  function getHorizontalDistance(a, b) {
    if (!a || !b) {
      return Number.POSITIVE_INFINITY;
    }
    const dx = Number(a.x) - Number(b.x);
    const dz = Number(a.z) - Number(b.z);
    return Math.sqrt(dx * dx + dz * dz);
  }

  function getNearbyStandablePosition(targetPosition, options = {}) {
    const bot = ensureBotReady();
    const base = toPlainPosition(targetPosition);
    if (!base) {
      return null;
    }
    const baseX = Math.floor(base.x);
    const baseY = Math.floor(base.y);
    const baseZ = Math.floor(base.z);
    const horizontalRadius = clamp(Number(options.horizontalRadius) || 3, 1, 6);
    const upwardSearch = clamp(Number(options.upwardSearch) || 4, 1, 10);
    const downwardSearch = clamp(Number(options.downwardSearch) || 8, 2, 16);
    const cacheKey = `standable:${baseX},${baseY},${baseZ}:${horizontalRadius}:${upwardSearch}:${downwardSearch}`;
    return getCachedBlockQuery(cacheKey, () => {
      const offsets = [];
      for (let dx = -horizontalRadius; dx <= horizontalRadius; dx += 1) {
        for (let dz = -horizontalRadius; dz <= horizontalRadius; dz += 1) {
          offsets.push({ dx, dz, horizontal: Math.abs(dx) + Math.abs(dz) });
        }
      }
      offsets.sort((a, b) => a.horizontal - b.horizontal);
      let best = null;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const offset of offsets) {
        for (let y = baseY + upwardSearch; y >= baseY - downwardSearch; y -= 1) {
          const candidate = new Vec3(baseX + offset.dx, y, baseZ + offset.dz);
          if (!isStandableAt(candidate)) {
            continue;
          }
          const verticalPenalty = Math.max(0, baseY - y) * 6 + Math.abs(y - baseY) * 2;
          const horizontalPenalty = getHorizontalDistance(candidate, base);
          const botPenalty = getHorizontalDistance(candidate, bot.entity?.position || base);
          const score = verticalPenalty + horizontalPenalty * 4 + botPenalty;
          if (score < bestScore) {
            best = candidate;
            bestScore = score;
          }
        }
      }
      if (!best) {
        return null;
      }
      return {
        x: best.x + 0.5,
        y: best.y,
        z: best.z + 0.5,
      };
    });
  }

  function getPlayerRendezvousPosition(target) {
    if (!target?.position) {
      return null;
    }
    if (target.entity) {
      return {
        x: Number(target.position.x),
        y: Number(target.position.y),
        z: Number(target.position.z),
      };
    }
    return (
      getNearbyStandablePosition(target.position, {
        horizontalRadius: 4,
        upwardSearch: 5,
        downwardSearch: 10,
      }) || toPlainPosition(target.position)
    );
  }

  function isBlockExposed(block) {
    const bot = ensureBotReady();
    if (!block?.position) {
      return false;
    }
    const neighbors = [
      block.position.offset(1, 0, 0),
      block.position.offset(-1, 0, 0),
      block.position.offset(0, 1, 0),
      block.position.offset(0, -1, 0),
      block.position.offset(0, 0, 1),
      block.position.offset(0, 0, -1),
    ];
    return neighbors.some((position) => isPassableBlock(bot.blockAt(position)));
  }

  function getAvailablePlankName() {
    for (const [logName, plankName] of Object.entries(LOG_TO_PLANK)) {
      if (getItemCountByName(logName) > 0 || getItemCountByName(plankName) > 0) {
        return plankName;
      }
    }
    return "oak_planks";
  }

  function getAvailableLogName() {
    for (const logName of Object.keys(LOG_TO_PLANK)) {
      if (getItemCountByName(logName) > 0) {
        return logName;
      }
    }
    return "";
  }

  function getTotalLogCount() {
    return getItemCount(Object.keys(LOG_TO_PLANK));
  }

  function getMostAbundantPlankName() {
    let bestName = "";
    let bestCount = -1;
    for (const plankName of ANY_PLANKS) {
      const count = getItemCountByName(plankName);
      if (count > bestCount) {
        bestCount = count;
        bestName = plankName;
      }
    }
    return bestName || getAvailablePlankName();
  }

  function findNearestWoodLogName(maxDistance = 48) {
    const block = findNearestBlockByNames(Object.keys(LOG_TO_PLANK), maxDistance);
    return String(block?.name || "").trim();
  }

  function selectPreferredWoodPlankName() {
    const byInventory = getMostAbundantPlankName();
    if (getItemCountByName(byInventory) > 0 || getItemCountByName(PLANK_TO_LOG[byInventory]) > 0) {
      return byInventory;
    }
    const nearestLogName = findNearestWoodLogName(48);
    if (nearestLogName && LOG_TO_PLANK[nearestLogName]) {
      return LOG_TO_PLANK[nearestLogName];
    }
    return "oak_planks";
  }

  async function craftItemByName(itemName, count = 1, craftingTable = null) {
    const bot = ensureBotReady();
    const item = getRegistryItem(itemName);
    if (!item) {
      throw new Error(`未知物品 ${itemName}`);
    }
    const craftingTableBlock =
      craftingTable && craftingTable.position
        ? craftingTable
        : craftingTable
          ? bot.blockAt(craftingTable)
          : null;
    if (craftingTableBlock) {
      currentTask.progressText = `正在走到工作台边合成 ${itemName}`;
      broadcastTaskStatus();
      await moveNearBlock(craftingTableBlock, 3);
    }
    updateTaskCheckpoint(currentTask, {
      kind: "craft_item",
      item: itemName,
      count,
      station: craftingTableBlock ? "crafting_table" : "inventory",
      stationPosition: craftingTableBlock ? toPlainPosition(craftingTableBlock.position) : null,
    });
    const targetCount = getItemCountByName(itemName) + Math.max(1, Math.ceil(Number(count) || 1));
    stopBotActions();
    if (craftingTableBlock) {
      currentTask.progressText = `正在使用工作台合成 ${itemName}`;
      broadcastTaskStatus();
      addTaskLog("info", `正在使用工作台合成 ${itemName}`);
    }
    while (getItemCountByName(itemName) < targetCount) {
      checkTaskSignal();
      const beforeCount = getItemCountByName(itemName);
      const recipe = bot.recipesFor(item.id, null, 1, craftingTableBlock || null)?.[0];
      if (!recipe) throw new Error(`无法继续合成 ${itemName}，还缺 ${targetCount - beforeCount} 个`);
      // Mineflayer predicts crafting slots while the server also sends window
      // snapshots. Repeating craftOnce inside one open table can consume stale
      // slot data. One recipe per call closes the window, then the next recipe
      // is chosen from the refreshed inventory rather than the old table view.
      await physicalCraft(recipe, 1, craftingTableBlock || null, itemName);
      const deadline = Date.now() + 1200;
      await sleep(150);
      while (getItemCountByName(itemName) <= beforeCount && Date.now() < deadline) {
        checkTaskSignal();
        await sleep(100);
      }
      if (getItemCountByName(itemName) <= beforeCount) {
        throw Object.assign(new Error(`合成 ${itemName} 后没有确认新增产物，已停止重复合成`),{materialTransaction:{
          item:itemName,beforeCraft:beforeCount,actualOutput:getItemCountByName(itemName),expected:recipe.result?.count,
          station:craftingTableBlock?"crafting_table":"inventory",window:bot.currentWindow?{id:bot.currentWindow.id,type:bot.currentWindow.type}:null,
          craftingSlots:(bot.inventory.slots||[]).slice(0,9).map(i=>i?{name:i.name,count:i.count}:null),
          cursor:bot.inventory.selectedItem?{name:bot.inventory.selectedItem.name,count:bot.inventory.selectedItem.count}:null,
        }});
      }
      recordTaskHeartbeat(currentTask, {
        actionState: "acting",
        checkpoint: {
          kind: "craft_item",
          item: itemName,
          count,
          craftedCount: getItemCountByName(itemName),
          targetCount,
          crafted: true,
        },
        clearRecoveryReason: true,
      });
    }
  }

  async function craftAvailablePlanksUpTo(minCount = 4) {
    const target = clamp(Number(minCount) || 4, 1, 256);
    while (getItemCount(ANY_PLANKS) < target) {
      checkTaskSignal();
      const logName = getAvailableLogName();
      if (!logName) {
        break;
      }
      await craftItemByName(LOG_TO_PLANK[logName], 1, null);
      await sleep(100);
    }
    return getItemCount(ANY_PLANKS) >= target;
  }

  function findNearestDroppedItemEntity(options = {}) {
    const bot = ensureBotReady();
    const center = toPlainPosition(options.position) || toPlainPosition(bot.entity?.position);
    const maxDistance = clamp(Number(options.maxDistance) || 8, 2, 16);
    const radius = clamp(Number(options.radius) || maxDistance, 1, 16);
    return getCachedEntityList()
      .filter((entity) => {
        if (!isDroppedItemEntity(entity, bot.registry) || options.expectedName && entity.getDroppedItem?.()?.name !== options.expectedName) {
          return false;
        }
        const botDistance = bot.entity.position.distanceTo(entity.position);
        if (botDistance > maxDistance) {
          return false;
        }
        if (!center) {
          return true;
        }
        return getDistance(center, entity.position) <= radius;
      })
      .sort(
        (a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position)
      )[0] || null;
  }

  async function collectNearbyDroppedItems(options = {}) {
    const bot = ensureBotReady();
    ensureMovements(bot);
    const focusPosition = toPlainPosition(options.position) || toPlainPosition(bot.entity.position);
    const radius = clamp(Number(options.radius) || 6, 1, 16);
    const timeoutMs = clamp(Number(options.timeoutMs) || 3000, 800, 10000);
    const idleGraceMs = clamp(Number(options.idleGraceMs) || 500, 150, 1200);
    const startedAt = Date.now();
    let moved = false;
    let lastFoundAt = Date.now(),lastObservedStartupDrop=null;

    while (Date.now() - startedAt < timeoutMs) {
      checkTaskSignal();
      const target = findNearestDroppedItemEntity({
        position: focusPosition,
        radius,
        maxDistance: Math.max(radius + 2, 6),
        expectedName: options.startupWood,
      });
      if (!target) {
        if (Date.now() - lastFoundAt >= idleGraceMs) {
          break;
        }
        await sleep(120);
        continue;
      }
      lastFoundAt = Date.now();
      if(options.startupWood){
        const observedKey=`${target.id}:${Math.floor(target.position.y)}`;
        if(lastObservedStartupDrop!==observedKey){lastObservedStartupDrop=observedKey;
          recordTaskDiagnostic(currentTask,'house_startup_drop_observed',{entityId:target.id,expectedName:options.startupWood,
            itemPosition:toPlainPosition(target.position),actual:toPlainPosition(bot.entity.position),inventoryCredit:false});}

        const ownerTask=currentTask,context=getExecutionContext()||{},token=context.token||getActiveCancellationToken(),
          client=bot._client,generation=ownerTask.executionGeneration,lease=getCurrentMovementLease();
        const owner=()=>currentBot===bot&&bot._client===client&&currentTask===ownerTask&&ownerTask.executionGeneration===generation
          &&(ownerTask.cancellationToken||runtimeToken)===token&&!token?.cancelled&&!token?.pauseRequested
          &&(!lease||isMovementLeaseActive(lease)||activeHouseSurfaceNavigationMove?.task===ownerTask
            &&activeHouseSurfaceNavigationMove.lease===lease&&isHouseSurfaceDefenseCurrent(activeHouseSurfaceNavigationMove));
        const active=()=>{token?.throwIfRequested();checkTaskSignal();const failure=getHouseSurfaceDefenseFailure();if(failure)throw failure;
          if(!owner())throw createAbortError('movement_preempted');};
        const deadline=Math.min(startedAt+timeoutMs,options.deadline||Infinity);
        moved=await require('./minecraft/houseStartupDropPickup').pickupStartupDrop({getBot:()=>currentBot,assertActive:active,
          isMovementOwner:owner,isMovementSuspended:()=>activeHouseSurfaceNavigationMove?.task===ownerTask
            &&activeHouseSurfaceNavigationMove.lease===lease&&isHouseSurfaceDefenseCurrent(activeHouseSurfaceNavigationMove),
          isStepAllowed:p=>!houseResourcePositionExcluded(p)&&allowsUnarmedHouseRangedStep(bot,p,ownerTask),
          actualnativegoto:(goal,profile,budget)=>executionContextStorage.run({...context,miningMovements:profile},
            ()=>houseSurfacePathfinderGoto(goal,Math.max(1,deadline-Date.now()),{...budget,deadline})),
          onFailure:error=>{if(activeHouseSurfaceNavigationMove?.task===ownerTask&&activeHouseSurfaceNavigationMove.runGeneration===generation)
            activeHouseSurfaceNavigationMove.closed=true;
            recordTaskDiagnostic(ownerTask,'house_startup_drop_guard_failure',{code:error.code,message:error.message,observedMovement:error.observedMovement});},
          record:facts=>recordTaskDiagnostic(ownerTask,'house_startup_drop_reached',facts),
        },{entity:target,expectedName:options.startupWood,deadline})||moved;
        await sleep(120);continue;
      }
      try {
        await pathfinderGoto(
          new goals.GoalNear(
            Math.floor(target.position.x),
            Math.floor(target.position.y),
            Math.floor(target.position.z),
            1
          ),
          4500,
          "前往掉落物超时"
        );
        moved = true;
      } catch (_) {
        await sleep(150);
      }
      await sleep(220);
    }
    return moved;
  }

  async function bootstrapWoodLogs(minLogs = 2, maxDistance = 48, options = {}) {
    const bot = ensureBotReady();
    const targetLogs = clamp(Number(minLogs) || 2, 1, 8);
    const startedCount = getTotalLogCount();
    const origin = bot.entity.position.clone();
    const skipped = new Set();
    const exploration = surfaceSearchPositions(origin, maxDistance);
    const deadline = Date.now() + 180000;
    let lastReason = "附近没有找到可手动采集的原木",survivalRecoveries=0;
    return withSurfaceResourceMovements(async () => {
      if(options.safeHouseBootstrap===true&&currentTask?.startupWood?.graph?.pendingWater){
        const ownerTask=currentTask,client=bot._client,generation=ownerTask.executionGeneration,lease=getCurrentMovementLease();
        const active=()=>{checkTaskSignal();if(currentTask!==ownerTask||currentBot!==bot||bot._client!==client
          ||ownerTask.executionGeneration!==generation||Date.now()>=deadline)throw createAbortError('movement_preempted');};
        if(!naturalWalkingFoot(bot,bot.entity.position.floored())||!hasGroundedBodySupport(bot)){
          await require('./minecraft/houseEmergencyShore').escapeEmergencyShore({getBot:()=>currentBot,Vec3,Movements,GoalBlock:goals.GoalBlock,
            assertActive:active,isDryFoot:p=>dryFoot(bot,p),isGrounded:()=>hasGroundedBodySupport(bot),
            setActive:profile=>{activeEmergencyShore=profile?{bot,profile,lease}:null;},
            goto:(goal,options)=>pathfinderGoto(goal,options.timeoutMs,'恢复启动采木前原生上岸超时',lease,{...options,preserveMovements:true}),
            record:(type,facts)=>recordTaskDiagnostic(ownerTask,type,facts)});active();
        }
        await exploreHouseSurfaceGraph(ownerTask,'house_startup_wood',ownerTask.startupWood.searchAnchor,setTaskProgress,{
          assertGraphActive:active,excludeBounds:[],graphCheckpoint:{get:()=>ownerTask.startupWood.graph,
            save:value=>{active();ownerTask.startupWood={...ownerTask.startupWood,graph:value};}}});active();
      }
      while (getTotalLogCount() < startedCount + targetLogs) {
        checkTaskSignal();
        if (Date.now() > deadline) throw new Error(`采集原木达到本轮时限：${lastReason}`);
        let candidates = findNearestBlocksByNames(Object.keys(LOG_TO_PLANK), maxDistance, 24)
          .filter((block) => !skipped.has(block.position.toString()));
        if(options.safeHouseBootstrap===true&&isUnarmedHouseExplorer(bot,currentTask))
          candidates=candidates.filter(b=>require('./minecraft/houseUnarmedResourceSafety').unarmedResourceTargetSafe(bot,b.position));
        if(options.safeHouseBootstrap===true)candidates=require('./minecraft/housePreSiteWood').prioritizeStartupWood(bot,candidates,{
          assertActive:checkTaskSignal,standingSafely:()=>furnishedHouseStandingSafely(bot.entity.position),
          avoidsSupport:p=>furnishedHouseDigAvoidsSupport(p,bot.entity.position),excluded:houseResourcePositionExcluded});
        let gathered = false;
        for (const candidate of candidates) {
          checkTaskSignal();
          if (Date.now() > deadline) throw new Error(`采集原木达到本轮时限：${lastReason}`);
          const block = bot.blockAt(candidate.position);
          if (!block || !isWoodBlockName(block.name)) continue;
          try {
            currentTask.progressText = "正在采集可触达的天然树木，准备开矿工具";
            broadcastTaskStatus();
            const safeStartup=options.safeHouseBootstrap===true;
            const active=()=>{checkTaskSignal();if(currentBot!==bot)throw createAbortError('movement_preempted');
              if(Date.now()>=deadline)throw Object.assign(Error('启动采木达到原有限时限'),{code:'house_startup_wood_timeout'});};
            const reachable = () => bot.canDigBlock(block) && (safeStartup
              ? furnishedHouseStandingSafely(bot.entity.position)&&furnishedHouseDigAvoidsSupport(block.position,bot.entity.position)
                &&require('./minecraft/houseResourceVisibility').hasHouseResourceSight(bot,block,{assertActive:active})
              : typeof bot.canSeeBlock !== "function" || bot.canSeeBlock(block));
            if(safeStartup){
              await require('./minecraft/houseResourceReach').createHouseResourceReach({
                getBot:()=>currentBot,captureActive:()=>active,avoidsSupport:furnishedHouseDigAvoidsSupport,
                standingSafely:furnishedHouseStandingSafely,getDeadline:()=>deadline,
                clearSight:(target,options)=>require('./minecraft/houseResourceSight').clearHouseResourceSight({getBot:()=>currentBot,assertActive:active,
                  standingSafely:()=>furnishedHouseStandingSafely(bot.entity.position),
                  canClear:leaf=>!houseResourcePositionExcluded(leaf.position)&&furnishedHouseDigAvoidsSupport(leaf.position,bot.entity.position),
                  dig:leaf=>physicalDigBlock(leaf,'启动采木清理视线树叶')},target,options),
                moveToBlock:(target,{deadline})=>pathfinderGoto(new goals.GoalLookAtBlock(target.position,bot.world,{reach:4.5}),Math.max(1,Math.min(8000,deadline-Date.now())),'前往启动木材超时'),
                onVisibilityRecovered:facts=>recordTaskDiagnostic(currentTask,'house_startup_wood_visibility_rechecked',facts),
              })(block);
            }
            // A log above our head can be within digging reach while a GoalNear
            // centred on its Y would demand an impossible standing position.
            if (!reachable()) {
              const goal = bot.world?.raycast
                ? new goals.GoalLookAtBlock(block.position, bot.world, { reach: 4.5 })
                : new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2);
              await pathfinderGoto(goal, 8000, "前往天然树木超时");
            }
            await waitForSurfaceGround("砍树");
            if (!reachable()) throw new Error(`当前无法触达 ${block.name}`);
            await equipBestTool(block);
            const before = getTotalLogCount();
            await physicalDigBlock(block, block.displayName || block.name);
            await sleep(250);
            await collectNearbyDroppedItems({ position: block.position, radius: 6, timeoutMs: 3500,
              ...(safeStartup?{startupWood:block.name,deadline}: {}) });
            await sleep(180);
            if (getTotalLogCount() <= before) throw new Error("砍树后没有确认拾取到原木");
            survivalRecoveries=0;gathered = true;
            break;
          } catch (error) {
            checkTaskSignal();
            if(options.safeHouseBootstrap===true&&error.code==='movement_preempted'&&survivalRecoveries<4
              &&await resumeHouseResourceAfterSurvival(error,{deadline,bot})){
              survivalRecoveries++;continue;
            }
            if(options.safeHouseBootstrap===true&&(/^(?:house_surface_|dry_graph_|house_resource_connection_changed|movement_preempted|paused|cancelled)/.test(String(error.code||''))))throw error;
            lastReason = error?.message || String(error);
            skipped.add(candidate.position.toString());
          }
        }
        if (gathered) continue;
        if(options.safeHouseBootstrap===true){
          const task=currentTask,client=bot._client,generation=task.executionGeneration;
          const active=()=>{checkTaskSignal();if(currentBot!==bot||currentTask!==task||bot._client!==client||task.executionGeneration!==generation)
              throw createAbortError('movement_preempted');
            if(Date.now()>=deadline)throw Object.assign(Error('启动采木探索达到原时限'),{code:'house_startup_wood_timeout'});};
          await waitForSurfaceGround('启动采木探路交接');active();
          task.startupWood={...task.startupWood,searchAnchor:task.startupWood?.searchAnchor||toPlainPosition(bot.entity.position.floored())};
          await require('./minecraft/houseStartupExplorationOrigin').prepareStartupExplorationOrigin({getBot:()=>currentBot,assertActive:active,
            getState:()=>task.startupWood,saveState:value=>{active();task.startupWood=value;},
            ready:drainStartupOriginDefense,isMotorIdle:()=>activeHouseSurfaceNavigationMove===null&&activeSurvivalInterrupt===null,
            record:facts=>recordTaskDiagnostic(task,'house_startup_actual_origin_segment',facts),
          },{deadline});active();
          const moved=await exploreHouseSurfaceGraph(task,'house_startup_wood',task.startupWood.searchAnchor,setTaskProgress,{
            assertGraphActive:active,excludeBounds:[],graphCheckpoint:{get:()=>task.startupWood.graph||null,
              save:value=>{active();const history=task.startupWood.graphSegments||[];
                if(history.reduce((n,s)=>n+s.graph.order.length,0)+value.order.length>256
                  ||history.reduce((n,s)=>n+s.graph.probes,0)+value.probes>8192)
                  throw Object.assign(Error('启动探索原累计节点或探测预算已用尽'),{code:'house_startup_origin_budget_limit'});
                task.startupWood={...task.startupWood,graph:value};}}});
          active();if(moved?.moved!==true)throw new Error(`启动采木尚未找到可达的新站位：${lastReason}`);
          skipped.clear();continue;
        }
        if (!(await exploreNextSurfacePosition(exploration))) {
          throw new Error(`附近没有找到可安全采集的原木：${lastReason}`);
        }
      }
      return true;
    },options.safeHouseBootstrap===true?{deadline}:{});
  }

  async function ensurePlanks(minCount = 4) {
    if (getExecutionContext()?.houseSelfSupply) return getExecutionContext().houseSelfSupply.ensureAnyPlanks(minCount);
    const targetCount = clamp(Number(minCount) || 4, 1, 256);
    if (getItemCount(ANY_PLANKS) >= targetCount) {
      return true;
    }
    try {
      await withdrawItemsFromNearbyContainer({
        names: [...ANY_PLANKS, ...Object.keys(LOG_TO_PLANK)],
        count: Math.max(2, targetCount - getItemCount(ANY_PLANKS)),
        progressText: "正在从附近箱子补木板/原木",
      });
    } catch (_) {}
    while (getItemCount(ANY_PLANKS) < targetCount) {
      checkTaskSignal();
      await craftAvailablePlanksUpTo(targetCount);
      if (getItemCount(ANY_PLANKS) >= targetCount) return true;
      const previousLogs = getTotalLogCount();
      await bootstrapWoodLogs(Math.ceil((targetCount - getItemCount(ANY_PLANKS)) / 4), 64);
      if (getTotalLogCount() <= previousLogs) {
        throw new Error("采集原木后没有拾取到建材，无法补齐木板");
      }
    }
    return true;
  }

  async function ensureSticks(minCount = 2) {
    if (getItemCountByName("stick") >= minCount) {
      return true;
    }
    const missing = Math.max(0, minCount - getItemCountByName("stick"));
    await ensurePlanks(Math.ceil(missing / 4) * 2);
    await craftItemByName("stick", missing, null);
    if (getItemCountByName("stick") < minCount) throw new Error("木棍合成后数量没有达到目标");
    return true;
  }

  async function ensureSpecificPlanks(plankName = "oak_planks", minCount = 4) {
    const targetPlank = String(plankName || "oak_planks").trim() || "oak_planks";
    const logName = PLANK_TO_LOG[targetPlank] || "oak_log";
    if (getItemCountByName(targetPlank) >= minCount) {
      return true;
    }
    try {
      await withdrawItemsFromNearbyContainer({
        names: [targetPlank, logName],
        count: Math.max(2, minCount - getItemCountByName(targetPlank)),
        progressText: `正在从附近箱子补 ${targetPlank}`,
      });
    } catch (_) {}
    if (getItemCountByName(targetPlank) >= minCount) {
      return true;
    }
    const missingPlanks = minCount - getItemCountByName(targetPlank);
    const requiredLogs = Math.ceil(Math.max(0, missingPlanks) / 4);
    if (getItemCountByName(logName) < requiredLogs) {
      currentTask.progressText = `正在收集 ${logName.replace(/_/g, " ")}，准备搭建`;
      broadcastTaskStatus();
      try {
        await bootstrapWoodLogs(Math.max(1, requiredLogs - getItemCountByName(logName)), 72);
      } catch (error) {
        addTaskLog(
          "warn",
          `没有稳定拿到指定原木 ${logName}：${error?.message || "未知原因"}，改用附近任意木材继续搭建`
        );
        await ensurePlanks(minCount);
      }
    }
    let stillMissing = minCount - getItemCountByName(targetPlank);
    let craftsNeeded = Math.ceil(Math.max(0, stillMissing) / 4);
    if (craftsNeeded > 0 && getItemCountByName(logName) < craftsNeeded) {
      await craftAvailablePlanksUpTo(minCount);
      craftsNeeded = Math.ceil(Math.max(0, minCount - getItemCountByName(targetPlank)) / 4);
    }
    if (craftsNeeded > 0 && getItemCountByName(logName) >= craftsNeeded) {
      stopBotActions();
      currentTask.progressText = `正在把原木加工成 ${targetPlank}`;
      broadcastTaskStatus();
      addTaskLog("info", `正在把原木加工成 ${targetPlank}`);
      for (let index = 0; index < craftsNeeded; index += 1) {
        checkTaskSignal();
        if (index === 0 || index === craftsNeeded - 1 || index % 8 === 0) {
          currentTask.progressText = `正在加工建材 ${index + 1}/${craftsNeeded}`;
          broadcastTaskStatus();
        }
        await craftItemByName(targetPlank, 1, null);
        await sleep(80);
      }
    }
    if (getItemCountByName(targetPlank) >= minCount) {
      return true;
    }
    await craftAvailablePlanksUpTo(minCount);
    return getItemCountByName(targetPlank) >= minCount || getItemCount(ANY_PLANKS) >= minCount;
  }

  function findNearbyPlacementTarget(centerPosition = null, options = {}) {
    const bot = ensureBotReady();
    const base = (toVec3(centerPosition) || bot.entity.position).floored();
    const radius = clamp(Number(options.radius) || 4, 1, 6);
    const minDistance = clamp(Number(options.minDistance) || 1, 0, radius);
    const verticalRange = clamp(Number(options.verticalRange) || 3, 1, 6);
    const offsets = [];
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        const distance = Math.abs(dx) + Math.abs(dz);
        if (distance < minDistance || distance > radius * 2) {
          continue;
        }
        offsets.push({ dx, dz, distance });
      }
    }
    offsets.sort((a, b) => a.distance - b.distance);
    for (const offset of offsets) {
      for (let dy = verticalRange; dy >= -verticalRange; dy -= 1) {
        const targetPos = base.plus(new Vec3(offset.dx, dy, offset.dz));
        const targetBlock = bot.blockAt(targetPos);
        const above = bot.blockAt(targetPos.offset(0, 1, 0));
        const below = bot.blockAt(targetPos.offset(0, -1, 0));
        if (!targetBlock || !above || !below) {
          continue;
        }
        if (!isReplaceableBlock(targetBlock) || !isPassableBlock(above)) {
          continue;
        }
        if (!isSafeSupportBlock(below)) {
          continue;
        }
        return {
          targetPos,
          anchorBlock: below,
          faceVector: new Vec3(0, 1, 0),
        };
      }
    }
    return null;
  }

  async function ensureCraftingTableAvailable(centerPosition = null) {
    if (getExecutionContext()?.houseSelfSupply) return getExecutionContext().houseSelfSupply.ensureStation("crafting_table");
    const bot = ensureBotReady();
    const registered = getRegisteredInfrastructureBlock("crafting_table", ["crafting_table"]);
    if (registered) {
      rememberAutonomousWorkAreaCenter(centerPosition || registered.position);
      return registered;
    }
    const nearby = findNearbyCraftingTable(18);
    if (nearby) {
      rememberInfrastructureBlock("crafting_table", nearby);
      rememberAutonomousWorkAreaCenter(centerPosition || nearby.position);
      return nearby;
    }

    let item = findInventoryItem(["crafting_table"]);
    if (!item) {
      if (getItemCount(ANY_PLANKS) < 4) {
        await ensurePlanks(4);
      }
      await craftItemByName("crafting_table", 1, null);
      item = findInventoryItem(["crafting_table"]);
    }
    if (!item) {
      throw new Error("没有可用的工作台，也无法现做一个工作台");
    }

    const placed =
      (await placeInfrastructureWithFallback(centerPosition, "crafting_table", "crafting_table")) ||
      findNearbyCraftingTable(18);
    if (!placed) {
      throw new Error("附近没有合适的位置摆放工作台");
    }
    return placed;
  }

  async function equipInventoryItem(item, destination = "hand", label = "") {
    const bot = ensureBotReady();
    if (!item) {
      recordTaskDiagnostic(currentTask,'inventory_equip_item_missing',{destination,label,stack:new Error('Missing inventory item').stack});
      throw new Error("没有可装备的物品");
    }
    await physicalEquip(item, destination, label || item.displayName || item.name);
  }

  async function ensureFuelForSmelting(minCount = 1, options = {}) {
    const fuelNames=SMELT_FUEL_ITEM_PRIORITY.filter(name=>name!==options.outputName);
    const targetFuelCount = clamp(Number(minCount) || 1, 1, 8);
    if (getItemCount(fuelNames) >= targetFuelCount) {
      return true;
    }
    try {
      await withdrawItemsFromNearbyContainer({
        names: fuelNames,
        count: targetFuelCount,
        progressText: "正在从附近箱子拿燃料",
      });
    } catch (_) {}
    if (getItemCount(fuelNames) >= targetFuelCount) {
      return true;
    }
    if (options.allowWoodFuel === true) {
      await ensurePlanks(targetFuelCount);
      return getItemCount(ANY_PLANKS) >= targetFuelCount;
    }
    await ensureBasicPickaxeForStone();
    await executeMineResource({
      args: {
        block: "coal",
        count: Math.max(2, targetFuelCount),
        label: "煤炭",
        maxDistance: 36,
      },
    });
    return getItemCount(fuelNames) >= targetFuelCount;
  }

  async function ensureFurnaceAvailable(centerPosition = null) {
    if (getExecutionContext()?.houseSelfSupply) return getExecutionContext().houseSelfSupply.ensureStation("furnace");
    const bot = ensureBotReady();
    const registered = getRegisteredInfrastructureBlock("furnace", FURNACE_BLOCK_NAMES);
    if (registered) {
      rememberAutonomousWorkAreaCenter(centerPosition || registered.position);
      return registered;
    }
    const nearby = findNearbyFurnace(18);
    if (nearby) {
      rememberInfrastructureBlock("furnace", nearby);
      rememberAutonomousWorkAreaCenter(centerPosition || nearby.position);
      return nearby;
    }

    let item = findInventoryItem(["furnace"]);
    if (!item) {
      if (getItemCountByName("cobblestone") < 8) {
        await ensureBasicPickaxeForStone();
        await executeMineResource({
          args: {
            block: "stone",
            count: 8,
            label: "圆石",
            maxDistance: 28,
          },
        });
      }
      const craftingTable = await ensureCraftingTableAvailable(centerPosition);
      await craftItemByName("furnace", 1, craftingTable);
      item = findInventoryItem(["furnace"]);
    }
    if (!item) {
      throw new Error("没有可用的熔炉，也无法现做一个熔炉");
    }

    const placed =
      (await placeInfrastructureWithFallback(centerPosition, "furnace", "furnace")) ||
      findNearbyFurnace(18);
    if (!placed) {
      throw new Error("附近没有合适的位置摆放熔炉");
    }
    return placed;
  }

  async function ensureContainerAvailable(centerPosition = null) {
    if (getExecutionContext()?.houseSelfSupply) return getExecutionContext().houseSelfSupply.ensureStorage();
    const bot = ensureBotReady();
    const registered = getRegisteredInfrastructureBlock("container", CONTAINER_BLOCK_NAMES);
    if (registered) {
      rememberAutonomousWorkAreaCenter(centerPosition || registered.position);
      return registered;
    }
    const nearby = findNearbyContainer(18);
    if (nearby) {
      rememberInfrastructureBlock("container", nearby);
      rememberAutonomousWorkAreaCenter(centerPosition || nearby.position);
      return nearby;
    }

    let item = findInventoryItem(["chest"]);
    if (!item) {
      if (getItemCount(ANY_PLANKS) < 8) {
        await ensurePlanks(8);
      }
      const craftingTable = await ensureCraftingTableAvailable(centerPosition);
      await craftItemByName("chest", 1, craftingTable);
      item = findInventoryItem(["chest"]);
    }
    if (!item) {
      throw new Error("没有可用的箱子，也无法现做一个箱子");
    }

    const placed =
      (await placeInfrastructureWithFallback(centerPosition, "chest", "container")) ||
      findNearbyContainer(18);
    if (!placed) {
      throw new Error("附近没有合适的位置摆放箱子");
    }
    return placed;
  }

  async function ensureNetherPortalAvailable(centerPosition = null) {
    const bot = ensureBotReady();
    const nearbyPortal = findNearbyNetherPortal(18);
    if (nearbyPortal) {
      rememberAutonomousWorkAreaCenter(centerPosition || nearbyPortal.position);
      return nearbyPortal;
    }
    if (!hasDiamondPickaxeOrBetter()) {
      throw new Error("需要钻石镐或更好的镐子才能准备下界门");
    }
    if (getItemCountByName("obsidian") < 10) {
      throw new Error("黑曜石不足：至少需要 10 个才能搭下界门");
    }
    if (!hasPortalIgnitionTool()) {
      throw new Error("缺少 flint_and_steel，当前无法点燃下界门");
    }
    const anchor = findNearbyNetherPortalAnchor(centerPosition || getCompanionWorkAreaCenter());
    if (!anchor) {
      throw new Error("附近没有合适的位置搭下界门");
    }
    setTaskProgress("正在搭建下界门框架");
    addTaskLog("info", `已选择下界门位置：${anchor.x}, ${anchor.y}, ${anchor.z}`);
    for (const blockSpec of createNetherPortalBlueprint(anchor)) {
      checkTaskSignal();
      await executePlaceBlock({
        args: {
          position: blockSpec.position,
          item: "obsidian",
        },
      });
      await sleep(100);
    }

    const ignitionBase = bot.blockAt(new Vec3(anchor.x + 1, anchor.y, anchor.z));
    const flintAndSteel = findInventoryItem(["flint_and_steel"]);
    if (!ignitionBase || !flintAndSteel) {
      throw new Error("下界门框架已完成，但缺少点火条件");
    }
    await equipInventoryItem(flintAndSteel, "hand", flintAndSteel.displayName || flintAndSteel.name);
    await moveNearBlock(ignitionBase, 2);
    try {
      await safeBotLookAt(ignitionBase.position.offset(0.5, 1, 0.5), true, {
        reason: "ignite_nether_portal",
      });
    } catch (_) {}
    try {
      await withTimeout(
        safeBotActivateBlock(ignitionBase, new Vec3(0, 1, 0), {
          reason: "ignite_nether_portal",
        }),
        DEFAULT_EQUIP_TIMEOUT_MS,
        "点燃下界门超时"
      );
    } catch (_) {
      await withTimeout(
        safeBotActivateBlock(ignitionBase, null, {
          reason: "ignite_nether_portal",
        }),
        DEFAULT_EQUIP_TIMEOUT_MS,
        "点燃下界门超时"
      );
    }
    await sleep(600);
    const activePortal = findNearbyNetherPortal(8);
    if (!activePortal) {
      throw new Error("下界门框架已搭好，但没有成功点燃");
    }
    rememberAutonomousWorkAreaCenter(activePortal.position);
    return activePortal;
  }

  async function ensureTorchSupply(minCount = 4) {
    const targetCount = clamp(Number(minCount) || 4, 1, 32);
    if (getItemCountByName("torch") >= targetCount) {
      return true;
    }
    const missing = Math.max(0, targetCount - getItemCountByName("torch"));
    const recipeCount = Math.max(1, Math.ceil(missing / 4));
    await ensureSticks(recipeCount);
    if (getItemCount(TORCH_FUEL_ITEM_NAMES) < recipeCount) {
      await ensureFuelForSmelting(recipeCount);
    }
    await craftItemByName("torch", missing, null);
    return getItemCountByName("torch") >= targetCount;
  }

  function findNearbyBedPlacementTarget(centerPosition = null, options = {}) {
    const bot = ensureBotReady();
    const center = toPlainPosition(centerPosition) || toPlainPosition(bot.entity?.position);
    if (!center) {
      return null;
    }
    const radius = clamp(Number(options.radius) || 5, 2, 8);
    const baseX = Math.floor(center.x);
    const baseY = Math.floor(center.y);
    const baseZ = Math.floor(center.z);
    const offsets = [];
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        const distance = Math.abs(dx) + Math.abs(dz);
        if (distance < 2 || distance > radius * 2) {
          continue;
        }
        offsets.push({ dx, dz, distance });
      }
    }
    offsets.sort((a, b) => a.distance - b.distance);
    const directions = [
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
    ];
    for (const offset of offsets) {
      for (let y = baseY + 2; y >= baseY - 4; y -= 1) {
        const footPos = new Vec3(baseX + offset.dx, y, baseZ + offset.dz);
        if (!isStandableAt(footPos)) {
          continue;
        }
        const belowFoot = bot.blockAt(footPos.offset(0, -1, 0));
        if (!isSafeSupportBlock(belowFoot)) {
          continue;
        }
        for (const dir of directions) {
          const headPos = footPos.plus(dir);
          const headBlock = bot.blockAt(headPos);
          const headAbove = bot.blockAt(headPos.offset(0, 1, 0));
          const belowHead = bot.blockAt(headPos.offset(0, -1, 0));
          if (!headBlock || !headAbove || !belowHead) {
            continue;
          }
          if (!isReplaceableBlock(headBlock) || !isPassableBlock(headAbove) || !isSafeSupportBlock(belowHead)) {
            continue;
          }
          return {
            footPos,
            headPos,
            lookTarget: headPos.offset(0.5, 0.5, 0.5),
          };
        }
      }
    }
    return null;
  }

  async function ensureBedAvailable(centerPosition = null) {
    const bot = ensureBotReady();
    const nearby = findNearbyBed(10);
    if (nearby) {
      rememberAutonomousWorkAreaCenter(centerPosition || nearby.position);
      return nearby;
    }

    try {
      await withdrawItemsFromNearbyContainer({
        names: BED_ITEM_NAMES,
        count: 1,
        progressText: "正在从附近箱子寻找床",
      });
    } catch (_) {}

    let item = findInventoryItem(BED_ITEM_NAMES);
    if (!item) {
      const craftableBedName = getCraftableBedItemName();
      if (craftableBedName) {
        await ensurePlanks(3);
        const craftingTable = await ensureCraftingTableAvailable(centerPosition);
        await craftItemByName(craftableBedName, 1, craftingTable);
        item = findInventoryItem([craftableBedName]);
      }
    }
    if (!item) {
      throw new Error("没有可用的床，也无法现做一张床");
    }

    const placement = findNearbyBedPlacementTarget(centerPosition || getCompanionWorkAreaCenter(), {
      radius: 6,
    });
    if (!placement) {
      throw new Error("附近没有合适的位置摆放床");
    }
    await equipInventoryItem(item, "hand", item.displayName || item.name);
    await moveToPosition(placement.footPos, 3);
    try {
      await safeBotLookAt(placement.lookTarget, true, {
        reason: "enter_nether_portal",
      });
    } catch (_) {}
    await physicalPlaceBlock(
      bot.blockAt(placement.footPos.offset(0, -1, 0)),
      new Vec3(0, 1, 0),
      placement.footPos,
      item.name || "bed"
    );
    await sleep(300);
    rememberAutonomousWorkAreaCenter(placement.footPos);
    return findNearbyBed(10) || bot.blockAt(placement.footPos) || bot.blockAt(placement.headPos);
  }

  async function sleepAtNearbyBed(options = {}) {
    const bot = ensureBotReady();
    const timeInfo = getTimeOfDayInfo();
    if (!timeInfo.isNight) {
      return true;
    }
    const bed = findNearbyBed(Number(options.maxDistance) || 10) || (await ensureBedAvailable());
    if (!bed || !isBedName(bed.name)) {
      throw new Error("附近没有可用的床");
    }
    await moveNearBlock(bed, 2);
    currentTask.progressText = "正在尝试睡觉";
    broadcastTaskStatus();
    addTaskLog("info", "正在尝试在附近床上过夜");
    await withTimeout(bot.sleep(bed), 10000, "躺到床上超时");
    const deadline = Date.now() + clamp(Number(options.waitMs) || 8000, 2000, 20000);
    while (Date.now() < deadline) {
      checkTaskSignal();
      if (!getTimeOfDayInfo().isNight) {
        break;
      }
      await sleep(400);
    }
    if (bot.isSleeping && getTimeOfDayInfo().isNight) {
      try {
        await bot.wake();
      } catch (_) {}
    }
    return true;
  }

  async function enterNearbyNetherPortal(options = {}) {
    const bot = ensureBotReady();
    const initialDimension = String(bot.game?.dimension || "").trim() || "unknown";
    const portal = findNearbyNetherPortal(Number(options.maxDistance) || 12);
    if (!portal) {
      throw new Error("附近没有可用的下界门");
    }
    currentTask.progressText = initialDimension.includes("nether") ? "正在返回主世界" : "正在进入下界门";
    broadcastTaskStatus();
    addTaskLog("info", initialDimension.includes("nether") ? "正在尝试通过附近下界门返回主世界" : "正在尝试穿过附近下界门");
    try {
      await moveToPosition(
        {
          x: Math.floor(portal.position.x),
          y: Math.floor(portal.position.y),
          z: Math.floor(portal.position.z),
        },
        1
      );
    } catch (_) {}
    const deadline = Date.now() + clamp(Number(options.waitMs) || 20000, 6000, 30000);
    try {
      while (Date.now() < deadline) {
        checkTaskSignal();
        const currentDimension = String(bot.game?.dimension || "").trim() || "unknown";
        if (currentDimension && currentDimension !== initialDimension) {
          return true;
        }
        try {
          await safeBotLookAt(portal.position.offset(0.5, 0.5, 0.5), true, {
            reason: "enter_nether_portal",
          });
        } catch (_) {}
        try {
          await safeBotSetControlState("forward", true, {
            reason: "enter_nether_portal",
          });
        } catch (_) {}
        await sleep(350);
      }
      const finalDimension = String(bot.game?.dimension || "").trim() || "unknown";
      if (!finalDimension || finalDimension === initialDimension) {
        throw new Error(initialDimension.includes("nether") ? "返回主世界超时" : "进入下界门超时");
      }
    } finally {
      try {
        await safeBotSetControlState("forward", false, {
          reason: "enter_nether_portal",
        });
      } catch (_) {}
    }
    return true;
  }

  async function useEyeOfEnderForStrongholdSearch(options = {}) {
    const bot = ensureBotReady();
    if (String(bot.game?.dimension || "").includes("nether")) {
      throw new Error("当前在下界，无法在这里用末影之眼定位要塞");
    }
    const eye = findInventoryItem(["eye_of_ender"]);
    if (!eye) {
      throw new Error("背包里没有末影之眼");
    }
    currentTask.progressText = "正在投掷末影之眼定位要塞方向";
    broadcastTaskStatus();
    addTaskLog("info", "正在尝试投掷末影之眼，记录要塞方向");
    await equipInventoryItem(eye, "hand", eye.displayName || eye.name);
    const origin = {
      x: Number(bot.entity.position.x.toFixed(1)),
      y: Number(bot.entity.position.y.toFixed(1)),
      z: Number(bot.entity.position.z.toFixed(1)),
    };
    try {
      await bot.look(bot.entity.yaw, -0.15, true);
    } catch (_) {}
    const beforeCount = getItemCountByName("eye_of_ender");
    const traceDeadline = Date.now() + clamp(Number(options.waitMs) || 2500, 1000, 6000);
    await physicalActivateItem("使用末影之眼");
    await sleep(250);
    let traced = null;
    while (Date.now() < traceDeadline) {
      checkTaskSignal();
      const eyeEntity =
        Object.values(bot.entities || {})
          .filter((entity) => {
            const name = String(entity?.name || "").trim();
            return (
              entity &&
              entity !== bot.entity &&
              entity.position &&
              (name.includes("eye_of_ender") || name.includes("ender_signal"))
            );
          })
          .sort(
            (a, b) =>
              bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position)
          )[0] || null;
      if (eyeEntity?.position) {
        traced = {
          x: Number(eyeEntity.position.x.toFixed(1)),
          y: Number(eyeEntity.position.y.toFixed(1)),
          z: Number(eyeEntity.position.z.toFixed(1)),
          originX: origin.x,
          originY: origin.y,
          originZ: origin.z,
          timestamp: Date.now(),
        };
        break;
      }
      await sleep(150);
    }
    dragonRunState.locateAttempts += 1;
    dragonRunState.lastLocateAt = Date.now();
    if (traced) {
      dragonRunState.lastEyeTrace = traced;
      addLearningInsight("记录到一条末影之眼飞行轨迹，可继续沿该方向推进要塞搜索", {
        intent: "locate_stronghold",
        trace: traced,
      });
      addTaskLog("info", `记录到末影之眼轨迹：${traced.x}, ${traced.y}, ${traced.z}`);
    } else {
      addTaskLog("warn", "末影之眼已投出，但这次没有稳定追踪到轨迹实体");
    }
    const afterCount = getItemCountByName("eye_of_ender");
    if (afterCount >= beforeCount) {
      await sleep(300);
    }
    return true;
  }

  function getStrongholdAdvanceTarget(options = {}) {
    const bot = ensureBotReady();
    const trace = dragonRunState.lastEyeTrace;
    if (!trace) {
      return null;
    }
    const origin = {
      x: Number(trace.originX ?? bot.entity.position.x),
      y: Number(trace.originY ?? bot.entity.position.y),
      z: Number(trace.originZ ?? bot.entity.position.z),
    };
    const dx = Number(trace.x) - origin.x;
    const dz = Number(trace.z) - origin.z;
    const distance = Math.hypot(dx, dz);
    if (!Number.isFinite(distance) || distance < 1) {
      return null;
    }
    const stepDistance = clamp(Number(options.stepDistance) || 96, 24, 192);
    const target = {
      x: Number(trace.x) + (dx / distance) * stepDistance,
      y: Number(trace.y || bot.entity.position.y),
      z: Number(trace.z) + (dz / distance) * stepDistance,
    };
    dragonRunState.lastStrongholdAdvanceAt = Date.now();
    return (
      getNearbyStandablePosition(target, {
        horizontalRadius: 4,
        upwardSearch: 8,
        downwardSearch: 16,
      }) || {
        x: Number(target.x.toFixed(1)),
        y: Number(target.y.toFixed(1)),
        z: Number(target.z.toFixed(1)),
      }
    );
  }

  function shouldRefreshStrongholdLocate(options = {}) {
    const bot = ensureBotReady();
    const trace = dragonRunState.lastEyeTrace;
    if (!trace) {
      return true;
    }
    const minTravelDistance = clamp(Number(options.minTravelDistance) || 56, 16, 160);
    const maxLocateAgeMs = clamp(Number(options.maxLocateAgeMs) || 45_000, 10_000, 180_000);
    const origin = {
      x: Number(trace.originX ?? trace.x ?? bot.entity.position.x),
      y: Number(trace.originY ?? trace.y ?? bot.entity.position.y),
      z: Number(trace.originZ ?? trace.z ?? bot.entity.position.z),
    };
    const horizontalTravel = getHorizontalDistance(bot.entity.position, origin);
    if (Number.isFinite(horizontalTravel) && horizontalTravel >= minTravelDistance) {
      return true;
    }
    return Date.now() - Number(dragonRunState.lastLocateAt || 0) >= maxLocateAgeMs;
  }

  function getNetherBlazeScoutTarget(options = {}) {
    const bot = ensureBotReady();
    const portal = findNearbyNetherPortal(24);
    const fortressBlock = findNearbyNetherFortressBlock(Number(options.maxDistance) || 64);
    if (fortressBlock?.position) {
      const fortressStandable =
        getNearbyStandablePosition(fortressBlock.position, {
          horizontalRadius: 6,
          upwardSearch: 10,
          downwardSearch: 18,
        }) || toPlainPosition(fortressBlock.position);
      if (fortressStandable) {
        dragonRunState.lastNetherScoutAt = Date.now();
        return {
          x: Number(fortressStandable.x.toFixed(1)),
          y: Number(fortressStandable.y.toFixed(1)),
          z: Number(fortressStandable.z.toFixed(1)),
          source: "fortress",
        };
      }
    }
    const center =
      toPlainPosition(portal?.position) ||
      getCompanionWorkAreaCenter() ||
      toPlainPosition(bot.entity?.position);
    if (!center) {
      return null;
    }
    const scoutOffsets = [
      { x: 16, z: 0 },
      { x: 0, z: 16 },
      { x: -16, z: 0 },
      { x: 0, z: -16 },
      { x: 24, z: 8 },
      { x: 8, z: 24 },
      { x: -24, z: 8 },
      { x: -8, z: 24 },
      { x: 24, z: -8 },
      { x: 8, z: -24 },
      { x: -24, z: -8 },
      { x: -8, z: -24 },
      { x: 32, z: 0 },
      { x: 0, z: 32 },
      { x: -32, z: 0 },
      { x: 0, z: -32 },
      { x: 40, z: 12 },
      { x: 12, z: 40 },
      { x: -40, z: 12 },
      { x: -12, z: 40 },
      { x: 40, z: -12 },
      { x: 12, z: -40 },
      { x: -40, z: -12 },
      { x: -12, z: -40 },
    ];
    const startIndex = Math.max(0, Number(dragonRunState.netherScoutIndex || 0)) % scoutOffsets.length;
    for (let offsetIndex = 0; offsetIndex < scoutOffsets.length; offsetIndex += 1) {
      const offset = scoutOffsets[(startIndex + offsetIndex) % scoutOffsets.length];
      const standable = getNearbyStandablePosition(
        {
          x: center.x + offset.x,
          y: center.y,
          z: center.z + offset.z,
        },
        {
          horizontalRadius: 4,
          upwardSearch: 8,
          downwardSearch: 16,
        }
      );
      if (!standable) {
        continue;
      }
      dragonRunState.netherScoutIndex = (startIndex + offsetIndex + 1) % scoutOffsets.length;
      dragonRunState.lastNetherScoutAt = Date.now();
      return {
        x: Number(standable.x.toFixed(1)),
        y: Number(standable.y.toFixed(1)),
        z: Number(standable.z.toFixed(1)),
        source: "portal_ring",
      };
    }
    return null;
  }

  function getStrongholdStructureTarget(options = {}) {
    const portalFrame = findNearbyEndPortalFrame(Number(options.maxDistance) || 64);
    const anchorBlock = portalFrame || findNearbyStrongholdBlock(Number(options.maxDistance) || 64);
    if (!anchorBlock?.position) {
      return null;
    }
    const standable =
      getNearbyStandablePosition(anchorBlock.position, {
        horizontalRadius: portalFrame ? 3 : 6,
        upwardSearch: 10,
        downwardSearch: 20,
      }) || toPlainPosition(anchorBlock.position);
    if (!standable) {
      return null;
    }
    return {
      x: Number(standable.x.toFixed(1)),
      y: Number(standable.y.toFixed(1)),
      z: Number(standable.z.toFixed(1)),
      source: portalFrame ? "end_portal_frame" : "stronghold_block",
    };
  }

  async function fillNearbyEndPortalFrames(options = {}) {
    const bot = ensureBotReady();
    if (String(bot.game?.dimension || "").includes("nether")) {
      throw new Error("当前在下界，无法在这里补末地门框");
    }
    const stats = getNearbyEndPortalFrameStats(Number(options.maxDistance) || 48);
    if (stats.total < 4) {
      throw new Error("附近还没有稳定识别到末地门框");
    }
    if (!stats.emptyFrames.length) {
      return true;
    }
    const neededEyes = stats.emptyFrames.length;
    if (getItemCountByName("eye_of_ender") < neededEyes) {
      throw new Error(`末影之眼不足：需要 ${neededEyes} 颗，当前只有 ${getItemCountByName("eye_of_ender")} 颗`);
    }
    const eye = findInventoryItem(["eye_of_ender"]);
    if (!eye) {
      throw new Error("背包里没有末影之眼");
    }
    await equipInventoryItem(eye, "hand", eye.displayName || eye.name);
    for (let index = 0; index < stats.emptyFrames.length; index += 1) {
      checkTaskSignal();
      const frame = bot.blockAt(stats.emptyFrames[index].position) || stats.emptyFrames[index];
      if (!frame?.position) {
        continue;
      }
      currentTask.progressText = `正在补末地门框 ${index + 1}/${stats.emptyFrames.length}`;
      broadcastTaskStatus();
      addTaskLog("info", `正在给末地门框补眼 ${index + 1}/${stats.emptyFrames.length}`);
      try {
        await moveNearBlock(frame, 2);
      } catch (_) {}
      try {
        await safeBotLookAt(frame.position.offset(0.5, 0.5, 0.5), true, {
          reason: "fill_end_portal",
        });
      } catch (_) {}
      await withTimeout(
        safeBotActivateBlock(frame, null, {
          reason: "fill_end_portal",
        }),
        DEFAULT_EQUIP_TIMEOUT_MS,
        "给末地门框补眼超时"
      );
      await sleep(180);
    }
    const refreshed = getNearbyEndPortalFrameStats(Number(options.maxDistance) || 48);
    if (refreshed.emptyFrames.length > 0) {
      throw new Error(`还有 ${refreshed.emptyFrames.length} 个末地门框没有成功补眼`);
    }
    return true;
  }

  async function enterNearbyEndPortal(options = {}) {
    const bot = ensureBotReady();
    const initialDimension = String(bot.game?.dimension || "").trim() || "unknown";
    if (initialDimension.includes("the_end")) {
      return true;
    }
    const portalBlock = findNearbyEndPortalBlock(Number(options.maxDistance) || 24);
    if (!portalBlock) {
      throw new Error("附近没有可用的末地传送门");
    }
    currentTask.progressText = "正在进入末地传送门";
    broadcastTaskStatus();
    addTaskLog("info", "正在尝试进入末地传送门");
    try {
      await moveToPosition(
        {
          x: Math.floor(portalBlock.position.x),
          y: Math.floor(portalBlock.position.y),
          z: Math.floor(portalBlock.position.z),
        },
        1
      );
    } catch (_) {}
    const deadline = Date.now() + clamp(Number(options.waitMs) || 15000, 5000, 30000);
    try {
      while (Date.now() < deadline) {
        checkTaskSignal();
        const currentDimension = String(bot.game?.dimension || "").trim() || "unknown";
        if (currentDimension && currentDimension !== initialDimension) {
          return true;
        }
        try {
          await safeBotLookAt(portalBlock.position.offset(0.5, 0.2, 0.5), true, {
            reason: "enter_end_portal",
          });
        } catch (_) {}
        try {
          await safeBotSetControlState("forward", true, {
            reason: "enter_end_portal",
          });
        } catch (_) {}
        await sleep(250);
      }
    } finally {
      try {
        await safeBotSetControlState("forward", false, {
          reason: "enter_end_portal",
        });
      } catch (_) {}
    }
    throw new Error("进入末地传送门超时");
  }

  async function stabilizeEndSpawn(options = {}) {
    const bot = ensureBotReady();
    if (!String(bot.game?.dimension || "").includes("the_end")) {
      throw new Error("当前不在末地");
    }
    currentTask.progressText = "正在末地出生点附近站稳";
    broadcastTaskStatus();
    if (Number.isFinite(bot.food) && bot.food < clamp(Number(options.minFood) || 16, 10, 20)) {
      await ensureNutrition(clamp(Number(options.minFood) || 16, 10, 20));
    }
    const standable =
      getNearbyStandablePosition(bot.entity.position, {
        horizontalRadius: 4,
        upwardSearch: 6,
        downwardSearch: 10,
      }) || toPlainPosition(bot.entity.position);
    if (standable) {
      try {
        await moveToPosition(
          {
            x: Math.floor(Number(standable.x)),
            y: Math.floor(Number(standable.y)),
            z: Math.floor(Number(standable.z)),
          },
          2
        );
      } catch (_) {}
    }
    return true;
  }

  async function recoverForEndFight(options = {}) {
    const bot = ensureBotReady();
    if (!String(bot.game?.dimension || "").includes("the_end")) {
      throw new Error("当前不在末地");
    }
    currentTask.progressText = "正在恢复末地战斗状态";
    broadcastTaskStatus();
    addTaskLog("info", "末地战斗状态偏危险，先恢复血量和站位");
    const minFood = clamp(Number(options.minFood) || 18, 12, 20);
    if (Number.isFinite(bot.food) && bot.food < minFood) {
      await ensureNutrition(minFood);
    }
    const safeSpot =
      getNearbyStandablePosition(bot.entity.position, {
        horizontalRadius: 5,
        upwardSearch: 6,
        downwardSearch: 10,
      }) || toPlainPosition(bot.entity.position);
    if (safeSpot) {
      try {
        await moveToPosition(
          {
            x: Math.floor(Number(safeSpot.x)),
            y: Math.floor(Number(safeSpot.y)),
            z: Math.floor(Number(safeSpot.z)),
          },
          2
        );
      } catch (_) {}
    }
    await sleep(clamp(Number(options.waitMs) || 1800, 600, 5000));
    return true;
  }

  async function repositionForEndFight(options = {}) {
    const bot = ensureBotReady();
    if (!String(bot.game?.dimension || "").includes("the_end")) {
      throw new Error("当前不在末地");
    }
    currentTask.progressText = "正在回到末地安全落脚点";
    broadcastTaskStatus();
    addTaskLog("info", "当前站位不稳，先回到附近更安全的末地落脚点");
    const safeAnchor =
      findEndFightSafeAnchor(Number(options.maxDistance) || 24) ||
      getNearbyStandablePosition(bot.entity.position, {
        horizontalRadius: 4,
        upwardSearch: 6,
        downwardSearch: 10,
      });
    if (!safeAnchor) {
      throw new Error("附近没有找到可靠的末地落脚点");
    }
    await moveToPosition(
      {
        x: Math.floor(Number(safeAnchor.x)),
        y: Math.floor(Number(safeAnchor.y)),
        z: Math.floor(Number(safeAnchor.z)),
      },
      2
    );
    await sleep(clamp(Number(options.waitMs) || 900, 300, 3000));
    return true;
  }

  async function holdForEnderDragonWindow(options = {}) {
    const bot = ensureBotReady();
    if (!String(bot.game?.dimension || "").includes("the_end")) {
      throw new Error("当前不在末地");
    }
    currentTask.progressText = "正在等待末影龙进入可接战窗口";
    broadcastTaskStatus();
    addTaskLog("info", "末影龙当前位置不适合追击，先在安全点附近等待窗口");
    const safeAnchor = findEndFightSafeAnchor(Number(options.maxDistance) || 24);
    if (safeAnchor) {
      try {
        await moveToPosition(
          {
            x: Math.floor(Number(safeAnchor.x)),
            y: Math.floor(Number(safeAnchor.y)),
            z: Math.floor(Number(safeAnchor.z)),
          },
          2
        );
      } catch (_) {}
    }
    await sleep(clamp(Number(options.waitMs) || 1600, 500, 5000));
    return true;
  }

  async function approachEndVictoryMarker(options = {}) {
    const bot = ensureBotReady();
    if (!String(bot.game?.dimension || "").includes("the_end")) {
      throw new Error("当前不在末地");
    }
    const marker = findEndVictoryMarker(Number(options.maxDistance) || 64);
    if (!marker?.position) {
      throw new Error("附近没有检测到末地胜利标记");
    }
    currentTask.progressText = "正在靠近末地胜利标记";
    broadcastTaskStatus();
    addTaskLog("info", `检测到 ${marker.name}，先靠过去确认战斗收尾`);
    try {
      await moveNearBlock(marker, Number(options.range) || 3);
    } catch (_) {
      await moveToPosition(
        {
          x: Math.floor(Number(marker.position.x)),
          y: Math.floor(Number(marker.position.y)),
          z: Math.floor(Number(marker.position.z)),
        },
        Number(options.range) || 3
      );
    }
    try {
      await collectNearbyDroppedItems({
        radius: 8,
        timeoutMs: 2500,
        idleGraceMs: 300,
      });
    } catch (_) {}
    dragonRunState.completedAt = Date.now();
    dragonRunState.completionMarker = {
      name: String(marker.name || "").trim() || null,
      position: {
        x: Number(marker.position.x.toFixed(1)),
        y: Number(marker.position.y.toFixed(1)),
        z: Number(marker.position.z.toFixed(1)),
      },
    };
    return true;
  }

  async function attackNamedEntity(names = [], options = {}) {
    const bot = ensureBotReady();
    const wanted = Array.isArray(names) ? names : [names];
    const maxDistance = clamp(Number(options.maxDistance) || 32, 4, 128);
    const timeoutMs = clamp(Number(options.timeoutMs) || 10000, 2000, 30000);
    const reachDistance = clamp(Number(options.reachDistance) || 4, 2, 6);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      checkTaskSignal();
      if (
        String(bot.game?.dimension || "").includes("the_end") &&
        ((Number.isFinite(bot.health) && bot.health < clamp(Number(options.minHealth) || 10, 4, 20)) ||
          (Number.isFinite(bot.food) && bot.food < clamp(Number(options.minFood) || 10, 4, 20)))
      ) {
        throw new Error("末地战斗状态危险，需要先恢复");
      }
      if (
        String(bot.game?.dimension || "").includes("the_end") &&
        isEndFightPositionUnsafe({
          minY: Number(options.minY) || 45,
          maxDistance: Number(options.safeAnchorDistance) || 16,
          maxSafeDistance: Number(options.maxSafeDistance) || 8,
        })
      ) {
        throw new Error("末地站位不安全，需要先重定位");
      }
      const target = findNearestEntityByNames(wanted, maxDistance);
      if (!target?.position) {
        return true;
      }
      if (typeof options.attackWindowFn === "function") {
        const windowOpen = options.attackWindowFn(target);
        if (!windowOpen) {
          throw new Error(String(options.windowClosedMessage || "攻击窗口已经关闭"));
        }
      }
      currentTask.progressText = `正在攻击 ${target.displayName || target.name || "目标"}`;
      broadcastTaskStatus();
      const distance = bot.entity.position.distanceTo(target.position);
      if (distance > reachDistance) {
        try {
          await moveToPosition(
            {
              x: Math.floor(target.position.x),
              y: Math.floor(target.position.y),
              z: Math.floor(target.position.z),
            },
            Math.max(1, reachDistance - 1)
          );
        } catch (_) {
          setPathfinderGoal(new goals.GoalFollow(target, Math.max(1, reachDistance - 1)), true);
          await sleep(300);
        }
      }
      if (bot.entity.position.distanceTo(target.position) <= reachDistance + 0.5) {
        try {
          await safeBotLookAt(target.position.offset(0, target.height || 1, 0), true, {
            targetName: target?.name || null,
            reason: "end_fight_attack",
          });
        } catch (_) {}
        try {
          await physicalAttack(target, target.displayName || target.name);
        } catch (_) {}
      }
      await sleep(350);
    }
    throw new Error(`${String(wanted[0] || "目标")} 战斗超时`);
  }

  async function breakNearbyEndCrystal(options = {}) {
    const bot = ensureBotReady();
    if (!String(bot.game?.dimension || "").includes("the_end")) {
      throw new Error("当前不在末地");
    }
    const crystalWindow = getEndCrystalWindowState({
      maxDistance: Number(options.maxDistance) || 48,
      maxHorizontalDistance: Number(options.maxHorizontalDistance) || 12,
      maxVerticalGap: Number(options.maxVerticalGap) || 8,
    });
    if (!crystalWindow.visible) {
      return true;
    }
    if (!crystalWindow.attackable) {
      throw new Error("附近水晶当前不在可处理窗口");
    }
    currentTask.progressText = "正在清理附近末地水晶";
    broadcastTaskStatus();
    addTaskLog("info", "发现附近末地水晶，先清理水晶");
    await attackNamedEntity(["end_crystal"], {
      maxDistance: Number(options.maxDistance) || 48,
      timeoutMs: Number(options.timeoutMs) || 12000,
      reachDistance: 4,
    });
    return true;
  }

  async function attackEnderDragonBasic(options = {}) {
    const bot = ensureBotReady();
    if (!String(bot.game?.dimension || "").includes("the_end")) {
      throw new Error("当前不在末地");
    }
    const dragonWindow = getEnderDragonWindowState({
      maxDistance: Number(options.maxDistance) || 96,
      maxHorizontalDistance: Number(options.maxHorizontalDistance) || 18,
      maxVerticalGap: Number(options.maxVerticalGap) || 10,
    });
    if (!dragonWindow.visible) {
      throw new Error("附近没有检测到末影龙");
    }
    if (!dragonWindow.attackable) {
      throw new Error("末影龙当前不在可接战窗口");
    }
    currentTask.progressText = "正在尝试接近并攻击末影龙";
    broadcastTaskStatus();
    addTaskLog("info", "正在执行基础打龙循环，优先近身接龙");
    await attackNamedEntity(["ender_dragon"], {
      maxDistance: Number(options.maxDistance) || 96,
      timeoutMs: Number(options.timeoutMs) || 12000,
      reachDistance: 5,
      attackWindowFn: () =>
        getEnderDragonWindowState({
          maxDistance: Number(options.maxDistance) || 96,
          maxHorizontalDistance: Number(options.maxHorizontalDistance) || 18,
          maxVerticalGap: Number(options.maxVerticalGap) || 10,
        }).attackable,
      windowClosedMessage: "末影龙当前不在可接战窗口",
    });
    return true;
  }

  function findLightingPlacementTargets(centerPosition = null, options = {}) {
    const bot = ensureBotReady();
    const center = toPlainPosition(centerPosition) || toPlainPosition(bot.entity?.position);
    if (!center) {
      return [];
    }
    const radius = clamp(Number(options.radius) || 6, 2, 10);
    const limit = clamp(Number(options.limit) || 4, 1, 8);
    const minSpacing = clamp(Number(options.minSpacing) || 3, 2, 5);
    const baseX = Math.floor(center.x);
    const baseY = Math.floor(center.y);
    const baseZ = Math.floor(center.z);
    const offsets = [];
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        const distance = Math.abs(dx) + Math.abs(dz);
        if (distance < 2 || distance > radius * 2) {
          continue;
        }
        offsets.push({ dx, dz, distance });
      }
    }
    offsets.sort((a, b) => a.distance - b.distance);
    const targets = [];
    for (const offset of offsets) {
      let standPos = null;
      for (let y = baseY + 2; y >= baseY - 4; y -= 1) {
        const candidate = new Vec3(baseX + offset.dx, y, baseZ + offset.dz);
        if (isStandableAt(candidate)) {
          standPos = candidate;
          break;
        }
      }
      if (!standPos) {
        continue;
      }
      const targetPos = standPos.clone();
      const existing = bot.blockAt(targetPos);
      if (existing?.name && TORCH_BLOCK_NAMES.includes(existing.name)) {
        continue;
      }
      if (existing && !isReplaceableBlock(existing)) {
        continue;
      }
      const tooCloseToExistingTorch = countNearbyBlocksByNames(TORCH_BLOCK_NAMES, targetPos, minSpacing, 2) > 0;
      if (tooCloseToExistingTorch) {
        continue;
      }
      const tooCloseToChosenTarget = targets.some(
        (position) => getHorizontalDistance(position, targetPos) < minSpacing
      );
      if (tooCloseToChosenTarget) {
        continue;
      }
      targets.push(targetPos);
      if (targets.length >= limit) {
        break;
      }
    }
    return targets;
  }

  async function ensureLightingAround(position = null, options = {}) {
    const center = toPlainPosition(position) || toPlainPosition(currentBot?.entity?.position);
    if (!center) {
      return false;
    }
    rememberAutonomousWorkAreaCenter(center);
    const radius = clamp(Number(options.radius) || 6, 2, 10);
    const minLights = clamp(Number(options.minLights) || 3, 1, 8);
    const existingLights = countNearbyBlocksByNames(TORCH_BLOCK_NAMES, center, radius, 3);
    if (existingLights >= minLights) {
      return true;
    }
    await ensureTorchSupply(Math.max(2, minLights));
    const targets = findLightingPlacementTargets(center, {
      radius,
      limit: minLights - existingLights,
      minSpacing: Number(options.minSpacing) || 3,
    });
    if (!targets.length) {
      return existingLights > 0;
    }
    currentTask.progressText = "正在补充附近照明";
    broadcastTaskStatus();
    addTaskLog("info", `正在布置 ${targets.length} 处照明点`);
    for (const target of targets) {
      checkTaskSignal();
      await executePlaceBlock({
        args: {
          position: target,
          item: "torch",
        },
      });
      await sleep(120);
    }
    return countNearbyBlocksByNames(TORCH_BLOCK_NAMES, center, radius, 3) >= Math.max(1, minLights - 1);
  }

  async function recoverHouseOwnedFurnace(request, assertActive = checkTaskSignal) {
    const ownerTask = getExecutionContext()?.task || currentTask;
    return require('./minecraft/houseOwnedFurnaceRecovery').recoverOwnedFurnace({
      getBot: () => ensureBotReady(), assertActive,
      isOwnerCurrent: position => {
        const owned = ownerTask?.materialSupply?.ownedStations?.furnace;
        return currentTask === ownerTask && owned?.confirmedPlaced === true
          && ['x','y','z'].every(axis => owned.position?.[axis] === position[axis]);
      },
      blockAt: p => currentBot.blockAt(toVec3(p)), reach: p => moveNearBlock(currentBot.blockAt(toVec3(p)), 2),
      openFurnace: physicalOpenFurnace,
      transfer: action => withTimeout(action(), DEFAULT_CONTAINER_TIMEOUT_MS, '重取自有熔炉材料超时'),
    }, request);
  }

  async function executeSmeltItem(step) {
    const inputNames = Array.isArray(step?.args?.inputItems)
      ? step.args.inputItems.map((item) => String(item || "").trim()).filter(Boolean)
      : String(step?.args?.input || "raw_iron")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
    const outputName = String(step?.args?.output || "").trim();
    const additionalCount = step?.args?.additionalCount;
    if (additionalCount !== undefined && (!Number.isInteger(additionalCount) || additionalCount < 1 || additionalCount > 32)) {
      throw Object.assign(new Error("冶炼新增批次必须为1到32件"), { code: "house_invalid_smelt_batch" });
    }
    const targetCount = additionalCount === undefined ? clamp(Number(step?.args?.count) || 1, 1, 32)
      : getItemCountByName(outputName) + additionalCount;
    if (!outputName || !inputNames.length) {
      throw new Error("smelt_item 缺少 input/output");
    }
    if (getItemCountByName(outputName) >= targetCount) {
      return true;
    }
    const furnaceBlock = await ensureFurnaceAvailable();
    await moveNearBlock(furnaceBlock, 2);
    currentTask.progressText = `正在用熔炉加工 ${outputName}`;
    broadcastTaskStatus();
    addTaskLog("info", `正在用熔炉加工 ${outputName}`);

    const smeltOwner = getExecutionContext()?.task || currentTask;
    const smeltBot = currentBot, smeltGeneration = smeltOwner?.executionGeneration;
    const smeltStartedAt = Date.now();
    let resumedCombatAt = 0, furnaceReopens = 0;
    let furnace = await physicalOpenFurnace(furnaceBlock);
    // While a container is open, Mineflayer updates that window's player slots;
    // bot.inventory receives them only when the window closes. Window.items()
    // excludes the furnace's input, fuel and output slots.
    const furnaceInventoryItems = () => typeof furnace?.items === "function"
      ? furnace.items()
      : currentBot?.inventory?.items?.() || [];
    const countFurnaceInventory = (names) => {
      const accepted = new Set(Array.isArray(names) ? names : [names]);
      return furnaceInventoryItems().reduce((count, item) =>
        count + (accepted.has(item.name) ? item.count : 0), 0);
    };
    const findFurnaceInventoryItem = (names) => {
      const items=furnaceInventoryItems();
      for(const name of names){const item=items.find(item=>item.name===name);if(item)return item;}
      return null;
    };
    const deadline = Date.now() + Math.max(45000, (targetCount - countFurnaceInventory(outputName)) * 12000 + 15000);
    let lastObservedState = "";
    const heartbeat = () => recordTaskHeartbeat(currentTask, {
      actionState: "acting",
      checkpoint: { kind: "smelt_item", output: outputName, targetCount,
        collected: countFurnaceInventory(outputName), progress: Number(furnace?.progress) || 0,
        fuelSeconds: Number(furnace?.fuelSeconds) || 0 },
      clearRecoveryReason: true,
    });
    try {
      while (countFurnaceInventory(outputName) < targetCount) {
        checkTaskSignal();
        if(Number.isInteger(furnace?.id)&&currentBot?.currentWindow!==furnace){
          const interrupted = Object.assign(Error("熔炉窗口已被中断，保留炉内材料并重新核对"),{code:"house_furnace_window_closed"});
          const owned = smeltOwner?.materialSupply?.ownedStations?.furnace;
          const assertSmeltOwner = () => {
            checkTaskSignal();
            if(currentTask!==smeltOwner||currentBot!==smeltBot||smeltOwner?.status!==TaskState.RUNNING
              ||smeltOwner.executionGeneration!==smeltGeneration||smeltBot.currentWindow
              ||owned?.confirmedPlaced!==true||smeltOwner.materialSupply.ownedStations.furnace!==owned
              ||!['x','y','z'].every(axis=>owned.position?.[axis]===furnaceBlock.position[axis])
              ||Date.now()>=deadline)throw interrupted;
          };
          // Defense deliberately closes containers. Resume only the same
          // owned batch after that defense has settled; read all slots anew.
          if(smeltOwner?.materialSupply?.materialSource!=='self_gathered'||furnaceReopens>=3)throw interrupted;
          assertSmeltOwner();
          if(activeSurvivalInterrupt)await settleSurvivalDefense('smelt_window_handoff');
          assertSmeltOwner();
          const combat=smeltOwner.materialSupply.combatMode;
          if(combat?.phase!=='resumed'||combat.startedAt<smeltStartedAt||combat.startedAt<=resumedCombatAt
            ||combat.cleanupPending||immediateFoodThreat(smeltBot))throw interrupted;
          resumedCombatAt=combat.startedAt;furnaceReopens++;
          const fresh=smeltBot.blockAt(toVec3(owned.position));
          if(fresh?.name!=='furnace')throw interrupted;
          await moveNearBlock(fresh,2);assertSmeltOwner();
          furnace=await physicalOpenFurnace(fresh);lastObservedState='';
          recordTaskDiagnostic(smeltOwner,'house_furnace_resumed_after_combat',{
            position:owned.position,output:outputName,targetCount,reopens:furnaceReopens,originalDeadline:deadline,
            input:furnace.inputItem()?.name||null,outputCount:furnace.outputItem()?.count||0,primitiveReplayed:false});
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`冶炼 ${outputName} 超时`);
        }
        const outputItem = furnace.outputItem();
        const pendingInput = furnace.inputItem();
        if (pendingInput && !inputNames.includes(pendingInput.name) || outputItem && outputItem.name !== outputName) {
          const owned = (getExecutionContext()?.task || currentTask)?.materialSupply?.ownedStations?.furnace;
          const knownSmelts = { raw_iron: 'iron_ingot', sand: 'glass', ...FOOD_SMELTING,
            ...Object.fromEntries(Object.keys(LOG_TO_PLANK).map(name => [name, 'charcoal'])) };
          const input = pendingInput?.name || Object.keys(knownSmelts).find(name => knownSmelts[name] === outputItem?.name);
          const oldOutput = knownSmelts[input];
          if (getExecutionContext()?.houseSelfSupply && oldOutput && (!outputItem || outputItem.name === oldOutput)
            && owned?.confirmedPlaced === true && ['x','y','z'].every(axis => owned.position?.[axis] === furnaceBlock.position[axis])) {
            furnace.close(); furnace = null;
            await recoverHouseOwnedFurnace({ position: owned.position, input, output: oldOutput });
            checkTaskSignal();
            furnace = await physicalOpenFurnace(furnaceBlock);
            lastObservedState = '';
            continue;
          }
          throw new Error(`熔炉已有其他材料 ${pendingInput?.name || outputItem?.name}，无法继续冶炼 ${outputName}`);
        }
        if (outputItem?.name === outputName) {
          await withTimeout(
            furnace.takeOutput(),
            DEFAULT_CONTAINER_TIMEOUT_MS,
            `取出 ${outputName} 超时`
          );
          heartbeat();
          await sleep(150);
          continue;
        }
        const currentInput = furnace.inputItem();
        const remaining = targetCount - countFurnaceInventory(outputName);
        if (currentInput && !inputNames.includes(currentInput.name)) {
          throw new Error(`熔炉已有其他材料 ${currentInput.name}，无法继续冶炼 ${outputName}`);
        }
        if (countFurnaceInventory(inputNames) + Number(currentInput?.count || 0) < remaining) {
          throw new Error(`缺少可冶炼材料：${inputNames.join(" / ")}，还需要 ${remaining} 个`);
        }
        if (!currentInput) {
          const inputItem = findFurnaceInventoryItem(inputNames);
          if (!inputItem) {
            throw new Error(`背包里没有可继续冶炼的 ${inputNames.join(" / ")}`);
          }
          await withTimeout(
            furnace.putInput(inputItem.type, inputItem.metadata, Math.min(inputItem.count, remaining)),
            DEFAULT_CONTAINER_TIMEOUT_MS,
            `放入 ${inputItem.displayName || inputItem.name} 超时`
          );
          heartbeat();
          await sleep(120);
          continue;
        }
        const burning = Number(furnace.fuelSeconds) > 0 || Number(furnace.fuel) > 0;
        if (!burning && !furnace.fuelItem()) {
          const fuelItem = findFurnaceInventoryItem([...SMELT_FUEL_ITEM_PRIORITY, ...ANY_PLANKS].filter(name=>name!==outputName));
          if (!fuelItem) {
            furnace.close();
            furnace = null;
            if (!(await ensureFuelForSmelting(1, { allowWoodFuel: true, outputName }))) {
              throw new Error("缺少可用燃料，无法继续冶炼");
            }
            await moveNearBlock(furnaceBlock, 2);
            furnace = await physicalOpenFurnace(furnaceBlock);
            lastObservedState = "";
            continue;
          }
          await withTimeout(
            furnace.putFuel(fuelItem.type, fuelItem.metadata, Math.min(1, fuelItem.count)),
            DEFAULT_CONTAINER_TIMEOUT_MS,
            `放入燃料 ${fuelItem.displayName || fuelItem.name} 超时`
          );
          heartbeat();
          await sleep(120);
          continue;
        }
        const observedState = JSON.stringify({ input: currentInput?.count || 0,
          output: outputItem?.count || 0, fuel: Number(furnace.fuel) || 0,
          fuelSeconds: Number(furnace.fuelSeconds) || 0, progress: Number(furnace.progress) || 0 });
        if (observedState !== lastObservedState) {
          lastObservedState = observedState;
          heartbeat();
        }
        await sleep(350);
      }
      return true;
    } finally {
      try {
        if(!Number.isInteger(furnace?.id)||currentBot?.currentWindow===furnace)furnace?.close();
      } catch (_) {}
    }
  }

  async function ensureBasicPickaxeForStone() {
    let existing = findInventoryItem(PICKAXE_ITEM_NAMES);
    if (existing) {
      return true;
    }
    try {
      await withdrawItemsFromNearbyContainer({
        names: PICKAXE_ITEM_NAMES,
        count: 1,
        progressText: "正在从附近箱子寻找镐子",
      });
    } catch (_) {}
    existing = findInventoryItem(PICKAXE_ITEM_NAMES);
    if (existing) {
      return true;
    }

    await ensureSticks(2);
    const craftingTable = await ensureCraftingTableAvailable();
    if (getItemCountByName("cobblestone") >= 3) {
      await craftItemByName("stone_pickaxe", 1, craftingTable);
      return true;
    }
    try {
      await withdrawItemsFromNearbyContainer({
        names: ["cobblestone"],
        count: 3,
        progressText: "正在从附近箱子拿圆石做镐子",
      });
    } catch (_) {}
    if (getItemCountByName("cobblestone") >= 3) {
      await craftItemByName("stone_pickaxe", 1, craftingTable);
      return true;
    }
    if (getItemCount(ANY_PLANKS) < 3) {
      await ensurePlanks(3);
    }
    await craftItemByName("wooden_pickaxe", 1, craftingTable);
    return true;
  }

  async function ensureStonePickaxeForIron() {
    if (findInventoryItem(["netherite_pickaxe", "diamond_pickaxe", "iron_pickaxe", "stone_pickaxe"])) return true;
    await ensureBasicPickaxeForStone();
    if (getItemCountByName("cobblestone") < 3) {
      await executeMineResource({ args: { block: "stone", count: 3, label: "圆石", maxDistance: 28 } });
    }
    await ensureSticks(2);
    const craftingTable = await ensureCraftingTableAvailable();
    await craftItemByName("stone_pickaxe", 1, craftingTable);
    if (!findInventoryItem(["netherite_pickaxe", "diamond_pickaxe", "iron_pickaxe", "stone_pickaxe"])) {
      throw new Error("需要石镐或更好的镐子才能采集铁矿");
    }
    return true;
  }

  async function ensureBasicAxeForWood() {
    let existing = findInventoryItem(AXE_ITEM_PRIORITY);
    if (existing) {
      return true;
    }
    try {
      await withdrawItemsFromNearbyContainer({
        names: AXE_ITEM_PRIORITY,
        count: 1,
        progressText: "正在从附近箱子寻找斧头",
      });
    } catch (_) {}
    existing = findInventoryItem(AXE_ITEM_PRIORITY);
    if (existing) {
      return true;
    }
    try {
      const hasCraftingTable =
        Boolean(findNearbyCraftingTable(10)) || Boolean(findInventoryItem(["crafting_table"]));
      const requiredPlanks = hasCraftingTable ? 5 : 9;
      const potentialPlanks = getItemCount(ANY_PLANKS) + getTotalLogCount() * 4;
      if (potentialPlanks < requiredPlanks) {
        await bootstrapWoodLogs(Math.ceil((requiredPlanks - potentialPlanks) / 4), 48);
      }
      await craftAvailablePlanksUpTo(requiredPlanks);
      if (getItemCountByName("stick") < 2 && getItemCount(ANY_PLANKS) >= 2) {
        await craftItemByName("stick", 1, null);
      }
      const canMakeCraftingTable =
        hasCraftingTable ||
        Boolean(findInventoryItem(["crafting_table"])) ||
        getItemCount(ANY_PLANKS) >= 4;
      if (!canMakeCraftingTable || getItemCountByName("stick") < 2) {
        return false;
      }
      const craftingTable = await ensureCraftingTableAvailable();
      if (getItemCountByName("cobblestone") >= 3) {
        await craftItemByName("stone_axe", 1, craftingTable);
        return true;
      }
      if (getItemCount(ANY_PLANKS) >= 3) {
        await craftItemByName("wooden_axe", 1, craftingTable);
        return true;
      }
    } catch (error) {
      addTaskLog(
        "warn",
        `这次没能先补出斧头，先继续木材链：${error?.message || "制作斧头失败"}`
      );
      return false;
    }
    return Boolean(findInventoryItem(AXE_ITEM_PRIORITY));
  }

  function getCombatReadinessState() {
    if (findInventoryItem(WEAPON_ITEM_PRIORITY)) {
      return "armed";
    }
    if (findInventoryItem(AXE_ITEM_PRIORITY) || findInventoryItem(PICKAXE_ITEM_NAMES)) {
      return "partial";
    }
    return "unarmed";
  }

  async function ensureCombatWeapon(options = {}) {
    const allowBootstrap = options.allowBootstrap !== false;
    let weapon = findInventoryItem(WEAPON_ITEM_PRIORITY);
    if (weapon) {
      return true;
    }
    try {
      await withdrawItemsFromNearbyContainer({
        names: WEAPON_ITEM_PRIORITY,
        count: 1,
        progressText: "正在从附近箱子寻找武器",
      });
    } catch (_) {}
    weapon = findInventoryItem(WEAPON_ITEM_PRIORITY);
    if (weapon) {
      return true;
    }
    if (!allowBootstrap) {
      return false;
    }

    await ensureSticks(1);
    const craftingTable = await ensureCraftingTableAvailable();
    if (getItemCountByName("cobblestone") >= 2) {
      await craftItemByName("stone_sword", 1, craftingTable);
      return true;
    }
    try {
      await withdrawItemsFromNearbyContainer({
        names: ["cobblestone"],
        count: 2,
        progressText: "正在从附近箱子拿圆石做武器",
      });
    } catch (_) {}
    if (getItemCountByName("cobblestone") >= 2) {
      await craftItemByName("stone_sword", 1, craftingTable);
      return true;
    }
    if (getItemCount(ANY_PLANKS) < 2) {
      await ensurePlanks(2);
    }
    await craftItemByName("wooden_sword", 1, craftingTable);
    return true;
  }

  async function ensureCombatReadiness(options = {}) {
    const ready = await ensureCombatWeapon({
      allowBootstrap: options.allowBootstrap === true,
    });
    const readiness = ready ? "armed" : getCombatReadinessState();
    if (currentTask) {
      currentTask.combatReadiness = readiness;
    }
    return {
      ready,
      readiness,
    };
  }

  function itemNeedsCraftingTable(itemName = "") {
    const normalized = String(itemName || "").trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return (
      normalized === "crafting_table" ||
      normalized === "furnace" ||
      normalized === "chest" ||
      isBedName(normalized) ||
      /(pickaxe|axe|sword|shovel|hoe)$/.test(normalized)
    );
  }

  async function prepareForSkillStep(step) {
    const skill = String(step?.skill || "").trim();
    if (!skill) {
      return;
    }
    if (
      ["follow_player", "escort_player"].includes(skill) &&
      typeof deps?.getPreferredPlayerName === "function" &&
      !String(step?.args?.playerName || "").trim() &&
      !getBestKnownPlayerName()
    ) {
      throw new Error("missing_owner: 请先设置陪玩玩家名，或在命令中明确指定玩家");
    }
    if (step?.args?.expedition === true && getResourceLearningKey(step.args?.block) === "diamond") return;
    const prep = actionRegistry.getPreparationDescriptor(step, {
      resolveBuildMaterial,
      getAliasSpec,
      isWoodBlockName,
      anyPlanks: ANY_PLANKS,
      itemNeedsCraftingTable,
    });
    if (prep.progressText) {
      setTaskProgress(prep.progressText);
    }
    if (prep.logText) {
      addTaskLog("info", prep.logText);
    }
    if (prep.ensureBasicAxe) {
      await ensureBasicAxeForWood();
      return;
    }
    if (prep.ensureBasicPickaxe) {
      await ensureBasicPickaxeForStone();
      return;
    }
    if (prep.ensureCombatReadiness) {
      const readiness = await ensureCombatReadiness({
        allowBootstrap: prep.allowBootstrapCombat === true,
      });
      if (currentTask) {
        currentTask.combatReadiness = readiness.readiness;
        if (prep.markEscortHoldingWithoutWeapon && readiness.readiness !== "armed") {
          currentTask.lastGuardScanResult = "holding_without_weapon";
        }
      }
      return;
    }
    if (prep.prepareCraftItem) {
      await prepareForCraftItem(prep.prepareCraftItem, step.args?.count);
      if (prep.ensureCraftingTable) {
        await ensureCraftingTableAvailable();
      }
      return;
    }
    if (prep.ensureFuelForSmelting && skill !== "smelt_item") {
      await ensureFuelForSmelting(1);
    }
    if (prep.ensureFurnace) {
      await ensureFurnaceAvailable();
    }
  }

  async function prepareForCraftItem(itemName = "", count = 1) {
    const normalized = String(itemName || "").trim().toLowerCase();
    const craftCount = clamp(Number(count) || 1, 1, 32);
    if (!normalized) {
      return;
    }
    if (normalized === "crafting_table") {
      setTaskProgress("正在准备工作台材料");
      await ensurePlanks(4 * craftCount);
      return;
    }
    if (normalized === "furnace") {
      setTaskProgress("正在准备熔炉材料");
      await ensureBasicPickaxeForStone();
      if (getItemCountByName("cobblestone") < 8 * craftCount) {
        await executeMineResource({
          args: {
            block: "stone",
            count: 8 * craftCount,
            label: "圆石",
            maxDistance: 28,
          },
        });
      }
      await ensureCraftingTableAvailable();
      return;
    }
    if (normalized === "chest") {
      setTaskProgress("正在准备箱子材料");
      await ensurePlanks(8 * craftCount);
      await ensureCraftingTableAvailable();
      return;
    }
    if (normalized === "torch") {
      setTaskProgress("正在准备火把材料");
      const recipeCount = Math.ceil(craftCount / 4);
      await ensureSticks(recipeCount);
      if (getItemCount(TORCH_FUEL_ITEM_NAMES) < recipeCount) {
        await ensureFuelForSmelting(recipeCount);
      }
      return;
    }
    if (normalized === "flint_and_steel") {
      setTaskProgress("正在准备打火石材料");
      if (getItemCountByName("iron_ingot") < 1) {
        await buildIronPickaxeProgressionSteps({
          includeFinalCraft: false,
          requiredIronIngots: 1,
        }).reduce(
          async (chain, step) => {
            await chain;
            await executeSkill(step);
          },
          Promise.resolve()
        );
      }
      if (getItemCountByName("flint") < 1) {
        await executeMineResource({
          args: {
            block: "flint",
            count: 1,
            label: "燧石",
            maxDistance: 28,
          },
        });
      }
      return;
    }
    if (isBedName(normalized)) {
      setTaskProgress("正在准备床铺材料");
      const woolName = normalized.replace(/_bed$/, "_wool");
      await ensurePlanks(3 * craftCount);
      if (getItemCountByName(woolName) < 3 * craftCount) {
        try {
          await withdrawItemsFromNearbyContainer({
            names: [woolName],
            count: 3 * craftCount,
            progressText: `正在从附近箱子拿 ${woolName}`,
          });
        } catch (_) {}
      }
      await ensureCraftingTableAvailable();
      return;
    }
    if (normalized === "bread") {
      setTaskProgress("正在准备面包材料");
      if (getItemCountByName("wheat") < 3 * craftCount) {
        try {
          await withdrawItemsFromNearbyContainer({
            names: ["wheat"],
            count: 3 * craftCount,
            progressText: "正在从附近箱子拿小麦做面包",
          });
        } catch (_) {}
      }
      return;
    }
    if (["wooden_pickaxe", "wooden_axe", "wooden_sword"].includes(normalized)) {
      setTaskProgress(`正在准备 ${normalized} 的材料`);
      await ensureSticks((normalized === "wooden_sword" ? 1 : 2) * craftCount);
      await ensureCraftingTableAvailable();
      await ensurePlanks((normalized === "wooden_sword" ? 2 : 3) * craftCount);
      return;
    }
    if (["stone_pickaxe", "stone_axe", "stone_sword"].includes(normalized)) {
      const neededCobble = (normalized === "stone_sword" ? 2 : 3) * craftCount;
      setTaskProgress(`正在准备 ${normalized} 的材料`);
      await ensurePlanks(3);
      await ensureSticks(normalized === "stone_sword" ? 1 : 2);
      await ensureCraftingTableAvailable();
      await ensureBasicPickaxeForStone();
      if (getItemCountByName("cobblestone") < neededCobble) {
        await executeMineResource({
          args: {
            block: "stone",
            count: neededCobble,
            label: "圆石",
            maxDistance: 20,
          },
        });
      }
      await ensureSticks((normalized === "stone_sword" ? 1 : 2) * craftCount);
      return;
    }
    if (["iron_pickaxe", "iron_axe", "iron_sword"].includes(normalized)) {
      const neededIngots = (normalized === "iron_sword" ? 2 : 3) * craftCount;
      setTaskProgress(`正在准备 ${normalized} 的材料`);
      await ensurePlanks(3);
      await ensureSticks(normalized === "iron_sword" ? 1 : 2);
      await ensureCraftingTableAvailable();
      await ensureStonePickaxeForIron();
      if (getItemCountByName("iron_ingot") < neededIngots) {
        if (getItemCount(IRON_ORE_ITEM_NAMES) < neededIngots) {
          await executeMineResource({
            args: {
              block: "iron_ore",
              count: neededIngots,
              label: "铁矿",
              maxDistance: 40,
            },
          });
        }
        await executeSmeltItem({
          args: {
            inputItems: IRON_ORE_ITEM_NAMES,
            output: "iron_ingot",
            count: neededIngots,
          },
        });
      }
      await ensureSticks((normalized === "iron_sword" ? 1 : 2) * craftCount);
      return;
    }
    if (["diamond_pickaxe", "diamond_axe", "diamond_sword"].includes(normalized)) {
      const neededDiamonds = normalized === "diamond_sword" ? 2 : 3;
      setTaskProgress(`正在准备 ${normalized} 的材料`);
      await ensurePlanks(3);
      await ensureSticks(normalized === "diamond_sword" ? 1 : 2);
      await ensureCraftingTableAvailable();
      if (getItemCountByName("diamond") < neededDiamonds) {
        await executeMineResource({
          args: {
            block: "diamond",
            count: neededDiamonds,
            label: "钻石",
            maxDistance: getLearnedSearchRadius("diamond", 48, 96),
          },
        });
      }
      return;
    }
    if (normalized === "blaze_powder") {
      setTaskProgress("正在准备烈焰粉材料");
      if (getItemCountByName("blaze_rod") < 1) {
        throw new Error("缺少 blaze_rod，当前无法合成烈焰粉");
      }
      return;
    }
    if (normalized === "eye_of_ender") {
      setTaskProgress("正在准备末影之眼材料");
      if (getItemCountByName("ender_pearl") < craftCount) {
        throw new Error("缺少 ender_pearl，当前无法合成末影之眼");
      }
      if (getItemCountByName("blaze_powder") < craftCount) {
        if (getItemCountByName("blaze_rod") < Math.ceil(craftCount / 2)) {
          throw new Error("缺少 blaze_rod / blaze_powder，当前无法合成末影之眼");
        }
        await craftItemByName("blaze_powder", craftCount - getItemCountByName("blaze_powder"), null);
      }
    }
  }

  async function ensureMiningToolByPriority(
    toolNames = [],
    progressText = "正在寻找合适的镐子"
  ) {
    let existing = findInventoryItem(toolNames);
    if (existing) {
      return true;
    }
    try {
      await withdrawItemsFromNearbyContainer({
        names: toolNames,
        count: 1,
        progressText,
      });
    } catch (_) {}
    existing = findInventoryItem(toolNames);
    return Boolean(existing);
  }

  function isWoodBlockName(name = "") {
    return Object.prototype.hasOwnProperty.call(LOG_TO_PLANK, String(name || "").trim());
  }

  function findBestFoodItem() {
    for (const name of FOOD_ITEM_PRIORITY) {
      const item = findInventoryItem([name]);
      if (item) {
        return item;
      }
    }
    const bot=currentBot;
    if(getExecutionContext()?.houseSelfSupply&&bot?.food<18){
      const raw=findInventoryItem(["beef","porkchop","mutton","rabbit","cod","salmon"]);
      if(raw)return raw;
      if(bot.health<20)return findInventoryItem(["rotten_flesh"]);
    }
    return null;
  }

  function getFoodReserveCount() {
    return getItemCount(FOOD_ITEM_PRIORITY);
  }

  const FOOD_SMELTING = {
    beef: "cooked_beef", porkchop: "cooked_porkchop", mutton: "cooked_mutton",
    chicken: "cooked_chicken", rabbit: "cooked_rabbit", cod: "cooked_cod",
    salmon: "cooked_salmon", potato: "baked_potato",
  };
  const SURFACE_HAZARDS = new Set([
    "water", "lava", "fire", "soul_fire", "magma_block", "powder_snow",
    "campfire", "soul_campfire", "sweet_berry_bush", "cactus", "wither_rose",
    "bubble_column", "seagrass", "tall_seagrass", "kelp", "kelp_plant",
  ]);
  let foodSupplyRunning = false;

  async function withSurfaceResourceMovements(action, budget = {}) {
    const bot = ensureBotReady();
    const outerContext = getExecutionContext() || {};
    // A meal/resource boundary may begin between the scheduler's threat read
    // and the emergency action's completion. Do not replace that action's
    // captured movement profile merely by entering this nested wrapper.
    const defenseAtEntry=activeSurvivalInterrupt;
    if(defenseAtEntry&&!defenseAtEntry.finished&&defenseAtEntry.bot===bot
      &&outerContext.pausedSurvivalOwner!==defenseAtEntry){
      await settleSurvivalDefense("resource_boundary_wait");
      checkTaskSignal();
      if(currentBot!==bot)throw createAbortError("bot_connection_lost");
    }
    const ownerTask = outerContext.task || currentTask;
    const ownerGeneration = ownerTask?.executionGeneration;
    const ownerToken = outerContext.token || getActiveCancellationToken();
    const ownerLease = getCurrentMovementLease();
    const deadline = Number.isFinite(budget?.deadline) ? budget.deadline : null;
    ownerToken?.throwIfRequested(); checkTaskSignal();
    if (deadline !== null && Date.now() >= deadline) throw Object.assign(new Error("原采集预算已结束"), { code: "house_resource_leg_limit" });
    const parentWork = activeHouseResourceWork;
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowFreeMotion = false;
    movements.allowParkour = false;
    movements.allowSprinting = outerContext.selfSupplyOnly !== true;
    if (outerContext.selfSupplyOnly === true) movements.getMoveDiagonal = () => {};
    movements.maxDropDown = 2;
    movements.infiniteLiquidDropdownDistance = false;
    movements.scafoldingBlocks = [];
    // Reuse pathfinder's entity collision cost to prefer going around mobs;
    // an ordinary resource route should not cut directly through their bodies.
    for(const name of ["creeper","spider","cave_spider","zombie","zombie_villager","husk","drowned","skeleton","stray","bogged"])movements.entitiesToAvoid.add(name);
    for (const name of SURFACE_HAZARDS) {
      const id = bot.registry.blocksByName[name]?.id;
      if (id != null) movements.blocksToAvoid.add(id);
    }
    // Pathfinder invokes step exclusions for both feet and head clearance.
    // Reject unknown/hazardous blocks around either, including a magma floor;
    // checking only the destination or requiring a solid floor here is wrong.
    movements.exclusionAreasStep.push((block) => block?.position && typeof block.position.offset === "function" && [-1, 0, 1].every((dy) => {
      const nearby = bot.blockAt(block.position.offset(0, dy, 0));
      return nearby && !SURFACE_HAZARDS.has(nearby.name) && ![true, "true"].includes(nearby.getProperties?.().waterlogged);
    }) ? 0 : Infinity);
    const surfaceEdgeAllowed = createSurfaceHazardEdgePolicy(bot);
    movements.exclusionAreasStep.push(block => surfaceEdgeAllowed(block?.position) ? 0 : Infinity);
    if(outerContext.selfSupplyOnly===true)movements.exclusionAreasStep.push(block=>
      allowsUnarmedHouseRangedStep(bot,block?.position,ownerTask)?0:Infinity);
    const work = { bot, client: bot._client, task: ownerTask, generation: ownerGeneration,
      token: ownerToken, lease: ownerLease, movements, closed: false, deadline,
      gatheringHouse: outerContext.selfSupplyOnly === true && ownerTask?.intent === "build_furnished_house" };
    movements.exclusionAreasStep.push(block => {
      if (!work.gatheringHouse || deadline === null) return 0;
      if (activeSurvivalInterrupt?.resourceWork === work && isSurvivalOwnerCurrent(activeSurvivalInterrupt)
        && isMovementLeaseActive(activeSurvivalInterrupt.lease)) return 0;
      if (work.closed || activeHouseResourceWork !== work || currentTask !== ownerTask || currentBot !== bot
        || ownerTask.executionGeneration !== ownerGeneration || ownerToken?.cancelled || ownerToken?.pauseRequested
        || !isMovementLeaseActive(ownerLease)) return Infinity;
      const nearby = nearbyHouseResourceThreats(bot), melee = nearby.filter(e => e.name !== "creeper");
      const dangers = [...nearby.filter(e => e.name === "creeper"), ...(melee.length >= 2 ? melee : [])];
      return block?.position && dangers.every(e => Math.hypot(block.position.x + .5 - e.position.x,
        block.position.z + .5 - e.position.z) >= Math.min(7.5, Math.hypot(bot.entity.position.x - e.position.x,
        bot.entity.position.z - e.position.z) - .5)) ? 0 : Infinity;
    });
    activeHouseResourceWork = work;
    try {
      return await executionContextStorage.run({ ...outerContext, miningMovements: movements }, async () => {
        ensureMovements(bot);
        return action();
      });
    } finally {
      const defense=activeSurvivalInterrupt,until=Date.now()+35000;
      if(defense&&!defense.finished&&defense.task===ownerTask&&defense.bot===bot
        &&defense.previousLease===work.lease&&(defense.workToken||defense.token)===ownerToken){
        while(currentBot===bot&&currentTask===ownerTask&&ownerTask.executionGeneration===ownerGeneration
          &&ownerTask.status===TaskState.RUNNING&&!ownerToken?.cancelled&&!ownerToken?.pauseRequested
          &&isSurvivalOwnerCurrent(defense)&&isMovementLeaseActive(defense.lease)&&!defense.finished&&Date.now()<until){
          await Promise.race([defense.finishedPromise,sleep(50)]);
        }
      }
      work.closed = true;
      if (activeHouseResourceWork === work) activeHouseResourceWork = parentWork;
      if (currentBot === bot && currentTask === ownerTask && ownerTask?.executionGeneration === ownerGeneration
        && !ownerToken?.cancelled && !ownerToken?.pauseRequested && (!ownerLease || isMovementLeaseActive(ownerLease))
        && appliedMovementsInstance === movements) {
        appliedMovementsBot = null;
        appliedMovementsInstance = null;
        ensureMovements(bot);
      }
    }
  }

  async function resumeHouseResourceAfterSurvival(error, { deadline, bot } = {}) {
    if (error?.code !== "movement_preempted" || !Number.isFinite(deadline) || deadline <= Date.now()) return false;
    const context = getExecutionContext(), task = context?.task;
    const retainedFailure = getHouseSurfaceDefenseFailure();
    if (retainedFailure) throw retainedFailure;
    const interrupt = error.survivalInterrupt || activeSurvivalInterrupt;
    const work = activeHouseResourceWork;
    if (!task || !work || work.closed || work.task !== task || work.bot !== bot ||
        !interrupt || interrupt.bot !== bot || interrupt.client !== bot._client || interrupt.task !== task ||
        interrupt.runGeneration !== task.executionGeneration || (interrupt.workToken||interrupt.token) !== context.token || work.token !== context.token ||
        interrupt.previousLease !== context.movementLease || work.lease !== interrupt.previousLease) {
      if(task)recordTaskDiagnostic(task,"house_resource_resume_owner_rejected",{hasWork:Boolean(work),closed:work?.closed===true,
        sameTask:work?.task===task,sameBot:work?.bot===bot,hasInterrupt:Boolean(interrupt),
        sameInterruptTask:interrupt?.task===task,sameInterruptClient:interrupt?.client===bot?._client,
        sameGeneration:interrupt?.runGeneration===task.executionGeneration,
        sameToken:(interrupt?.workToken||interrupt?.token)===context?.token,
        samePreviousLease:interrupt?.previousLease===context?.movementLease,
        sameWorkLease:work?.lease===interrupt?.previousLease,interruptFinished:interrupt?.finished===true,
        defenseError:interrupt?.error?.code||null});
      return false;
    }
    const assertOwner = () => {
      context.token?.throwIfRequested(); checkTaskSignal();
      if (currentTask !== task || currentBot !== bot || bot._client !== work.client || work.closed ||
          activeHouseResourceWork !== work || task.executionGeneration !== work.generation ||
          (bot.pathfinder.movements !== work.movements && !(
            activeSurvivalInterrupt===interrupt&&!interrupt.finished&&isMovementLeaseActive(interrupt.lease)
              &&(ownsSurvivalTemporaryProfile(bot,interrupt.lease)||bot.pathfinder.movements===interrupt.stationaryMovements)
            ||interrupt.finished&&!interrupt.error&&isMovementLeaseActive(work.lease)
              &&bot.pathfinder.movements===interrupt.previousMovements))
          || !isSurvivalOwnerCurrent(interrupt)) throw createAbortError("movement_preempted");
    };
    const until = Math.min(deadline, Number.isFinite(interrupt.deadline)?interrupt.deadline+250:Date.now()+(interrupt.rangedEngagement?32500:8000));
    while (!interrupt.finished) {
      assertOwner();
      if (!isMovementLeaseActive(interrupt.lease) || Date.now() >= until) throw error;
      await sleep(20);
    }
    // Retain the failed defense's own cause before checking its released lease.
    // The original task/token identity was already checked above.
    if (interrupt.error) throw interrupt.error;
    assertOwner();
    ensureMovementLeaseActive(work.lease);
    const landingDeadline = Math.min(until, Date.now() + 1200);
    while (!hasGroundedBodySupport(bot)) {
      assertOwner(); ensureMovementLeaseActive(work.lease);
      if (!inspectSurfaceBody(bot).dry || Date.now() >= landingDeadline) throw Object.assign(
        new Error("自卫后没有在原时限内确认真实干地支撑"), { code: "house_surface_defense_ground_unconfirmed" });
      await sleep(20);
    }
    if (Date.now() >= deadline) throw error;
    assertOwner(); ensureMovementLeaseActive(work.lease);
    // Dig/equip interruptions can retreat just like goto interruptions. Carry
    // the same confirmed defense witness back to the quarry so it reconciles
    // its actual earlier cursor instead of replaying the exposed old frontier.
    if(interrupt.rangedCover?.confirmed&&interrupt.miningRetreatThreat){
      const quarry=task.materialSupply?.quarry,nav=quarry?.routes?.[quarry.activeResource]?.navigation;
      const index=nav?.breadcrumbs?.slice(0,nav.routeIndex+1).findLastIndex(p=>bot.entity.position.floored().equals(toVec3(p)));
      if(Number.isSafeInteger(index)&&index>=0&&index<nav.routeIndex){
        error.survivalInterrupt=interrupt;error.observedMiningRetreat=true;
      }
    }
    recordTaskDiagnostic(task, "house_resource_survival_resumed", { actualPosition: toPlainPosition(bot.entity.position),
      originalDeadline: deadline, primitiveReplayed: false });
    return true;
  }

  function safeSurfaceFoot(position) {
    const bot = ensureBotReady();
    const foot = toVec3(position)?.floored();
    // Match the dry return graph: non-colliding aquatic blocks are still wet.
    // Recording them as dry witnesses creates a route that cannot be replayed.
    return Boolean(foot && naturalWalkingFoot(bot, foot));
  }

  async function waitForSurfaceGround(label) {
    const bot = ensureBotReady();
    const deadline = Date.now() + 2000;
    while (bot.entity.onGround === false) {
      checkTaskSignal();
      if (Date.now() >= deadline) {
        const error = new Error(`${label}前尚未落稳，已停止当前地表动作`);
        error.code = "surface_not_grounded";
        throw error;
      }
      await sleep(50);
    }
    checkTaskSignal();
  }

  function immediateFoodThreat(bot) {
    return Object.values(bot.entities||{}).some(e=>{
      if(e===bot.entity||e.isValid===false||!isThreateningMobEntity(e,bot.registry)||!e.position)return false;
      const ranged=isHouseRangedThreatEntity(e);
      if(terrainSeparatedHouseMelee(bot,e))return false;
      const melee=["zombie","zombie_villager","husk","drowned","spider","cave_spider"].includes(e.name);
      if(Math.abs(e.position.y-bot.entity.position.y)>(ranged?8:4))return false;
      return e.position.distanceTo(bot.entity.position)<(e.name==="creeper"?8.5:ranged?24:melee?4.5:16)
        &&(!ranged||require("./minecraft/houseRangedCombat").shouldInterruptWorkForRanged(bot,e,Date.now()-Number(combatMemory.lastBotHurtAt||0)<6500)
          &&!require("./minecraft/houseRangedCover").isHouseRangedPursuitDeferred(bot,e)&&!rangedCoverConfirmed(bot,bot.entity.position,[e]));
    });
  }

  async function settleHouseFoodThreats(deadline,reason){
    while(true){
      checkTaskSignal();
      if(!Number.isFinite(deadline)||Date.now()>=deadline)throw Object.assign(Error('原补给时限内尚未收束紧迫威胁'),{code:'house_food_defense_deadline'});
      const handled=await settleSurvivalDefense(reason);checkTaskSignal();
      if(!immediateFoodThreat(ensureBotReady()))return;
      if(!handled)throw Object.assign(Error('紧迫食物威胁未取得原任务自卫控制权'),{code:'house_food_defense_unhandled'});
      await sleep(20);
    }
  }

  function assertHuntingHealth() {
    if (Number.isFinite(currentBot?.health) && currentBot.health <= 10) {
      const bot=currentBot;
      if(bot.health>0&&(foodSupplyRunning||bot.health>=6)&&(getExecutionContext()?.houseSelfSupply
        ||getExecutionContext()?.housePreSiteBootstrap===true&&bot.health>=6
          &&require("./minecraft/houseAutomaticRecovery").selfGatheredHouseWork(currentTask))&&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry
        &&!immediateFoodThreat(bot))return;
      const error = new Error("生命值不足，已停止狩猎并返回营地");
      error.code = "food_supply_low_health";
      throw error;
    }
  }

  function surfaceSearchPositions(anchor, maxDistance = 64) {
    const origin = toVec3(anchor).floored();
    const positions = [];
    const maximum = clamp(Number(maxDistance) || 64, 16, 96);
    for (let radius = 16; radius <= maximum; radius += 16) {
      for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]]) {
        const scale = radius / Math.hypot(dx, dz);
        positions.push(origin.offset(Math.round(dx * scale), 0, Math.round(dz * scale)));
      }
    }
    return positions;
  }

  async function exploreNextSurfacePosition(positions, options = {}) {
    const bot = ensureBotReady();
    const selfSupply = getExecutionContext()?.selfSupplyOnly === true;
    const diagnostics = { rejected: { unloaded: 0, hazard: 0, noDryFoot: 0, protected: 0 }, attempts: [] };
    while (positions.length) {
      checkTaskSignal();
      if(Number.isFinite(options.deadline)&&Date.now()>=options.deadline)throw Object.assign(Error("地表补给探路达到原任务时限"),{code:"house_food_search_timeout"});
      const column = positions.shift();
      const targets = [];
      const horizontal = selfSupply ? [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8],
        [12, 12], [-12, 12], [-12, -12], [12, -12]] : [[0, 0]];
      const origin = bot.entity.position.clone();
      for (const [dx, dz] of horizontal) {
        let target;
        for (let offset = 0; offset <= (selfSupply ? 32 : 12) && !target; offset += 1) {
          for (const dy of offset ? [-offset, offset] : [0]) {
            const candidate = new Vec3(column.x + dx, Math.floor(origin.y) + dy, column.z + dz);
            if (selfSupply && (Math.hypot(candidate.x - origin.x, candidate.z - origin.z) > 56
              || Math.hypot(candidate.x - origin.x, candidate.z - origin.z) < 4)) continue;
            if (selfSupply && houseResourcePositionExcluded(candidate)) { diagnostics.rejected.protected += 1; continue; }
            const blocks = [bot.blockAt(candidate), bot.blockAt(candidate.offset(0, 1, 0)), bot.blockAt(candidate.offset(0, -1, 0))];
            if (blocks.some(block => !block)) { diagnostics.rejected.unloaded += 1; continue; }
            if (blocks.some(block => SURFACE_HAZARDS.has(block.name) || block.getProperties?.().waterlogged === true)) {
              diagnostics.rejected.hazard += 1; continue;
            }
            if (safeSurfaceFoot(candidate)) { target = candidate; break; }
            diagnostics.rejected.noDryFoot += 1;
          }
        }
        if (target) targets.push(target);
      }
      for (const target of targets) {
        checkTaskSignal();
        try {
          if(Number.isFinite(options.deadline)&&Date.now()>=options.deadline)throw Object.assign(Error("地表补给探路达到原任务时限"),{code:"house_food_search_timeout"});
          const maximumTimeout = selfSupply ? clamp(Math.ceil(bot.entity.position.distanceTo(target) / 3 * 1000) + 10000, 10000, 45000) : 8000;
          const timeout=Number.isFinite(options.deadline)?Math.max(1,Math.min(maximumTimeout,options.deadline-Date.now())):maximumTimeout;
          await pathfinderGoto(new goals.GoalBlock(target.x, target.y, target.z), timeout, "地表资源探查移动超时");
          await sleep(300); checkTaskSignal();
          if (selfSupply) {
            await waitForSurfaceGround("自给地表探索");
            if (!safeSurfaceFoot(bot.entity.position) || bot.entity.position.distanceTo(origin) < 0.1
              || bot.entity.position.floored().distanceTo(target) > 1) throw Object.assign(new Error("原生探路尚未确认在目标干燥落稳"), { code: "house_surface_move_unconfirmed" });
          }
          return options.detailed ? { moved: true, diagnostics } : true;
        } catch (error) {
          checkTaskSignal();
          if(error?.code === "house_food_search_timeout")throw error;
          if(error?.code === "movement_preempted") {
            if(await resumeHouseResourceAfterSurvival(error,{deadline:Math.min(Number.isFinite(options.deadline)?options.deadline:Infinity,Date.now()+35000),bot})) continue;
            throw error;
          }
          diagnostics.attempts.push({ target: toPlainPosition(target), code: error.code || error.name || "path_error", message: String(error.message || error).slice(0, 240) });
          if (selfSupply) setTaskProgress(`自给探路尝试绕行：${error.code || error.name || "无路"}，目标 ${target.x},${target.y},${target.z}`);
        }
      }
    }
    const reason = diagnostics.attempts.length ? `全部 ${diagnostics.attempts.length} 个干燥替代目标原生寻路失败：${diagnostics.attempts.at(-1).message}`
      : `已加载列中未找到安全落脚点：未加载 ${diagnostics.rejected.unloaded}，危险或流体 ${diagnostics.rejected.hazard}，无干燥支撑 ${diagnostics.rejected.noDryFoot}，保护区 ${diagnostics.rejected.protected}`;
    if (selfSupply) setTaskProgress(`自给探路暂时受阻：${reason}`);
    return options.detailed ? { moved: false, reason, diagnostics } : false;
  }

  async function returnToFoodAnchor(anchor) {
    const bot = ensureBotReady();
    checkTaskSignal();
    const houseSource=getExecutionContext()?.houseSelfSupply;
    const houseCamp=houseSource?.getCamp?.();
    if(houseCamp&&typeof houseSource.returnCamp==="function"&&toVec3(houseCamp).equals(anchor)){
      await houseSource.returnCamp();checkTaskSignal();return;
    }
    stopBotActions();
    const returnTimeoutMs = foodReturnTimeoutMs(bot.entity.position, anchor);
    await pathfinderGoto(new goals.GoalNear(anchor.x, anchor.y, anchor.z, 1),
      returnTimeoutMs, "补给后返回营地超时");
    const deadline = Date.now() + 2000;
    while (bot.entity.onGround === false && Date.now() < deadline) {
      checkTaskSignal();
      await sleep(50);
    }
    if (bot.entity.onGround === false || bot.entity.position.floored().distanceTo(anchor.floored()) > 1) {
      throw new Error("补给后尚未在营地入口落稳，已停止返回矿道");
    }
  }

  function readyFoodCount() {
    return getItemCount(FOOD_ITEM_PRIORITY.filter((name) => !FOOD_SMELTING[name]));
  }

  function foodPointsByName(name) {
    const points = Number(currentBot?.registry.foodsByName?.[name]?.foodPoints);
    return Number.isFinite(points) && points > 0 ? points : 0;
  }

  function readyFoodPoints() {
    return FOOD_ITEM_PRIORITY.filter((name) => !FOOD_SMELTING[name])
      .reduce((total, name) => total + getItemCountByName(name) * foodPointsByName(name), 0);
  }

  function isHuntableFoodAnimal(entity, anchor, maxDistance) {
    const sourceRabbit = entity?.name === "rabbit" && getExecutionContext()?.selfSupplyOnly === true;
    let drySurface = entity?.position && safeSurfaceFoot(entity.position);
    if (sourceRabbit && !drySurface) {
      // A rabbit normally jumps while fleeing. Its observed dry landing
      // column remains eligible; this does not permit the bot to enter fluid.
      for (let below = 1; below <= 2 && !drySurface; below += 1) drySurface = safeSurfaceFoot(entity.position.offset(0, -below, 0));
    }
    if (!entity?.position || entity.username || entity.type === "player" || entity.isValid === false ||
      !["cow", "pig", "sheep", "chicken", ...(sourceRabbit ? ["rabbit"] : [])].includes(entity.name) ||
      entity.position.distanceTo(anchor) > maxDistance || !drySurface) return false;
    const keys = currentBot.registry.entitiesByName?.[entity.name]?.metadataKeys || [];
    const babyIndex = keys.indexOf("baby");
    if (entity.metadata?.[babyIndex >= 0 ? babyIndex : 16] === true) return false;
    const healthIndex = keys.indexOf("health");
    if (Number(entity.metadata?.[healthIndex >= 0 ? healthIndex : 9]) <= 0) return false;
    const nameIndex = keys.indexOf("custom_name");
    return !entity.metadata?.[nameIndex >= 0 ? nameIndex : 2];
  }

  async function huntFoodAnimal(target, anchor, maxDistance) {
    const bot = ensureBotReady();
    const deadline = Date.now() + 30000;
    let lastPosition = target.position.clone();
    // Arm and charge before approaching a fleeing animal. Waiting to equip
    // after arrival gives it the whole weapon-switch cooldown to escape.
    checkTaskSignal();const initialWeapon=bot.heldItem?.type;
    await equipBestWeapon();checkTaskSignal();
    const firstReady=meleeAttackReadyAt(Math.max(combatMemory.lastOwnAttackAt||0,
      initialWeapon!==bot.heldItem?.type?Date.now():0),bot.heldItem?.name);
    if(firstReady>Date.now())await sleep(firstReady-Date.now());checkTaskSignal();
    while (Date.now() < deadline) {
      checkTaskSignal();
      if(foodSupplyRunning&&getExecutionContext()?.houseSelfSupply)await settleHouseFoodThreats(deadline,"food_hunt_urgent_safety");
      const live = bot.entities[target.id];
      if (!live || live.isValid === false) break;
      const keys = bot.registry.entitiesByName?.[live.name]?.metadataKeys || [];
      const healthIndex = keys.indexOf("health");
      if (Number(live.metadata?.[healthIndex >= 0 ? healthIndex : 9]) <= 0) break;
      if (!isHuntableFoodAnimal(live, anchor, maxDistance)) throw new Error("动物离开安全采食范围");
      assertHuntingHealth();
      lastPosition = live.position.clone();
      const distance = bot.entity.position.distanceTo(live.position);
      if (meleeReachDistance(bot.entity, live) > 2.5) {
        // A naturally spawned animal can be 64m away. Allow ordinary surface travel,
        // with a hard bound for a moving/unreachable target and this entire attempt.
        const approachMs = Math.min(deadline - Date.now(), clamp(Math.ceil(distance / 3 * 1000) + 4000, 6000, 26000));
        try {
          recordTaskDiagnostic(currentTask,'house_food_native_approach_started',{targetId:live.id,targetName:live.name,
            weapon:bot.heldItem?.name,range:2,deadline,actual:toPlainPosition(bot.entity.position),target:toPlainPosition(live.position)});
          await pathfinderGoto(new (require('./minecraft/houseHuntingApproach').HouseFoodApproachGoal)(live),approachMs,"接近食用动物超时");
        }
        catch(error){
          checkTaskSignal();
          if(!require("./minecraft/houseLocalRoute").isHouseFoodApproachRouteFailure(error))throw error;
          if(!getExecutionContext()?.houseSelfSupply||Date.now()>=deadline||!isHuntableFoodAnimal(live,anchor,maxDistance)
            ||!await recoverHouseLocalRoute(getExecutionContext().task,toPlainPosition(live.position.floored()),deadline))throw error;
        }
      }
      await waitForSurfaceGround("狩猎");
      assertHuntingHealth();
      if (meleeReachDistance(bot.entity, live) > 2.75) continue;
      stopBotActions();
      const previousWeapon = bot.heldItem?.type;
      await equipBestWeapon();
      // Ordinary hunting can wait for a newly selected weapon to charge.
      // Emergency retaliation retains its separate immediate-contact path.
      const selectedAt = Date.now();
      const readyAt = meleeAttackReadyAt(Math.max(combatMemory.lastOwnAttackAt || 0,
        previousWeapon !== bot.heldItem?.type ? selectedAt : 0), bot.heldItem?.name);
      if (readyAt > Date.now()) await sleep(readyAt - Date.now());
      checkTaskSignal();
      if (bot.entities[live.id] !== live || live.isValid === false || meleeReachDistance(bot.entity, live) > 2.75) continue;
      await safeBotLookAt(live.position.offset(0, Math.min(1, live.height || 0.5), 0), true,
        { reason: "hunt_food", targetName: live.name });
      await physicalAttack(live, live.name);
      recordTaskHeartbeat(currentTask, { actionState: "acting",
        checkpoint: { kind: "hunt_food", animal: live.name, entityId: live.id }, clearRecoveryReason: true });
      // Full attack cooldown, including slow axes. Sending a packet is not a kill.
      await sleep(bot.heldItem?.name?.endsWith("_axe") ? 1300 : 750);
    }
    stopBotActions();
    await sleep(700); // Death animation and item entities arrive after the last hit.
    await collectNearbyDroppedItems({ position: lastPosition, radius: 5, timeoutMs: 5000 });
  }

  function saveEmergencyFoodPath(ownerTask, path) {
    const previous=ownerTask.materialSupply.surfaceResources||{};
    ownerTask.materialSupply.surfaceResources={...previous,searches:{...previous.searches,
      survival_food:{...previous.searches?.survival_food,observedPath:path}}};
  }

  async function exploreEmergencyFood(deadline) {
    const bot=ensureBotReady(),context=getExecutionContext(),ownerTask=context?.task||currentTask;
    const source=context?.houseSelfSupply,anchor=source?.getCamp?.(),resource="survival_food";
    if(!source||!anchor||!foodSupplyRunning)return false;
    checkTaskSignal();assertHuntingHealth();
    const active=()=>{checkTaskSignal();if(Date.now()>=deadline)throw Object.assign(Error("地表补给探索达到原任务时限"),{code:"house_food_search_timeout"});};
    return require("./minecraft/houseFoodSearch").advanceFoodFrontier({
      anchor,getPosition:()=>bot.entity.position,getCheckpoint:()=>ownerTask.materialSupply.surfaceGraphs?.[resource],assertActive:active,
      savePath:path=>saveEmergencyFoodPath(ownerTask,path),
      returnToRoot:async()=>{
        // Reuse camp transport and its fresh native connectors before trying
        // a local direct root approach. The source preserves pending routes.
        if(typeof source.returnCamp==='function'){
          await source.returnCamp();active();
          if(!bot.entity.position.floored().equals(toVec3(anchor))||!hasGroundedBodySupport(bot))
            throw Object.assign(Error('补给恢复尚未实际回到原固定起点'),{code:'house_food_root_unreachable'});
          recordTaskDiagnostic(ownerTask,'house_food_fixed_root_recovered',{anchor,actual:toPlainPosition(bot.entity.position),oldTraversalCredit:false});
          return;
        }
        // Start this transport graph only after actual arrival at its fixed root.
        for(let attempt=0;!bot.entity.position.floored().equals(toVec3(anchor));attempt++){
          active();if(attempt>=3)throw Object.assign(Error("紧急采食未能实际接回补给起点"),{code:"house_food_root_unreachable"});
          try{await houseSurfacePathfinderGoto(new goals.GoalBlock(anchor.x,anchor.y,anchor.z),Math.min(20000,deadline-Date.now()),{deadline});}
          catch(error){active();if(!await recoverHouseLocalRoute(ownerTask,anchor,Math.min(deadline,Date.now()+20000)))throw error;}
        }
      },rejoin:async()=>{
        await exploreHouseSurfaceGraph(ownerTask,resource,anchor,()=>{}, {returnToAnchor:true,rejoinInterruptedSuffix:true,
          provisioningReturn:true,assertGraphActive:active,via:ownerTask.materialSupply.surfaceResources?.searches?.[resource]?.observedPath||[]});
      },explore:async()=>{
        context.houseSurfaceResource=resource;
        recordTaskDiagnostic(ownerTask,"house_bootstrap_food_strategy_changed",{strategy:"observed_surface_and_water_graph",health:bot.health,food:bot.food});
        return exploreHouseSurfaceGraph(ownerTask,resource,anchor,()=>{}, {survivalProvisioning:true,assertGraphActive:active,excludeBounds:[]});
      }});
  }

  async function exploreHouseLocalFood(deadline) {
    const bot=ensureBotReady(),context=getExecutionContext(),ownerTask=context?.task;
    if(!foodSupplyRunning||!context?.houseSelfSupply||ownerTask?.materialSupply?.materialSource!=='self_gathered')return false;
    const client=bot._client,generation=ownerTask.executionGeneration,token=context.token;
    const active=()=>{token?.throwIfRequested();checkTaskSignal();
      if(currentBot!==bot||bot._client!==client||currentTask!==ownerTask||ownerTask.executionGeneration!==generation)
        throw createAbortError('movement_preempted');
      const failure=getHouseSurfaceDefenseFailure();if(failure)throw failure;
      if(Date.now()>=deadline)throw createAbortError('house_food_search_timeout');};
    await settleSurvivalDefense('local_food_frontier');active();
    await alignHouseResourceGraphOrigin(ownerTask,Math.min(deadline,Date.now()+12000));active();
    let search=ownerTask.materialSupply.fieldFoodSearch;
    if(!search){search={anchor:toPlainPosition(bot.entity.position.floored()),graph:null,graphSegments:[]};ownerTask.materialSupply.fieldFoodSearch=search;}
    const adapter=()=>({fieldFoodExploration:true,survivalProvisioning:true,assertGraphActive:active,excludeBounds:[],
      graphCheckpoint:{get:()=>search.graph,save:value=>{
        active();const old=(search.graphSegments||[]).map(s=>s.graph);
        if(old.reduce((n,g)=>n+(g.order?.length||0),0)+value.order.length>256
          ||old.reduce((n,g)=>n+(g.probes||0),0)+value.probes>8192)throw createAbortError('house_food_frontier_budget_limit');
        search.graph=value;
      }}});
    if(search.graph&&(search.graph.pendingWater||search.graph.pendingDryTrail)){
      await exploreHouseSurfaceGraph(ownerTask,'survival_food',search.anchor,()=>{},
        {...adapter(),returnToAnchor:true,returnToCurrentOnly:true,rejoinInterruptedSuffix:true,provisioningReturn:true,via:search.observedPath||[]});active();
    }
    if(search.graph&&!search.graph.nodes[`${Math.floor(bot.entity.position.x)},${Math.floor(bot.entity.position.y)},${Math.floor(bot.entity.position.z)}`]){
      await require('./minecraft/houseStartupExplorationOrigin').prepareStartupExplorationOrigin({getBot:()=>currentBot,assertActive:active,
        getState:()=>({...search,searchAnchor:search.anchor}),saveState:value=>{active();const {searchAnchor,...rest}=value;
          search={...rest,anchor:searchAnchor};ownerTask.materialSupply.fieldFoodSearch=search;},
        ready:drainStartupOriginDefense,isMotorIdle:()=>activeHouseSurfaceNavigationMove===null&&activeSurvivalInterrupt===null,
        record:facts=>recordTaskDiagnostic(ownerTask,'house_food_actual_origin_segment',facts)}, {deadline,maximumSegments:32});active();
    }
    // The food graph has its own observed origin, not a fictional camp move.
    context.houseSurfaceResource='survival_food_field';
    recordTaskDiagnostic(ownerTask,'house_bootstrap_food_strategy_changed',{strategy:'actual_local_food_frontier',
      anchor:search.anchor,actual:toPlainPosition(bot.entity.position),health:bot.health,food:bot.food,requiredReturnToCamp:false});
    const result=await exploreHouseSurfaceGraph(ownerTask,'survival_food',search.anchor,()=>{},adapter());active();
    if(result.via)search.observedPath=result.via;
    return result.moved===true;
  }

  async function ensureHouseBootstrapFood(minFood = 16, options = {}) {
    if (getExecutionContext()?.selfSupplyOnly !== true) throw Object.assign(new Error("无工具启动口粮仅用于自给任务"), { code: "house_bootstrap_context_required" });
    const bot = ensureBotReady();
    const attempts = new Map();
    const deadline = Math.min(Date.now() + 360000,Number.isFinite(options.deadline)?options.deadline:Infinity);
    const search=surfaceSearchPositions(bot.entity.position.clone(),64);
    let drySearchMoves=0,localToolsAttempted=false,mealDefenseHandoffs=0;
    const context=getExecutionContext(),ownerTask=context?.task||currentTask,client=bot._client,generation=ownerTask?.executionGeneration;
    const observeFoodPath=()=>{
      if(context.houseSurfaceResource!=="survival_food"||currentBot!==bot||bot._client!==client||currentTask!==ownerTask
        ||ownerTask.executionGeneration!==generation||!hasGroundedBodySupport(bot)||!safeSurfaceFoot(bot.entity.position))return;
      const path=ownerTask.materialSupply.surfaceResources?.searches?.survival_food?.observedPath;
      const p=toPlainPosition(bot.entity.position.floored());
      if(path?.length&&path.length<4096&&!toVec3(path.at(-1)).equals(toVec3(p)))saveEmergencyFoodPath(ownerTask,[...path,p]);
    };
    bot.on("physicsTick",observeFoodPath);
    try{
    while (bot.food < minFood) {
      checkTaskSignal();
      if(foodSupplyRunning&&getExecutionContext()?.houseSelfSupply)await settleHouseFoodThreats(deadline,"bootstrap_food_urgent_safety");
      if(options.carriedOnly!==true)assertHuntingHealth();
      if (Date.now() >= deadline) throw Object.assign(new Error("无工具启动采食达到时限，保留自然探索进度"), { code: "house_bootstrap_food_unavailable" });
      const carriedFood=()=>selectBootstrapFood(bot.inventory.items(),{health:bot.health,food:bot.food});
      let food=carriedFood();
      if(!food&&options.carriedOnly===true)return false;
      if(!food&&Object.values(bot.entities||{}).some(e=>e.name==="item"&&e.isValid!==false&&e.position?.distanceTo(bot.entity.position)<=6)){
        recordTaskDiagnostic(currentTask,"house_bootstrap_food_strategy_changed",{strategy:"actual_nearby_drops",health:bot.health,food:bot.food});
        await collectNearbyDroppedItems({radius:6,timeoutMs:4000});checkTaskSignal();food=carriedFood();
      }
      if (food) {
        if(["rotten_flesh","chicken"].includes(food.name))recordTaskDiagnostic(currentTask,"house_emergency_food_fallback",{
          item:food.name,health:bot.health,food:bot.food,expectedRisk:"temporary_hunger_effect",normalReserveCredit:false});
        const before = bot.food;
        try{
          stopBotActions();await equipInventoryItem(food);checkTaskSignal();
          await physicalConsume(food.name,food.name);checkTaskSignal();
        }catch(error){
          checkTaskSignal();
          if(error.code==='movement_preempted'&&mealDefenseHandoffs<8
            &&await resumeHouseResourceAfterSurvival(error,{deadline:Math.min(deadline,Date.now()+35000),bot})){
            mealDefenseHandoffs++;
            recordTaskDiagnostic(currentTask,'house_food_native_defense_resumed',{beforeFood:before,actualFood:bot.food,
              item:food.name,remaining:getItemCountByName(food.name),mealDefenseHandoffs,originalDeadline:deadline,
              nutritionCredit:'actual_native_readback_only'});
            continue;
          }
          throw error;
        }
        const confirmBy = Date.now() + 2500;
        while (bot.food <= before) {
          checkTaskSignal(); if (Date.now() >= confirmBy) throw Object.assign(new Error("启动进食未确认饥饿值恢复，停止重复消耗"), { code: "house_bootstrap_food_unconfirmed" });
          await sleep(50);
        }
        continue;
      }
      // A nutrition-first retry must not keep hunting after its actual sword
      // breaks when carried wood already covers a local table and both tools.
      if(!localToolsAttempted&&context.houseSelfSupply?.prepareSurvivalTools&&!findInventoryItem(WEAPON_ITEM_PRIORITY)
        &&bot.health>=14&&bot.food>=12&&hasGroundedBodySupport(bot)&&safeSurfaceFoot(bot.entity.position)
        &&!immediateFoodThreat(bot)&&bot.inventory.items().reduce((n,i)=>n+(i.name.endsWith('_log')?4*i.count:i.name.endsWith('_planks')?i.count:0),0)>=12){
        localToolsAttempted=true;
        const restored=await executionContextStorage.run({...context,foodWeaponReplacement:ownerTask.taskId},
          ()=>context.houseSelfSupply.prepareSurvivalTools({deadline,localWorkshopOnly:true}));
        checkTaskSignal();
        if(restored&&!findInventoryItem(WEAPON_ITEM_PRIORITY))throw Object.assign(Error('食源探索前补做武器尚未实际入包'),{code:'house_food_weapon_unconfirmed'});
        recordTaskDiagnostic(ownerTask,'house_food_weapon_replacement_observed',{restored:restored===true,weaponPresent:Boolean(findInventoryItem(WEAPON_ITEM_PRIORITY)),health:bot.health,food:bot.food});
        if(restored)continue;
      }
      const anchor = bot.entity.position.clone();
      const target = Object.values(bot.entities || {}).filter(entity => isHuntableFoodAnimal(entity, anchor, 64) && (attempts.get(entity.id) || 0) < 3)
        .sort((a, b) => a.position.distanceTo(anchor) - b.position.distanceTo(anchor))[0];
      if (!target) {
        if(options.nutritionFirst===true&&context.houseSelfSupply&&await exploreHouseLocalFood(deadline))continue;
        if(!localToolsAttempted&&options.nutritionFirst!==true&&context.houseSelfSupply?.prepareSurvivalTools){
          const priorVisits=ownerTask.materialSupply.fieldWoodSearch?.graph?.visits||0;
          const priorWood=bot.inventory.items().filter(i=>i.name.endsWith('_log')).reduce((n,i)=>n+i.count,0);
          try{
            if(await context.houseSelfSupply.prepareSurvivalTools({deadline})){
              localToolsAttempted=true;context.houseSurfaceResource=null;
              recordTaskDiagnostic(currentTask,"house_survival_field_tools_confirmed",{health:bot.health,food:bot.food,actual:toPlainPosition(bot.entity.position)});
              continue;
            }
          }catch(error){
            checkTaskSignal();
            if(/paused|cancelled|preempted|owner|connection/.test(String(error.code||"")))throw error;
            const freshWood=bot.inventory.items().filter(i=>i.name.endsWith('_log')).reduce((n,i)=>n+i.count,0)>priorWood;
            const newObservedNodes=(ownerTask.materialSupply.fieldWoodSearch?.graph?.visits||0)>priorVisits;
            if((freshWood||newObservedNodes)&&["house_resource_leg_limit","house_resource_local_wood_unavailable"].includes(error.code)){
              recordTaskDiagnostic(currentTask,"house_survival_field_tools_progress",{freshWood,newObservedNodes,deadline,health:bot.health});
              continue;
            }
            localToolsAttempted=true;
            recordTaskDiagnostic(currentTask,"house_survival_field_tools_blocked",{code:error.code||error.name,message:error.message});
          }
        }
        recordTaskDiagnostic(currentTask,"house_bootstrap_food_strategy_changed",{strategy:"fresh_loaded_dry_search",health:bot.health,food:bot.food,remaining:search.length});
        if(drySearchMoves<3&&search.length&&await exploreNextSurfacePosition(search,{deadline})){drySearchMoves++;continue;}
        if(context.houseSelfSupply&&await exploreEmergencyFood(deadline)){drySearchMoves=0;continue;}
        throw Object.assign(new Error("本轮已检查不同干地食源和路线，仍没有安全天然食物"), { code: "house_bootstrap_food_unavailable" });
      }
      attempts.set(target.id, (attempts.get(target.id) || 0) + 1);
      setTaskProgress(`正在取得天然 ${target.name} 作为启动食物`);
      const before=getItemCount(Object.keys(FOOD_SMELTING));
      try { await huntFoodAnimal(target, anchor, 64);if(getItemCount(Object.keys(FOOD_SMELTING))<=before)attempts.set(target.id,3); }
      catch (error) { checkTaskSignal(); if (error.code === "food_supply_low_health") throw error; }
    }
    return true;
    }finally{observeFoodPath();bot.removeListener("physicsTick",observeFoodPath);}
  }

  function getPlantingReserveCount() {
    return getItemCount(["wheat_seeds", "carrot", "potato", "beetroot_seeds"]);
  }

  function getDefaultDepositReserveCount(itemName = "") {
    const normalized = String(itemName || "").trim();
    if (!normalized) {
      return 0;
    }
    if (
      PICKAXE_ITEM_NAMES.includes(normalized) ||
      AXE_ITEM_PRIORITY.includes(normalized) ||
      WEAPON_ITEM_PRIORITY.includes(normalized) ||
      BED_ITEM_NAMES.includes(normalized)
    ) {
      return Number.POSITIVE_INFINITY;
    }
    if (
      [
        "crafting_table",
        "furnace",
        "chest",
        "barrel",
        "torch",
        "stick",
        "coal",
        "charcoal",
        "coal_block",
        "cobblestone",
        "iron_ingot",
        "raw_iron",
        "wheat_seeds",
        "carrot",
        "potato",
        "beetroot_seeds",
      ].includes(normalized)
    ) {
      return {
        crafting_table: Number.POSITIVE_INFINITY,
        furnace: Number.POSITIVE_INFINITY,
        chest: Number.POSITIVE_INFINITY,
        barrel: Number.POSITIVE_INFINITY,
        torch: 8,
        stick: 4,
        coal: 4,
        charcoal: 4,
        coal_block: 1,
        cobblestone: 16,
        iron_ingot: 4,
        raw_iron: 4,
        wheat_seeds: 12,
        carrot: 10,
        potato: 10,
        beetroot_seeds: 8,
      }[normalized];
    }
    if (FOOD_ITEM_PRIORITY.includes(normalized)) {
      return DEFAULT_FOOD_RESERVE_COUNT;
    }
    if (ANY_PLANKS.includes(normalized)) {
      return 16;
    }
    if (Object.prototype.hasOwnProperty.call(LOG_TO_PLANK, normalized)) {
      return 8;
    }
    return 0;
  }

  function findUsableCombatWeapon(){
    const bot=ensureBotReady();
    const usable=WEAPON_ITEM_PRIORITY.flatMap(name=>bot.inventory.items().filter(item=>item.name===name))
      .filter(item=>{const maximum=bot.registry.items[item.type]?.maxDurability;return !Number.isFinite(maximum)||maximum-Number(item.durabilityUsed||0)>0;});
    const first=usable[0];
    return /^(wooden|golden)_sword$/.test(first?.name||'')
      ?usable.find(item=>/^(iron|diamond|netherite)_axe$/.test(item.name))||first:first;
  }
  async function equipBestWeapon() {
    const weapon = findUsableCombatWeapon();
    if (!weapon) {
      return false;
    }
    try {
      await equipInventoryItem(weapon, "hand", weapon.displayName || weapon.name);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function openNearbyContainerForTransfer(options = {}) {
    const bot = ensureBotReady();
    ensureMovements(bot);
    const container =
      normalizeVec3Input(options.position)
        ? bot.blockAt(
            new Vec3(
              Number(options.position.x),
              Number(options.position.y),
              Number(options.position.z)
            )
          )
        : findNearbyContainer(Number(options.maxDistance) || 16);
    if (!container || !CONTAINER_BLOCK_NAMES.includes(container.name)) {
      throw new Error("附近没有找到可用箱子/木桶");
    }
    await moveNearBlock(container, 2);
    const opened = await physicalOpenContainer(container, "附近箱子/木桶");
    return {
      container,
      opened,
    };
  }

  async function withdrawItemsFromNearbyContainer({
    names = [],
    count = 1,
    maxDistance = 16,
    progressText = "正在从附近箱子补给物资",
  }) {
    const context = getExecutionContext() || {};
    assertHouseExternalWithdrawalAllowed(context.task || currentTask, context);
    const wanted = names.map((name) => String(name || "").trim()).filter(Boolean);
    if (!wanted.length) {
      throw new Error("没有指定要从箱子里拿什么");
    }
    const bot = ensureBotReady();
    const containers = findNearbyContainers(maxDistance, 10);
    if (!containers.length) {
      throw new Error("附近没有找到可用箱子/木桶");
    }
    let remaining = clamp(Number(count) || 1, 1, 256);
    let totalTaken = 0;
    for (const container of containers) {
      checkTaskSignal();
      let opened = null;
      try {
        await moveNearBlock(container, 2);
        opened = await physicalOpenContainer(container, "附近箱子/木桶");
        const matchingItems = opened
          .containerItems()
          .filter((item) => wanted.includes(item.name))
          .sort((a, b) => wanted.indexOf(a.name) - wanted.indexOf(b.name));
        for (const target of matchingItems) {
          if (remaining <= 0) {
            break;
          }
          const takeCount = Math.min(remaining, target.count);
          currentTask.progressText = `${progressText}：${target.displayName || target.name} (${totalTaken}/${count})`;
          broadcastTaskStatus();
          await withTimeout(
            opened.withdraw(target.type, target.metadata, takeCount, target.nbt),
            DEFAULT_CONTAINER_TIMEOUT_MS,
            `从箱子拿取 ${target.displayName || target.name} 超时`
          );
          totalTaken += takeCount;
          remaining -= takeCount;
          await sleep(80);
        }
        if (remaining <= 0) {
          return true;
        }
      } finally {
        if (opened) {
          try {
            opened.close();
          } catch (_) {}
        }
      }
    }
    if (totalTaken > 0) {
      throw new Error(
        `附近箱子/木桶里的 ${wanted.join(" / ")} 不足：还差 ${remaining} 个`
      );
    }
    throw new Error(`附近箱子/木桶里没有 ${wanted.join(" / ")}`);
  }

  async function ensureNutrition(minFood = 14, options = {}) {
    if (!getExecutionContext()?.houseSelfSupply && (getExecutionContext()?.task || currentTask)?.materialSupply) {
      return withCurrentHouseMaterialRuntime(() => ensureNutrition(minFood, options));
    }
    checkTaskSignal();
    const bot=ensureBotReady(),context=getExecutionContext(),task=context?.task||currentTask;
    const token=getActiveCancellationToken(),lease=getCurrentMovementLease(),previous=nutritionFlights.get(bot);
    if(previous){
      if(previous===context?.nutritionFlight)return ensureNutritionOnce(minFood,options);
      if(previous.client===bot._client&&previous.task===task&&previous.generation===task?.executionGeneration
        &&previous.token===token&&previous.lease===lease){await previous.promise;checkTaskSignal();return bot.food>=minFood;}
      throw Object.assign(Error('已有另一归属的补餐动作，等待重新观察'),{code:'food_consumption_busy'});
    }
    const flight={client:bot._client,task,generation:task?.executionGeneration,token,lease,promise:null};
    nutritionFlights.set(bot,flight);
    flight.promise=executionContextStorage.run({...context,nutritionFlight:flight},()=>ensureNutritionOnce(minFood,options))
      .finally(()=>{if(nutritionFlights.get(bot)===flight)nutritionFlights.delete(bot);});
    return flight.promise;
  }
  async function ensureNutritionOnce(minFood = 14, options = {}) {
    const bot = ensureBotReady();
    if (!Number.isFinite(bot.food) || bot.food >= minFood) {
      return true;
    }
    let foodItem = findBestFoodItem();
    if(!foodItem&&options.recoveryThresholdOnly===true&&getExecutionContext()?.houseSelfSupply&&bot.food>=18)return true;
    if (!foodItem && !foodSupplyRunning) {
      try {
        await withdrawItemsFromNearbyContainer({
          names: FOOD_ITEM_PRIORITY,
          count: 8,
          progressText: "正在去附近箱子补充食物",
        });
      } catch (error) {
        addTaskLog(
          "warn",
          `附近没有现成食物补给，改走自给口粮链：${error?.message || "补食物失败"}`
        );
      }
      foodItem = findBestFoodItem();
    }
    if (!foodItem && !foodSupplyRunning) {
      try {
        await ensureFoodSupply(Math.max(2, DEFAULT_FOOD_RESERVE_COUNT), options);
      } catch (error) {
        addTaskLog(
          "warn",
          `基础口粮准备失败：${error?.message || "无法补充食物"}`
        );
      }
      foodItem = findBestFoodItem();
    }
    if (!foodItem) {
      throw new Error("食物不足：背包里没有可直接食用的食物");
    }
    for (let meals = 0; meals < 12 && bot.food < minFood; meals += 1) {
      checkTaskSignal();
      foodItem = findBestFoodItem();
      if (!foodItem) {
        if(options.recoveryThresholdOnly===true&&getExecutionContext()?.houseSelfSupply&&bot.food>=18)return true;
        throw new Error("现有食物不足以补足本次饥饿值");
      }
      const previousFood = bot.food;
      if(getExecutionContext()?.houseSelfSupply&&["rotten_flesh","beef","porkchop","mutton","rabbit","cod","salmon"].includes(foodItem.name))
        recordTaskDiagnostic(currentTask,"house_opportunistic_carried_food",{item:foodItem.name,health:bot.health,food:bot.food,expectedRisk:foodItem.name==="rotten_flesh"?"temporary_hunger_effect":null,reserveCredit:false});
      currentTask.progressText = `正在补充食物：${foodItem.displayName || foodItem.name}`;
      broadcastTaskStatus();
      stopBotActions();
      await equipInventoryItem(foodItem, "hand", foodItem.displayName || foodItem.name);
      await physicalConsume(foodItem.displayName || foodItem.name,foodItem.name);
      await sleep(300);
      if (bot.food <= previousFood) throw new Error("食用后没有确认饥饿值恢复，已停止重复消耗食物");
    }
    return bot.food >= minFood;
  }

  async function ensureEmergencyFoodRecovery() {
    const bot=ensureBotReady();
    if(!getExecutionContext()?.houseSelfSupply)throw Object.assign(Error("紧急采食需要原自给任务能力"),{code:"house_emergency_food_context"});
    const emergencyDeadline=Date.now()+360000;
    recordTaskDiagnostic(currentTask,"house_emergency_food_before_equipment",{health:bot.health,food:bot.food});
    if(bot.food<8)await ensureHouseBootstrapFood(12,{deadline:emergencyDeadline});
    while(bot.health<6){
      checkTaskSignal();assertHuntingHealth();
      if(Date.now()>=emergencyDeadline)throw Object.assign(Error("紧急采食与回血达到本轮时限，保留已确认食源和进度"),{code:"house_emergency_food_timeout"});
      if(bot.food<18)await ensureHouseBootstrapFood(18,{deadline:emergencyDeadline});
      const recovered=await prepareHouseRecovery({targetHealth:6,assertActive:checkTaskSignal,
        observe:()=>({health:bot.health,food:bot.food,safe:hasGroundedBodySupport(bot)&&safeSurfaceFoot(bot.entity.position),
          threat:immediateFoodThreat(bot)}),
        defend:()=>settleSurvivalDefense("emergency_food_recovery"),
        hasFood:()=>false,canProvision:()=>true,provisionMinimumHealth:()=>Number.MIN_VALUE,
        onProgress:value=>recordTaskHeartbeat(currentTask,{actionState:"acting",checkpoint:{kind:"emergency_food_recovery",...value}})});
      if(recovered.recovered)recordTaskDiagnostic(currentTask,"house_emergency_food_recovery_confirmed",recovered);
      else if(!recovered.needsProvision)break;
    }
  }

  async function ensureFoodSupply(minCount = DEFAULT_FOOD_RESERVE_COUNT, options = {}) {
    if (!getExecutionContext()?.houseSelfSupply && (getExecutionContext()?.task || currentTask)?.materialSupply) {
      return withCurrentHouseMaterialRuntime(() => ensureFoodSupply(minCount, options));
    }
    const targetCount = clamp(Number(minCount) || DEFAULT_FOOD_RESERVE_COUNT, 1, 32);
    const requestedPoints = Number(options.minFoodPoints);
    const targetPoints = Number.isFinite(requestedPoints) && requestedPoints > 0
      ? clamp(Math.ceil(requestedPoints), 1, 256) : null;
    if (foodSupplyRunning) throw new Error("口粮补给已经在进行，不能递归启动补给");
    const bot = ensureBotReady();
    const anchor = toVec3(options.anchor) || bot.entity.position.clone();
    // House provisioning must consider already visible food just beyond the
    // old camp-centered 64m ring. Use the existing bounded native approach
    // range; explicit caller limits and ordinary tasks keep their behavior.
    const maxDistance = clamp(Number(options.maxDistance) || (getExecutionContext()?.houseSelfSupply ? 96 : 64), 16, 96);
    const targetReserve = targetPoints ?? targetCount;
    // Only confirmed, ready-to-eat backpack items fulfill the reserve contract.
    // Raw meat is useful for planning a cooking batch, never for declaring success.
    const readyReserve = () => targetPoints == null ? readyFoodCount() : readyFoodPoints();
    const effectiveReserveTarget=()=>surfaceReserveTarget({health:bot.health,food:bot.food,requestedPoints:targetReserve,maintenance:targetPoints===8&&options.surfaceMaintenance===true});
    const unitsNeeded = (name, mealPoints = 0) => {
      const points = foodPointsByName(name);
      if (targetPoints != null && !points) return 0;
      const reserveUnits = targetPoints == null ? Math.max(0, targetCount - readyFoodCount())
        : Math.ceil(Math.max(0, targetPoints - readyFoodPoints()) / points);
      return reserveUnits + (points ? Math.ceil(mealPoints / points) : 0);
    };
    const potentialReserve = () => readyReserve() + Object.entries(FOOD_SMELTING)
      .reduce((total, [raw, cooked]) => total + getItemCountByName(raw) *
        (targetPoints == null ? 1 : foodPointsByName(cooked)), 0);
    const potentialAfterNecessaryMeal=()=>potentialReserve()-(targetPoints==null?0:require('./minecraft/houseFoodBatchPlan').immediateMealCost({
      health:bot.health,food:bot.food,points:foodPointsByName,
      items:bot.inventory.items().map(i=>({name:FOOD_SMELTING[i.name]||i.name,count:i.count}))}));
    const readyAfterNecessaryMeal=async()=>{
      if(readyReserve()<effectiveReserveTarget())return false;
      if((bot.food<=18||bot.health<20&&bot.food<20)&&findBestFoodItem()
        &&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry&&!immediateFoodThreat(bot)){
        await ensureNutrition(20,options);checkTaskSignal();
      }
      return readyReserve()>=effectiveReserveTarget();
    };
    const foodContext=getExecutionContext(),foodOwner=foodContext?.task||currentTask;
    const foodClient=bot._client,foodGeneration=foodOwner?.executionGeneration;
    const observeFoodDetour=()=>{
      if(!foodContext?.houseSelfSupply||foodContext.houseSurfaceResource!=="survival_food"&&foodOwner.materialSupply?.activeSurfaceGraph!=="survival_food"
        ||currentBot!==bot||bot._client!==foodClient||currentTask!==foodOwner||foodOwner.executionGeneration!==foodGeneration
        ||!hasGroundedBodySupport(bot)||!safeSurfaceFoot(bot.entity.position)||!inspectSurfaceBody(bot).dry)return;
      const path=foodOwner.materialSupply.surfaceResources?.searches?.survival_food?.observedPath;
      const p=toPlainPosition(bot.entity.position.floored());
      if(path?.length&&path.length<4096&&!toVec3(path.at(-1)).equals(toVec3(p))){
        // A knockback/settled landing gap must not disable all later actual
        // observations. These points grant no edge or traversal permission.
        if(toVec3(path.at(-1)).distanceTo(toVec3(p))>3)recordTaskDiagnostic(foodOwner,'house_food_observed_trace_gap',{
          from:path.at(-1),actual:p,freshConnectorRequired:true});
        saveEmergencyFoodPath(foodOwner,[...path,p]);
      }
    };
    bot.on("physicsTick",observeFoodDetour);
    foodSupplyRunning = true;
    try {
      if(getExecutionContext()?.houseSelfSupply){
        const localMeal=await restoreLocalSurvivalMeal({assertActive:checkTaskSignal,
          observe:()=>({maintenance:options.surfaceMaintenance===true&&targetPoints===8,hasWeapon:Boolean(findInventoryItem(WEAPON_ITEM_PRIORITY)),
            hasEmergencyMeal:['rotten_flesh','chicken'].includes(selectBootstrapFood(bot.inventory.items(),{health:bot.health,food:bot.food})?.name),
            health:bot.health,food:bot.food}),
          acquireAndEat:()=>withSurfaceResourceMovements(()=>ensureHouseBootstrapFood(18,{deadline:Date.now()+90000}))});
        if(localMeal){recordTaskDiagnostic(currentTask,"house_local_survival_meal_confirmed",localMeal);return localMeal;}
      }
      return await withSurfaceResourceMovements(async () => {
        let primaryFailure = null;
        try {
          // Survival provisioning must not depend on first crafting a sword,
          // gathering fuel or meeting the building-material health threshold.
          // Reuse the existing no-tool food skill before those prerequisites.
          if(getExecutionContext()?.houseSelfSupply&&(bot.health<6||bot.food<8)){
            await ensureEmergencyFoodRecovery();
          }
          if (await readyAfterNecessaryMeal()) return true;
          try {
            await withdrawItemsFromNearbyContainer({
              names: targetPoints == null ? FOOD_ITEM_PRIORITY : FOOD_ITEM_PRIORITY.filter((name) => !FOOD_SMELTING[name]),
              count: targetPoints == null ? targetCount - readyFoodCount()
                : Math.ceil((targetPoints - readyFoodPoints()) / 2),
              progressText: "正在从附近箱子补充基础口粮",
            });
          } catch (_) { checkTaskSignal(); }
          if (await readyAfterNecessaryMeal()) return true;
          const crops = findNearestMatureCropBlocks(["wheat", "carrots", "potatoes"], 32, 24);
          if (crops.length) {
            await executeHarvestCrops({ args: { crops: ["wheat", "carrots", "potatoes"],
              count: Math.min(unitsNeeded("carrot") * 3, crops.length), maxDistance: 32,
              replant: true, supplyingFood: true } });
          }
          const breadCount = Math.min(unitsNeeded("bread"), Math.floor(getItemCountByName("wheat") / 3));
          if (breadCount > 0) {
            await returnToFoodAnchor(anchor);
            await craftItemByName("bread", breadCount, await ensureCraftingTableAvailable(anchor));
          }
          const cookAvailable = async (mealPoints = 0) => {
            for (const [raw, cooked] of Object.entries(FOOD_SMELTING)) {
              checkTaskSignal();
              const amount = Math.min(getItemCountByName(raw), unitsNeeded(cooked, mealPoints));
              if (!amount) continue;
              await returnToFoodAnchor(anchor);
              await ensureFurnaceAvailable(anchor);
              await executeSmeltItem({ args: { inputItems: [raw], output: cooked,
                count: getItemCountByName(cooked) + amount } });
            }
          };
          await cookAvailable();
          if (await readyAfterNecessaryMeal()) return true;
          if (!findInventoryItem(WEAPON_ITEM_PRIORITY)) {
            await returnToFoodAnchor(anchor);
            await ensureSticks(1);
            const weapon = getItemCountByName("cobblestone") >= 2 ? "stone_sword" : "wooden_sword";
            if (weapon === "wooden_sword") await ensurePlanks(2);
            await craftItemByName(weapon, 1, await ensureCraftingTableAvailable(anchor));
          }
          const exploration = surfaceSearchPositions(anchor, maxDistance);
          const attempts = new Map();
          const deadline = Date.now() + 360000;
          const eatCollectedFood = async () => {
            if (!Number.isFinite(bot.food) || bot.food > (bot.health<20?18:16) ||
              !(readyFoodCount() || getItemCount(Object.keys(FOOD_SMELTING)))) return;
            // A healthy long-range hunter batches small catches while hunger
            // still leaves a return margin. Wounded/critical hunger still eats
            // the first catch; raw meat never fulfills the ready reserve.
            if(bot.health>=20&&bot.food>12&&potentialAfterNecessaryMeal()<effectiveReserveTarget())return;
            // The first catch can restore regeneration before a long trip to
            // the furnace. It remains consumed food, never spare-reserve credit.
            if(getExecutionContext()?.houseSelfSupply&&bot.health<20&&bot.food<18&&findBestFoodItem()
              &&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry&&!immediateFoodThreat(bot)){
              await ensureNutrition(18,options);checkTaskSignal();
            }
            if(getExecutionContext()?.houseSelfSupply&&readyFoodPoints()===0&&getItemCount(Object.keys(FOOD_SMELTING))===0){
              recordTaskDiagnostic(currentTask,'house_food_empty_return_skipped',{health:bot.health,food:bot.food,
                remainingRaw:0,readyReserve:0,requiredReserve:effectiveReserveTarget(),reserveCredit:false,continueOriginalFoodTask:true});
              return;
            }
            await returnToFoodAnchor(anchor);
            await cookAvailable(Math.max(0, 20 - bot.food));
            const availablePoints = readyFoodPoints();
            if (availablePoints > 0) {
              // A small first catch can be eaten before the full reserve exists.
              // ensureNutrition verifies the actual hunger increase; consumed items
              // disappear from readyReserve and must be gathered again afterwards.
              await ensureNutrition(Math.min(20, bot.food + availablePoints), options);
            }
          };
          while (readyReserve() < effectiveReserveTarget()) {
            checkTaskSignal();
            assertHuntingHealth();
            if (Date.now() > deadline) throw new Error("地表采食达到本轮时限，已返回营地保留任务");
            await eatCollectedFood();
            if (potentialAfterNecessaryMeal() >= effectiveReserveTarget()) {
              await cookAvailable();
              if (await readyAfterNecessaryMeal()) break;
            }
            // A persistent food frontier may leave the old camp radius. The
            // observed transport graph still owns the return; nearby natural
            // food must be judged from the actual search position.
            const huntAnchor=getExecutionContext()?.houseSelfSupply?bot.entity.position.clone():anchor;
            const candidates = getCachedEntityList().filter((entity) =>
              isHuntableFoodAnimal(entity, huntAnchor, maxDistance) && (attempts.get(entity.id)?.count || 0) < 3)
              .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
            const target = candidates.find((entity) => (attempts.get(entity.id)?.nextAt || 0) <= Date.now());
            if (!target) {
              if (candidates.length) {
                // A temporary NoPath/timeout does not discard a viable food source.
                // Wait briefly for its cooldown rather than burning hunger on a search ring.
                await sleep(Math.min(1000, Math.max(50,
                  Math.min(...candidates.map((entity) => attempts.get(entity.id).nextAt)) - Date.now())));
                continue;
              }
              if(getExecutionContext()?.houseSelfSupply){
                if(!await exploreEmergencyFood(deadline))break;
              }else if (!(await exploreNextSurfacePosition(exploration,{deadline}))) break;
              continue;
            }
            const before = getItemCount(Object.keys(FOOD_SMELTING));
            const attempt = attempts.get(target.id) || { count: 0, nextAt: 0 };
            attempt.count += 1;
            attempts.set(target.id, attempt);
            currentTask.progressText = `正在安全狩猎天然 ${target.name} 并收集肉类`;
            broadcastTaskStatus();
            try { await huntFoodAnimal(target, huntAnchor, maxDistance); }
            catch (error) {
              checkTaskSignal();
              if (error?.code === "movement_preempted") {
                if (await resumeHouseResourceAfterSurvival(error, {deadline,bot})) { attempt.count-=1; continue; }
                throw error;
              }
              if (error?.code === "food_supply_low_health") throw error;
              if(["NoPath","no_path"].includes(String(error.code||error.name)))attempt.count=3;
              addTaskLog("warn", `本次采食未完成，将有限重试或寻找其他食源：${error?.message || error}`);
            }
            attempt.nextAt = Date.now() + 5000;
            if (getItemCount(Object.keys(FOOD_SMELTING)) > before) {
              recordTaskHeartbeat(currentTask, { actionState: "acting",
                checkpoint: { kind: "food_supply", rawFood: getItemCount(Object.keys(FOOD_SMELTING)),
                  targetCount, targetFoodPoints: targetPoints }, clearRecoveryReason: true });
            }
          }
          await cookAvailable();
          if (readyReserve() < effectiveReserveTarget()) {
            throw new Error(`自然食源不足：已确认可用口粮 ${readyReserve()}/${targetReserve}${targetPoints == null ? "" : " 食物点"}，已保留营地和矿道进度`);
          }
          return true;
        } catch (error) {
          primaryFailure = error;
          throw error;
        } finally {
          let active = currentBot === bot;
          try { checkTaskSignal(); } catch (_) { active = false; }
          if (active) {
            try { await returnToFoodAnchor(anchor); }
            catch (returnError) {
              checkTaskSignal();
              if (!primaryFailure) throw returnError;
              const details = { code: returnError.code || returnError.name || null,
                message: String(returnError.message || returnError).slice(0, 240) };
              try {
                if (typeof primaryFailure === "object") primaryFailure.foodReturnFailure = details;
                recordTaskDiagnostic(getExecutionContext()?.task || currentTask, "food_return_after_failure", details);
              } catch (_) { /* A diagnostic failure cannot replace the primary failure either. */ }
            }
          }
        }
      });
    } finally { observeFoodDetour();bot.removeListener("physicsTick",observeFoodDetour);foodSupplyRunning = false; }
  }

  async function executeDepositItems(step) {
    const bot = ensureBotReady();
    const { opened } = await openNearbyContainerForTransfer({
      position: step.args?.position,
      maxDistance: step.args?.maxDistance,
    });
    try {
      const keepNames = new Set(
        ["crafting_table", "stick", "bread", ...FOOD_ITEM_PRIORITY].concat(
          Array.isArray(step.args?.keep) ? step.args.keep.map((item) => String(item || "").trim()) : []
        )
      );
      const items = bot.inventory
        .items()
        .map((item) => {
          const keepReserve = Math.max(
            keepNames.has(item.name) ? getDefaultDepositReserveCount(item.name) : 0,
            getDefaultDepositReserveCount(item.name)
          );
          if (!Number.isFinite(keepReserve)) {
            return null;
          }
          const depositCount = Math.max(0, Number(item.count || 0) - keepReserve);
          if (depositCount <= 0) {
            return null;
          }
          return {
            item,
            depositCount,
          };
        })
        .filter(Boolean);
      if (!items.length) {
        throw new Error("背包里没有适合存入箱子的物品");
      }
      for (const entry of items) {
        const item = entry.item;
        checkTaskSignal();
        currentTask.progressText = `正在存放 ${item.displayName || item.name}`;
        broadcastTaskStatus();
        await withTimeout(
          opened.deposit(item.type, item.metadata, entry.depositCount, item.nbt),
          DEFAULT_CONTAINER_TIMEOUT_MS,
          `存放 ${item.displayName || item.name} 超时`
        );
        await sleep(80);
      }
    } finally {
      try {
        opened.close();
      } catch (_) {}
    }
  }

  async function executeWithdrawItems(step) {
    const names = Array.isArray(step.args?.items)
      ? step.args.items.map((item) => String(item || "").trim()).filter(Boolean)
      : String(step.args?.item || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
    const count = clamp(Number(step.args?.count) || 1, 1, 256);
    await withdrawItemsFromNearbyContainer({
      names,
      count,
      maxDistance: Number(step.args?.maxDistance) || 16,
      progressText: "正在从附近箱子拿取物品",
    });
  }

  function classifyTaskError(error) {
    const step = currentTask?.plan?.steps?.[Number(currentTask?.currentStepIndex) || 0];
    if (step?.skill === "build_estate") {
      return { status: TaskState.BLOCKED, code: String(error?.code || "").startsWith("farm_") || String(error?.code || "").startsWith("estate_")
        ? error.code : `estate_${error?.code || "action_failed"}`, message: error.message };
    }
    if (step?.skill === "build_furnished_house_phase" && error?.code !== "house_materials_missing") {
      return { status: TaskState.BLOCKED, code: String(error?.code || "").startsWith("house_")
        ? error.code : `house_${error?.code || "action_failed"}`, message: error.message };
    }
    if (step?.args?.expedition === true && ["executor_stalled", "step_timeout"].includes(String(error?.code || ""))) {
      return { status: TaskState.BLOCKED, code: `mining_${error.code}`, message: error.message };
    }
    if (error?.code === "house_materials_missing") {
      return { status: TaskState.BLOCKED, code: "insufficient_material", message: error.message };
    }
    return taskRecovery.classifyTaskError(error);
  }

  async function equipBestTool(block) {
    const bot = ensureBotReady();
    if (!block) {
      return;
    }
    try {
      const tool = bot.pathfinder?.bestHarvestTool?.(block);
      if (tool) {
        await equipInventoryItem(tool, "hand", tool.displayName || tool.name);
      }
    } catch (_) {}
  }

  function checkTaskSignal() {
    const executionContext = getExecutionContext();
    if(executionContext?.pausedSurvivalOwner&&(!isSurvivalOwnerCurrent(executionContext.pausedSurvivalOwner)
      ||activeSurvivalInterrupt!==executionContext.pausedSurvivalOwner||!isMovementLeaseActive(executionContext.pausedSurvivalOwner.lease)))throw createAbortError("movement_preempted");
    const activeTask = executionContext?.task || currentTask;
    if (executionContext?.runGeneration != null &&
      (currentTask?.taskId !== activeTask?.taskId || activeTask?.executionGeneration !== executionContext.runGeneration)) {
      throw createAbortError(activeTask?.status === TaskState.PAUSED ? "paused" : "cancelled");
    }
    if (activeTask?.watchdogAbortMessage&&!executionContext?.pausedSurvivalOwner) {
      const error = new Error(activeTask.watchdogAbortMessage);
      error.code = String(activeTask.watchdogAbortCode || "step_timeout");
      throw error;
    }
    getActiveCancellationToken()?.throwIfRequested();
  }

  async function moveToPosition(position, range = 1) {
    updateTaskCheckpoint(currentTask, {
      kind: "movement",
      targetPosition: normalizeVec3Input(position),
      range: clamp(Number(range) || 1, 1, 4),
    });
    await pathfinderGoto(
      new goals.GoalNear(position.x, position.y, position.z, clamp(Number(range) || 1, 1, 4)),
      DEFAULT_PATHFIND_TIMEOUT_MS,
      `前往 ${position.x}, ${position.y}, ${position.z} 超时`
    );
  }

  async function moveNearBlock(block, range = 2) {
    if (!block) {
      throw new Error("未找到目标方块");
    }
    updateTaskCheckpoint(currentTask, {
      kind: "move_near_block",
      targetBlock: String(block.name || "").trim() || null,
      targetPosition: toPlainPosition(block.position),
      range: clamp(Number(range) || 2, 1, 4),
    });
    await moveToPosition(block.position, range);
  }

  function findNearestBlockByNames(names = [], maxDistance = 48) {
    const bot = ensureBotReady();
    const wanted = new Set(names.map((name) => String(name || "").trim()).filter(Boolean));
    const key = `findNearestBlock:${getPositionCacheKey(bot.entity?.position)}:${clamp(Number(maxDistance) || 48, 4, 96)}:${[...wanted].sort().join(",")}:${JSON.stringify(getExecutionContext()?.houseResourceExclusionBounds || [])}`;
    return getCachedBlockQuery(key, () =>
      bot.findBlock({
        maxDistance,
        matching: (block) => {
          return Boolean(block?.name && wanted.has(block.name) && !houseResourcePositionExcluded(block.position));
        },
      })
    );
  }

  function findNearestBlocksByNames(names = [], maxDistance = 48, limit = 10) {
    const bot = ensureBotReady();
    const wanted = new Set(names.map((name) => String(name || "").trim()).filter(Boolean));
    const normalizedDistance = clamp(Number(maxDistance) || 48, 4, 96);
    const normalizedLimit = clamp(Number(limit) || 10, 1, 24);
    const key = `findNearestBlocks:${getPositionCacheKey(bot.entity?.position)}:${normalizedDistance}:${normalizedLimit}:${[...wanted].sort().join(",")}:${JSON.stringify(getExecutionContext()?.houseResourceExclusionBounds || [])}`;
    return getCachedBlockQuery(key, () => {
      const positions = bot.findBlocks({
        maxDistance: normalizedDistance,
        count: normalizedLimit,
        matching: (block) => Boolean(block?.name && wanted.has(block.name) && !houseResourcePositionExcluded(block.position)),
      });
      return positions
        .map((position) => bot.blockAt(position))
        .filter((block) => block && wanted.has(block.name) && !houseResourcePositionExcluded(block.position))
        .sort((a, b) => {
          const exposedScore = Number(isBlockExposed(b)) - Number(isBlockExposed(a));
          if (exposedScore !== 0) {
            return exposedScore;
          }
          return bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position);
        });
    });
  }

  function findHouseSurfaceMaterialBlocks(names = [], maxDistance = 96, limit = 24) {
    if (!names.length || !names.every(name=>isWoodBlockName(name)||name==="sand")) return findNearestBlocksByNames(names, maxDistance, limit);
    const context = getExecutionContext() || {}, task = context.task || currentTask;
    if (context.selfSupplyOnly !== true || task?.materialSupply?.materialSource !== "self_gathered") {
      throw Object.assign(new Error("地表木材筛选缺少自给采集执行上下文"), { code: "house_resource_surface_context_required" });
    }
    const bot = ensureBotReady(), client = bot._client, dimension = bot.game?.dimension;
    const generation = task.executionGeneration, token = context.token || getActiveCancellationToken(), lease = getCurrentMovementLease();
    const owner = () => currentBot === bot && bot._client === client && bot.game?.dimension === dimension
      && currentTask === task && task.executionGeneration === generation && (task.cancellationToken || runtimeToken) === token
      && !token?.cancelled && !token?.pauseRequested && (!lease || isMovementLeaseActive(lease));
    const active = () => { token?.throwIfRequested(); checkTaskSignal(); if (!owner()) throw createAbortError("movement_preempted"); };
    active();
    const resource = names.length === 1 ? names[0] : "any_log";
    const memory = createHouseObservedResourceMemory({ getBot: () => currentBot, assertActive: active, isOwnerCurrent: owner,
      getCP: () => task.materialSupply?.observedResources?.[resource],
      saveCP: value => { active(); task.materialSupply = { ...task.materialSupply,
        observedResources: { ...task.materialSupply?.observedResources, [resource]: value } }; },
      getGraphState: () => task.materialSupply?.surfaceGraphs?.[resource], isExcludedPosition: houseResourcePositionExcluded,
      isCandidateAllowed:block=>(!isUnarmedHouseExplorer(bot,task)
        ||require('./minecraft/houseUnarmedResourceSafety').unarmedResourceTargetSafe(bot,block.position))
        &&require("./minecraft/houseResourceFailures").canRetryResource(
        task.materialSupply?.surfaceResources?.searches?.[resource]?.failedTargets,block,bot.entity.position,{approachRevision:4}),
    }, { resource, names, queryRadius: clamp(Number(maxDistance) || 96, 4, 96),
      queryCandidates: clamp(Number(limit) || 24, 1, 24), queryBudgetMs: 1000 });
    const facts = memory.query(); active();
    const candidates = memory.getLoadedCandidates(); active();
    recordTaskDiagnostic(task, "house_resource_loaded_surface_query", { resource, ...facts,
      returnedCandidates: candidates.length, actualMovementPerformed: false, acquiredMaterialCredit: false });
    return candidates;
  }

  function countNearbyBlocksByNames(names = [], centerPosition = null, horizontalRadius = 6, verticalRange = 3) {
    const bot = ensureBotReady();
    const center = toPlainPosition(centerPosition) || toPlainPosition(bot.entity?.position);
    if (!center) {
      return 0;
    }
    const wanted = new Set(names.map((name) => String(name || "").trim()).filter(Boolean));
    if (!wanted.size) {
      return 0;
    }
    const radius = clamp(Number(horizontalRadius) || 6, 1, 12);
    const vertical = clamp(Number(verticalRange) || 3, 1, 6);
    const baseX = Math.floor(center.x);
    const baseY = Math.floor(center.y);
    const baseZ = Math.floor(center.z);
    const key = `countBlocks:${baseX},${baseY},${baseZ}:${radius}:${vertical}:${[...wanted].sort().join(",")}:${JSON.stringify(getExecutionContext()?.houseResourceExclusionBounds || [])}`;
    return getCachedBlockQuery(key, () => {
      let count = 0;
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (Math.abs(dx) + Math.abs(dz) > radius * 2) {
            continue;
          }
          for (let dy = -vertical; dy <= vertical; dy += 1) {
            const block = bot.blockAt(new Vec3(baseX + dx, baseY + dy, baseZ + dz));
            if (block?.name && wanted.has(block.name)) {
              count += 1;
            }
          }
        }
      }
      return count;
    });
  }

  function getBlockPropertyValue(block, key = "") {
    if (!block || !key) {
      return null;
    }
    try {
      if (typeof block.getProperties === "function") {
        const props = block.getProperties();
        if (props && Object.prototype.hasOwnProperty.call(props, key)) {
          return props[key];
        }
      }
    } catch (_) {}
    if (block.properties && Object.prototype.hasOwnProperty.call(block.properties, key)) {
      return block.properties[key];
    }
    if (block._properties && Object.prototype.hasOwnProperty.call(block._properties, key)) {
      return block._properties[key];
    }
    return null;
  }

  function isMatureCropBlock(block) {
    if (!block?.name || !Object.prototype.hasOwnProperty.call(CROP_HARVEST_CONFIG, block.name)) {
      return false;
    }
    const config = CROP_HARVEST_CONFIG[block.name];
    const ageValue = Number(getBlockPropertyValue(block, "age"));
    if (!Number.isFinite(ageValue)) {
      return false;
    }
    return ageValue >= Number(config.maxAge);
  }

  function findNearestMatureCropBlocks(cropNames = [], maxDistance = 20, limit = 12) {
    const bot = ensureBotReady();
    const wanted = new Set(
      (Array.isArray(cropNames) ? cropNames : [cropNames])
        .map((name) => String(name || "").trim())
        .filter((name) => Object.prototype.hasOwnProperty.call(CROP_HARVEST_CONFIG, name))
    );
    if (!wanted.size) {
      return [];
    }
    const normalizedDistance = clamp(Number(maxDistance) || 20, 4, 64);
    const normalizedLimit = clamp(Number(limit) || 12, 1, 24);
    const cacheKey = `matureCrops:${getPositionCacheKey(bot.entity?.position)}:${normalizedDistance}:${normalizedLimit}:${[...wanted].sort().join(",")}:${JSON.stringify(getExecutionContext()?.houseResourceExclusionBounds || [])}`;
    return getCachedBlockQuery(cacheKey, () => {
      const positions = bot.findBlocks({
        maxDistance: normalizedDistance,
        count: normalizedLimit,
        matching: (block) => Boolean(block?.name && wanted.has(block.name) && !houseResourcePositionExcluded(block.position)),
      });
      return positions
        .map((position) => bot.blockAt(position))
        .filter((block) => block && wanted.has(block.name) && isMatureCropBlock(block))
        .sort(
          (a, b) =>
            bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position)
        );
    });
  }

  function findPlantableFarmlandTargets(cropNames = [], maxDistance = 20, limit = 12) {
    const bot = ensureBotReady();
    const wanted = new Set(
      (Array.isArray(cropNames) ? cropNames : [cropNames])
        .map((name) => String(name || "").trim())
        .filter((name) => Object.prototype.hasOwnProperty.call(CROP_HARVEST_CONFIG, name))
    );
    if (!wanted.size) {
      return [];
    }
    const normalizedDistance = clamp(Number(maxDistance) || 20, 4, 64);
    const normalizedLimit = clamp(Number(limit) || 12, 1, 32);
    const cacheKey = `plantableFarmland:${getPositionCacheKey(bot.entity?.position)}:${normalizedDistance}:${normalizedLimit}:${[...wanted].sort().join(",")}:${JSON.stringify(getExecutionContext()?.houseResourceExclusionBounds || [])}`;
    return getCachedBlockQuery(cacheKey, () => {
      const positions = bot.findBlocks({
        maxDistance: normalizedDistance,
        count: normalizedLimit,
        matching: (block) => block?.name === "farmland",
      });
      return positions
        .map((position) => {
          const farmland = bot.blockAt(position);
          const plantPos = position.offset(0, 1, 0);
          const currentCrop = bot.blockAt(plantPos);
          const headSpace = bot.blockAt(position.offset(0, 2, 0));
          if (!farmland || farmland.name !== "farmland") {
            return null;
          }
          if (currentCrop && !isReplaceableBlock(currentCrop)) {
            return null;
          }
          if (headSpace && !isPassableBlock(headSpace)) {
            return null;
          }
          return {
            farmland,
            position: plantPos,
          };
        })
        .filter(Boolean)
        .sort(
          (a, b) =>
            bot.entity.position.distanceTo(a.farmland.position) -
            bot.entity.position.distanceTo(b.farmland.position)
        )
        .slice(0, normalizedLimit);
    });
  }

  async function executeFollowPlayer(step) {
    const bot = ensureBotReady();
    ensureMovements(bot);
    const distance = clamp(Number(step.args?.distance) || 2, 1, 6);
    const once = step.args?.once === true;
    const loopDelayMs = 180;
    while (true) {
      checkTaskSignal();
      await maybeHandleForegroundCombatInterrupt();
      const target = findPlayerTarget(step.args?.playerName);
      if (!target?.position) {
        throw new Error("没有找到要跟随的玩家");
      }
      const rendezvous = getPlayerRendezvousPosition(target);
      if (!rendezvous) {
        throw new Error("没有找到可到达的玩家位置");
      }
      updateTaskCheckpoint(currentTask, {
        kind: "follow_player",
        playerName: String(target.username || step.args?.playerName || "玩家").trim() || "玩家",
        playerPosition: toPlainPosition(target.position),
        once,
      });
      currentTask.progressText =
        target.source === "memory"
          ? `正在前往 ${target.username || step.args?.playerName || "玩家"} 上次出现位置附近的地表`
          : `正在跟随 ${target.username || step.args?.playerName || "玩家"}`;
      broadcastTaskStatus();
      if (once) {
        await pathfinderGoto(
          new goals.GoalNear(
            rendezvous.x,
            rendezvous.y,
            rendezvous.z,
            Math.max(1, distance - 1)
          ),
          DEFAULT_PATHFIND_TIMEOUT_MS,
          `前往 ${target.username || step.args?.playerName || "玩家"} 超时`
        );
        recordTaskHeartbeat(currentTask, {
          actionState: "moving",
          checkpoint: {
            kind: "follow_player",
            playerName: String(target.username || step.args?.playerName || "玩家").trim() || "玩家",
            playerPosition: toPlainPosition(target.position),
            once,
          },
          clearRecoveryReason: true,
        });
        return;
      }
      const targetDistance = target.entity
        ? getDistance(bot.entity.position, target.position)
        : getHorizontalDistance(bot.entity.position, rendezvous);
      const followGoal = target.entity
        ? new goals.GoalFollow(target.entity, distance)
        : new goals.GoalNear(
            rendezvous.x,
            rendezvous.y,
            rendezvous.z,
            Math.max(1, distance - 1)
          );
      if (targetDistance > distance + 1) {
        if (shouldRefreshContinuousGoal(followGoal, true)) {
          setPathfinderGoal(followGoal, true);
        } else {
          touchMovementSession({
            goalSignature: getPathGoalSignature(followGoal, true),
            kind: "follow_player",
          });
        }
      } else {
        markMovementSessionStable({
          kind: "follow_player",
        });
      }
      recordTaskHeartbeat(currentTask, {
        actionState: targetDistance > distance + 1 ? "moving" : "acting",
        checkpoint: {
          kind: "follow_player",
          playerName: String(target.username || step.args?.playerName || "玩家").trim() || "玩家",
          playerPosition: toPlainPosition(target.position),
          distance: Number(targetDistance.toFixed(2)),
          withinRange: targetDistance <= distance + 1,
          once,
        },
        clearRecoveryReason: true,
      });
      await sleep(loopDelayMs);
    }
  }

  async function executeGoToPosition(step) {
    const position = normalizeVec3Input(step.args);
    if (!position) {
      throw new Error("坐标参数无效");
    }
    updateTaskCheckpoint(currentTask, {
      kind: "go_to_position",
      targetPosition: position,
      range: Number(step.args?.range) || 1,
    });
    await maybeHandleForegroundCombatInterrupt();
    currentTask.progressText = `正在前往 ${position.x}, ${position.y}, ${position.z}`;
    broadcastTaskStatus();
    await moveToPosition(position, Number(step.args?.range) || 1);
    recordTaskHeartbeat(currentTask, {
      actionState: "moving",
      checkpoint: {
        kind: "go_to_position",
        targetPosition: position,
        range: Number(step.args?.range) || 1,
      },
      clearRecoveryReason: true,
    });
  }

  async function executeDiamondExpedition(step) {
    const bot = ensureBotReady();
    const task = getExecutionContext()?.task || currentTask;
    const outerContext = getExecutionContext() || { task, token: getActiveCancellationToken() };
    const miningMovements = new Movements(bot);
    miningMovements.canDig = false;
    miningMovements.allow1by1towers = false;
    miningMovements.allowFreeMotion = false;
    miningMovements.allowParkour = false;
    miningMovements.allowSprinting = false;
    miningMovements.maxDropDown = 2; // Pathfinder counts the support floor: this permits one foot-level step.
    miningMovements.infiniteLiquidDropdownDistance = false;
    miningMovements.scafoldingBlocks = [];
    for (const name of ["water", "lava", "fire", "soul_fire", "magma_block", "powder_snow", "campfire", "sweet_berry_bush"]) {
      const id = bot.registry.blocksByName[name]?.id;
      if (id != null) miningMovements.blocksToAvoid.add(id);
    }
    try {
      return await executionContextStorage.run({ ...outerContext, miningMovements }, async () => {
        ensureMovements(bot);
        const expedition = createDiamondExpedition({
          getBot: ensureBotReady,
          assertActive: checkTaskSignal,
          getCheckpoint: () => task?.diamondExpedition || null,
          saveCheckpoint: (state) => {
            checkTaskSignal();
            if (task) task.diamondExpedition = cloneSerializable(state, {}) || {};
          },
          report: (text, state, progressed = false) => {
            checkTaskSignal();
            if (!task) return;
            task.progressText = text;
            const summary = { kind: "diamond_expedition", phase: state.phase,
              depth: Math.floor(bot.entity.position.y), targetY: state.targetY,
              diamonds: getItemCountByName("diamond"), targetCount: Number(step.args?.count) || 1,
              excavated: Number(state.navigation?.dugBlocks || state.navigation?.dug || 0),
              reason: state.reason || null };
            updateTaskCheckpoint(task, summary);
            if (progressed) recordTaskHeartbeat(task, { actionState: "acting", checkpoint: summary });
            broadcastTaskStatus();
          },
          ensurePlanks, ensureSticks, ensureCraftingTableAvailable, ensureFurnaceAvailable,
          craftItemByName, executeSmeltItem, ensureNutrition, ensureFoodSupply,
          equipBestTool, equipItem: (item) => equipInventoryItem(item),
          digBlock: physicalDigBlock,
          collectDrops: (options) => options?.allowMovement === false ? sleep(500) : collectNearbyDroppedItems(options),
          navigationOptions: { goto: miningPathfinderGoto },
        });
        return expedition.run(step);
      });
    } finally {
      if (currentBot === bot && (!outerContext.runGeneration || task?.executionGeneration === outerContext.runGeneration)) {
        // A newer task/run owns its movements once the previous generation is detached.
        appliedMovementsBot = null;
        appliedMovementsInstance = null;
        ensureMovements(bot);
      }
    }
  }

  async function executeMineResource(step) {
    if (step?.args?.expedition === true && getResourceLearningKey(step.args?.block) === "diamond") {
      return executeDiamondExpedition(step);
    }
    const bot = ensureBotReady();
    ensureMovements(bot);
    const spec = getAliasSpec(step.args?.block || "stone");
    const targetCount = clamp(Number(step.args?.count) || 1, 1, 256);
    const searchRadii = [
      clamp(Number(step.args?.maxDistance) || 24, 12, 96),
      clamp(Number(step.args?.maxDistance) || 48, 24, 96),
      clamp(Math.max(Number(step.args?.maxDistance) || 64, 72), 32, 96),
    ];
    const targetsWood = spec.blocks.some((name) => isWoodBlockName(name));
    if (targetsWood && step.args?.skipToolPreparation !== true) {
      if (step.args?.allowBareHand === true) {
        try {
          await ensureBasicAxeForWood();
        } catch (error) {
          addTaskLog("warn", `暂时做不出斧子，先徒手采木：${error?.message || "工具准备失败"}`);
        }
      } else {
        await ensureBasicAxeForWood();
      }
    } else if (
      step.args?.skipToolPreparation !== true && spec.blocks.some((name) =>
        [
          "stone",
          "cobblestone",
          "coal_ore",
          "deepslate_coal_ore",
          "iron_ore",
          "deepslate_iron_ore",
        ].includes(String(name || "").trim())
      )
    ) {
      if (spec.blocks.some((name) => ["iron_ore", "deepslate_iron_ore"].includes(name))) {
        await ensureStonePickaxeForIron();
      } else {
        await ensureBasicPickaxeForStone();
      }
    }
    let collected = getItemCount(spec.items);
    updateTaskCheckpoint(currentTask, {
      kind: "mine_resource",
      target: String(step.args?.block || "stone").trim() || "stone",
      collected,
      targetCount,
    });

    while (collected < targetCount) {
      checkTaskSignal();
      await maybeHandleForegroundCombatInterrupt();
      if (Number.isFinite(bot.food) && bot.food < 12 && !foodSupplyRunning && !step.args?.supplyingFood) {
        await ensureNutrition(16);
      }
      currentTask.progressText = `正在采集 ${step.args?.label || step.args?.block || "资源"} ${collected}/${targetCount}`;
      broadcastTaskStatus();
      let lastReason = "";
      let minedBlock = false;
      for (const radius of searchRadii) {
        const candidates = findNearestBlocksByNames(spec.blocks, radius, 18).filter((block) =>
          !(step.args?.excludeBounds || []).some((bounds) => block.position.x >= bounds.minX && block.position.x <= bounds.maxX &&
            block.position.y >= bounds.minY && block.position.y <= bounds.maxY &&
            block.position.z >= bounds.minZ && block.position.z <= bounds.maxZ));
        if (!candidates.length) {
          lastReason = `搜索半径 ${radius} 格内没有找到目标`;
          continue;
        }
        for (const block of candidates) {
          try {
            updateTaskCheckpoint(currentTask, {
              kind: "mine_resource",
              target: String(step.args?.block || "stone").trim() || "stone",
              targetBlock: String(block.name || "").trim() || null,
              targetPosition: toPlainPosition(block.position),
              collected,
              targetCount,
            });
            await moveNearBlock(block, 2);
            checkTaskSignal();
            if (
              step.args?.skipToolPreparation !== true && [
                "stone",
                "cobblestone",
                "coal_ore",
                "deepslate_coal_ore",
                "iron_ore",
                "deepslate_iron_ore",
              ].includes(block.name)
            ) {
              if (["iron_ore", "deepslate_iron_ore"].includes(block.name)) {
                await ensureStonePickaxeForIron();
              } else {
                await ensureBasicPickaxeForStone();
              }
            } else if (isWoodBlockName(block.name) && step.args?.skipToolPreparation !== true) {
              if (step.args?.allowBareHand === true) {
                try {
                  await ensureBasicAxeForWood();
                } catch (_) {}
              } else {
                await ensureBasicAxeForWood();
              }
            }
            if (["diamond_ore", "deepslate_diamond_ore"].includes(block.name)) {
              const ok = await ensureMiningToolByPriority(
                ["netherite_pickaxe", "diamond_pickaxe", "iron_pickaxe"],
                "正在寻找铁镐或更好的镐子来挖钻石"
              );
              if (!ok) {
                throw new Error("需要铁镐或更好的镐子才能挖钻石；背包和附近箱子里都没找到");
              }
            }
            if (["obsidian"].includes(block.name)) {
              const ok = await ensureMiningToolByPriority(
                ["netherite_pickaxe", "diamond_pickaxe"],
                "正在寻找钻石镐或更好的镐子来挖黑曜石"
              );
              if (!ok) {
                throw new Error("需要钻石镐或更好的镐子才能挖黑曜石；背包和附近箱子里都没找到");
              }
            }
            if (getExecutionContext()?.houseResourceExclusionBounds) await waitForSurfaceGround("采集建房材料");
            await equipBestTool(block);
            if (!bot.canDigBlock(block)) {
              lastReason = `当前无法挖掘 ${block.displayName || block.name}`;
              continue;
            }
            const beforeCollected = getItemCount(spec.items);
            await physicalDigBlock(block, block.displayName || block.name);
            recordTaskHeartbeat(currentTask, {
              actionState: "acting",
              checkpoint: {
                kind: "mine_resource",
                targetBlock: String(block.name || "").trim() || null,
                targetPosition: toPlainPosition(block.position),
              },
            });
            await sleep(250);
            await collectNearbyDroppedItems({
              position: block.position,
              radius: isWoodBlockName(block.name) ? 6 : 4,
              timeoutMs: isWoodBlockName(block.name) ? 4200 : 2200,
              idleGraceMs: 400,
            });
            await sleep(180);
            collected = getItemCount(spec.items);
            if (collected <= beforeCollected && isWoodBlockName(block.name)) {
              await sleep(300);
              await collectNearbyDroppedItems({
                position: block.position,
                radius: 7,
                timeoutMs: 2200,
                idleGraceMs: 300,
              });
              collected = getItemCount(spec.items);
            }
            recordTaskHeartbeat(currentTask, {
              actionState: "acting",
              checkpoint: {
                kind: "mine_resource",
                target: String(step.args?.block || "stone").trim() || "stone",
                collected,
                targetCount,
              },
              clearRecoveryReason: true,
            });
            minedBlock = true;
            break;
          } catch (error) {
            checkTaskSignal();
            lastReason = error?.message || String(error || "");
          }
        }
        if (minedBlock) {
          break;
        }
      }
      if (!minedBlock) {
        const message = lastReason || "附近没有找到可采集目标";
        throw new Error(spec.blocks.some((name) => ["diamond_ore", "deepslate_diamond_ore"].includes(name)) &&
          /没有找到/.test(message)
          ? `${message}；本步骤只扫描附近矿物；请使用“从零开始挖到钻石”启动自动下矿探矿任务`
          : message);
      }
    }
    currentTask.progressText = `已采集完成 ${targetCount} 个 ${step.args?.label || step.args?.block || "资源"}`;
    broadcastTaskStatus();
  }

  async function executeHarvestCrops(step) {
    const bot = ensureBotReady();
    ensureMovements(bot);
    const cropNames = (
      Array.isArray(step.args?.crops)
        ? step.args.crops
        : String(step.args?.crop || "wheat,carrots,potatoes")
            .split(",")
            .map((item) => item.trim())
    )
      .map((name) => String(name || "").trim())
      .filter((name) => Object.prototype.hasOwnProperty.call(CROP_HARVEST_CONFIG, name));
    if (!cropNames.length) {
      throw new Error("没有指定可收割的作物类型");
    }
    const targetCount = clamp(Number(step.args?.count) || 4, 1, 64);
    const maxDistance = clamp(Number(step.args?.maxDistance) || 20, 6, 64);
    const replant = step.args?.replant !== false;
    let harvested = 0;

    while (harvested < targetCount) {
      checkTaskSignal();
      await maybeHandleForegroundCombatInterrupt();
      if (Number.isFinite(bot.food) && bot.food < 12 && !foodSupplyRunning && !step.args?.supplyingFood) {
        await ensureNutrition(16);
      }
      currentTask.progressText = `正在收割附近成熟作物 ${harvested}/${targetCount}`;
      broadcastTaskStatus();
      const candidates = findNearestMatureCropBlocks(cropNames, maxDistance, 18);
      if (!candidates.length) {
        throw new Error("附近没有找到成熟可收割的作物");
      }
      const block = candidates[0];
      const config = CROP_HARVEST_CONFIG[block.name];
      const position = block.position.clone();
      await moveNearBlock(block, 2);
      const beforeFood = getFoodReserveCount();
      await physicalDigBlock(block, block.displayName || block.name);
      await sleep(220);
      await collectNearbyDroppedItems({
        position,
        radius: 3,
        timeoutMs: 2200,
        idleGraceMs: 320,
      });
      if (replant && config?.replantItem && findInventoryItem([config.replantItem])) {
        try {
          await executePlaceBlock({
            args: {
              position,
              item: config.replantItem,
            },
          });
        } catch (_) {}
      }
      harvested += 1;
      if (getFoodReserveCount() <= beforeFood && getItemCountByName("wheat") < 3) {
        await sleep(120);
      }
    }
    currentTask.progressText = `已收割完成 ${harvested} 株作物`;
    broadcastTaskStatus();
  }

  async function executePlantCrops(step) {
    const cropNames = (
      Array.isArray(step.args?.crops)
        ? step.args.crops
        : String(step.args?.crop || "wheat,carrots,potatoes")
            .split(",")
            .map((item) => item.trim())
    )
      .map((name) => String(name || "").trim())
      .filter((name) => Object.prototype.hasOwnProperty.call(CROP_HARVEST_CONFIG, name));
    if (!cropNames.length) {
      throw new Error("没有指定可补种的作物类型");
    }
    const targetCount = clamp(Number(step.args?.count) || 4, 1, 64);
    const maxDistance = clamp(Number(step.args?.maxDistance) || 20, 6, 64);
    const replantItems = cropNames
      .map((cropName) => CROP_HARVEST_CONFIG[cropName]?.replantItem)
      .filter(Boolean);
    if (!replantItems.some((itemName) => findInventoryItem([itemName]))) {
      try {
        await withdrawItemsFromNearbyContainer({
          names: replantItems,
          count: targetCount,
          progressText: "正在从附近箱子拿作物种子/作物做补种",
        });
      } catch (_) {}
    }
    let planted = 0;
    while (planted < targetCount) {
      checkTaskSignal();
      await maybeHandleForegroundCombatInterrupt();
      currentTask.progressText = `正在补种附近农田 ${planted}/${targetCount}`;
      broadcastTaskStatus();
      const targets = findPlantableFarmlandTargets(cropNames, maxDistance, 18);
      if (!targets.length) {
        throw new Error("附近没有可补种的空农田");
      }
      let plantedThisRound = false;
      for (const target of targets) {
        checkTaskSignal();
        const cropName = cropNames.find((name) =>
          Boolean(findInventoryItem([CROP_HARVEST_CONFIG[name]?.replantItem || ""]))
        );
        if (!cropName) {
          break;
        }
        const itemName = CROP_HARVEST_CONFIG[cropName].replantItem;
        const expectedBlock = CROP_ITEM_TO_BLOCK[itemName] || cropName;
        try {
          await executePlaceBlock({
            args: {
              position: target.position,
              item: itemName,
              expectBlocks: [expectedBlock],
            },
          });
          planted += 1;
          plantedThisRound = true;
          break;
        } catch (_) {}
      }
      if (!plantedThisRound) {
        throw new Error("缺少可用种子/作物，或附近农田当前无法补种");
      }
    }
    currentTask.progressText = `已补种完成 ${planted} 格农田`;
    broadcastTaskStatus();
  }

  async function executeAttackHostile(step, escortEntity = null) {
    const bot = ensureBotReady();
    ensureMovements(bot);
    const maxDistance = clamp(Number(step.args?.maxDistance) || 16, 6, 28);
    const leashDistance = clamp(Number(step.args?.leashDistance) || 12, 4, 28);
    const timeoutAt = Date.now() + clamp(Number(step.args?.timeoutMs) || 15000, 3000, 45000);
    const readiness = await ensureCombatReadiness({
      allowBootstrap: false,
    });
    if (currentTask) {
      currentTask.combatReadiness = readiness.readiness;
    }

    while (Date.now() < timeoutAt) {
      checkTaskSignal();
      if (Number(bot.health) <= 10) throw Object.assign(new Error("近战生命过低，停止战斗并保留进度"), {code:"mining_low_health"});
      if (Number.isFinite(bot.food) && bot.food < 10) {
        await ensureNutrition(14);
      }
      const hostile = escortEntity?.position
        ? findPriorityEscortHostile(escortEntity, {
            searchRadius: maxDistance,
            maxBotDistance: Math.max(leashDistance + 10, getDistance(bot.entity.position, escortEntity.position) + maxDistance),
          })
        : findHostileEntity(escortEntity, maxDistance, {
            protectEntity: escortEntity,
            maxBotDistance: maxDistance + 6,
          });
      if (!hostile) {
        if (escortEntity) {
          if (currentTask) {
            currentTask.escortState = "idle";
            currentTask.lastGuardScanResult = "no_hostile_in_range";
          }
          return false;
        }
        throw new Error("附近没有发现敌对生物");
      }
      if (
        escortEntity &&
        getDistance(escortEntity.position, hostile.position) > Math.max(leashDistance, 12)
      ) {
        return false;
      }
      updateTaskCheckpoint(currentTask, {
        kind: "attack_hostile",
        hostileName: String(hostile.name || "").trim() || null,
        hostileId: Number(hostile.id || hostile.entityId || 0) || null,
        hostilePosition: toPlainPosition(hostile.position),
      });
      currentTask.progressText = `正在攻击 ${hostile.displayName || hostile.name}`;
      if (currentTask) {
        currentTask.escortState = escortEntity ? "engaged" : currentTask.escortState || null;
        currentTask.lastHostileSeenAt = Date.now();
        currentTask.lastGuardScanResult = "hostile_engaged";
      }
      broadcastTaskStatus();
      await equipBestWeapon();
      const hostileDistance = bot.entity.position.distanceTo(hostile.position);
      if (hostileDistance > 2.6) {
        const followGoal = new goals.GoalFollow(hostile, 2);
        if (shouldRefreshContinuousGoal(followGoal, true)) {
          setPathfinderGoal(followGoal, true);
        } else {
          touchMovementSession({
            goalSignature: getPathGoalSignature(followGoal, true),
            kind: "attack_hostile",
          });
        }
      } else {
        markMovementSessionStable({
          kind: "attack_hostile",
        });
      }
      if (bot.entity.position.distanceTo(hostile.position) <= 3) {
        try {
          await safeBotLookAt(hostile.position.offset(0, hostile.height || 1, 0), true, {
            targetName: hostile?.name || null,
            reason: "attack_hostile",
          });
        } catch (_) {}
        try {
          await physicalAttack(hostile, hostile.displayName || hostile.name);
          recordTaskHeartbeat(currentTask, {
            actionState: "acting",
            checkpoint: {
              kind: "attack_hostile",
              hostileName: String(hostile.name || "").trim() || null,
              hostilePosition: toPlainPosition(hostile.position),
            },
            clearRecoveryReason: true,
          });
        } catch (_) {}
      }
      await sleep(bot.heldItem?.name?.endsWith("_axe") ? 1100 : 650);
    }
    return true;
  }

  function isUnarmedHouseExplorer(bot, task = currentTask) {
    return task?.status === TaskState.RUNNING && require('./minecraft/houseAutomaticRecovery').selfGatheredHouseWork(task)
      && !bot.inventory.items().some(item => WEAPON_ITEM_PRIORITY.includes(item.name) || AXE_ITEM_PRIORITY.includes(item.name));
  }

  function findUnarmedSiteMeleeThreat(bot, task = currentTask) {
    if (!isUnarmedHouseExplorer(bot, task) || activeHouseSurfaceNavigationMove?.bot !== bot) return null;
    return Object.values(bot.entities || {}).filter(entity => ["zombie", "zombie_villager", "husk", "drowned", "spider", "cave_spider"].includes(entity?.name)
      && entity.isValid !== false && entity.position && Math.abs(entity.position.y - bot.entity.position.y) < 4
      && entity.position.distanceTo(bot.entity.position) <= 4.5&&!terrainSeparatedHouseMelee(bot,entity))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null;
  }
  function allowsUnarmedHouseRangedStep(bot,position,task=currentTask){
    if(!isUnarmedHouseExplorer(bot,task)&&!(task?.status===TaskState.RUNNING&&require('./minecraft/houseAutomaticRecovery').selfGatheredHouseWork(task)))return true;
    if(!position)return false;
    if(activeSurvivalInterrupt?.task===task&&isSurvivalOwnerCurrent(activeSurvivalInterrupt))return true;
    if(isUnarmedHouseExplorer(bot,task)&&Object.values(bot.entities||{}).some(e=>
      ['creeper','zombie','zombie_villager','husk','drowned','spider','cave_spider'].includes(e?.name)&&e.isValid!==false&&e.position
      &&isThreateningMobEntity(e,bot.registry)&&Math.abs(e.position.y-position.y)<4
      // Resolve cheap separation first. A distant mob cannot affect this
      // step, so repeated full terrain rays would only consume native A* time.
      &&Math.hypot(position.x+.5-e.position.x,position.z+.5-e.position.z)
        <Math.min(e.name==='creeper'?17:12,Math.hypot(bot.entity.position.x-e.position.x,bot.entity.position.z-e.position.z)-.5)
      &&!terrainSeparatedHouseMelee(bot,e)))return false;
    return Object.values(bot.entities||{}).filter(e=>isHouseRangedThreatEntity(e)&&e.isValid!==false&&e.position&&shouldAvoidHouseRangedThreat(bot,e)
      &&isThreateningMobEntity(e,bot.registry)&&Math.abs(e.position.y-position.y)<8).every(e=>{
      const current=Math.hypot(bot.entity.position.x-e.position.x,bot.entity.position.z-e.position.z);
      return Math.hypot(position.x+.5-e.position.x,position.z+.5-e.position.z)>=Math.min(24,current-.5)
        ||rangedCoverConfirmed(bot,new Vec3(position.x+.5,position.y,position.z+.5),[e]);
    });
  }
  function terrainSeparatedHouseMelee(bot,entity){
    return require('./minecraft/houseAutomaticRecovery').selfGatheredHouseWork(currentTask)
      &&require('./minecraft/houseCombatCleanupThreat').naturalTerrainSeparatesMelee(bot,entity,currentTask.materialSupply||currentTask.startupWood||{},
        {recentDamage:Date.now()-Number(combatMemory.lastBotHurtAt||0)<6500});
  }
  function nearbyHouseResourceThreats(bot) {
    return Object.values(bot.entities || {}).filter(e => (["creeper", "zombie", "zombie_villager", "husk", "drowned", "spider", "cave_spider", "phantom", "enderman"].includes(e?.name)
      ||require("./minecraft/entitySemantics").isObservedSelfAggressor(e))
      && e.isValid !== false && isThreateningMobEntity(e,bot.registry) && e.position && Math.abs(e.position.y - bot.entity.position.y) < 4
      && bot.entity.position.distanceTo(e.position) <= 8.5&&!terrainSeparatedHouseMelee(bot,e))
      .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
  }
  function canDefendContactBeforeCreeper(bot, contact, creeper) {
    if (!contact || !creeper || !["zombie", "zombie_villager", "husk", "drowned", "spider", "cave_spider"].includes(contact.name)
      || meleeReachDistance(bot.entity, contact) > 3
      || creeper.position.distanceTo(bot.entity.position) <= 5 || bot.version !== "1.21.8" || !creeper.metadata) return false;
    const keys = bot.registry.entitiesByName.creeper?.metadataKeys || [];
    const ordinary = ["is_powered", "is_ignited"].every(name => {
      const index = keys.indexOf(name), value = creeper.metadata[index];
      return index >= 0 && (value === undefined || value === false || value === 0);
    });
    const swellIndex = keys.indexOf("swell_dir"), swell = creeper.metadata[swellIndex];
    return ordinary && swellIndex >= 0 && (swell === undefined || swell === -1);
  }
  function findHouseResourceEscapeThreat(bot, task = currentTask) {
    const work = activeHouseResourceWork;
    if (!work || !require('./minecraft/houseAutomaticRecovery').selfGatheredHouseWork(task) || work.closed || work.bot !== bot || work.client !== bot._client || work.task !== task
      || task?.status !== TaskState.RUNNING || work.generation !== task.executionGeneration
      || work.token !== task.cancellationToken || !isMovementLeaseActive(work.lease)
      || work.deadline!==null&&(!Number.isFinite(work.deadline)||Date.now()>=work.deadline)) return null;
    const unarmed=!findInventoryItem(WEAPON_ITEM_PRIORITY);
    const nearby = nearbyHouseResourceThreats(bot), creeper = nearby.find(e => e.name === "creeper"),
      melee = nearby.filter(e => e.name !== "creeper"&&!isHouseRangedThreatEntity(e)&&(!unarmed||e.position.distanceTo(bot.entity.position)<=4.5));
    const unarmedClose=unarmed&&melee.find(e=>e.position.distanceTo(bot.entity.position)<=4.5);
    return creeper || ((work.gatheringHouse&&melee.length>=2||bot.health<=10&&melee.length>=1)?melee[0]:unarmedClose||null);
  }

  async function maybeHandleSurvivalCritical(reason = "survival") {
    if (!currentBot?.entity || survivalInterruptRunning) {
      return false;
    }
    const naturalHouseWork=require('./minecraft/houseAutomaticRecovery').selfGatheredHouseWork(currentTask);
    const survivalState=currentTask?.materialSupply||(naturalHouseWork?(currentTask.startupWood||=( {schema:1,combatOnly:true} )):null);
    const automaticRecovery=currentTask?.status===TaskState.PAUSED&&currentTask.automaticSurvivalRecovery===true
      &&naturalHouseWork;
    if(currentTask&&currentTask.status!==TaskState.RUNNING&&!automaticRecovery)return false;
    if(automaticRecovery&&activeMovementLease&&!(activeMovementLease.kind==="task"
      &&(activeMovementLease.ownerId===currentTask.taskId||activeMovementLease.ownerId?.startsWith(`${currentTask.taskId}:`))))return false;
    const bot = ensureBotReady();
    const camp = currentTask?.materialSupply?.camp?.anchor;
    const campScope = currentTask?.status === TaskState.RUNNING && currentTask.materialSupply?.materialSource === "self_gathered"
      && camp && currentTask.movementLease && isMovementLeaseActive(currentTask.movementLease)
      && !activeMiningNavigationMove && !activeHouseSurfaceNavigationMove && !activeHouseSurfaceWater && !activeHouseResourceWork
      && Math.hypot(bot.entity.position.x - camp.x, bot.entity.position.z - camp.z) <= 12
      && Math.abs(bot.entity.position.y - camp.y) <= 3 && hasGroundedBodySupport(bot);
    const campCreeper = campScope && Object.values(bot.entities || {}).filter(entity => entity?.name === "creeper"
      && entity.isValid !== false && isThreateningMobEntity(entity,bot.registry) && entity.position && Math.abs(entity.position.y - bot.entity.position.y) < 4
      && entity.position.distanceTo(bot.entity.position) <= 8.5)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    const recentSelfDamage = Date.now() - Number(combatMemory.lastBotHurtAt || 0) < 6500;
    const surfaceCreeper = (activeHouseSurfaceNavigationMove?.bot === bot||automaticRecovery
      ||naturalHouseWork&&currentTask?.status===TaskState.RUNNING&&isMovementLeaseActive(currentTask.movementLease)) && Object.values(bot.entities || {})
      .filter(entity => entity?.name === "creeper" && entity.isValid !== false && entity.position
        && isThreateningMobEntity(entity,bot.registry)
        && Math.abs(entity.position.y - bot.entity.position.y) < 4 && entity.position.distanceTo(bot.entity.position) <= 8.5&&!terrainSeparatedHouseMelee(bot,entity))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    const observedUnarmedSiteMelee=findUnarmedSiteMeleeThreat(bot);
    const unarmedSiteMelee=observedUnarmedSiteMelee&&!terrainSeparatedHouseMelee(bot,observedUnarmedSiteMelee)?observedUnarmedSiteMelee:null;
    const resourceEscapeThreat = findHouseResourceEscapeThreat(bot);
    const siteSurvival=currentTask?.status===TaskState.RUNNING
      &&currentTask.currentStep==='build_furnished_house_phase'
      &&currentTask.siteSearch?.kind==='loaded_natural_house_site_search'&&!currentTask.siteSearch.reservation
      &&currentTask.siteSearch.ownerIdentity?.taskId===currentTask.taskId;
    const perceivedRanged=findHouseRangedThreat(bot)||(recentSelfDamage?findObservedHouseRangedThreat(bot):null);
    const houseRanged=(currentTask?.status===TaskState.RUNNING||automaticRecovery)&&(naturalHouseWork||siteSurvival)
      &&require('./minecraft/houseRangedCombat').shouldInterruptWorkForRanged(bot,perceivedRanged,recentSelfDamage)?perceivedRanged:null;
    const touchingHouseMelee=naturalHouseWork
      &&nearbyHouseResourceThreats(bot).find(e=>e.name!=="creeper"&&!isHouseRangedThreatEntity(e)&&e.position.distanceTo(bot.entity.position)<=3);
    const nearHouseMelee=naturalHouseWork
      &&nearbyHouseResourceThreats(bot).find(e=>e.name!=="creeper"&&!isHouseRangedThreatEntity(e)&&e.position.distanceTo(bot.entity.position)<=(findInventoryItem(WEAPON_ITEM_PRIORITY)?6.5:4.5));
    const hostileEnderman=naturalHouseWork&&Object.values(bot.entities||{}).filter(e=>e?.name==='enderman'
      &&e.isValid!==false&&e.position&&isThreateningMobEntity(e,bot.registry)
      &&Math.abs(e.position.y-bot.entity.position.y)<4&&e.position.distanceTo(bot.entity.position)<16
      &&!terrainSeparatedHouseMelee(bot,e))
      .sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position))[0];
    const observedCreeper = surfaceCreeper || campCreeper || (resourceEscapeThreat?.name === "creeper" ? resourceEscapeThreat : null);
    const immediateContact = canDefendContactBeforeCreeper(bot, touchingHouseMelee, observedCreeper) ? touchingHouseMelee : null;
    let fallbackThreat=findHostileEntity(bot.entity,7,{protectEntity:bot.entity,maxBotDistance:8});
    if(naturalHouseWork&&!recentSelfDamage&&fallbackThreat
      &&['creeper','zombie','zombie_villager','husk','drowned','spider','cave_spider'].includes(fallbackThreat.name)
      &&Math.abs(fallbackThreat.position.y-bot.entity.position.y)>=4){
      const keys=bot.registry.entitiesByName.creeper?.metadataKeys||[],metadata=fallbackThreat.metadata;
      const activeFuse=fallbackThreat.name==='creeper'&&metadata
        &&(metadata[keys.indexOf('is_ignited')]===true||metadata[keys.indexOf('is_ignited')]===1||metadata[keys.indexOf('swell_dir')]===1);
      if(!activeFuse)fallbackThreat=null;
    }
    if(fallbackThreat&&terrainSeparatedHouseMelee(bot,fallbackThreat))fallbackThreat=null;
    let closeThreat = immediateContact || surfaceCreeper || campCreeper || touchingHouseMelee || unarmedSiteMelee || nearHouseMelee || hostileEnderman || resourceEscapeThreat || houseRanged || fallbackThreat;
    if (!closeThreat) {
      return false;
    }
    const threatDistance = bot.entity.position.distanceTo(closeThreat.position);
    if (activeHouseSurfaceWater?.task === currentTask && activeHouseSurfaceWater.isPhysicalOwner()) {
      const frame=activeHouseSurfaceWater;
      const threats=Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&e.isValid!==false
        &&e.position&&isThreateningMobEntity(e,bot.registry)
        &&e.position.distanceTo(bot.entity.position)<=32);
      if(bot.health>=16&&bot.food>=14&&require('./minecraft/houseWaterThreatPolicy').waterThreatEscapeForward(
        frame.route,bot.entity.position,threats)){
        if(!frame.forwardEscapeRecorded){frame.forwardEscapeRecorded=true;
          recordTaskDiagnostic(currentTask,'house_water_escape_forward',{route:frame.route,actual:toPlainPosition(bot.entity.position),
            threats:threats.map(e=>({id:e.id,name:e.name,position:toPlainPosition(e.position)})),arrivalConfirmed:false});}
        return true;
      }
      activeHouseSurfaceWater.session.requestCancel("water_hostile_retreat");
      return true;
    }
    if (!surfaceCreeper && !unarmedSiteMelee && !resourceEscapeThreat && !campCreeper && !houseRanged && !nearHouseMelee && !hostileEnderman && !recentSelfDamage && threatDistance > 4.5) {
      return false;
    }
    survivalInterruptRunning = true;
    lastSurvivalInterruptAt = Date.now();
    const previousLease = activeMovementLease;
    const survivalLease = claimMovementLease("survival-critical", reason);
    const miningMove = activeMiningNavigationMove;
    const confinedMining = miningMove?.bot === bot && miningMove.task === currentTask &&
      miningMove.lease === previousLease && miningMove.movements === bot.pathfinder.movements;
    const surfaceMove = activeHouseSurfaceNavigationMove;
    const confinedSurface = surfaceMove?.bot === bot && !surfaceMove.closed && surfaceMove.task === currentTask &&
      surfaceMove.lease === previousLease && surfaceMove.movements === bot.pathfinder.movements;
    const resourceWork = activeHouseResourceWork;
    const confinedResource = resourceWork?.bot === bot && !resourceWork.closed && resourceWork.client === bot._client
      && resourceWork.task === currentTask && resourceWork.generation === currentTask?.executionGeneration
      && resourceWork.token === currentTask?.cancellationToken && resourceWork.lease === previousLease
      && resourceWork.movements === bot.pathfinder.movements;
    const needsStationaryDefenseProfile=campCreeper||(houseRanged||(siteSurvival||naturalHouseWork)&&require("./minecraft/entitySemantics").isObservedSelfAggressor(closeThreat)||naturalHouseWork&&["zombie","zombie_villager","husk","drowned","spider","cave_spider","creeper","enderman"].includes(closeThreat.name))&&!confinedMining&&!confinedSurface&&!confinedResource;
    const campPreviousProfile = needsStationaryDefenseProfile ? bot.pathfinder.movements : null;
    const campMove = needsStationaryDefenseProfile ? { movements: new Movements(bot), deadline: Date.now() + (houseRanged?32000:8000) } : null;
    if (campMove) {
      const p = campMove.movements;
      p.canDig = false; p.scafoldingBlocks = []; p.allowParkour = false; p.allow1by1towers = false;
      p.allowSprinting = false; p.allowFreeMotion = false; p.maxDropDown = 2; p.infiniteLiquidDropdownDistance = false;
      p.getMoveDiagonal = () => {};
      for (const name of SURFACE_HAZARDS) {
        const id = bot.registry.blocksByName[name]?.id;
        if (id != null) p.blocksToAvoid.add(id);
      }
      p.exclusionAreasStep.push(block => block?.position && [-1, 0, 1].every(dy => {
        const cell = bot.blockAt(block.position.offset(0, dy, 0));
        return cell && !SURFACE_HAZARDS.has(cell.name) && ![true, "true"].includes(cell.getProperties?.().waterlogged);
      }) ? 0 : Infinity);
      bot.pathfinder.setMovements(p);
      recordTaskDiagnostic(currentTask, "house_camp_defense_started", { threat: closeThreat.name, threatDistance,
        actualPosition: toPlainPosition(bot.entity.position), timeoutMs: 8000, escapeTimeoutMs:4000 });
    }
    const stationaryHouse = currentTask?.status === TaskState.RUNNING && naturalHouseWork
      ? { movements: bot.pathfinder.movements } : null;
    const confinedMove = confinedMining ? miningMove : confinedSurface ? surfaceMove : confinedResource ? resourceWork : campMove || stationaryHouse;
    const confined = Boolean(confinedMove);
    const independentSurvival=naturalHouseWork;
    const interrupt = { bot, client: bot._client, task: currentTask,
      runGeneration: currentTask?.executionGeneration, token: automaticRecovery||independentSurvival?new CancellationToken():currentTask?.cancellationToken || runtimeToken,
      workToken:currentTask?.cancellationToken||runtimeToken,
      automaticRecovery:automaticRecovery||independentSurvival,
      previousLease, lease: survivalLease, previousMovements:campPreviousProfile||bot.pathfinder.movements,
      stationaryMovements:campMove?.movements||null, miningMove: confinedMining ? miningMove : null,
      surfaceMove: confinedSurface ? surfaceMove : null,
      resourceWork: confinedResource ? resourceWork : null,
      surfacePosition: confinedSurface || confinedResource || campMove || houseRanged ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null,
      rangedEngagement:(independentSurvival||siteSurvival)&&isHouseRangedThreatEntity(closeThreat)&&!touchingHouseMelee,
      startedAt:Date.now(),startingHealth:bot.health,
      finished: false, error: null };
    interrupt.deadline=Date.now()+(interrupt.rangedEngagement?32000:independentSurvival?24000:8000);
    const survivalActionDeadline=Math.min(interrupt.deadline,independentSurvival?Infinity:
      Number.isFinite(confinedMove?.deadline)?confinedMove.deadline:Infinity);
    interrupt.finishedPromise=new Promise(resolve=>{interrupt.resolveFinished=resolve;});
    activeSurvivalInterrupt = interrupt;
    if(independentSurvival){
      require('./minecraft/houseCombatMode').transitionCombat(survivalState,'fighting',{
        startedAt:interrupt.startedAt,targetId:closeThreat.id,targetName:closeThreat.name,trigger:reason,
        resumeTaskId:interrupt.task.taskId,resumeStep:interrupt.task.currentStepIndex,resumeGeneration:interrupt.runGeneration,
        reactionMs:recentSelfDamage?Date.now()-combatMemory.lastBotHurtAt:null});
      recordTaskDiagnostic(interrupt.task,'house_combat_mode_started',survivalState.combatMode);
    }
    if (confinedResource) recordTaskDiagnostic(interrupt.task, "house_resource_defense_started", {
      mode: resourceEscapeThreat ? "bounded_escape" : "stationary_defense", threat: closeThreat.name,
      originalDeadline: resourceWork.deadline, health: bot.health, actualPosition: toPlainPosition(bot.entity.position),
      threats: nearbyHouseResourceThreats(bot).slice(0, 16).map(e => ({ id: e.id, name: e.name, position: toPlainPosition(e.position) })) });
    if (confinedSurface) recordTaskDiagnostic(interrupt.task, "house_surface_defense_started", {
      threat: closeThreat.name, threatDistance, previousLease: previousLease?.token, survivalLease: survivalLease.token,
      originalDeadline: surfaceMove.deadline, sameProfile: bot.pathfinder.movements === surfaceMove.movements,
      taskId: interrupt.task?.taskId, generation: interrupt.runGeneration,
      actualPosition: toPlainPosition(bot.entity.position), velocity: toPlainPosition(bot.entity.velocity),
      onGround: bot.entity.onGround, health: bot.health, food: bot.food,
      nearbyCreepers: Object.values(bot.entities || {}).filter(entity => entity?.name === "creeper" &&
        entity.isValid !== false && entity.position && entity.position.distanceTo(bot.entity.position) <= 16)
        .slice(0, 16).map(entity => ({ id: entity.id, position: toPlainPosition(entity.position),
          distance: entity.position.distanceTo(bot.entity.position) })) });
    const assertInterruptActive = () => {
      interrupt.token?.throwIfRequested();
      if(independentSurvival&&!interrupt.task?.automaticSurvivalRecovery)interrupt.workToken?.throwIfRequested();
      if(interrupt.workToken&&(interrupt.task?.cancellationToken||runtimeToken)!==interrupt.workToken)throw createAbortError("movement_preempted");
      if (!isSurvivalOwnerCurrent(interrupt) || !isBotConnectionWritable()) throw createAbortError("cancelled");
      ensureMovementLeaseActive(survivalLease);
      if (confined && bot.pathfinder.movements !== confinedMove.movements && !ownsSurvivalTemporaryProfile(bot,survivalLease)) throw createAbortError("movement_preempted");
      if (confinedSurface&&!independentSurvival) surfaceMove.assertActive();
      if (confinedResource&&!independentSurvival && Number.isFinite(resourceWork.deadline) && Date.now() >= resourceWork.deadline)
        throw Object.assign(new Error("避让已达到原采集预算"), { code: "house_resource_leg_limit" });
      if(Date.now()>=interrupt.deadline)throw Object.assign(Error("本次生存中断达到原总时限"),{code:"survival_interrupt_timeout"});
      if(closeThreat.name!=="creeper"){
        const urgent=Object.values(bot.entities||{}).filter(e=>e?.name==="creeper"&&e.isValid!==false&&e.position
          &&isThreateningMobEntity(e,bot.registry)
          &&Math.abs(e.position.y-bot.entity.position.y)<4&&e.position.distanceTo(bot.entity.position)<=8.5
          &&!terrainSeparatedHouseMelee(bot,e)&&!canDefendContactBeforeCreeper(bot,closeThreat,e))
          .sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position))[0];
        if(urgent)throw Object.assign(Error("新苦力怕威胁抢占普通近战"),{code:"survival_threat_escalated",threat:urgent});
      }
      if(closeThreat.name==="creeper"&&closeThreat.position?.distanceTo(bot.entity.position)>14){
        const contact=nearbyHouseResourceThreats(bot).find(e=>e!==closeThreat&&e.name!=="creeper"&&e.position.distanceTo(bot.entity.position)<=3);
        const ranged=findHouseRangedThreat(bot);
        if(contact||ranged)throw Object.assign(Error("远离的旧苦力怕不再占用新的贴身或弓箭自卫"),
          {code:"survival_threat_escalated",threat:contact||ranged});
      }
      if ((independentSurvival||siteSurvival) && isHouseRangedThreatEntity(closeThreat)) {
        const contact = nearbyHouseResourceThreats(bot).find(entity => entity !== closeThreat && entity.name !== 'creeper'
          && ['zombie','zombie_villager','husk','drowned','spider','cave_spider','enderman'].includes(entity.name) && meleeReachDistance(bot.entity, entity) <= 3);
        if (contact) throw Object.assign(Error('贴身近战抢占远程接近和紧急掩体施工'), { code: 'survival_threat_escalated', threat: contact });
      }
      if(independentSurvival&&["zombie","zombie_villager","husk","drowned","spider","cave_spider"].includes(closeThreat.name)
        &&meleeReachDistance(bot.entity,closeThreat)>3){
        const contact=nearbyHouseResourceThreats(bot).find(e=>e!==closeThreat&&e.name!=="creeper"&&meleeReachDistance(bot.entity,e)<=3);
        const jointUnarmedRetreat=Boolean(contact)&&!findInventoryItem(WEAPON_ITEM_PRIORITY)
          &&['zombie','zombie_villager','husk','drowned','spider','cave_spider'].includes(contact.name)
          &&(confinedSurface||campMove||confinedResource);
        // Empty-hand contact strikes already select the closest live hitbox.
        // The bounded retreat validates every nearby melee threat; repeatedly
        // switching its primary after each knockback prevents any retreat.
        if(contact&&!jointUnarmedRetreat&&!retainMeleeTargetAfterKnockback(bot.entity,closeThreat,contact,combatMemory))throw Object.assign(Error("新的贴身敌人优先于暂时打不到的旧近战目标"),{code:"survival_threat_escalated",threat:contact});
        if(!contact){
          const archer=findHouseRangedThreat(bot)||findObservedHouseRangedThreat(bot);
          if(archer&&require('./minecraft/entitySemantics').isObservedSelfAggressor(archer)
            &&!rangedCoverConfirmed(bot,bot.entity.position,[archer]))
            throw Object.assign(Error('近敌已离开攻击范围，已确认的射手伤害优先避箭'),{code:'survival_threat_escalated',threat:archer});
        }
      }
      if (Number(bot.health) <= 0) {
        const error = new Error("自卫时生命值过低，已停止并保留采矿进度");
        error.code = "mining_low_health";
        throw error;
      }
    };
    let confinedEscapeDropLimit = null;
    try {
      return await executionContextStorage.run({ ...(getExecutionContext() || {}),
        task: interrupt.task, token: interrupt.token, runGeneration: interrupt.runGeneration,
        ...(automaticRecovery||independentSurvival?{pausedSurvivalOwner:interrupt}:{}),
        movementLease: survivalLease,
        ...(confined ? { miningMovements: confinedMove.movements } : {}) }, async () => {
        const respond=async()=>{
        assertInterruptActive();
        // Ranged cover and melee approaches use the same one-block native
        // combat steps as creeper retreat. Narrow the captured exploration
        // drop allowance for every such interrupt, then restore only on a
        // successful handoff to its exact original owner.
        if(confinedSurface&&[5,6].includes(confinedMove.movements.maxDropDown)){
          confinedEscapeDropLimit=confinedMove.movements.maxDropDown;confinedMove.movements.maxDropDown=2;
        }
        if(interrupt.rangedEngagement)recordTaskDiagnostic(interrupt.task,"house_ranged_target_locked",{targetId:closeThreat.id,distance:bot.entity.position.distanceTo(closeThreat.position),perceptionRadius:24,armed:Boolean(findInventoryItem(WEAPON_ITEM_PRIORITY)),health:bot.health,
          trigger:reason,damageResponseMs:recentSelfDamage?Date.now()-combatMemory.lastBotHurtAt:null,
          decision:shouldPressHouseRanged(bot,closeThreat)?"engage":"cover",shield:bot.inventory.slots[45]?.name==="shield"});
        if (currentTask) {
          addTaskLog(
            "warn",
            `受到 ${closeThreat.displayName || closeThreat.name || "敌对生物"} 威胁，先自保还手`
          );
        }
          if((closeThreat.name==="creeper"||interrupt.rangedEngagement)&&bot.inventory.slots[45]?.name==="shield"){
            await safeBotLookAt(closeThreat.position.offset(0,closeThreat.height||1,0),true,{reason:"shield_creeper_escape"});
            assertInterruptActive();
            await runBotWritableAction("bot.activateItem",{offHand:true,reason:"shield_creeper_escape"},async()=>{assertInterruptActive();bot.activateItem(true);});
            interrupt.shieldRaised=true;
          }
        stopBotActions({
          preserveOffhandShield:interrupt.shieldRaised===true,
          reason: "survival_critical",
          closeWindow: true,
          invalidateCaches: true,
          survivalInterrupt: interrupt,
        });
        // An asynchronous health event has no expedition execution context.
        // Keep checkedMove's exact two-column restrictions and defend in place;
        // applying default movements here would enable digging/parkour/chasing.
        if (!confined) ensureMovements(bot);
        assertInterruptActive();
        const creeperKeys=bot.registry.entitiesByName.creeper?.metadataKeys||[];
        const creeperOrdinary=()=>["is_powered","is_ignited"].every(name=>{
          const index=creeperKeys.indexOf(name),value=closeThreat.metadata?.[index];
          // Native Vanilla metadata is sparse: unchanged boolean defaults may
          // be omitted. Only this pinned protocol may supply false defaults;
          // explicit true/1, malformed values and unknown layouts refuse.
          return index>=0&&([false,0].includes(value)||value===undefined&&bot.version==="1.21.8"&&Boolean(closeThreat.metadata));
        });
        const guardedCreeperCombat=closeThreat.name==="creeper"&&(confinedSurface||campMove||confinedResource&&(resourceEscapeThreat||closeThreat.name==="creeper"))&&naturalHouseWork
          &&bot.health>10&&bot.inventory.slots[45]?.name==="shield"&&remainingHouseToolDurability(bot.inventory.slots[45])>=64
          &&Boolean(findInventoryItem(["stone_sword","iron_sword","diamond_sword","netherite_sword"]))
          &&creeperOrdinary()&&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry
          &&survivalActionDeadline-Date.now()>=6000
          &&!Object.values(bot.entities||{}).some(e=>e!==bot.entity&&e!==closeThreat&&e.isValid!==false&&isThreateningMobEntity(e,bot.registry)&&e.position?.distanceTo(bot.entity.position)<8.5);
        if(closeThreat.name==="creeper")recordTaskDiagnostic(interrupt.task,"house_creeper_response_eligibility",{
          health:bot.health,shieldRemaining:bot.inventory.slots[45]?.name==="shield"?remainingHouseToolDurability(bot.inventory.slots[45]):0,
          protocol:bot.version,metadata:closeThreat.metadata,ordinary:creeperOrdinary(),
          dry:inspectSurfaceBody(bot).dry,grounded:hasGroundedBodySupport(bot),
          remainingFrameMs:Number.isFinite(confinedMove?.deadline)?confinedMove.deadline-Date.now():null,
          mode:guardedCreeperCombat?"controlled_strike_then_reassess":"guarded_retreat"});
        interrupt.guardedCreeperCombat=guardedCreeperCombat;
        const knownMelee=["zombie","zombie_villager","husk","drowned","spider","cave_spider","phantom","enderman"].includes(closeThreat.name)
          ||require("./minecraft/entitySemantics").isObservedSelfAggressor(closeThreat);
        const endermanContact=independentSurvival&&closeThreat.name==='enderman';
        const contactMelee=knownMelee&&!isHouseRangedThreatEntity(closeThreat)&&(!findInventoryItem(WEAPON_ITEM_PRIORITY)||bot.health<=10);
        const contactTarget=()=>{
          if(!knownMelee)return closeThreat;
          return [closeThreat,...nearbyHouseResourceThreats(bot)].filter((e,i,a)=>a.indexOf(e)===i
            &&bot.entities?.[e.id]===e&&e.isValid!==false&&e.position
            &&(['zombie','zombie_villager','husk','drowned','spider','cave_spider'].includes(e.name)
              ||e===closeThreat||require('./minecraft/entitySemantics').isObservedSelfAggressor(e))
            &&meleeReachDistance(bot.entity,e)<=3)
            .sort((a,b)=>meleeReachDistance(bot.entity,a)-meleeReachDistance(bot.entity,b))[0]||closeThreat;
        };
        const strikeContact=async()=>{
          assertInterruptActive();
          const target=contactTarget();
          if(bot.entities?.[target.id]===target&&target.isValid!==false
            &&meleeReachDistance(bot.entity,target)<=3
            &&Date.now()>=meleeAttackReadyAt(combatMemory.lastOwnAttackAt,bot.heldItem?.name)){
            if(findInventoryItem(WEAPON_ITEM_PRIORITY))await equipBestWeapon();
            assertInterruptActive();
            if(interrupt.shieldRaised||bot.usingHeldItem){
              await runBotWritableAction("bot.deactivateItem",{reason:"contact_strike"},async()=>{assertInterruptActive();bot.deactivateItem();});
              interrupt.shieldRaised=false;
            }
            await physicalAttack(target,"贴身自卫击退");
          }
        };
        if(knownMelee){
          await strikeContact();
          broadcastContextSnapshot(true);
          if(bot.entities?.[closeThreat.id]!==closeThreat||closeThreat.isValid===false)return true;
        }
        if(closeThreat.name==="creeper"&&!guardedCreeperCombat){
          await strikeImmediateCloseCreeper({getBot:()=>bot,getThreat:()=>bot.entities?.[closeThreat.id],
            assertActive:assertInterruptActive,
            canStrike:()=>inspectSurfaceBody(bot).dry,
            attack:target=>physicalAttack(target,"苦力怕贴身紧急击退"),
            record:(type,facts)=>recordTaskDiagnostic(interrupt.task,type,facts)}, {deadline:interrupt.deadline});
          assertInterruptActive();
          if(bot.entities?.[closeThreat.id]!==closeThreat||closeThreat.isValid===false)return true;
        }
        if(bot.entity.isInWater===false&&inspectSurfaceBody(bot).dry&&hasGroundedBodySupport(bot)
          &&!naturalWalkingFoot(bot,bot.entity.position.floored())&&!activeHouseSurfaceWater?.isPhysicalOwner()){
          interrupt.originAlignmentActive=true;
          try{
          await require('./minecraft/houseGraphOriginAlignment').alignHouseGraphOrigin({getBot:()=>currentBot,assertActive:assertInterruptActive,
            goto:(goal,budget)=>pathfinderGoto(goal,Math.min(budget,interrupt.deadline-Date.now()),'自卫干地边缘对齐超时',survivalLease,
              {preserveMovements:true,isOwnerCurrent:()=>isSurvivalOwnerCurrent(interrupt)&&isMovementLeaseActive(survivalLease)}),
            record:facts=>recordTaskDiagnostic(interrupt.task,'house_defense_dry_edge_alignment',facts)},
            {deadline:Math.min(interrupt.deadline,Date.now()+2500),excluded:houseResourcePositionExcluded});
          }finally{interrupt.originAlignmentActive=false;}
          assertInterruptActive();
        }
        if((bot.entity.isInWater===true||hasGroundedBodySupport(bot)
          &&(!inspectSurfaceBody(bot).dry||!naturalWalkingFoot(bot,bot.entity.position.floored())))
          &&!activeHouseSurfaceWater?.isPhysicalOwner()){
          const {escapeEmergencyShore}=require("./minecraft/houseEmergencyShore");
          await escapeEmergencyShore({getBot:()=>currentBot,Vec3,Movements,GoalBlock:goals.GoalBlock,
            assertActive:assertInterruptActive,isDryFoot:p=>dryFoot(bot,p),isGrounded:()=>hasGroundedBodySupport(bot),
            setActive:profile=>{activeEmergencyShore=profile?{bot,profile,lease:survivalLease}:null;},
            goto:(goal,options)=>pathfinderGoto(goal,options.timeoutMs,"意外落水上岸超时",survivalLease,{...options,preserveMovements:true}),
            record:(type,facts)=>recordTaskDiagnostic(interrupt.task,type,facts)});
          assertInterruptActive();
          const shoreStart=interrupt.surfacePosition||toPlainPosition(bot.entity.position);
          const shoreHorizontal=Math.hypot(bot.entity.position.x-shoreStart.x,bot.entity.position.z-shoreStart.z);
          const shoreVertical=Math.abs(bot.entity.position.y-shoreStart.y);
          if(shoreHorizontal<=16&&shoreVertical<=8&&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry)
            interrupt.shoreRecovery={confirmed:true,actual:toPlainPosition(bot.entity.position),maximumDisplacement:shoreHorizontal,
              maximumVerticalDisplacement:shoreVertical};
          if(bot.entities?.[closeThreat.id]!==closeThreat||closeThreat.isValid===false
            ||closeThreat.position.distanceTo(bot.entity.position)>(interrupt.rangedEngagement?24:8.5))return true;
          // A supported bank is a fighting stance, not proof that the same
          // nearby attacker has gone. Continue under this original owner.
        }
        let creeperResponseDeadline=null;
        if(guardedCreeperCombat){
          const responseDeadline=creeperResponseDeadline=Math.min(Date.now()+8000,survivalActionDeadline);
          recordTaskDiagnostic(interrupt.task,"house_creeper_knockback_response_started",{health:bot.health,threatId:closeThreat.id,movementGranted:false,originalDeadline:responseDeadline});
          interrupt.creeperStrike=await strikeCreeperBeforeRetreat({getBot:()=>bot,getThreat:()=>bot.entities?.[closeThreat.id],assertActive:assertInterruptActive,
            canStrike:()=>creeperOrdinary()&&bot.inventory.slots[45]?.name==="shield"&&remainingHouseToolDurability(bot.inventory.slots[45])>=64&&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry
              &&!Object.values(bot.entities||{}).some(e=>e!==bot.entity&&e!==closeThreat&&e.isValid!==false&&isThreateningMobEntity(e,bot.registry)&&e.position?.distanceTo(bot.entity.position)<8.5),
            look:target=>safeBotLookAt(target.position.offset(0,target.height||1,0),true,{reason:"creeper_controlled_strike"}),
            equipSword:()=>equipInventoryItem(findInventoryItem(["stone_sword","iron_sword","diamond_sword","netherite_sword"]),"hand","苦力怕击退用剑"),
            shield:async raised=>{await runBotWritableAction(raised?"bot.activateItem":"bot.deactivateItem",{reason:"creeper_strike_shield"},async()=>{assertInterruptActive();if(raised)bot.activateItem(true);else bot.deactivateItem();});interrupt.shieldRaised=raised;},
            attack:target=>physicalAttack(target,"苦力怕有限击退"),record:(type,facts)=>recordTaskDiagnostic(interrupt.task,type,facts),
          },{deadline:responseDeadline});
          assertInterruptActive();
          if(interrupt.creeperStrike.threatGone)return true;
          // A strike is only preparation for a fresh terrain-checked retreat;
          // never stand still for several swings until the fuse completes.
        }
        const armoredPair=require('./minecraft/houseMeleePair').canPressMeleePair(bot,closeThreat,nearbyHouseResourceThreats(bot),{
          exposedRanged:()=>Boolean(findHouseRangedThreat(bot,24))});
        if(armoredPair)recordTaskDiagnostic(interrupt.task,'house_armored_melee_pair_engaged',{
          targets:nearbyHouseResourceThreats(bot).map(e=>({id:e.id,name:e.name})),health:bot.health,
          chest:bot.inventory.slots[6]?.name,shieldRemaining:remainingHouseToolDurability(bot.inventory.slots[45]),originalDeadline:interrupt.deadline});
        const armedContactEngagement=endermanContact&&Boolean(findInventoryItem(WEAPON_ITEM_PRIORITY))||armoredPair||["zombie","zombie_villager","husk","drowned","spider","cave_spider"].includes(closeThreat.name)
          &&Boolean(findInventoryItem(WEAPON_ITEM_PRIORITY))&&(
            meleeReachDistance(bot.entity,closeThreat)<=3&&nearbyHouseResourceThreats(bot).filter(e=>e.name!=="creeper"&&e.position.distanceTo(bot.entity.position)<=4.5).length===1
            ||bot.health>=12&&meleeReachDistance(bot.entity,closeThreat)<=6.5&&nearbyHouseResourceThreats(bot).filter(entity=>!isHouseRangedThreatEntity(entity)).length===1);
        const observedHealth=getObservedEntityHealth(closeThreat,bot.registry);
        const finishingContact=Number.isFinite(observedHealth)&&observedHealth>0&&observedHealth<=1&&meleeReachDistance(bot.entity,closeThreat)<=3;
        if (!armedContactEngagement&&!finishingContact&&(confinedSurface || campMove || confinedResource && (resourceEscapeThreat||closeThreat.name==="creeper"||contactMelee)) &&
          (closeThreat.name === "creeper" || contactMelee || closeThreat === unarmedSiteMelee || closeThreat === resourceEscapeThreat)) {
          const escapeDeadline = Math.min(survivalActionDeadline,creeperResponseDeadline??Infinity, Date.now() + 4000);
          if(escapeDeadline-Date.now()<50)throw Object.assign(Error("本次自保预算已耗尽，保留盾姿与进度"),{code:"house_creeper_response_timeout"});
          // A proximity warning can arrive during an ordinary one-block jump.
          // Let original physics settle after stopping the old goal; the
          // escape module must start with an actual grounded observation.
          const landingDeadline = Math.min(escapeDeadline, Date.now() + 1000);
          while (!hasGroundedBodySupport(bot)) {
            assertInterruptActive();
            if (!inspectSurfaceBody(bot).dry || Date.now() >= landingDeadline) {
              throw Object.assign(new Error("提前避让前未在有限干地落稳"), { code: "house_creeper_escape_landing_unconfirmed" });
            }
            if(contactMelee)await strikeContact();
            await sleep(20);
          }
          // Emergency escape retains its original two-block drop contract.
          // Only the captured ordinary graph profile may have the explicit
          // survivable-drop capability; narrow it before any escape planning.
          if (confinedSurface && [5,6].includes(confinedMove.movements.maxDropDown)) {
            confinedEscapeDropLimit = confinedMove.movements.maxDropDown;
            confinedMove.movements.maxDropDown = 2;
          }
          const escape = createHouseCreeperEscape({ getBot: () => currentBot, assertActive: assertInterruptActive,
            isOwnerCurrent: () => isMovementLeaseActive(survivalLease) && isSurvivalOwnerCurrent(interrupt),
            // Pause may revoke permission to act while this exact old goal
            // still needs cleanup. Never borrow a replacement lease/client/task.
            isCleanupOwnerCurrent: () => currentBot === bot && bot._client === interrupt.client
              && currentTask === interrupt.task && currentTask?.executionGeneration === interrupt.runGeneration
              && isMovementLeaseActive(survivalLease),
            getThreat: () => bot.entities?.[closeThreat.id], getThreats: () => Object.values(bot.entities || {}),
            actualNativeGoto: (goal, options) => pathfinderGoto(goal, options.timeoutMs,
              "提前避让爬行者超时", survivalLease, options),
            record: (type, facts) => recordTaskDiagnostic(interrupt.task, type, facts),
          }, { timeoutMs: Math.max(50, Math.min(4000, escapeDeadline - Date.now())), threatName: closeThreat.name,
            safeDistance:closeThreat.name==="creeper"?8.5:contactMelee&&!findInventoryItem(WEAPON_ITEM_PRIORITY)?5:6.5,
            emergencySprinting:bot.food>6&&(closeThreat.name==="creeper"||contactMelee||bot.health<16),
            emergencyRetreat:closeThreat.name==="creeper"||contactMelee||bot.health<16 });
          try{interrupt.creeperEscape = await escape.escape();}
          catch(error){
            if(error.code==='house_creeper_escape_threat_lost'&&error.nativeSettlement==='SETTLED'
              &&(!bot.entities?.[closeThreat.id]||bot.entities[closeThreat.id].isValid===false||getObservedEntityHealth(bot.entities[closeThreat.id],bot.registry)===0)){
              const until=Math.min(interrupt.deadline,Date.now()+1200);
              while(!hasGroundedBodySupport(bot)&&Date.now()<until){assertInterruptActive();if(!inspectSurfaceBody(bot).dry)throw error;await sleep(20);}
              assertInterruptActive();const start=interrupt.surfacePosition||toPlainPosition(bot.entity.position);
              const horizontal=Math.hypot(bot.entity.position.x-start.x,bot.entity.position.z-start.z),vertical=Math.abs(bot.entity.position.y-start.y);
              const next=nearbyHouseResourceThreats(bot).find(e=>e.position.distanceTo(bot.entity.position)<=8.5)||findHouseRangedThreat(bot);
              if(next)throw Object.assign(Error('旧目标消失后重新接管当前威胁'),{code:'survival_threat_escalated',threat:next});
              if(!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry||horizontal>12||vertical>2)throw error;
              interrupt.threatGoneRecovery={confirmed:true,maximumDisplacement:horizontal,maximumVerticalDisplacement:vertical};
              recordTaskDiagnostic(interrupt.task,'house_combat_target_absent_reobserved',{targetId:closeThreat.id,nativeSettlement:'SETTLED',
                actual:toPlainPosition(bot.entity.position),horizontal,vertical,killConfirmed:false,
                ...(error.nativeGoalIssued===false?{nativeGoalIssued:false,nativeIdleObserved:error.nativeIdleObserved===true}:{}),
                nativeHealthZeroObserved:getObservedEntityHealth(bot.entities?.[closeThreat.id],bot.registry)===0});
              return true;
            }
            const creeperNoExit=closeThreat.name==="creeper"&&error.code==="house_creeper_escape_no_path"
              &&creeperOrdinary()&&Boolean(findInventoryItem(["stone_sword","iron_sword","diamond_sword","netherite_sword"]))
              &&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry
              &&!nearbyHouseResourceThreats(bot).some(e=>e!==closeThreat&&e.position.distanceTo(bot.entity.position)<4.5);
            if(!(contactMelee||creeperNoExit)||!["house_creeper_escape_no_path","house_creeper_escape_braking_timeout","house_creeper_escape_braking_unconfirmed"].includes(error.code))throw error;
            // No dry escape route is not a request to stand idle under attack.
            // Fight only this already observed contact attacker, without chase,
            // within the original survival owner and original total deadline.
            const contactDeadline=Math.min(interrupt.deadline,Date.now()+4000);
            recordTaskDiagnostic(interrupt.task,"house_contact_defense_no_retreat",{targetId:closeThreat.id,targetName:closeThreat.name,originalDeadline:interrupt.deadline,knockbackConfirmed:false,escapeFailure:error.code,escapePlanStats:error.planStats||null});
            while(Date.now()<contactDeadline){
              assertInterruptActive();
              if(bot.entities?.[closeThreat.id]!==closeThreat||closeThreat.isValid===false||getObservedEntityHealth(closeThreat,bot.registry)===0)return true;
              if(creeperNoExit&&(!creeperOrdinary()||!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry))throw error;
              if(meleeReachDistance(bot.entity,contactTarget())>3){
                // A failed exit at4m is not a resolved threat. Retain the
                // bounded defense owner and observe the approaching attacker
                // instead of releasing/restarting every physics tick.
                await safeBotLookAt(closeThreat.position.offset(0,closeThreat.height||1,0),true,{reason:"blocked_contact_track"});
                await sleep(50);continue;
              }
              await strikeContact();await sleep(50);
            }
            return true;
          }
          if (campMove) recordTaskDiagnostic(interrupt.task, "house_camp_defense_escaped", {
            actualPosition: toPlainPosition(bot.entity.position), campReturnConfirmed: false });
          return true;
        }
        const seekRangedCover=async()=>{
          const deferUnproductivePursuit=()=>{
            if(require("./minecraft/houseRangedCover").deferHouseRangedPursuit(bot,closeThreat))
              recordTaskDiagnostic(interrupt.task,"house_ranged_pursuit_deferred",{targetId:closeThreat.id,
                retryAfterMs:30000,reason:"bounded_approach_did_not_reach_target_after_cover_or_escape",health:bot.health,
                damageOrNearThreatRearmsImmediately:true});
          };
          if((bot.health<=14||interrupt.rangedApproachFailed)&&inspectSurfaceBody(bot).dry){
            const landingDeadline=Math.min(interrupt.deadline,Date.now()+900);
            while(!hasGroundedBodySupport(bot)&&Date.now()<landingDeadline){assertInterruptActive();await sleep(20);}
          }
          // Stationary emergency construction must not voluntarily lower an
          // equipped shield before the first protective block is placed.
          if(require('./minecraft/houseShieldState').getHouseShield(bot)?.equipped&&closeThreat.name!=='witch'){
            await safeBotLookAt(closeThreat.position.offset(0,closeThreat.height||1,0),true,{reason:'shield_cover_construction'});
            await runBotWritableAction('bot.activateItem',{offHand:true,reason:'shield_cover_construction'},async()=>{assertInterruptActive();bot.activateItem(true);});
            interrupt.shieldRaised=true;
          }
          const coverOrigin=bot.entity.position.clone();
          if(interrupt.task.materialSupply&&(bot.health<=14||interrupt.rangedApproachFailed)&&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry){
            const enemies=require('./minecraft/houseRangedScreen').loadedCoverThreats(bot,terrainSeparatedHouseMelee);
            recordTaskDiagnostic(interrupt.task,'house_ranged_construction_observation',{health:bot.health,
              actual:toPlainPosition(bot.entity.position),enemies:enemies.map(e=>({id:e.id,name:e.name,distance:e.position.distanceTo(bot.entity.position)})),
              carriedBlocks:getItemCountByName('dirt')+getItemCountByName('cobblestone'),screenEligible:enemies.length>0&&enemies.every(isHouseRangedThreatEntity)});
            if(enemies.length&&enemies.every(isHouseRangedThreatEntity)){
              const screen=require('./minecraft/houseRangedScreen').planRangedScreen({position:toPlainPosition(bot.entity.position),threats:enemies,
                blockAt:p=>bot.blockAt(toVec3(p)),inventory:Object.fromEntries(require('./minecraft/houseRangedScreen').RANGED_SCREEN_ITEMS.map(name=>[name,getItemCountByName(name)])),excluded:houseResourcePositionExcluded});
              if(screen){
                const screenDeadline=Math.min(interrupt.deadline,Date.now()+5000);let placed=0;
                for(const spec of screen.blocks){
                  assertInterruptActive();if(Date.now()>=screenDeadline)break;
                  await placeFurnishedHouseBlock(spec,()=>{assertInterruptActive();require('./minecraft/houseCombatMode').rememberCombatCover(interrupt.task.materialSupply,spec);placed++;});
                  if(rangedCoverConfirmed(bot,bot.entity.position,enemies))break;
                }
                const confirmed=rangedCoverConfirmed(bot,bot.entity.position,enemies);
                recordTaskDiagnostic(interrupt.task,'house_ranged_screen_observed',{placed,confirmed,fullEnclosure:false,health:bot.health});
                if(confirmed&&bot.health>12&&enemies.length===1){interrupt.rangedCover={confirmed:true,maximumDisplacement:bot.entity.position.distanceTo(coverOrigin)+1,maximumVerticalDisplacement:2};return true;}
              }
            }
          }
          if(interrupt.task.materialSupply&&(bot.health<=12||interrupt.rangedApproachFailed)&&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry){
            const enemies=require('./minecraft/houseRangedScreen').loadedCoverThreats(bot,terrainSeparatedHouseMelee);
            if(enemies.length&&enemies.every(emergencyCoverThreatSupported)){
              let shelter=null;
              try{shelter=await buildHouseEmergencyCover(interrupt.task,enemies,{assertActive:assertInterruptActive,
                deadline:Math.min(interrupt.deadline,Date.now()+5000)});}
              catch(error){
                assertInterruptActive();
                if(!/^house_recovery_cover_(timeout|materials_missing|access_unavailable|access_changed)$/.test(String(error.code||""))&&error.code!=='placement_no_safe_stance')throw error;
                recordTaskDiagnostic(interrupt.task,"house_ranged_partial_cover",{code:error.code,health:bot.health});
              }
              if(shelter&&emergencyShelterConfirmed({plan:shelter.plan,position:toPlainPosition(bot.entity.position),
                blockAt:p=>bot.blockAt(toVec3(p)),threats:enemies,raycast:(from,to)=>{const start=toVec3(from),delta=toVec3(to).minus(start);return bot.world.raycast(start,delta.unit(),delta.norm());}})){
                interrupt.rangedCover={confirmed:true,maximumDisplacement:bot.entity.position.distanceTo(coverOrigin)+1,maximumVerticalDisplacement:2};
                recordTaskDiagnostic(interrupt.task,"house_ranged_built_cover_confirmed",{placed:shelter?.placed.length||interrupt.task.materialSupply?.defensiveCover?.placed?.length||0,fullEnclosure:Boolean(shelter),health:bot.health,actual:toPlainPosition(bot.entity.position)});
                return true;
              }
            }
          }
          // Native pathfinding faces the route. Keeping a raised shield here
          // slows retreat while exposing our back to the archer.
          if(interrupt.shieldRaised||bot.usingHeldItem){
            await runBotWritableAction("bot.deactivateItem",{reason:"bounded_ranged_retreat"},async()=>{assertInterruptActive();bot.deactivateItem();});
            interrupt.shieldRaised=false;
          }
          for(let attempt=0;attempt<3;attempt++){
          const runCover=(active=assertInterruptActive)=>seekHouseRangedCover({getBot:()=>currentBot,assertActive:active,
            goto:(goal,budget)=>pathfinderGoto(goal,budget,'寻找实际遮挡超时',survivalLease,{preserveMovements:true,isOwnerCurrent:()=>isSurvivalOwnerCurrent(interrupt)&&isMovementLeaseActive(survivalLease)}),
            record:(type,facts)=>recordTaskDiagnostic(interrupt.task,type,facts)}, {deadline:interrupt.deadline,boundaryOrigin:coverOrigin});
          const quarry=interrupt.task.materialSupply?.quarry,nav=quarry?.routes?.[quarry.activeResource]?.navigation;
          let cover;
          const prefix=nav?.breadcrumbs?.slice(0,nav.routeIndex+1);
          if((confinedMining||confinedResource)&&prefix?.some(p=>bot.entity.position.floored().equals(toVec3(p)))){
            cover=await require('./minecraft/houseMiningRangedRetreat').withRecordedMiningRangedRetreat({
              getBot:()=>currentBot,assertActive:assertInterruptActive,isOwnerCurrent:()=>isSurvivalOwnerCurrent(interrupt)&&isMovementLeaseActive(survivalLease),positions:prefix,deadline:interrupt.deadline,
              setActive:profile=>{if(profile)activeHouseRangedRetreat={bot,profile,lease:survivalLease,interrupt};
                else if(activeHouseRangedRetreat?.interrupt===interrupt)activeHouseRangedRetreat=null;},
            },({assertActive})=>runCover(assertActive));
            if(cover.covered)interrupt.miningRetreatThreat={id:closeThreat.id,position:toPlainPosition(closeThreat.position)};
          }else cover=await runCover();
          recordTaskDiagnostic(interrupt.task,"house_ranged_cover_observed",cover);
          const start=interrupt.surfacePosition||coverOrigin;
          const recoveryBounds={confirmed:true,maximumDisplacement:Math.hypot(coverOrigin.x-start.x,coverOrigin.z-start.z)+12,
            maximumVerticalDisplacement:Math.abs(coverOrigin.y-start.y)+2};
          if(cover.covered)interrupt.rangedCover=recoveryBounds;
          else if(cover.threatGone&&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry
            &&bot.entity.position.distanceTo(coverOrigin)<=12.5)
            interrupt.rangedEscape={...recoveryBounds,reason:'out_of_observed_range',coverConfirmed:false};
          if(cover.covered||cover.threatGone){deferUnproductivePursuit();return true;}
          if(!cover.moved)break;
          assertInterruptActive();
          }
          deferUnproductivePursuit();
          throw Object.assign(Error("已锁定远程敌人，但尚未找到已加载的避箭路线"),{code:"house_ranged_cover_unavailable"});
        };
        if(interrupt.rangedEngagement&&meleeReachDistance(bot.entity,closeThreat)>3
          &&!shouldPressHouseRanged(bot,closeThreat))return seekRangedCover();
        if(!interrupt.rangedEngagement&&!endermanContact&&bot.health<=10&&meleeReachDistance(bot.entity,closeThreat)>3)throw Object.assign(Error('低血不主动追击远处敌人，保留防御姿态'),{code:'mining_low_health'});
        await equipBestWeapon();
        if(interrupt.rangedEngagement&&confinedSurface&&[5,6].includes(confinedMove.movements.maxDropDown)){
          confinedEscapeDropLimit=confinedMove.movements.maxDropDown;confinedMove.movements.maxDropDown=2;
        }
        const deadline = Math.min(Date.now()+(interrupt.rangedEngagement?32000:8000),survivalActionDeadline);
        let shieldHolding=false;
        while (Date.now() < deadline && closeThreat?.position && bot.entity) {
          assertInterruptActive();
          if((interrupt.rangedEngagement?!shouldPressHouseRanged(bot,closeThreat):!endermanContact&&bot.health<=10)&&meleeReachDistance(bot.entity,closeThreat)>3){
            if(interrupt.rangedEngagement)return seekRangedCover();
            throw Object.assign(Error("低血不继续追击远处敌人，保留防御姿态"),{code:"mining_low_health"});
          }
          if (bot.entities?.[closeThreat.id] !== closeThreat || closeThreat.isValid === false || getObservedEntityHealth(closeThreat,bot.registry)===0) break;
          const distance = bot.entity.position.distanceTo(closeThreat.position);
          if (confined && !interrupt.rangedEngagement && !guardedCreeperCombat && distance > (endermanContact?16:armedContactEngagement?6.5:4.8)) break;
          if(independentSurvival&&confined&&knownMelee&&closeThreat.name!=="phantom"&&bot.health>10&&distance<=(armedContactEngagement?6.5:4.8)&&meleeReachDistance(bot.entity,closeThreat)>3){
            const origin=interrupt.surfacePosition||toPlainPosition(bot.entity.position);
            const approached=await approachHouseRanged({getBot:()=>currentBot,assertActive:assertInterruptActive,
              getThreat:()=>bot.entities?.[closeThreat.id],canContinueEngagement:()=>bot.health>10,
              goto:(goal,budget)=>pathfinderGoto(goal,budget,"近身自卫跨一级地形超时",survivalLease,
                {preserveMovements:true,isOwnerCurrent:()=>isSurvivalOwnerCurrent(interrupt)&&isMovementLeaseActive(survivalLease)})},
              {origin,deadline:Math.min(deadline,Date.now()+2000),contact:true});
            assertInterruptActive();
            if(approached)interrupt.meleeApproach={confirmed:true,maximumDisplacement:3,maximumVerticalDisplacement:1.35};
          }
          if ((confinedSurface||interrupt.rangedEngagement) && meleeReachDistance(bot.entity,closeThreat) > 3 && isHouseRangedThreatEntity(closeThreat)) {
            if(interrupt.rangedEngagement&&bot.inventory.slots[45]?.name==="shield"&&!shieldHolding){
              await safeBotLookAt(closeThreat.position.offset(0,closeThreat.height||1,0),true,{reason:"shield_ranged_advance"});
              await runBotWritableAction("bot.activateItem",{offHand:true,reason:"shield_ranged_advance"},async()=>{assertInterruptActive();bot.activateItem(true);});
              shieldHolding=true;interrupt.shieldRaised=true;
            }
            let approached;
            try{approached = await (interrupt.rangedEngagement?approachHouseRanged:approachHouseMelee)({ getBot: () => currentBot, assertActive: assertInterruptActive,
              getThreat: () => bot.entities?.[closeThreat.id],
              canContinueEngagement:()=>shouldPressHouseRanged(bot,closeThreat),
              onStep:value=>recordTaskHeartbeat(interrupt.task,{actionState:"acting",checkpoint:{kind:"ranged_approach",...value}}),
              onPlan:value=>recordTaskDiagnostic(interrupt.task,"house_ranged_approach_plan",value),
              goto: (goal,budget) => pathfinderGoto(goal,budget,"有限平地近战接近超时",survivalLease,
                {preserveMovements:true,isOwnerCurrent:()=>isSurvivalOwnerCurrent(interrupt)&&isMovementLeaseActive(survivalLease)}),
              stopOwn: goal => { if(isSurvivalOwnerCurrent(interrupt)&&isMovementLeaseActive(survivalLease)
                &&bot.pathfinder.movements===confinedMove.movements&&bot.pathfinder.goal===goal){bot.pathfinder.setGoal(null);bot.clearControlStates();} },
            }, {origin:interrupt.surfacePosition,deadline:Math.min(deadline,independentSurvival?deadline:surfaceMove?.deadline??deadline)});
            }catch(error){
              assertInterruptActive();
              if(interrupt.rangedEngagement&&inspectSurfaceBody(bot).dry&&["house_surface_ranged_injured","NoPath","no_path","Timeout","MINING_MOVEMENT_TIMEOUT","MINING_ROUTE_CHANGED"].includes(error.code||error.name)){
                recordTaskDiagnostic(interrupt.task,"house_ranged_approach_interrupted",{code:error.code||error.name,health:bot.health,startingHealth:error.startingHealth??null,actual:toPlainPosition(bot.entity.position)});
                interrupt.rangedApproachFailed=true;
                return seekRangedCover();
              }
              throw error;
            }
            assertInterruptActive();if(!approached){if(interrupt.rangedEngagement){interrupt.rangedApproachFailed=true;return seekRangedCover();}break;}
            interrupt.meleeApproach={confirmed:true,maximumDisplacement:interrupt.rangedEngagement?28:3,
              maximumVerticalDisplacement:interrupt.rangedEngagement?8:1.2};
          }
          if (!confined && distance > 2.6 && !(endermanContact&&bot.health<=10)) {
            const followGoal = new goals.GoalFollow(closeThreat, 2);
            if (shouldRefreshContinuousGoal(followGoal, true)) {
              setPathfinderGoal(followGoal, true, survivalLease);
            } else {
              touchMovementSession({
                goalSignature: getPathGoalSignature(followGoal, true),
                kind: "survival-critical",
              });
            }
          } else {
            markMovementSessionStable({
              kind: "survival-critical",
            });
          }
          // Track the target between swings. Sleeping for the full cooldown
          // misses a mob moving into reach and leaves the shield facing stale
          // coordinates; polling does not grant another attack before cooldown.
          try { await safeBotLookAt(closeThreat.position.offset(0, closeThreat.height || 1, 0),true,{reason:"survival_track"}); } catch (_) {}
          if (meleeReachDistance(bot.entity,closeThreat) <= 3 && Date.now()>=meleeAttackReadyAt(combatMemory.lastOwnAttackAt,bot.heldItem?.name)) {
            try {
              await safeBotLookAt(closeThreat.position.offset(0, closeThreat.height || 1, 0), true, {
                targetName: closeThreat?.name || null,
                reason: "survival_interrupt",
              });
            } catch (_) {}
            assertInterruptActive();
            try {
              if (bot.inventory.slots[45]?.name === "shield") {
                assertInterruptActive();
                await runBotWritableAction("bot.deactivateItem", {reason:"shield_melee_swing"}, async()=>{assertInterruptActive();bot.deactivateItem();});
                shieldHolding=false;
              }
              await physicalAttack(closeThreat, closeThreat.displayName || closeThreat.name || "敌对生物");
            } catch (_) {}
          }
          if (!shieldHolding && bot.inventory.slots[45]?.name === "shield" && bot.entities?.[closeThreat.id] === closeThreat) {
            assertInterruptActive();
            await runBotWritableAction("bot.activateItem", {offHand:true,reason:"shield_defense"}, async()=>{assertInterruptActive();bot.activateItem(true);});
            shieldHolding=true;interrupt.shieldRaised=true;
          }
          await sleep(50);
        }
        if ((confinedResource || confinedSurface || guardedCreeperCombat) && bot.entities?.[closeThreat.id] === closeThreat && closeThreat.isValid !== false && getObservedEntityHealth(closeThreat,bot.registry)!==0 &&
            closeThreat.position?.distanceTo(bot.entity.position) <= (interrupt.rangedEngagement?24:guardedCreeperCombat?8.5:4.8)) throw Object.assign(
          new Error("有限自卫结束时威胁仍在近处，保留采集进度"), { code: "house_surface_defense_threat_remaining" });
        return true;
        };
        for(let escalation=0;escalation<12;escalation++){

          try{
            try{await respond();}
            catch(error){
              const retainedLowHealthContact=error.code==='mining_low_health'
                &&combatMemory.lastOwnAttackTargetId===closeThreat.id
                &&Date.now()-Number(combatMemory.lastOwnAttackAt||0)>=0&&Date.now()-Number(combatMemory.lastOwnAttackAt||0)<1500
                &&meleeReachDistance(bot.entity,closeThreat)<=4.5;
              if(!["zombie","zombie_villager","husk","drowned","spider","cave_spider"].includes(closeThreat.name)
                ||!(/^(?:house_creeper_escape_|house_shore_)/.test(String(error.code||""))||["NoPath","Timeout","house_surface_ranged_limit"].includes(error.code||error.name)||retainedLowHealthContact)
                ||bot.entities?.[closeThreat.id]!==closeThreat||meleeReachDistance(bot.entity,closeThreat)>(retainedLowHealthContact?4.5:3))throw error;
              assertInterruptActive();bot.pathfinder.stop();
              recordTaskDiagnostic(interrupt.task,"house_contact_navigation_failed_fighting",{targetId:closeThreat.id,reason:error.code||error.name,originalDeadline:interrupt.deadline});
              // Knockback briefly moves a still approaching attacker outside
              // sword reach. Keep this owner, face/shield and wait for reach;
              // do not return control to a shore retry after every single hit.
              while(Date.now()+600<interrupt.deadline){
                assertInterruptActive();
                if(bot.entities?.[closeThreat.id]!==closeThreat||closeThreat.isValid===false
                  ||getObservedEntityHealth(closeThreat,bot.registry)===0||meleeReachDistance(bot.entity,closeThreat)>8.5)break;
                await safeBotLookAt(closeThreat.position.offset(0,closeThreat.height||1,0),true,{reason:"blocked_contact_track"});
                if(meleeReachDistance(bot.entity,closeThreat)<=3&&Date.now()>=meleeAttackReadyAt(combatMemory.lastOwnAttackAt,bot.heldItem?.name)){
                  if(interrupt.shieldRaised||bot.usingHeldItem){
                    await runBotWritableAction("bot.deactivateItem",{reason:"blocked_contact_strike"},async()=>{assertInterruptActive();bot.deactivateItem();});
                    interrupt.shieldRaised=false;
                  }
                  await physicalAttack(closeThreat,"退路失败后的近身自卫");
                }
                if(bot.inventory.slots[45]?.name==="shield"&&!interrupt.shieldRaised){
                  await runBotWritableAction("bot.activateItem",{offHand:true,reason:"blocked_contact_shield"},async()=>{assertInterruptActive();bot.activateItem(true);});
                  interrupt.shieldRaised=true;
                }
                await sleep(50);
              }
              assertInterruptActive();
              if(bot.entities?.[closeThreat.id]===closeThreat&&closeThreat.isValid!==false
                &&getObservedEntityHealth(closeThreat,bot.registry)!==0&&meleeReachDistance(bot.entity,closeThreat)<=8.5)
                throw Object.assign(Error("退路受阻后的有限反击仍有威胁"),{code:"house_surface_defense_threat_remaining"});
            }
            const perceivedNextRanged=findHouseRangedThreat(bot);
            const nextRanged=perceivedNextRanged&&require('./minecraft/houseRangedCombat').shouldInterruptWorkForRanged(bot,perceivedNextRanged,
              Date.now()-Number(combatMemory.lastBotHurtAt||0)<6500)?perceivedNextRanged:null;
            const next=nearbyHouseResourceThreats(bot).find(e=>e!==closeThreat&&e.position.distanceTo(bot.entity.position)<=4.5)
              ||nextRanged;
            if(next&&next!==closeThreat&&escalation<11&&Date.now()+1000<interrupt.deadline){
              const previous=closeThreat;closeThreat=next;interrupt.rangedEngagement=(independentSurvival||siteSurvival)&&isHouseRangedThreatEntity(next);
              if(independentSurvival)require('./minecraft/houseCombatMode').transitionCombat(survivalState,'fighting',{targetId:next.id,targetName:next.name});
              recordTaskDiagnostic(interrupt.task,'house_combat_target_reselected',{from:previous.id,to:next.id,originalDeadline:interrupt.deadline});continue;
            }
            if(siteSurvival&&bot.health<16){
              // Work remains suspended under this same survival lease. Wait
              // only for real server regeneration after a verified dry escape;
              // never lower the site's health gate or extend either deadline.
              const until=Math.min(interrupt.deadline,surfaceMove?.deadline??Infinity,Date.now()+6000);
              while(bot.health<16&&bot.food>=18&&Date.now()<until){
                assertInterruptActive();
                if(!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry||findHouseRangedThreat(bot)
                  ||nearbyHouseResourceThreats(bot).some(e=>e.position.distanceTo(bot.entity.position)<=4.5))break;
                await sleep(25);
              }
              assertInterruptActive();
              if(bot.health<16||bot.food<14)throw Object.assign(Error('自卫后尚未恢复原选址生命与饥饿门槛'),{code:'house_site_search_survival_limit'});
              recordTaskDiagnostic(interrupt.task,'house_site_survival_restored',{health:bot.health,food:bot.food,
                originalDeadline:interrupt.deadline,positionOrHealthWritten:false});
            }
            if(independentSurvival&&Date.now()+500<interrupt.deadline){
              require('./minecraft/houseCombatMode').transitionCombat(survivalState,'cleanup');
              const cleanup=interrupt.task.materialSupply?await cleanupHouseCombatCover(interrupt.task,assertInterruptActive):{removed:0,pending:0,preCamp:true};
              recordTaskDiagnostic(interrupt.task,'house_combat_cleanup_result',cleanup);
            }
            return true;
          }
          catch(error){
            // A missed handoff observation cannot leave a stationary actor
            // idle beside its attacker. A fresh actually grounded observation
            // may start one more leg inside the original interrupt deadline.
            // Hazardous/unknown/no-path and foreign ownership still refuse.
            if(error.code==="house_creeper_escape_braking_timeout"&&escalation===0
              &&Date.now()+600<interrupt.deadline&&isSurvivalOwnerCurrent(interrupt)
              &&isMovementLeaseActive(survivalLease)&&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry
              &&Math.hypot(bot.entity.velocity.x,bot.entity.velocity.z)<=.03
              &&interrupt.surfacePosition&&Math.hypot(bot.entity.position.x-interrupt.surfacePosition.x,
                bot.entity.position.z-interrupt.surfacePosition.z)<=.6){
              assertInterruptActive();recordTaskDiagnostic(interrupt.task,"house_survival_stationary_handoff_reobserved",{
                actual:toPlainPosition(bot.entity.position),originalDeadline:interrupt.deadline,previousCode:error.code});
              continue;
            }
            if(error.code!=="survival_threat_escalated"||!error.threat||escalation===11)throw error;
            interrupt.token?.throwIfRequested();
            if(!isSurvivalOwnerCurrent(interrupt)||!isMovementLeaseActive(survivalLease))throw createAbortError("movement_preempted");
            const previousThreat=closeThreat;closeThreat=error.threat;interrupt.rangedEngagement=(independentSurvival||siteSurvival)&&isHouseRangedThreatEntity(closeThreat);
            recordTaskDiagnostic(interrupt.task,"survival_threat_escalated",{from:previousThreat.name,to:closeThreat.name,threatId:closeThreat.id,originalDeadline:interrupt.deadline});
          }
        }
      });
    } catch (error) {
      interrupt.error = error;
      recordTaskDiagnostic(interrupt.task,'house_combat_defense_failed',{
        code:error.code||error.name,message:error.message,actual:toPlainPosition(bot.entity.position),
        originalTaskId:interrupt.task?.taskId,mining:Boolean(confinedMining),originalDeadline:interrupt.deadline,
        velocity:toPlainPosition(bot.entity.velocity),onGround:bot.entity.onGround,airborneFacts:error.airborneFacts||null,brakingFacts:error.brakingFacts||null});
      if(independentSurvival)require('./minecraft/houseCombatMode').transitionCombat(survivalState,'recovery_required',{failureCode:error.code||error.name});
      if (confinedResource) recordTaskDiagnostic(interrupt.task, "house_resource_defense_failed", {
        code: error.code, message: error.message, health: bot.health, originalDeadline: resourceWork.deadline,
        actualPosition: toPlainPosition(bot.entity.position), observedEscape: error.observedEscape || null });
      if ((confinedSurface || confinedResource || confinedMining) && isSurvivalOwnerCurrent(interrupt) &&
          isMovementLeaseActive(survivalLease) && (bot.pathfinder.movements ===
            (confinedSurface ? surfaceMove.movements : confinedResource ? resourceWork.movements : miningMove.movements)
              ||ownsSurvivalTemporaryProfile(bot,survivalLease))) {
        if (confinedSurface) surfaceMove.defenseFailure = interrupt;
        if(!retainedHouseSurfaceDefenseFailure||retainedHouseSurfaceDefenseFailure.task!==interrupt.task
          ||retainedHouseSurfaceDefenseFailure.runGeneration!==interrupt.runGeneration)retainedHouseSurfaceDefenseFailure=interrupt;
      }
      if (confinedSurface) recordTaskDiagnostic(interrupt.task, "house_surface_defense_failed", {
        code: error.code, message: error.message, observedEscape: error.observedEscape,
        probes: Number.isInteger(error.probes) ? error.probes : null,
        initialDistance: Number.isFinite(error.initialDistance) ? error.initialDistance : null,
        planStats: error.planStats || null, actualPosition: toPlainPosition(bot.entity.position),
        velocity: toPlainPosition(bot.entity.velocity), onGround: bot.entity.onGround,
        health: bot.health, food: bot.food, previousLease: previousLease?.token,
        survivalLease: survivalLease.token, generation: interrupt.runGeneration,
        failureRetained:retainedHouseSurfaceDefenseFailure===interrupt,moveFailureAttached:surfaceMove.defenseFailure===interrupt,
        taskLease:interrupt.task?.movementLease?.token??null });
      if(interrupt.shieldRaised&&closeThreat.name==="creeper"&&isSurvivalOwnerCurrent(interrupt)&&isMovementLeaseActive(survivalLease)
        &&bot.inventory.slots[45]?.name==="shield"&&bot.entities?.[closeThreat.id]===closeThreat){
        try{
          assertInterruptActive();await safeBotLookAt(closeThreat.position.offset(0,closeThreat.height||1,0),true,{reason:"shield_escape_failure"});
          assertInterruptActive();await runBotWritableAction("bot.activateItem",{offHand:true,reason:"shield_escape_failure"},async()=>{assertInterruptActive();bot.activateItem(true);});
        }catch{ /* An abort never grants another actor shielding writes. */ }
      }
      throw error;
    } finally {
      const ownsSurvival = isMovementLeaseActive(survivalLease);
      const sameOwner = isSurvivalOwnerCurrent(interrupt);
      const sameMovements = !confined || bot.pathfinder.movements === confinedMove.movements;
      if (ownsSurvival && sameOwner && sameMovements) {
        // Restore only after successful escape under the exact original owner.
        // Failure/pause/replacement never grants a new actor the drop ability.
        if (!interrupt.error && [5,6].includes(confinedEscapeDropLimit) && confinedMove.movements.maxDropDown === 2) {
          confinedMove.movements.maxDropDown = confinedEscapeDropLimit;
        }
        stopBotActions({ reason: "survival_complete", preserveOffhandShield:Boolean(interrupt.error&&interrupt.shieldRaised) });
        if (campMove) bot.pathfinder.setMovements(campPreviousProfile);
      }
      releaseMovementLease(survivalLease);
      if (!activeMovementLease && previousLease && ownsSurvival && sameOwner && sameMovements && !interrupt.error &&
        (!interrupt.task || interrupt.task.movementLease === previousLease)) {
        activeMovementLease = previousLease;
        if(independentSurvival){
          const pending=require('./minecraft/houseCombatMode').combatCover(survivalState).length;
          require('./minecraft/houseCombatMode').transitionCombat(survivalState,pending?'cleanup_pending':'resumed',{cleanupPending:pending});
          recordTaskDiagnostic(interrupt.task,pending?'house_combat_cleanup_required':'house_combat_task_resumed',survivalState.combatMode);}

      }
      interrupt.finished = true;
      interrupt.resolveFinished?.();
      if (activeSurvivalInterrupt === interrupt) activeSurvivalInterrupt = null;
      survivalInterruptRunning = false;
      broadcastContextSnapshot();
      broadcastTaskStatus();
    }
  }

  async function drainStartupOriginDefense(){
    const frame=activeSurvivalInterrupt,context=getExecutionContext();
    if(!frame||frame.finished||frame.bot!==currentBot||frame.client!==currentBot?._client||frame.task!==context?.task
      ||frame.runGeneration!==context?.runGeneration||(frame.workToken||frame.token)!==context?.token
      ||frame.previousLease!==context?.movementLease||!isSurvivalOwnerCurrent(frame))return false;
    await settleSurvivalDefense('startup_origin_boundary');checkTaskSignal();return true;
  }

  async function settleSurvivalDefense(reason) {
    const retainedFailure = getHouseSurfaceDefenseFailure();
    if (retainedFailure) throw retainedFailure;
    const frame=activeSurvivalInterrupt;
    if(!frame)return maybeHandleSurvivalCritical(reason);
    const deadline=Date.now()+35000;
    while(!frame.finished){
      checkTaskSignal();
      if(!isSurvivalOwnerCurrent(frame)||Date.now()>=deadline)throw createAbortError("movement_preempted");
      await Promise.race([frame.finishedPromise,sleep(50)]);
    }
    checkTaskSignal();if(frame.error)throw frame.error;
    return true;
  }

  async function maybeHandleForegroundCombatInterrupt() {
    if (!currentTask || currentTask.source === "autonomous" || !currentBot?.entity) {
      return false;
    }
    if (await maybeHandleSurvivalCritical("foreground_interrupt")) {
      return true;
    }
    const bot = ensureBotReady();
    const taskIntent = normalizeLearningIntent(currentTask.intent);
    const selfThreat = findHostileEntity(bot.entity, 8, {
      protectEntity: bot.entity,
      maxBotDistance: 10,
    });
    const protectedPlayerName = taskIntent === "escort_player" ? getProtectedPlayerNameForEscort() : "";
    const playerTarget = protectedPlayerName ? findPlayerTarget(protectedPlayerName) : null;
    const playerThreat =
      playerTarget?.entity
        ? findPriorityEscortHostile(playerTarget.entity, {
            searchRadius: 14,
            maxBotDistance: Math.max(18, getDistance(bot.entity.position, playerTarget.position) + 10),
          })
        : null;
    const recentSelfDamage = Date.now() - Number(combatMemory.lastBotHurtAt || 0) < 6000;
    const recentProtectedDamage =
      playerTarget?.username &&
      combatMemory.lastProtectedPlayerName &&
      combatMemory.lastProtectedPlayerName.toLowerCase() === String(playerTarget.username || "").trim().toLowerCase() &&
      Date.now() - Number(combatMemory.lastProtectedPlayerHurtAt || 0) < 6000;
    const interruptTarget =
      (recentProtectedDamage ? playerThreat : null) ||
      (recentSelfDamage ? selfThreat : null) ||
      playerThreat ||
      selfThreat;
    if (!interruptTarget) {
      return false;
    }
    addTaskLog(
      "warn",
      playerThreat
        ? `检测到 ${interruptTarget.displayName || interruptTarget.name} 正在威胁玩家，先短暂处理`
        : `检测到 ${interruptTarget.displayName || interruptTarget.name} 正在贴身攻击我，先短暂还手`
    );
    await executeAttackHostile(
      {
        args: {
          maxDistance: playerThreat ? 12 : 6,
          leashDistance: playerThreat ? 10 : 6,
          timeoutMs: playerThreat ? 5000 : 3200,
        },
      },
      playerThreat ? playerTarget?.entity || null : bot.entity
    );
    return true;
  }

  async function executeEscortPlayer(step) {
    const bot = ensureBotReady();
    ensureMovements(bot);
    const distance = clamp(Number(step.args?.distance) || 3, 2, 6);
    const hostileRadius = clamp(Number(step.args?.hostileRadius) || 12, 8, 18);
    const leashDistance = clamp(Number(step.args?.leashDistance) || 12, 6, 24);
    const loopDelayMs = 180;
    while (true) {
      checkTaskSignal();
      if (Number.isFinite(bot.food) && bot.food < 10) {
        await ensureNutrition(14);
      }
      const playerTarget = findPlayerTarget(step.args?.playerName);
      if (!playerTarget?.position) {
        throw new Error("没有找到要护卫的玩家");
      }
      if (currentTask) {
        currentTask.escortState = "scanning";
        currentTask.combatReadiness = getCombatReadinessState();
      }
      updateTaskCheckpoint(currentTask, {
        kind: "escort_player",
        playerName: String(playerTarget.username || step.args?.playerName || "玩家").trim() || "玩家",
        playerPosition: toPlainPosition(playerTarget.position),
      });
      const rendezvous = getPlayerRendezvousPosition(playerTarget);
      if (!rendezvous) {
        throw new Error("没有找到可到达的护卫位置");
      }
      const playerDistance = playerTarget.entity
        ? getDistance(bot.entity.position, playerTarget.position)
        : getHorizontalDistance(bot.entity.position, rendezvous);
      const hostile = playerTarget.entity
        ? findPriorityEscortHostile(playerTarget.entity, {
            searchRadius: hostileRadius,
            maxBotDistance: Math.max(leashDistance + 10, playerDistance + hostileRadius + 4),
          })
        : null;
      if (hostile) {
        currentTask.progressText = `正在护卫并攻击 ${hostile.displayName || hostile.name}`;
        currentTask.escortState = "engaged";
        currentTask.lastHostileSeenAt = Date.now();
        currentTask.lastGuardScanResult = "hostile_engaged";
        broadcastTaskStatus();
        recordTaskHeartbeat(currentTask, {
          actionState: "acting",
          checkpoint: {
            kind: "escort_player",
            playerName: String(playerTarget.username || step.args?.playerName || "玩家").trim() || "玩家",
            hostileName: String(hostile.name || "").trim() || null,
            hostilePosition: toPlainPosition(hostile.position),
          },
        });
        await executeAttackHostile(
          {
            args: {
              maxDistance: hostileRadius + 2,
              leashDistance,
              timeoutMs: 5000,
            },
          },
          playerTarget.entity
        );
      } else {
        currentTask.escortState = "idle";
        currentTask.lastGuardScanResult = "no_hostile_in_range";
        currentTask.progressText =
          playerTarget.source === "memory"
            ? `正在回到 ${playerTarget.username || step.args?.playerName || "玩家"} 上次出现位置附近的地表`
            : `正在护卫 ${playerTarget.username || step.args?.playerName || "玩家"}`;
        broadcastTaskStatus();
        if (playerDistance > distance + 1) {
          const followGoal = playerTarget.entity
            ? new goals.GoalFollow(playerTarget.entity, distance)
            : new goals.GoalNear(
                rendezvous.x,
                rendezvous.y,
                rendezvous.z,
                Math.max(1, distance - 1)
              );
          if (shouldRefreshContinuousGoal(followGoal, true)) {
            setPathfinderGoal(followGoal, true);
          } else {
            touchMovementSession({
              goalSignature: getPathGoalSignature(followGoal, true),
              kind: "escort_player",
            });
          }
          recordTaskHeartbeat(currentTask, {
            actionState: "moving",
            checkpoint: {
              kind: "escort_player",
              playerName: String(playerTarget.username || step.args?.playerName || "玩家").trim() || "玩家",
              playerPosition: toPlainPosition(playerTarget.position),
              distance: Number(playerDistance.toFixed(2)),
              withinRange: false,
            },
            clearRecoveryReason: true,
          });
          await sleep(loopDelayMs);
        } else {
          markMovementSessionStable({
            kind: "escort_player",
          });
          recordTaskHeartbeat(currentTask, {
            actionState: "acting",
            checkpoint: {
              kind: "escort_player",
              playerName: String(playerTarget.username || step.args?.playerName || "玩家").trim() || "玩家",
              playerPosition: toPlainPosition(playerTarget.position),
              distance: Number(playerDistance.toFixed(2)),
              withinRange: true,
            },
            clearRecoveryReason: true,
          });
          await sleep(loopDelayMs);
        }
      }
    }
  }

  function findAnchorBlockForPlacement(targetPos) {
    const bot = ensureBotReady();
    const directions = [
      new Vec3(0, -1, 0),
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
      new Vec3(0, 1, 0),
    ];
    for (const dir of directions) {
      const anchorPos = targetPos.plus(dir);
      const anchorBlock = bot.blockAt(anchorPos);
      if (!anchorBlock || anchorBlock.name === "air") {
        continue;
      }
      return {
        block: anchorBlock,
        faceVector: dir.scaled(-1),
      };
    }
    return null;
  }

  function placementIntersectsPlayer(targetPos, position = null, movementMargin = 0) {
    const bot = ensureBotReady();
    const feet = position || bot.entity.position;
    const halfWidth = (Number(bot.entity.width) || 0.6) / 2 + movementMargin;
    const height = Number(bot.entity.height) || 1.8;
    return feet.x + halfWidth > targetPos.x && feet.x - halfWidth < targetPos.x + 1 &&
      feet.z + halfWidth > targetPos.z && feet.z - halfWidth < targetPos.z + 1 &&
      feet.y + height > targetPos.y && feet.y < targetPos.y + 1;
  }

  async function moveToPlacementStance(targetPos, anchor) {
    const bot = ensureBotReady();
    const facePoint = anchor.block.position.offset(
      0.5 + anchor.faceVector.x * 0.5,
      0.5 + anchor.faceVector.y * 0.5,
      0.5 + anchor.faceVector.z * 0.5
    );
    const faceGoal = bot.world?.getBlock && bot.world?.raycast
      ? new goals.GoalPlaceBlock(targetPos, bot.world, {
        range: 4.5,
        faces: [anchor.block.position.minus(targetPos)],
      })
      : null;
    const canPlaceFrom = (position) => {
      if (placementIntersectsPlayer(targetPos, position)) return false;
      const eye = position.offset(0, Number(bot.entity.eyeHeight) || 1.62, 0);
      return eye.distanceTo(facePoint) <= 4.5 && (!faceGoal || faceGoal.getFaceAndRef(eye) !== null);
    };
    await waitForSurfaceGround("放置方块");
    if (canPlaceFrom(bot.entity.position)) return;

    const candidates = [];
    for (let dx = -3; dx <= 3; dx += 1) {
      for (let dz = -3; dz <= 3; dz += 1) {
        for (let dy = -3; dy <= 3; dy += 1) {
          const feet = targetPos.offset(dx, dy, dz);
          const center = feet.offset(0.5, 0, 0.5);
          // Installed pathfinder can finish up to 0.35 blocks from the centre.
          // Leave that margin so a neighbouring goal cannot still put our body
          // across the new block, as happened on the natural hillside.
          if (!safeSurfaceFoot(feet) || placementIntersectsPlayer(targetPos, center, 0.35) || !canPlaceFrom(center)) continue;
          candidates.push({ feet, distance: center.distanceTo(bot.entity.position) });
        }
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    for (const candidate of candidates.slice(0, 12)) {
      checkTaskSignal();
      try {
        await pathfinderGoto(new goals.GoalBlock(candidate.feet.x, candidate.feet.y, candidate.feet.z), 8000, "前往安全放置站位超时");
        await waitForSurfaceGround("放置方块");
        if (safeSurfaceFoot(bot.entity.position.floored()) && canPlaceFrom(bot.entity.position)) return;
      } catch (_) {
        checkTaskSignal();
      }
    }
    const error = new Error("目标方块附近没有可触达且不与身体重叠的安全放置站位");
    error.code = "placement_no_safe_stance";
    throw error;
  }

  async function clearPlacementObstruction(targetPos, itemName = "") {
    const bot = ensureBotReady();
    const existing = bot.blockAt(targetPos);
    if (!existing || existing.name === "air") {
      return true;
    }
    if (String(existing.name || "").trim() === String(itemName || "").trim()) {
      return true;
    }
    if (!isReplaceableBlock(existing)) {
      return false;
    }
    await moveNearBlock(existing, 2);
    try {
      await equipBestTool(existing);
    } catch (_) {}
    if (!bot.canDigBlock(existing)) {
      throw new Error(`目标位置被 ${existing.displayName || existing.name} 挡住，而且当前无法清理`);
    }
    await physicalDigBlock(existing, existing.displayName || existing.name);
    await sleep(180);
    await collectNearbyDroppedItems({
      position: targetPos,
      radius: 4,
      timeoutMs: 1800,
      idleGraceMs: 300,
    });
    return true;
  }

  async function executePlaceBlock(step) {
    const bot = ensureBotReady();
    ensureMovements(bot);
    const position = normalizeVec3Input(step.args?.position || step.args);
    const itemName = String(step.args?.item || step.args?.block || "").trim();
    const expectedBlockNames = new Set(
      (Array.isArray(step.args?.expectBlocks) ? step.args.expectBlocks : [])
        .map((name) => String(name || "").trim())
        .filter(Boolean)
    );
    if (!expectedBlockNames.size && CROP_ITEM_TO_BLOCK[itemName]) {
      expectedBlockNames.add(CROP_ITEM_TO_BLOCK[itemName]);
    }
    if (!expectedBlockNames.size) {
      expectedBlockNames.add(itemName);
    }
    if (!position || !itemName) {
      throw new Error("放置方块缺少坐标或材料");
    }
    const targetPos = new Vec3(position.x, position.y, position.z);
    updateTaskCheckpoint(currentTask, {
      kind: "place_block",
      item: itemName,
      targetPosition: toPlainPosition(targetPos),
    });
    const existing = bot.blockAt(targetPos);
    if (existing && expectedBlockNames.has(String(existing.name || "").trim())) {
      return;
    }
    if (existing && !isReplaceableBlock(existing)) {
      throw new Error(`目标位置已被 ${existing.displayName || existing.name} 占用`);
    }
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      checkTaskSignal();
      await clearPlacementObstruction(targetPos, itemName);
      const item = findInventoryItem([itemName]);
      if (!item) {
        throw new Error(`背包里没有 ${itemName}`);
      }
      await equipInventoryItem(item, "hand", item.displayName || item.name);
      const anchor = findAnchorBlockForPlacement(targetPos);
      if (!anchor) {
        throw new Error("目标位置附近没有可依附的方块");
      }
      await moveToPlacementStance(targetPos, anchor);
      try {
        await safeBotLookAt(targetPos.offset(0.5, 0.5, 0.5), true, {
          reason: "open_structure_target",
        });
      } catch (_) {}
      try {
        await physicalPlaceBlock(anchor.block, anchor.faceVector, targetPos, itemName);
      } catch (error) {
        lastError = error?.message || String(error || "");
        await sleep(200);
      }
      await sleep(160);
      const placed = bot.blockAt(targetPos);
      if (placed && expectedBlockNames.has(String(placed.name || "").trim())) {
        recordTaskHeartbeat(currentTask, {
          actionState: "acting",
          checkpoint: {
            kind: "place_block",
            item: itemName,
            targetPosition: toPlainPosition(targetPos),
            placedBlock: String(placed.name || "").trim() || null,
          },
          clearRecoveryReason: true,
        });
        return;
      }
      if (!lastError && placed && !isReplaceableBlock(placed)) {
        throw new Error(`目标位置被 ${placed.displayName || placed.name} 占用，无法继续放置`);
      }
      addTaskLog("warn", `放置 ${itemName} 失败，正在重试 (${attempt + 1}/3)`);
      lastError = lastError || `放置 ${itemName} 后目标方块未更新`;
      await sleep(180);
    }
    throw new Error(lastError || `放置 ${itemName} 失败`);
  }

  async function executeBreakBlock(step) {
    const bot = ensureBotReady();
    ensureMovements(bot);
    const position = normalizeVec3Input(step.args?.position || step.args);
    let block = null;
    if (position) {
      block = bot.blockAt(new Vec3(position.x, position.y, position.z));
    }
    if (!block && step.args?.block) {
      block = findNearestBlockByNames([String(step.args.block)], 16);
    }
    if (!block || block.name === "air") {
      throw new Error("没有找到要拆除的方块");
    }
    updateTaskCheckpoint(currentTask, {
      kind: "break_block",
      block: String(block.name || "").trim() || null,
      targetPosition: toPlainPosition(block.position),
    });
    await moveNearBlock(block, 2);
    await equipBestTool(block);
    await physicalDigBlock(block, block.displayName || block.name);
    recordTaskHeartbeat(currentTask, {
      actionState: "acting",
      checkpoint: {
        kind: "break_block",
        block: String(block.name || "").trim() || null,
        targetPosition: toPlainPosition(block.position),
      },
      clearRecoveryReason: true,
    });
  }

  function getAvailableBlueprintMaterial(material = "") {
    const normalized = String(material || "").trim();
    if (!isAnyPlankMaterial(normalized)) {
      return normalized;
    }
    const plankName = getMostAbundantPlankName();
    if (plankName && getItemCountByName(plankName) > 0) {
      return plankName;
    }
    return "";
  }

  function getBlueprintMaterialCount(material = "") {
    const normalized = String(material || "").trim();
    if (isAnyPlankMaterial(normalized)) {
      return getItemCount(ANY_PLANKS);
    }
    return getItemCount([normalized]);
  }

  function getSmallHousePlaybookAnchor(step = {}) {
    const fromArgs = normalizeVec3Input(step.args?.anchor || step.args?.position);
    if (fromArgs) {
      return fromArgs;
    }
    return normalizeVec3Input(currentTask?.stepCheckpoint?.anchor || currentTask?.stepCheckpoint?.buildAnchor);
  }

  function setSmallHousePlaybookCheckpoint(phase, label, patch = {}) {
    updateTaskCheckpoint(currentTask, {
      kind: "build_small_house_playbook",
      playbookVersion: 1,
      playbookPhase: String(phase || "").trim() || null,
      playbookStepLabel: String(label || phase || "").trim() || null,
      ...patch,
    });
  }

  function getSmallHousePlaybookPhaseGroups(anchor, step = {}) {
    const { height } = getSmallHousePlaybookDimensions(step);
    return getBlueprintPhaseGroups(anchor, createSmallHousePlaybookBlueprint(anchor, step), height);
  }

  function getSmallHouseMaterialSummary(step = {}) {
    const material = getSmallHousePlaybookMaterial(step);
    return {
      material,
      plankCount: getItemCount(ANY_PLANKS),
      requiredBlocks: getSmallHousePlaybookRequiredBlocks(step),
      byPlank: Object.fromEntries(
        ANY_PLANKS
          .map((name) => [name, getItemCountByName(name)])
          .filter(([, count]) => count > 0)
      ),
      logs: getTotalLogCount(),
      craftingTable: getItemCountByName("crafting_table"),
    };
  }

  function getSmallHouseRemainingMaterials(anchor, step = {}) {
    const bot = ensureBotReady();
    const { width, depth } = getSmallHousePlaybookDimensions(step);
    const missingStructureBlocks = createSmallHousePlaybookBlueprint(anchor, step)
      .filter((block) => !isBlueprintBlockSatisfied(block)).length;
    let missingSupportBlocks = 0;
    for (let x = 0; x < width; x += 1) {
      for (let z = 0; z < depth; z += 1) {
        if (!isSafeSupportBlock(bot.blockAt(new Vec3(anchor.x + x, anchor.y - 1, anchor.z + z)))) {
          missingSupportBlocks += 1;
        }
      }
    }
    return {
      missingStructureBlocks,
      missingSupportBlocks,
      requiredBlocks: missingStructureBlocks + missingSupportBlocks,
    };
  }

  function scoreBuildSite(anchor, width = 5, depth = 4, height = 3) {
    const bot = ensureBotReady();
    let penalty = 0;
    for (let x = 0; x < width; x += 1) {
      for (let z = 0; z < depth; z += 1) {
        const floorPos = new Vec3(anchor.x + x, anchor.y, anchor.z + z);
        const support = bot.blockAt(floorPos.offset(0, -1, 0));
        const floorBlock = bot.blockAt(floorPos);
        if (!isSafeSupportBlock(support)) {
          penalty += 8;
        }
        if (floorBlock && !isReplaceableBlock(floorBlock)) {
          penalty += 6;
        }
        for (let y = 1; y <= height + 2; y += 1) {
          const airSpace = bot.blockAt(floorPos.offset(0, y, 0));
          if (airSpace && !isReplaceableBlock(airSpace)) {
            penalty += y <= height ? 4 : 2;
          }
        }
      }
    }
    return penalty;
  }

  function findNearbyBuildAnchor(width = 5, depth = 4, height = 3, centerPosition = null) {
    const bot = ensureBotReady();
    const center =
      toPlainPosition(centerPosition) ||
      getCompanionWorkAreaCenter() ||
      toPlainPosition(bot.entity.position);
    if (!center) {
      return null;
    }
    const base = new Vec3(Math.floor(center.x), Math.floor(center.y), Math.floor(center.z));
    const cacheKey = `buildAnchor:${base.x},${base.y},${base.z}:${clamp(Number(width) || 5, 3, 7)}:${clamp(Number(depth) || 4, 3, 6)}:${clamp(Number(height) || 3, 2, 5)}`;
    return getCachedBlockQuery(cacheKey, () => {
      let best = null;
      let bestScore = Number.POSITIVE_INFINITY;
      for (let dx = -8; dx <= 8; dx += 1) {
        for (let dz = -8; dz <= 8; dz += 1) {
          const distancePenalty = Math.abs(dx) + Math.abs(dz);
          if (distancePenalty < 2 || distancePenalty > 12) {
            continue;
          }
          const standable = getNearbyStandablePosition(
            {
              x: base.x + dx,
              y: base.y,
              z: base.z + dz,
            },
            {
              horizontalRadius: 0,
              upwardSearch: 4,
              downwardSearch: 8,
            }
          );
          const candidate = standable
            ? {
                x: Math.floor(standable.x),
                y: Math.floor(standable.y),
                z: Math.floor(standable.z),
              }
            : {
                x: base.x + dx,
                y: base.y,
                z: base.z + dz,
              };
          const sitePenalty = scoreBuildSite(candidate, width, depth, height);
          const totalScore = sitePenalty + distancePenalty * 1.5;
          if (totalScore < bestScore) {
            best = candidate;
            bestScore = totalScore;
          }
        }
      }
      return best && bestScore < 120 ? best : null;
    });
  }

  async function prepareSmallHouseSite(anchor, material, width = 5, depth = 4, height = 3, options = {}) {
    const bot = ensureBotReady();
    const supportRadiusZStart = 0;
    const supportRadiusZEnd = depth - 1;
    const placeFloor = options.placeFloor !== false;
    const protectedBlueprint = new Map(
      (options.protectedBlueprint || createSmallHouseBlueprint(anchor, material, width, depth, height))
        .map((block) => [`${block.position.x}:${block.position.y}:${block.position.z}`, block])
    );
    setTaskProgress("正在平整木屋地基");
    addTaskLog("info", "正在平整木屋地基并补齐支撑面");

    for (let x = 0; x < width; x += 1) {
      for (let z = supportRadiusZStart; z <= supportRadiusZEnd; z += 1) {
        checkTaskSignal();
        await maybeHandleForegroundCombatInterrupt();
        const floorPos = new Vec3(anchor.x + x, anchor.y, anchor.z + z);
        const supportPos = floorPos.offset(0, -1, 0);
        const support = bot.blockAt(supportPos);
        if (!isSafeSupportBlock(support)) {
          const supportMaterial = getAvailableBlueprintMaterial(material);
          if (!supportMaterial) {
            throw new Error("材料不足：背包里没有可用木板来补地基支撑");
          }
          await executePlaceBlock({
            args: {
              position: supportPos,
              item: supportMaterial,
              expectBlocks: getBlueprintExpectedBlockNames(material),
            },
          });
          await sleep(60);
        }

        const floorBlock = bot.blockAt(floorPos);
        const floorSatisfied = getBlueprintExpectedBlockNames(material).includes(String(floorBlock?.name || "").trim());
        // Clear terrain at floor height even when laying the floor is a later phase.
        if (!floorSatisfied && floorBlock && !isReplaceableBlock(floorBlock)) {
          await executeBreakBlock({ args: { position: floorPos } });
        }
        if (placeFloor && z >= 0 && z < depth && !floorSatisfied) {
          const floorMaterial = getAvailableBlueprintMaterial(material);
          if (!floorMaterial) {
            throw new Error("材料不足：背包里没有可用木板来铺地板");
          }
          await executePlaceBlock({
            args: {
              position: floorPos,
              item: floorMaterial,
              expectBlocks: getBlueprintExpectedBlockNames(material),
            },
          });
          await sleep(60);
        }

        for (let y = 1; y <= height + 2; y += 1) {
          const block = bot.blockAt(floorPos.offset(0, y, 0));
          if (!block || block.name === "air" || isReplaceableBlock(block)) {
            continue;
          }
          const plannedBlock = protectedBlueprint.get(`${block.position.x}:${block.position.y}:${block.position.z}`);
          if (plannedBlock && getBlueprintExpectedBlockNames(plannedBlock.item).includes(block.name)) {
            continue;
          }
          if (!bot.canDigBlock(block)) {
            throw new Error(`建造区域里有 ${block.displayName || block.name} 挡住，当前无法清理`);
          }
          await executeBreakBlock({
            args: {
              position: block.position,
            },
          });
          await sleep(50);
        }
      }
    }
  }

  function isBlueprintBlockSatisfied(blockSpec) {
    const bot = ensureBotReady();
    const target = normalizeVec3Input(blockSpec?.position);
    const itemName = String(blockSpec?.item || "").trim();
    if (!target || !itemName) {
      return false;
    }
    const block = bot.blockAt(new Vec3(target.x, target.y, target.z));
    return getBlueprintExpectedBlockNames(itemName).includes(String(block?.name || "").trim());
  }

  async function executeBlueprintPhase(anchor, phaseLabel, blocks = []) {
    const label = String(phaseLabel || "结构").trim() || "结构";
    let remaining = blocks.filter((block) => !isBlueprintBlockSatisfied(block));
    const bounds = blocks.reduce(
      (acc, block) => {
        const x = Number(block?.position?.x || 0);
        const z = Number(block?.position?.z || 0);
        return {
          minX: Math.min(acc.minX, x),
          maxX: Math.max(acc.maxX, x),
          minZ: Math.min(acc.minZ, z),
          maxZ: Math.max(acc.maxZ, z),
        };
      },
      {
        minX: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        minZ: Number.POSITIVE_INFINITY,
        maxZ: Number.NEGATIVE_INFINITY,
      }
    );
    if (!remaining.length) {
      addTaskLog("info", `${label} 已经完整，直接进入下一段`);
      return;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      updateTaskCheckpoint(currentTask, {
        kind: "build_phase",
        phase: label,
        remainingBlocks: remaining.length,
        attempt: attempt + 1,
        anchor: toPlainPosition(anchor),
      });
      checkTaskSignal();
      await maybeHandleForegroundCombatInterrupt();
      setTaskProgress(`正在搭建${label}（第 ${attempt + 1}/3 轮，剩余 ${remaining.length} 块）`);
      addTaskLog("info", `开始搭建${label}，当前还差 ${remaining.length} 块`);
      for (let index = 0; index < remaining.length; index += 1) {
        checkTaskSignal();
        await maybeHandleForegroundCombatInterrupt();
        // Another player or an earlier retry may already have placed this block.
        if (isBlueprintBlockSatisfied(remaining[index])) {
          continue;
        }
        updateTaskCheckpoint(currentTask, {
          kind: "build_phase",
          phase: label,
          remainingBlocks: remaining.length,
          currentBlockIndex: index,
          currentBlockPosition: toPlainPosition(remaining[index]?.position),
          anchor: toPlainPosition(anchor),
        });
        if (index === 0 || index === remaining.length - 1 || index % 4 === 0) {
          setTaskProgress(`正在搭建${label} ${index + 1}/${remaining.length}`);
        }
        const itemName = getAvailableBlueprintMaterial(remaining[index].item);
        if (!itemName) {
          throw new Error("材料不足：背包里没有可用木板来继续搭建");
        }
        await executePlaceBlock({
          args: {
            position: remaining[index].position,
            item: itemName,
            expectBlocks: getBlueprintExpectedBlockNames(remaining[index].item),
          },
        });
        await sleep(80);
      }
      remaining = blocks
        .filter((block) => !isBlueprintBlockSatisfied(block))
        .sort((a, b) => {
          const ax = Number(a?.position?.x || 0);
          const az = Number(a?.position?.z || 0);
          const bx = Number(b?.position?.x || 0);
          const bz = Number(b?.position?.z || 0);
          const aEdge =
            ax === bounds.minX || ax === bounds.maxX || az === bounds.minZ || az === bounds.maxZ
              ? 0
              : 1;
          const bEdge =
            bx === bounds.minX || bx === bounds.maxX || bz === bounds.minZ || bz === bounds.maxZ
              ? 0
              : 1;
          return aEdge - bEdge;
        });
      if (!remaining.length) {
        recordTaskHeartbeat(currentTask, {
          actionState: "acting",
          checkpoint: {
            kind: "build_phase",
            phase: label,
            remainingBlocks: 0,
            anchor: toPlainPosition(anchor),
          },
          clearRecoveryReason: true,
        });
        addTaskLog("success", `${label} 已搭建完成`);
        return;
      }
      addTaskLog("warn", `${label} 还有 ${remaining.length} 块没有放稳，准备补放`);
      try {
        await moveToPosition(anchor, 4);
      } catch (_) {}
    }
    throw new Error(`${label} 长时间没有进展，已按超时处理`);
  }

  function chooseSmallHousePlaybookAnchor(step = {}) {
    const bot = ensureBotReady();
    const requestedAnchor = getSmallHousePlaybookAnchor(step);
    if (requestedAnchor) {
      return requestedAnchor;
    }
    const { width, depth, height } = getSmallHousePlaybookDimensions(step);
    const preferredBuildCenter =
      getCompanionWorkAreaCenter() ||
      findPlayerTarget(getBestKnownPlayerName())?.position ||
      bot.entity.position;
    return (
      findNearbyBuildAnchor(width, depth, height, preferredBuildCenter) || {
        x: Math.floor(bot.entity.position.x) + 2,
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z) + 2,
      }
    );
  }

  function getSmallHousePhaseBlocks(anchor, step = {}, phase = "") {
    const targetLabel =
      phase === "place_floor"
        ? "地板"
        : phase === "place_walls"
          ? "墙体"
          : phase === "place_roof"
            ? "屋顶"
            : "";
    if (!targetLabel) {
      return null;
    }
    return getSmallHousePlaybookPhaseGroups(anchor, step).find((group) => group.label === targetLabel) || null;
  }

  async function executeBuildSmallHousePhase(step) {
    ensureBotReady();
    const phase = String(step.args?.phase || "").trim();
    const label = String(step.args?.label || phase || "小木屋步骤").trim();
    const { width, depth, height } = getSmallHousePlaybookDimensions(step);
    const material = getSmallHousePlaybookMaterial(step);

    if (!phase) {
      throw new Error("小木屋步骤缺少 phase");
    }

    if (phase === "inspect_inventory") {
      const materialSummary = getSmallHouseMaterialSummary(step);
      setTaskProgress("正在检查背包里的木屋材料");
      setSmallHousePlaybookCheckpoint(phase, label, {
        width,
        depth,
        height,
        material,
        materialSummary,
      });
      addTaskLog(
        "info",
        `木屋材料检查：当前木板 ${materialSummary.plankCount}/${materialSummary.requiredBlocks}，原木 ${materialSummary.logs}`
      );
      recordTaskHeartbeat(currentTask, {
        actionState: "acting",
        checkpoint: {
          playbookPhase: phase,
          playbookStepLabel: label,
          materialSummary,
        },
        clearRecoveryReason: true,
      });
      return;
    }

    if (phase === "select_site") {
      const anchor = chooseSmallHousePlaybookAnchor(step);
      setTaskProgress("正在像真人一样先找一块平整落点");
      setSmallHousePlaybookCheckpoint(phase, label, {
        anchor: toPlainPosition(anchor),
        buildAnchor: toPlainPosition(anchor),
        width,
        depth,
        height,
        material,
      });
      addTaskLog("info", `已选择小木屋落点：${anchor.x}, ${anchor.y}, ${anchor.z}`);
      recordTaskHeartbeat(currentTask, {
        actionState: "acting",
        checkpoint: {
          playbookPhase: phase,
          playbookStepLabel: label,
          anchor: toPlainPosition(anchor),
        },
        clearRecoveryReason: true,
      });
      return;
    }

    const anchor = chooseSmallHousePlaybookAnchor(step);
    setSmallHousePlaybookCheckpoint(phase, label, {
      anchor: toPlainPosition(anchor),
      buildAnchor: toPlainPosition(anchor),
      width,
      depth,
      height,
      material,
    });

    if (phase === "prepare_materials") {
      const remainingMaterials = getSmallHouseRemainingMaterials(anchor, step);
      const requiredBlocks = remainingMaterials.requiredBlocks;
      const targetBlocks = requiredBlocks;
      setTaskProgress(`正在准备小木屋木材 ${getBlueprintMaterialCount(material)}/${requiredBlocks}`);
      addTaskLog("info", `正在补齐小木屋材料：结构缺 ${remainingMaterials.missingStructureBlocks} 块，地基支撑缺 ${remainingMaterials.missingSupportBlocks} 块`);
      if (requiredBlocks === 0) {
        addTaskLog("info", "小木屋结构和支撑已经完整，无需继续采集建材");
      } else if (isAnyPlankMaterial(material)) {
        await ensurePlanks(targetBlocks);
      } else {
        await ensureSpecificPlanks(material, targetBlocks);
      }
      const materialCount = getBlueprintMaterialCount(material);
      const materialSummary = { ...getSmallHouseMaterialSummary(step), ...remainingMaterials };
      if (materialCount < requiredBlocks) {
        throw new Error(`材料不足：需要 ${requiredBlocks} 个木板，当前只有 ${materialCount} 个`);
      }
      setSmallHousePlaybookCheckpoint(phase, label, {
        materialSummary,
      });
      addTaskLog("success", `小木屋材料已齐：木板 ${materialCount}/${requiredBlocks}`);
      recordTaskHeartbeat(currentTask, {
        actionState: "acting",
        checkpoint: {
          playbookPhase: phase,
          playbookStepLabel: label,
          materialSummary,
        },
        clearRecoveryReason: true,
      });
      return;
    }

    if (phase === "clear_site") {
      setTaskProgress("正在清理小木屋地基");
      await prepareSmallHouseSite(anchor, material, width, depth, height, {
        placeFloor: false,
        protectedBlueprint: createSmallHousePlaybookBlueprint(anchor, step),
      });
      addTaskLog("success", "小木屋地基已经清理完成");
      recordTaskHeartbeat(currentTask, {
        actionState: "acting",
        checkpoint: {
          playbookPhase: phase,
          playbookStepLabel: label,
          anchor: toPlainPosition(anchor),
        },
        clearRecoveryReason: true,
      });
      return;
    }

    if (["place_floor", "place_walls", "place_roof"].includes(phase)) {
      const group = getSmallHousePhaseBlocks(anchor, step, phase);
      if (!group) {
        throw new Error(`小木屋未知建造阶段：${phase}`);
      }
      const remainingCount = group.blocks.filter((block) => !isBlueprintBlockSatisfied(block)).length;
      if (remainingCount > 0 && getBlueprintMaterialCount(material) < remainingCount) {
        throw new Error(`材料不足：${label} 还需要 ${remainingCount} 个木板，当前只有 ${getBlueprintMaterialCount(material)} 个`);
      }
      setTaskProgress(`正在${label}`);
      await executeBlueprintPhase(anchor, group.label, group.blocks);
      setSmallHousePlaybookCheckpoint(phase, label, {
        phaseRemainingBlocks: 0,
        materialSummary: getSmallHouseMaterialSummary(step),
      });
      return;
    }

    if (phase === "verify") {
      const blueprint = createSmallHousePlaybookBlueprint(anchor, step);
      const missing = blueprint.filter((block) => !isBlueprintBlockSatisfied(block));
      const verificationSummary = {
        totalBlocks: blueprint.length,
        missingBlocks: missing.length,
        anchor: toPlainPosition(anchor),
        width,
        depth,
        height,
      };
      setSmallHousePlaybookCheckpoint(phase, label, {
        verificationSummary,
      });
      if (missing.length) {
        throw new Error(`建造校验未通过：小木屋还缺 ${missing.length} 个方块`);
      }
      setTaskProgress("小木屋已经盖好并完成校验");
      addTaskLog("success", "小木屋结构校验通过：地板、墙体和屋顶都已完成");
      recordTaskHeartbeat(currentTask, {
        actionState: "acting",
        checkpoint: {
          playbookPhase: phase,
          playbookStepLabel: label,
          verificationSummary,
        },
        clearRecoveryReason: true,
      });
      return;
    }

    throw new Error(`小木屋暂不支持阶段 ${phase}`);
  }

  async function executeBuildStructure(step) {
    const bot = ensureBotReady();
    const rawMaterial = String(step.args?.material || "wood").trim().toLowerCase();
    let material = resolveBuildMaterial(rawMaterial || "wood");
    const learnedFootprint = getLearnedSmallHouseDimensions(
      Number(step.args?.width) || 5,
      Number(step.args?.depth) || 4
    );
    const width = learnedFootprint.width;
    const depth = learnedFootprint.depth;
    const height = Number(step.args?.height) || 3;
    const requestedAnchor = normalizeVec3Input(step.args?.position);
    const preferredBuildCenter =
      getCompanionWorkAreaCenter() ||
      findPlayerTarget(getBestKnownPlayerName())?.position ||
      bot.entity.position;
    const anchor =
      requestedAnchor ||
      findNearbyBuildAnchor(
        width,
        depth,
        height,
        preferredBuildCenter
      ) || {
        x: Math.floor(bot.entity.position.x) + 2,
        y: Math.floor(bot.entity.position.y),
        z: Math.floor(bot.entity.position.z) + 2,
      };
    const genericWoodRequested =
      !rawMaterial || ["wood", "oak", "plank", "planks"].includes(rawMaterial);
    updateTaskCheckpoint(currentTask, {
      kind: "build_small_house",
      phase: "choose_site",
      anchor: toPlainPosition(anchor),
      width,
      depth,
      height,
      material,
    });

    setTaskProgress("正在规划建造位置");
    if (!requestedAnchor) {
      addTaskLog(
        "info",
        `已选择建造位置：${anchor.x}, ${anchor.y}, ${anchor.z}`
      );
    }
    if (learnedFootprint.penalty > 0) {
      addTaskLog(
        "info",
        `根据历史经验，本次先把房屋缩到 ${width}x${depth}，优先保证能稳定盖起来`
      );
    }

    if (genericWoodRequested || ANY_PLANKS.includes(material)) {
      const preferredPlank = genericWoodRequested ? selectPreferredWoodPlankName() : material;
      const previewBlueprint = createSmallHouseBlueprint(anchor, preferredPlank, width, depth, height);
      setTaskProgress(`正在准备建材：${preferredPlank} (${previewBlueprint.length} 块)`);
      await ensureSpecificPlanks(preferredPlank, previewBlueprint.length);
      if (getItemCountByName(preferredPlank) >= previewBlueprint.length) {
        material = preferredPlank;
      } else {
        const abundantPlank = getMostAbundantPlankName();
        if (getItemCountByName(abundantPlank) > getItemCountByName(preferredPlank)) {
          addTaskLog("info", `指定木材不足，改用库存最多的 ${abundantPlank} 继续搭建`);
          material = abundantPlank;
        } else {
          material = preferredPlank;
        }
      }
    }

    let blueprint = createSmallHouseBlueprint(anchor, material, width, depth, height);
    updateTaskCheckpoint(currentTask, {
      kind: "build_small_house",
      phase: "gather_planks",
      anchor: toPlainPosition(anchor),
      width,
      depth,
      height,
      material,
      requiredBlocks: blueprint.length,
    });
    setTaskProgress(`正在整理 ${material} 建材`);
    let materialCount = getItemCount([material]);
    if (materialCount < blueprint.length && ANY_PLANKS.includes(material)) {
      await ensureSpecificPlanks(material, blueprint.length);
      materialCount = getItemCount([material]);
      const abundantPlank = getMostAbundantPlankName();
      if (getItemCountByName(abundantPlank) > materialCount) {
        material = abundantPlank;
        blueprint = createSmallHouseBlueprint(anchor, material, width, depth, height);
        materialCount = getItemCount([material]);
        addTaskLog("info", `切换到可用木材 ${material}，继续当前木屋阶段`);
      }
    }
    if (materialCount < blueprint.length) {
      try {
        await withdrawItemsFromNearbyContainer({
          names: [material],
          count: blueprint.length - materialCount,
          progressText: `正在从附近箱子拿 ${material}`,
        });
      } catch (_) {}
      materialCount = getItemCount([material]);
    }
    if (materialCount < blueprint.length) {
      throw new Error(`材料不足：需要 ${blueprint.length} 个 ${material}，当前只有 ${materialCount} 个`);
    }
    updateTaskCheckpoint(currentTask, {
      kind: "build_small_house",
      phase: "flatten_site",
      anchor: toPlainPosition(anchor),
      width,
      depth,
      height,
      material,
      requiredBlocks: blueprint.length,
    });
    await prepareSmallHouseSite(anchor, material, width, depth, height);
    stopBotActions();
    setTaskProgress("材料已齐，准备回到建造位置");
    addTaskLog("info", `材料已准备完成，开始去 ${anchor.x}, ${anchor.y}, ${anchor.z} 搭建`);
    try {
      await moveToPosition(anchor, 4);
    } catch (_) {
      // Per-block placement retries remain the authoritative fallback even if the pre-move cannot fully settle.
    }
    const phaseGroups = getBlueprintPhaseGroups(anchor, blueprint, height);
    for (const phase of phaseGroups) {
      updateTaskCheckpoint(currentTask, {
        kind: "build_small_house",
        phase: phase.label,
        anchor: toPlainPosition(anchor),
        width,
        depth,
        height,
        material,
      });
      await executeBlueprintPhase(anchor, phase.label, phase.blocks);
    }
    setTaskProgress("木屋主体已经搭建完成");
  }

  function furnishedHouseStandingSafely(position) {
    const bot = ensureBotReady();
    const feet = toVec3(position);
    if (!feet) return false;
    const half = (Number(bot.entity.width) || 0.6) / 2;
    const height = Number(bot.entity.height) || 1.8;
    let supported = false;
    for (let x = Math.floor(feet.x - half); x <= Math.floor(feet.x + half); x += 1) {
      for (let z = Math.floor(feet.z - half); z <= Math.floor(feet.z + half); z += 1) {
        for (let y = Math.floor(feet.y - 0.06); y <= Math.floor(feet.y + height); y += 1) {
          const block = bot.blockAt(new Vec3(x, y, z));
          if (!block || SURFACE_HAZARDS.has(block.name) || block.getProperties?.().waterlogged === true) return false;
          for (const shape of block.shapes || []) {
            if (feet.x + half <= x + shape[0] || feet.x - half >= x + shape[3] ||
                feet.z + half <= z + shape[2] || feet.z - half >= z + shape[5]) continue;
            const top = y + shape[4];
            if (Math.abs(feet.y - top) < 0.07) supported = true;
            if (feet.y + 0.02 < top && feet.y + height > y + shape[1] + 0.02) return false;
          }
        }
      }
    }
    return supported;
  }

  async function withFurnishedHouseMovements(operation) {
    const bot = ensureBotReady();
    const outer = getExecutionContext() || {};
    // Do not replace the captured survival profile at a furniture boundary.
    const defenseAtEntry = activeSurvivalInterrupt;
    if (defenseAtEntry && !defenseAtEntry.finished && defenseAtEntry.bot === bot
      && outer.pausedSurvivalOwner !== defenseAtEntry) {
      await settleSurvivalDefense('furniture_profile_boundary'); checkTaskSignal();
      if (currentBot !== bot) throw createAbortError('bot_connection_lost');
    }
    const ownerTask = outer.task || currentTask;
    const ownerGeneration = ownerTask?.executionGeneration;
    const ownerToken = outer.token || getActiveCancellationToken();
    const movements = configureFurnishedHouseDoorTraversal(new Movements(bot));
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    movements.allowFreeMotion = false;
    movements.allowSprinting = false;
    movements.canOpenDoors = true;
    // Pathfinder compares feet Y to the landing floor Y; 2 permits one
    // actual block of downward travel, needed to dismantle the ramp safely.
    movements.maxDropDown = 2;
    movements.infiniteLiquidDropdownDistance = false;
    movements.scafoldingBlocks = [];
    for (const name of SURFACE_HAZARDS) {
      const id = bot.registry.blocksByName[name]?.id;
      if (id != null) movements.blocksToAvoid.add(id);
    }
    movements.exclusionAreasStep.push((block) => block?.position && typeof block.position.offset === "function" && [-1, 0, 1].every((dy) => {
      const nearby = bot.blockAt(block.position.offset(0, dy, 0));
      return nearby && !SURFACE_HAZARDS.has(nearby.name) && nearby.getProperties?.().waterlogged !== true;
    }) ? 0 : 100);
    try {
      return await executionContextStorage.run({ ...outer, miningMovements: movements }, async () => {
        ensureMovements(bot);
        return operation();
      });
    } finally {
      const defense = activeSurvivalInterrupt, until = Date.now() + 35000;
      if (defense && defense.task === ownerTask && defense.bot === bot && !defense.finished) {
        while (currentBot === bot && currentTask === ownerTask && ownerTask.executionGeneration === ownerGeneration
          && !ownerToken?.cancelled && !ownerToken?.pauseRequested && !defense.finished && Date.now() < until) {
          await Promise.race([defense.finishedPromise, sleep(50)]);
        }
      }
      if (currentBot === bot && currentTask === ownerTask && ownerTask?.executionGeneration === ownerGeneration &&
          !ownerToken?.cancelled && !ownerToken?.pauseRequested &&
          ![TaskState.PAUSED, TaskState.CANCELLED].includes(ownerTask?.status) && appliedMovementsInstance === movements) {
        appliedMovementsBot = null;
        appliedMovementsInstance = null;
        ensureMovements(bot);
      }
    }
  }

  function furnishedHouseStanceCandidates(target, test) {
    const bot = ensureBotReady();
    const candidates = [];
    const seen = new Set();
    for (let dx = -4; dx <= 4; dx += 1) {
      for (let dz = -4; dz <= 4; dz += 1) {
        for (let dy = -5; dy <= 3; dy += 1) {
          const support = bot.blockAt(target.offset(dx, dy, dz));
          if (!support || SURFACE_HAZARDS.has(support.name)) continue;
          for (const shape of support.shapes || []) {
            const position = support.position.offset(0.5, shape[4], 0.5);
            const id = position.toString();
            if (seen.has(id) || !furnishedHouseStandingSafely(position) || !test(position)) continue;
            seen.add(id);
            candidates.push({ position, distance: position.distanceTo(bot.entity.position) });
          }
        }
      }
    }
    return candidates.sort((a, b) => a.distance - b.distance);
  }

  async function furnishedHouseReach(target, canAct, label, marginTest = canAct) {
    const bot = ensureBotReady();
    const gotoStance=(goal)=>activeHouseSurfaceNavigationMove
      ?pathfinderGoto(goal,12000,`前往${label}站位超时`)
      :houseSurfacePathfinderGoto(goal,12000);
    await waitForSurfaceGround(label);
    if (furnishedHouseStandingSafely(bot.entity.position) && canAct(bot.entity.position)) return;
    const candidates = furnishedHouseStanceCandidates(target, marginTest);
    let lastError;
    if (candidates.length) {
      try {
        // Let A* select any validated stance, instead of repeatedly exhausting
        // the nearest nodes when a finished wall separates them from the bot.
        const reachable = new goals.GoalCompositeAny(candidates.map(({ position }) =>
          new goals.GoalBlock(Math.floor(position.x), Math.ceil(position.y - 1e-6), Math.floor(position.z))));
        // These coordinates identify this action in the movement lease only;
        // the composite's heuristic and end condition use its child goals.
        Object.assign(reachable, { x: target.x, y: target.y, z: target.z });
        await gotoStance(reachable);
        await waitForSurfaceGround(label);
        if (furnishedHouseStandingSafely(bot.entity.position) && canAct(bot.entity.position)) return;
      } catch (error) {
        checkTaskSignal();
        if(error.code==='movement_preempted')throw error;
        if(error.code==='NoPath'||error.name==='NoPath')throw Object.assign(Error(`${label}的当前站位集合已确认无路，需要重新规划运输路线`),{code:'placement_no_safe_stance',cause:error});
        lastError = error;
      }
    }
    for (const { position } of candidates.slice(0, 20).flatMap((candidate) => [candidate, candidate])) {
      checkTaskSignal();
      try {
        // Pathfinder indexes a slab's standing node at the next integer Y,
        // while real physics leaves the feet on its half-height collision top.
        await gotoStance(new goals.GoalBlock(Math.floor(position.x), Math.ceil(position.y - 1e-6), Math.floor(position.z)));
        await waitForSurfaceGround(label);
        if (furnishedHouseStandingSafely(bot.entity.position) && canAct(bot.entity.position)) return;
      } catch (error) {
        checkTaskSignal();
        if(error.code==='movement_preempted')throw error;
        lastError = error;
      }
    }
    const error = new Error(`${label}没有可达且有真实支撑的安全站位${lastError ? `：${lastError.message}` : ""}`);
    error.code = "placement_no_safe_stance";
    throw error;
  }

  async function returnToHouseConstruction(destination){
    const bot=ensureBotReady(),task=currentTask,material=task?.materialSupply;
    const live=()=>task.materialSupply;
    if(material?.materialSource!=='self_gathered'||!material.houseAnchor||bot.entity.position.distanceTo(destination)<=20
      ||destination.distanceTo(toVec3(material.houseAnchor))>24)return;
    return withCurrentHouseMaterialRuntime(async()=>{
      const client=bot._client,generation=task.executionGeneration,deadline=Date.now()+180000;
      const active=()=>{checkTaskSignal();if(currentBot!==bot||bot._client!==client||currentTask!==task||task.executionGeneration!==generation)throw createAbortError('movement_preempted');};
      const abandonChangedRecordedParent=(saved,error)=>{
        active();if(!require('./minecraft/houseRecordedConstructionRoute').canRebaseCompletedConstructionBank(saved,error,
          toPlainPosition(bot.entity.position.floored()),hasGroundedBodySupport(bot),p=>naturalWalkingFoot(bot,p)))return false;
        live().recordedConstructionReturnHistory=[...(live().recordedConstructionReturnHistory||[]).slice(-7),{...saved,abandonedAt:Date.now(),reason:error.code,parentLegCompleted:false}];
        delete live().recordedConstructionReturn;
        live().constructionReturn={anchor:toPlainPosition(bot.entity.position.floored()),target:toPlainPosition(destination),graph:null};
        recordTaskDiagnostic(task,'house_construction_completed_bank_rebased',{actual:toPlainPosition(bot.entity.position),parentLegCompleted:false,houseAccepted:false});
        return true;
      };
      discardForeignHouseWaterFrame();
      if((bot.entity.isInWater||bot.blockAt(bot.entity.position.floored())?.name==='water')&&!activeHouseSurfaceWater?.isPhysicalOwner()){
        const lease=getCurrentMovementLease();
        await require('./minecraft/houseEmergencyShore').escapeEmergencyShore({getBot:()=>currentBot,Vec3,Movements,GoalBlock:goals.GoalBlock,
          assertActive:active,isDryFoot:p=>dryFoot(bot,p),isGrounded:()=>hasGroundedBodySupport(bot),
          setActive:profile=>{activeEmergencyShore=profile?{bot,profile,lease}:null;},
          goto:(goal,options)=>pathfinderGoto(goal,options.timeoutMs,'施工返程意外落水上岸超时',lease,{...options,preserveMovements:true}),
          record:(type,facts)=>recordTaskDiagnostic(task,type,facts)});active();
      }
      // Returning for construction uses the same survival need as ordinary
      // work. Healthy10-hunger workers must not start a remote hunt merely to
      // satisfy a separate return-only18-hunger gate.
      if(selectSurvivalJob({health:bot.health,food:bot.food,safe:true,hasMeal:false,canProvision:true,threat:false})==='provision'){
        await ensureNutrition(18,{anchor:toPlainPosition(bot.entity.position.floored()),minFoodPoints:8,surfaceMaintenance:true});active();
      }
      const interrupted=live().recordedConstructionReturn;
      if(interrupted?.graph&&!interrupted.returnConfirmed&&destination.equals(toVec3(interrupted.target))){
        try{
        await exploreHouseSurfaceGraph(task,'house_owned_stock_camp',interrupted.anchor,setTaskProgress,{returnToAnchor:true,returnToCurrentOnly:true,rejoinInterruptedSuffix:true,
          assertGraphActive:active,excludeBounds:[],graphCheckpoint:{get:()=>interrupted.graph,save:value=>{active();interrupted.graph=value;}}});
        if(interrupted.targetNodeId)await exploreHouseSurfaceGraph(task,'house_owned_stock_camp',interrupted.anchor,setTaskProgress,{
          observedNode:{nodeId:interrupted.targetNodeId,position:interrupted.targetPosition},assertGraphActive:active,excludeBounds:[],
          graphCheckpoint:{get:()=>interrupted.graph,save:value=>{active();interrupted.graph=value;}}});
        active();interrupted.returnConfirmed=true;
        if(bot.entity.position.distanceTo(destination)<=32)return;
        }catch(error){if(!abandonChangedRecordedParent(interrupted,error))throw error;}
      }
      await waitForSurfaceGround('施工返程起点');active();
      const blueprint=createFurnishedHouseBlueprint(material.houseAnchor,{profile:material.profile||'cottage'}),owned=new Set(task.stepCheckpoint?.furnishedHouse?.ownedBlockIds||[]);
      let trip=live().constructionReturn;
      const fresh=()=>({anchor:toPlainPosition(bot.entity.position.floored()),target:toPlainPosition(destination),graph:null});
      if(!trip||!destination.equals(toVec3(trip.target))){trip=fresh();live().constructionReturn=trip;}
      if(bot.entity.position.y<destination.y-3){
        const before=bot.entity.position.clone();
        for(let stage=0;stage<3&&bot.entity.position.y<destination.y-1;stage++){
          active();const previousY=bot.entity.position.y;
          if(!await recoverHouseLocalRoute(task,toPlainPosition(destination),Math.min(deadline,Date.now()+20000)))break;
          active();if(bot.entity.position.y<=previousY+.5)break;
        }
        if(bot.entity.position.y>before.y+.5){
          active();if(!naturalWalkingFoot(bot,bot.entity.position.floored())||!hasGroundedBodySupport(bot))throw Object.assign(Error('施工上行后尚未落稳'),{code:'house_construction_origin_unconfirmed'});
          live().constructionReturnHistory=[...(live().constructionReturnHistory||[]).slice(-7),trip];trip=fresh();live().constructionReturn=trip;
          recordTaskDiagnostic(task,'house_construction_upward_escape_observed',{before:toPlainPosition(before),actual:toPlainPosition(bot.entity.position),oldRouteTraversalCredit:false});
        }
      }
      const candidates=require('./minecraft/houseRecordedConstructionRoute').recordedConstructionRoutes(live(),toPlainPosition(bot.entity.position.floored()),toPlainPosition(destination),p=>naturalWalkingFoot(bot,p));
      recordTaskDiagnostic(task,'house_construction_recorded_route_candidates',{actual:toPlainPosition(bot.entity.position),candidates:candidates.map(c=>({index:c.index,resource:c.resource,entry:c.entry,target:c.targetPosition}))});
      let recordedTransportProgress=false;
      for(const candidate of candidates){
        active();const goal=new goals.GoalBlock(candidate.entry.x,candidate.entry.y,candidate.entry.z),profile=bot.pathfinder.movements;
        const probe=require('./minecraft/houseSurfaceGraph').runRecordedConstructionConnectorProbe(bot,profile,goal,{assertActive:active,isOwnerCurrent:()=>currentBot===bot&&currentTask===task&&task.executionGeneration===generation,recordedEntry:candidate.entry});
        const actualFoot=bot.entity.position.floored();
        const dryPath=probe.result?.status==='success'&&!probe.result.path?.some((p,i)=>p.toBreak?.length||p.toPlace?.length||!naturalWalkingFoot(bot,p)
          &&!(i===0&&p.x===actualFoot.x&&p.y===actualFoot.y&&p.z===actualFoot.z&&hasGroundedBodySupport(bot)));
        recordTaskDiagnostic(task,'house_construction_recorded_connector_probe',{entry:candidate.entry,target:candidate.targetPosition,status:probe.result?.status||'UNKNOWN',dryPath:Boolean(dryPath),pathLength:probe.result?.path?.length||0,actualMovementPerformed:false});
        if(!dryPath)continue;
        await houseSurfacePathfinderGoto(goal,Math.min(60000,Math.max(12000,(probe.result.path?.length||1)*650)));active();
        await waitForSurfaceGround('施工运输已观察入口');active();
        const graph=require('./minecraft/houseRecordedConstructionRoute').confirmRecordedConstructionEntry(candidate,toPlainPosition(bot.entity.position.floored()),hasGroundedBodySupport(bot));
        const saved={sourceIndex:candidate.index,resource:candidate.resource,anchor:candidate.anchor,targetNodeId:candidate.targetNodeId,targetPosition:candidate.targetPosition,target:toPlainPosition(destination),graph};live().recordedConstructionReturn=saved;
        recordTaskDiagnostic(task,'house_construction_recorded_entry_confirmed',{actual:toPlainPosition(bot.entity.position),sourceIndex:candidate.index,resource:candidate.resource,oldRouteTraversalCredit:false});
        try{await exploreHouseSurfaceGraph(task,'house_owned_stock_camp',candidate.anchor,setTaskProgress,{observedNode:{nodeId:candidate.targetNodeId,position:candidate.targetPosition},
          assertGraphActive:active,excludeBounds:[],graphCheckpoint:{get:()=>saved.graph,save:value=>{active();saved.graph=value;}}});}
        catch(error){if(!abandonChangedRecordedParent(saved,error))throw error;recordedTransportProgress=true;trip=live().constructionReturn;break;}
        active();saved.returnConfirmed=true;recordedTransportProgress=true;
        recordTaskDiagnostic(task,'house_construction_recorded_transport_confirmed',{actual:toPlainPosition(bot.entity.position),targetNode:candidate.targetPosition,houseAccepted:false});
        if(bot.entity.position.distanceTo(destination)<=32)return;
        live().constructionReturnHistory=[...(live().constructionReturnHistory||[]).slice(-7),trip];trip=fresh();live().constructionReturn=trip;break;
      }
      const nearestEntry=[...candidates].sort((a,b)=>toVec3(a.entry).distanceTo(bot.entity.position)-toVec3(b.entry).distanceTo(bot.entity.position))[0];
      if(!recordedTransportProgress&&nearestEntry&&await recoverHouseLocalRoute(task,nearestEntry.entry,Math.min(deadline,Date.now()+20000))){
        active();live().constructionReturnHistory=[...(live().constructionReturnHistory||[]).slice(-7),trip];live().constructionReturn=fresh();
        recordTaskDiagnostic(task,'house_construction_connector_local_progress',{actual:toPlainPosition(bot.entity.position),entry:nearestEntry.entry,recordedEntryReached:false});
        throw Object.assign(Error('已实际开辟局部返屋通道，继续重新验证运输入口'),{code:'house_construction_return_incomplete'});
      }
      const hint=blueprint.blocks.filter(s=>owned.has(s.id)&&matchesFurnishedHouseBlock(bot.blockAt(toVec3(s.position)),s))
        .sort((a,b)=>toVec3(a.position).distanceTo(destination)-toVec3(b.position).distanceTo(destination))[0];
      if(!hint)throw Object.assign(Error('没有重新观察到施工地点的自有方块，不能虚报返屋'),{code:'house_construction_target_unobserved'});
      const explore=extra=>exploreHouseSurfaceGraph(task,'house_owned_stock_camp',trip.anchor,setTaskProgress,{
        assertGraphActive:active,excludeBounds:[],ownedConstructionTarget:{position:hint.position,item:hint.item},
        graphCheckpoint:{get:()=>trip.graph,save:value=>{active();trip.graph=value;}},...extra});
      const actual=bot.entity.position.floored(),current=trip.graph?.nodes?.[trip.graph.current]?.position;
      if(current&&!trip.graph.nodes[`${actual.x},${actual.y},${actual.z}`]&&!trip.graph.pendingWater&&!trip.graph.pendingDryTrail){
        const rejoined=await require('./minecraft/houseCampRejoin').rejoinOwnedCampRoute({assertActive:active,deadline,target:current,
          position:()=>toPlainPosition(bot.entity.position),recover:(goal,budget)=>recoverHouseLocalRoute(task,goal,budget),
          rejoin:()=>explore({returnToAnchor:true,returnToCurrentOnly:true,rejoinInterruptedSuffix:true,via:[current]})});
        if(!rejoined){active();if(!naturalWalkingFoot(bot,bot.entity.position.floored())||!hasGroundedBodySupport(bot))throw Object.assign(Error('施工返程新起点未落稳'),{code:'house_construction_origin_unconfirmed'});
          live().constructionReturnHistory=[...(live().constructionReturnHistory||[]).slice(-7),trip];trip=fresh();live().constructionReturn=trip;}
      }
      for(let legs=0;legs<24&&bot.entity.position.distanceTo(destination)>20;legs++){
        active();if(Date.now()>=deadline)throw Object.assign(Error('施工返程达到原有限时限'),{code:'house_construction_return_timeout'});
        const result=await explore({});if(!result?.moved&&result?.reason!=='finite_attempt_batch_failed')break;
      }
      active();if(bot.entity.position.distanceTo(destination)>24)throw Object.assign(Error('施工返程尚未实际接近房屋'),{code:'house_construction_return_incomplete'});
      recordTaskDiagnostic(task,'house_construction_return_observed',{actual:toPlainPosition(bot.entity.position),target:toPlainPosition(destination),houseAccepted:false});
    });
  }

  async function furnishedHouseMoveTo(position, range = 0.8) {
    const target = toVec3(position);
    const bot = ensureBotReady();
    await returnToHouseConstruction(target);checkTaskSignal();
    await furnishedHouseReach(target, (feet) => Math.hypot(feet.x - target.x - 0.5, feet.z - target.z - 0.5) <= range &&
      Math.abs(feet.y - target.y) <= 1.1, "小屋通路");
    checkTaskSignal();
    if (!bot.entity.onGround) throw Object.assign(new Error("小屋通路尚未落稳"), { code: "surface_not_grounded" });
  }

  async function placeFurnishedHouseBlock(spec, onConfirmed) {
    const bot = ensureBotReady();
    const target = toVec3(spec.position);
    const expected = [spec, ...(spec.derivedBlocks || [])];
    const confirmed = () => expected.every((entry) => matchesFurnishedHouseBlock(bot.blockAt(toVec3(entry.position)), entry));
    const waitForConfirmation = async () => {
      const deadline = Date.now() + 1200;
      while (Date.now() < deadline && !confirmed()) {
        checkTaskSignal();
        await sleep(50);
      }
      checkTaskSignal();
      if (!confirmed()) throw Object.assign(new Error(`放置 ${spec.item} 后本体或派生方块状态未确认`), { code: "house_state_mismatch" });
    };
    if (matchesFurnishedHouseBlock(bot.blockAt(target), spec)) return waitForConfirmation();
    const verticalOnly = ["white_bed", "oak_door", "torch", "oak_log"].includes(spec.item);
    const directions = verticalOnly ? [new Vec3(0, -1, 0)] :
      [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
    const anchors = directions.map((direction) => ({ block: bot.blockAt(target.plus(direction)), face: direction.scaled(-1) }))
      .filter(({ block }) => block && block.boundingBox === "block" && (block.shapes || []).length &&
        !SURFACE_HAZARDS.has(block.name) && block.getProperties?.().waterlogged !== true);
    if (!anchors.length) throw Object.assign(new Error(`放置 ${spec.id} 尚无邻接支撑`), { code: "house_no_anchor" });
    const occupied = [target];
    if (spec.item === "white_bed") occupied.push(target.offset(0, 0, -1));
    if (spec.item === "oak_door") occupied.push(target.offset(0, 1, 0));
    for (const cell of occupied) {
      const existing = bot.blockAt(cell);
      if (!existing || !isReplaceableBlock(existing) || SURFACE_HAZARDS.has(existing.name)) {
        throw Object.assign(new Error(`家具放置格 ${cell} 被 ${existing?.name || "未知方块"} 占用`), { code: "house_state_mismatch" });
      }
    }
    let anchor;
    let lastError;
    for (const candidate of anchors) {
      const facePoint = candidate.block.position.offset(0.5 + candidate.face.x * 0.5, 0.5 + candidate.face.y * 0.5, 0.5 + candidate.face.z * 0.5);
      const goal = bot.world?.getBlock && bot.world?.raycast ? new goals.GoalPlaceBlock(target, bot.world,
        { range: 4.5, faces: [candidate.face.scaled(-1)] }) : null;
      const canAct = (feet, margin = 0) => occupied.every((cell) => !placementIntersectsPlayer(cell, feet, margin)) &&
        feet.offset(0, Number(bot.entity.eyeHeight) || 1.62, 0).distanceTo(facePoint) <= 4.5 &&
        (!goal || goal.getFaceAndRef(feet.offset(0, Number(bot.entity.eyeHeight) || 1.62, 0)) !== null);
      try {
        await furnishedHouseReach(target, canAct, `放置 ${spec.item}`, (feet) => canAct(feet, 0.35));
        anchor = candidate;
        break;
      } catch (error) {
        checkTaskSignal();
        if (error.code !== "placement_no_safe_stance") throw error;
        lastError = error;
      }
    }
    if (!anchor) throw lastError;
    const item = findInventoryItem([spec.item]);
    if (!item) throw Object.assign(new Error(`建房材料不足：${spec.item}`), { code: "house_materials_missing" });
    await equipInventoryItem(item);
    checkTaskSignal();
    let facing = spec.properties?.facing;
    if (["chest", "furnace"].includes(spec.item) && facing) {
      facing = { north: "south", south: "north", east: "west", west: "east" }[facing];
    }
    const yaw = { north: 0, south: Math.PI, east: -Math.PI / 2, west: Math.PI / 2 }[facing];
    await physicalPlaceBlock(anchor.block, anchor.face, target, spec.item, {
      onPlaced: onConfirmed, ...(yaw != null ? { yaw, pitch: 0 } : {}), placementOptions: {
        forceLook: yaw != null ? "ignore" : true, half: "bottom", swingArm: "right",
      },
    });
    await waitForConfirmation();
  }

  function furnishedHouseDigAvoidsSupport(target, feet) {
    const bot = ensureBotReady();
    if (placementIntersectsPlayer(target, feet)) return false;
    const half = (Number(bot.entity.width) || 0.6) / 2;
    if (feet.x + half <= target.x || feet.x - half >= target.x + 1 ||
        feet.z + half <= target.z || feet.z - half >= target.z + 1) return true;
    return !(bot.blockAt(target)?.shapes || []).some((shape) => Math.abs(feet.y - target.y - shape[4]) < 0.07);
  }

  async function breakFurnishedHouseBlock(position, options = {}) {
    const bot = ensureBotReady();
    const target = toVec3(position);
    let block = bot.blockAt(target);
    if (!block || block.name === "air") return;
    const canDigFrom = (feet) => {
      if (Number.isFinite(options.maxFeetY) && feet.y > options.maxFeetY + 0.07) return false;
      if (!furnishedHouseDigAvoidsSupport(target, feet)) return false;
      return require("./minecraft/houseDigSight").canSeeHouseDigTarget(bot,target,feet);
    };
    if(!options.noMove)await furnishedHouseReach(target, canDigFrom, `拆除 ${block.name}`);
    checkTaskSignal();
    block = bot.blockAt(target);
    if (!block || block.name === "air") return;
    await equipBestTool(block);
    checkTaskSignal();
    await waitForSurfaceGround("拆除脚手架");
    if (!furnishedHouseStandingSafely(bot.entity.position) || !canDigFrom(bot.entity.position) || !bot.canDigBlock(block)) {
      throw Object.assign(new Error(`拆除 ${block.name} 会失去脚下支撑或当前无法触达`), { code: "house_unsafe_dig" });
    }
    options.beforeDig?.();
    await physicalDigBlock(block, block.displayName || block.name);
    checkTaskSignal();
  }

  function createFurnishedHouseSiteSearch(profile) {
    const bot = ensureBotReady(), ownerTask = currentTask, context = getExecutionContext() || {};
    const client = bot._client, token = context.token || getActiveCancellationToken();
    const generation = ownerTask?.executionGeneration, lease = getCurrentMovementLease();
    const frame = naturalXPStepWatchdogFrames.get(ownerTask);
    const isOwnerCurrent = () => currentBot === bot && bot._client === client && currentTask === ownerTask &&
      ownerTask.executionGeneration === generation && ownerTask.movementLease === lease &&
      (ownerTask.cancellationToken || runtimeToken) === token && !token?.cancelled && !token?.pauseRequested &&
      (!lease || isMovementLeaseActive(lease) || activeHouseSurfaceNavigationMove?.task === ownerTask &&
        activeHouseSurfaceNavigationMove.lease === lease && isHouseSurfaceDefenseCurrent(activeHouseSurfaceNavigationMove));
    const isOwnerContext = () => {
      const now = getExecutionContext();
      // Native physics timers predate task AsyncLocalStorage. Their captured
      // graph callbacks use the still-current real step/actor capability;
      // an explicitly different task context never borrows that capability.
      if (!now) return Boolean(frame && naturalXPStepWatchdogFrames.get(ownerTask) === frame && isOwnerCurrent() &&
        frame.stepIndex === ownerTask.currentStepIndex && frame.step === ownerTask.plan?.steps?.[frame.stepIndex]);
      const defense = activeSurvivalInterrupt;
      const capturedDefenseContext = defense && now.movementLease === defense.lease &&
        defense.previousLease === lease && defense.surfaceMove === activeHouseSurfaceNavigationMove &&
        defense.surfaceMove?.task === ownerTask && isHouseSurfaceDefenseCurrent(defense.surfaceMove);
      return now.task === context.task && now.token === context.token &&
        now.runGeneration === context.runGeneration && (now.movementLease === context.movementLease || capturedDefenseContext);
    };
    const assertOwner = () => {
      token?.throwIfRequested(); checkTaskSignal();
      if (!isOwnerCurrent() || !isOwnerContext()) throw createAbortError("movement_preempted");
    };
    const readRemainingMs = () => {
      assertOwner();
      if (!frame || naturalXPStepWatchdogFrames.get(ownerTask) !== frame || frame.task !== ownerTask || frame.bot !== bot ||
          frame.client !== client || frame.token !== token || frame.lease !== lease || frame.generation !== generation ||
          frame.stepIndex !== ownerTask.currentStepIndex || frame.step !== ownerTask.plan?.steps?.[frame.stepIndex] ||
          frame.step?.skill !== "build_furnished_house_phase" || (frame.step.args?.profile || "cottage") !== profile ||
          !Number.isSafeInteger(frame.startedAt) || !Number.isSafeInteger(frame.deadline) ||
          !Number.isSafeInteger(frame.hardTimeoutMs) || frame.hardTimeoutMs <= 0 ||
          frame.deadline !== frame.startedAt + frame.hardTimeoutMs || Date.now() < frame.startedAt) {
        throw Object.assign(new Error("选址探索没有原真实步骤时限，保留任务"), { code: "house_site_search_step_budget_pending" });
      }
      return Math.max(0, frame.deadline - Date.now());
    };
    const resource = `house_site_${profile}`;
    const graphCheckpoint = {
      get: () => ownerTask.siteSearch?.graph || null,
      save: value => {
        assertOwner();
        if (ownerTask.siteSearch?.kind !== "loaded_natural_house_site_search" || ownerTask.siteSearch.profile !== profile ||
            ownerTask.siteSearch.ownerIdentity?.taskId !== ownerTask.taskId) {
          throw Object.assign(new Error("选址图与原任务不符"), { code: "house_site_search_checkpoint_changed" });
        }
        ownerTask.siteSearch = { ...ownerTask.siteSearch, graph: value };
      },
    };
    const report = (text, facts) => {
      assertOwner(); setTaskProgress(text); recordTaskHeartbeat(ownerTask, { actionState: "moving", clearRecoveryReason: true });
      if (facts) recordTaskDiagnostic(ownerTask, "house_site_search_actual_observation", facts);
    };
    const travel = (args, options) => exploreHouseSurfaceGraph(ownerTask, resource, args.anchor, report,
      { ...options, excludeBounds: args.excludeBounds, graphCheckpoint, assertGraphActive: args.assertActive });
    const provider = createNaturalHouseSiteSearch({
      inspectHouseSite: require('./minecraft/naturalHouseSites').inspectCreatableHouseSite,
      recoverTimedOutLeg:(error,budget)=>require('./minecraft/houseSiteTimeoutRecovery').recoverTimedOutSiteLeg({
        getBot:()=>currentBot,assertActive:assertOwner,getCP:graphCheckpoint.get,saveCP:graphCheckpoint.save,
        isMotorIdle:()=>activeHouseSurfaceNavigationMove===null&&activeSurvivalInterrupt===null,
        record:facts=>recordTaskDiagnostic(ownerTask,'house_site_expired_leg_grounded_observation',facts),
      },error,budget),
      getBot: () => { assertOwner(); return bot; }, assertActive: assertOwner, isOwnerCurrent, isOwnerContext,
      ownerIdentity: { taskId: ownerTask.taskId, generation }, readRemainingMs,
      isOwnedDefenseActive:()=>activeHouseSurfaceNavigationMove?.task===ownerTask
        &&activeHouseSurfaceNavigationMove.lease===lease&&isHouseSurfaceDefenseCurrent(activeHouseSurfaceNavigationMove),
      getCP: () => ownerTask.siteSearch || null,
      saveCP: value => {
        assertOwner();
        ownerTask.siteSearch = { ...value, graph: ownerTask.siteSearch?.graph ?? value.graph };
      },
      getGraphCP: graphCheckpoint.get,
      initializeGraph: args => travel(args, args.nodeId ? { observedNode: { nodeId: args.nodeId, position: args.exactPosition } }
        : { returnToAnchor: true, via: [] }),
      next: args => travel(args, {}),
      travelObserved: args => travel(args, { observedNode: { nodeId: args.nodeId, position: args.exactPosition } }),
      report,
    });
    return { provider, assertOwner };
  }

  async function restoreHouseWorkNutrition(ownerTask) {
    const bot=ensureBotReady(),context=getExecutionContext()||{},client=bot._client,generation=ownerTask.executionGeneration;
    const deadline=Date.now()+360000,wasFoodSupplyRunning=foodSupplyRunning;
    const active=()=>{context.token?.throwIfRequested();checkTaskSignal();
      if(currentBot!==bot||bot._client!==client||currentTask!==ownerTask||ownerTask.executionGeneration!==generation)
        throw createAbortError('movement_preempted');
      if(Date.now()>=deadline)throw Object.assign(Error('自然补给达到原六分钟时限'),{code:'house_bootstrap_food_unavailable'});};
    const stopNativeProgress=typeof client?.on==='function'&&typeof client?.removeListener==='function'
      ?require('./minecraft/houseNutritionSignals').observeNativeNutritionProgress(client,{
        initialHealth:bot.health,initialFood:bot.food,
        isOwnerCurrent:()=>currentBot===bot&&bot._client===client&&currentTask===ownerTask&&ownerTask.executionGeneration===generation
          &&ownerTask.cancellationToken===context.token&&!context.token?.cancelled&&!context.token?.pauseRequested
          &&ownerTask.status===TaskState.RUNNING&&Date.now()<deadline,
        onProgress:facts=>{recordTaskHeartbeat(ownerTask,{actionState:'acting',checkpoint:{kind:'native_nutrition_recovery',...facts},clearRecoveryReason:true});
          recordTaskDiagnostic(ownerTask,'house_native_nutrition_progress',facts);},
      }):()=>{};
    try {
      foodSupplyRunning=true;
      await withSurfaceResourceMovements(async()=>{
        await alignHouseResourceGraphOrigin(ownerTask,Math.min(deadline,Date.now()+12000),context.houseResourceExclusionBounds||[]);active();
        for(let attempt=0;attempt<6&&(bot.health<16||bot.food<18);attempt++){
          active();if(bot.food<20)await ensureHouseBootstrapFood(20,{deadline,nutritionFirst:true});active();
          const recovery=await prepareHouseRecovery({targetHealth:16,assertActive:active,
            observe:()=>({health:bot.health,food:bot.food,safe:hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry,threat:immediateFoodThreat(bot)}),
            hasFood:()=>Boolean(selectBootstrapFood(bot.inventory.items(),{health:bot.health,food:bot.food})),
            eat:()=>ensureHouseBootstrapFood(20,{deadline,nutritionFirst:true}),defend:()=>settleSurvivalDefense('natural_work_nutrition_recovery'),
            provisionMinimumHealth:()=>6,canProvision:()=>true,
            onProgress:facts=>recordTaskDiagnostic(ownerTask,'house_natural_work_recovery',facts)});
          active();if(!recovery.needsProvision&&bot.health>=16&&bot.food>=18)break;
        }
        if(bot.health<16||bot.food<18)throw Object.assign(Error('实际口粮或生命尚未达到原工作门槛'),{code:'house_bootstrap_food_unavailable'});
      },{deadline});active();
    }finally{stopNativeProgress();foodSupplyRunning=wasFoodSupplyRunning;}
  }

  async function chooseFurnishedHouseAnchor(profile) {
    const task=currentTask;
    const carriedWood=ensureBotReady().inventory.items().reduce((n,i)=>n+(i.name.endsWith('_log')?4*i.count:i.name.endsWith('_planks')?i.count:0),0);
    if(profile==='cottage'&&!task.materialSupply&&!task.siteSearch&&carriedWood<12){
      const captured=getExecutionContext()||{},bot=ensureBotReady(),client=bot._client,generation=task.executionGeneration;
      const active=()=>{captured.token?.throwIfRequested();checkTaskSignal();
        if(currentTask!==task||currentBot!==bot||bot._client!==client||task.executionGeneration!==generation)
          throw createAbortError('movement_preempted');};
      await executionContextStorage.run({...captured,selfSupplyOnly:true,housePreSiteBootstrap:true},async()=>{
        if(!task.startupWood?.graph?.pendingWater)await waitForSurfaceGround('选址前采集启动木材');
        active();
        if(bot.health<16||bot.food<18){await restoreHouseWorkNutrition(task);active();}
        await require('./minecraft/housePreSiteWood').prepareHousePreSiteWood({getBot:()=>currentBot,assertActive:active,
          countLogs:getTotalLogCount,gather:amount=>bootstrapWoodLogs(amount,48,{safeHouseBootstrap:true}),
          save:record=>{active();task.startupWood={...task.startupWood,...record};},
          record:record=>recordTaskDiagnostic(task,'house_pre_site_wood_prepared',record)});
      });active();
    }
    const { provider, assertOwner } = createFurnishedHouseSiteSearch(profile);
    const selected = await provider.search({ profile }); assertOwner();
    if (selected.confirmed !== true) throw Object.assign(new Error("真实已加载选址与营地未确认"), { code: "house_no_safe_site" });
    recordTaskDiagnostic(currentTask, "house_site_search_selected", {
      anchor: selected.anchor, camp: selected.camp.anchor, actual: selected.actual, diagnostics: selected.diagnostics,
      materialOrOwnedPlacementCredit: false,
    });
    return selected.anchor;
  }

  function houseConstructionMaterialBounds(blueprint) {
    if (blueprint.workBounds) return { ...blueprint.workBounds, minY: blueprint.workBounds.minY - 5, maxY: blueprint.workBounds.maxY + 2 };
    const cells = [...blueprint.blocks, ...blueprint.scaffold].map(spec => spec.position);
    return { ...blueprint.bounds, minY: blueprint.anchor.y - 5, maxY: blueprint.bounds.maxY + 2,
      minX: Math.min(blueprint.bounds.minX, ...cells.map(p => p.x)) - 1,
      maxX: Math.max(blueprint.bounds.maxX, ...cells.map(p => p.x)) + 1,
      minZ: Math.min(blueprint.bounds.minZ, ...cells.map(p => p.z)) - 1,
      maxZ: Math.max(blueprint.bounds.maxZ, ...cells.map(p => p.z)) + 1 };
  }

  async function withCurrentHouseMaterialRuntime(operation) {
    const ownerTask = getExecutionContext()?.task || currentTask;
    const material = ownerTask?.materialSupply;
    const blueprint = ["medieval_castle", "riverside_villa"].includes(material?.profile)
      ? createEstateBlueprint(material.houseAnchor, { profile: material.profile })
      : createFurnishedHouseBlueprint(material?.houseAnchor, { profile: material?.profile || "cottage" });
    const source=createHouseMaterialRuntime(ownerTask, blueprint, [houseConstructionMaterialBounds(blueprint)]);
    return source.withContext(()=>operation(source));
  }

  async function prepareFurnishedHouseMaterials(requirements, options) {
    const blueprint = createFurnishedHouseBlueprint(options.anchor, { profile: options.profile || "cottage" });
    const ownerTask = getExecutionContext()?.task || currentTask;
    const planned = { ...requirements };
    if (options.reserveFunctionalInputs && blueprint.profile === 'cottage' && ownerTask.materialSupply?.materialSource === 'self_gathered') {
      for (const [name, count] of Object.entries(require('./minecraft/houseFurnitureUse').INPUTS)) planned[name] = (planned[name] || 0) + count;
    }
    const result=await createHouseMaterialRuntime(ownerTask, blueprint, [houseConstructionMaterialBounds(blueprint)]).run(planned,{requireFullEquipment:options.requireFullEquipment===true});
    await returnFieldHouseWood(ownerTask);
    return result;
  }

  async function returnFieldHouseWood(ownerTask){
    const field=ownerTask.materialSupply?.fieldPlankSearch;
    if(!field?.graph||field.returnConfirmed===true)return;
    const bot=ensureBotReady();
    const current=field.graph.nodes?.[field.graph.current]?.position;
    if(!field.graph.pendingWater&&!field.graph.pendingDryTrail
      &&await followHouseNativeDryConnector(ownerTask,field.anchor,Date.now()+60000)){
      checkTaskSignal();field.returnConfirmed=true;
      recordTaskDiagnostic(ownerTask,'house_field_wood_return_confirmed',{actual:toPlainPosition(bot.entity.position),anchor:field.anchor,source:'fresh_native_dry_return',oldTraversalCredit:false});
      return;
    }
    await exploreHouseSurfaceGraph(ownerTask,'house_field_wood',field.anchor,setTaskProgress,{
      returnToAnchor:true,rejoinInterruptedSuffix:true,via:current?[current]:[],excludeBounds:[],assertGraphActive:checkTaskSignal,
      graphCheckpoint:{get:()=>ownerTask.materialSupply.fieldPlankSearch.graph,
        save:value=>{checkTaskSignal();ownerTask.materialSupply.fieldPlankSearch.graph=value;}}});
    checkTaskSignal();
    if(bot.entity.position.distanceTo(toVec3(field.anchor))>2.5||!hasGroundedBodySupport(bot))
      throw Object.assign(Error('补木后尚未实际返回施工附近'),{code:'house_field_return_unconfirmed'});
    field.returnConfirmed=true;
    recordTaskDiagnostic(ownerTask,'house_field_wood_return_confirmed',{actual:toPlainPosition(bot.entity.position),anchor:field.anchor});
  }

  async function traverseHouseSurfaceWater(ownerTask, resource, route, context, assertActive, options = {}) {
    assertActive();
    discardForeignHouseWaterFrame();
    if (activeHouseSurfaceWater) throw Object.assign(new Error("上一次跨水操作尚未收口"), { code: "house_surface_water_busy" });
    const bot = ensureBotReady(), client = bot._client, lease = getCurrentMovementLease();
    const generation = ownerTask.executionGeneration, token = context.token || getActiveCancellationToken();
    const surfaceOnly = route?.schema === 1 && route.kind === "loaded_surface_swim" && route.depth === "surface_only";
    const shallow = route?.schema === 1 && route.kind === "loaded_source_water_wade" && route.depth === 1;
    if (!surfaceOnly && !shallow) throw Object.assign(new Error("跨水路线类型没有对应的原生脚本"), { code: "house_surface_transport_invalid" });
    const cleanupTimeoutMs = surfaceOnly
      ? Math.min(120000, route.retreatTimeoutMs ?? 10000 + route.width * 1500) + 5000 : 35000;
    const previousProfile = bot.pathfinder.movements;
    let waterProfile = null, resolveSettlement;
    const frame = { bot, client, task: ownerTask, generation, lease, resource, route:JSON.parse(JSON.stringify(route)), cleanupTimeoutMs, closed: false, session: null,
      settled: new Promise(resolve => { resolveSettlement = resolve; }) };
    frame.resolveSettlement = resolveSettlement;
    const identityOwner = () => !frame.closed && currentBot === bot && bot._client === client && currentTask === ownerTask
      && ownerTask.executionGeneration === generation && ownerTask.movementLease === lease
      && isMovementLeaseActive(lease) && isBotConnectionWritable();
    const physicalOwner = () => identityOwner() && (bot.pathfinder.movements === (waterProfile || previousProfile)
      || frame.session && !frame.session.isActive() && !frame.session.isHolding() && bot.pathfinder.movements === previousProfile);
    frame.isPhysicalOwner = physicalOwner;
    const createTraversal = surfaceOnly ? createNaturalSurfaceSwim : createNaturalShallowWaterTraversal;
    const session = createBankAlignedWaterSession({ createAlignment: createDryBankAlignment, createTraversal,
      validateRoute: surfaceOnly ? validateSurfaceRoute : validateShallowWaterRoute, assertActive,
      getBot: () => currentBot, getOwner: () => frame, recoveryReturn: options.recoveryReturn === true
        ||options.survivalProvisioning===true&&foodSupplyRunning&&Boolean(context.houseSelfSupply)&&!immediateFoodThreat(bot),
      isOwnerCurrent: captured => captured === frame && physicalOwner(), Vec3, Movements, GoalBlock: goals.GoalBlock,
      record: (type, facts) => {
        if (["water_native_started", "surface_swim_started"].includes(type)) waterProfile = bot.pathfinder.movements;
        if (!physicalOwner()) return;
        if (token?.cancelled || token?.pauseRequested || [TaskState.PAUSED, TaskState.CANCELLED].includes(ownerTask.status)) {
          session.requestCancel(token?.cancelled ? "cancelled" : "paused");
        }
        recordTaskDiagnostic(ownerTask, `house_surface_${type}`, { resource, ...facts });
        recordTaskHeartbeat(ownerTask, { actionState: ownerTask.status === TaskState.RUNNING ? "moving" : "recovering" });
      } });
    frame.session = session; activeHouseSurfaceWater = frame;
    try {
      recordTaskDiagnostic(ownerTask, "house_surface_transport_entry", { resource, route,
        position: toPlainPosition(bot.entity.position), velocity: toPlainPosition(bot.entity.velocity),
        onGround: bot.entity.onGround === true, isInWater: bot.entity.isInWater === true,
        isInLava: bot.entity.isInLava === true, health: bot.health, food: bot.food });
      const result = await executionContextStorage.run({ ...context, houseSurfaceResource: resource }, () => session.traverse(route));
      assertActive(); return result;
    } catch (error) {
      if (!physicalOwner()) error.houseWaterForeignActor = true;
      if (/^(water_|surface_swim_|dry_bank_)/.test(String(error.code || ""))) {
        error.originCode = error.code; error.code = `house_surface_${error.code}`;
      }
      throw error;
    } finally {
      const holding = session.isHolding();
      resolveSettlement({ holding, actualDry: currentBot === bot && !bot.entity.isInWater && !bot.entity.isInLava && hasGroundedBodySupport(bot),
        capturedTaskCurrent: currentTask === ownerTask && ownerTask.executionGeneration === generation,
        foreignLease: Boolean(activeMovementLease && activeMovementLease !== lease) });
      if (!holding) {
        frame.closed = true;
        if (activeHouseSurfaceWater === frame) activeHouseSurfaceWater = null;
      } else discardForeignHouseWaterFrame();
    }
  }

  async function settleHouseSurfaceWater(task, reason) {
    const frame = activeHouseSurfaceWater;
    if (!frame || frame.task !== task) return { applicable: false };
    if (!frame.isPhysicalOwner()) {
      discardForeignHouseWaterFrame();
      return { applicable: true, foreignLease: true,
        capturedTaskCurrent: currentTask === task && task.executionGeneration === frame.generation };
    }
    frame.session.requestCancel(reason);
    let outcome;
    try { outcome = await withTimeout(frame.settled, frame.cleanupTimeoutMs, "跨水暂停退岸尚未确认"); }
    catch (error) {
      frame.cleanupPending = true;
      recordTaskDiagnostic(task, "house_surface_water_cleanup_pending", { code: error.code, message: error.message });
      outcome = { holding: true, actualDry: false, capturedTaskCurrent: currentTask === task && task.executionGeneration === frame.generation,
        foreignLease: !frame.isPhysicalOwner() };
    }
    return { applicable: true, ...outcome };
  }

  function markHouseWaterPausePending(task, cancelRequested) {
    task.status = TaskState.PAUSED; task.cancelRequested = cancelRequested;
    task.errorCode = "house_surface_water_cleanup_pending";
    task.error = "跨水停止后尚未确认退回干岸，正在保持安全站位";
    setTaskTurnPhase(task, "paused", { progressText: task.error });
    autonomousState.running = false; autonomousState.suppressedByForeground = true;
    setAgentMode(TaskState.PAUSED); broadcastTaskStatus(true); broadcastContextSnapshot();
  }

  function revokeHouseWaterConnection() {
    const frame = activeHouseSurfaceWater;
    if (!frame) return;
    frame.closed = true;
    frame.session.release();
    frame.resolveSettlement({ holding: false, actualDry: false, foreignLease: true,
      capturedTaskCurrent: false, underlyingPromiseSettled: false });
    if (activeHouseSurfaceWater === frame) activeHouseSurfaceWater = null;
  }

  function discardForeignHouseWaterFrame() {
    const frame = activeHouseSurfaceWater;
    if (!frame || frame.isPhysicalOwner()) return false;
    // The foreign actor already owns all physical state. Release only the old
    // listener and reference; closing first prevents release() writing controls.
    revokeHouseWaterConnection();
    return true;
  }

  const inBounds = (p, bounds) => bounds.some(b => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && p.z >= b.minZ && p.z <= b.maxZ);

  async function alignHouseResourceGraphOrigin(ownerTask,deadline,excludeBounds=[]) {
    const bot=ensureBotReady(),context=getExecutionContext()||{},client=bot._client,generation=ownerTask.executionGeneration;
    const active=()=>{context.token?.throwIfRequested();checkTaskSignal();
      if(currentBot!==bot||bot._client!==client||currentTask!==ownerTask||ownerTask.executionGeneration!==generation)
        throw createAbortError('movement_preempted');};
    // Await unknown spawn physics flags/cells; never infer safe defaults.
    const observationDeadline=Math.min(deadline,Date.now()+1200);
    while(Date.now()<observationDeadline&&(typeof bot.entity.isInWater!=='boolean'||typeof bot.entity.isInLava!=='boolean'
      ||typeof bot.entity.onGround!=='boolean'||inspectSurfaceBody(bot).cells.some(c=>!c.loaded))){
      active();await sleep(20);
    }
    active();
    if(bot.entity.onGround===false&&inspectSurfaceBody(bot).dry){await waitForSurfaceGround('资源图对齐');active();}
    if(naturalWalkingFoot(bot,bot.entity.position.floored())&&hasGroundedBodySupport(bot))return;
    recordTaskDiagnostic(ownerTask,'house_graph_origin_alignment_observation',{actual:toPlainPosition(bot.entity.position),
      onGround:bot.entity.onGround,isInWater:bot.entity.isInWater,isInLava:bot.entity.isInLava,
      body:inspectSurfaceBody(bot),nativeSupport:hasGroundedBodySupport(bot),foot:naturalWalkingFoot(bot,bot.entity.position.floored())});
    try{await withSurfaceResourceMovements(()=>require('./minecraft/houseGraphOriginAlignment').alignHouseGraphOrigin({
      getBot:()=>currentBot,assertActive:active,goto:(goal,budget)=>houseSurfacePathfinderGoto(goal,budget,{deadline,actualOriginAlignment:true}),
      record:facts=>recordTaskDiagnostic(ownerTask,facts.phase==='native_probe'?'house_graph_origin_native_probe':'house_surface_graph_origin_aligned',facts),
    },{deadline,excluded:p=>inBounds(p,excludeBounds)||houseResourcePositionExcluded(p)}),{deadline});}
    catch(error){
      active();
      if(!houseOriginDefenseRelocations.has(error)||Date.now()>=deadline||!hasGroundedBodySupport(bot)
        ||!naturalWalkingFoot(bot,bot.entity.position.floored())||!inspectSurfaceBody(bot).dry
        ||!isMovementLeaseActive(context.movementLease))throw error;
      recordTaskDiagnostic(ownerTask,'house_graph_origin_defense_relocated',{actual:toPlainPosition(bot.entity.position),
        originalGoalReached:false,graphNodeCredit:false,originalDeadline:deadline,requiredReturnToOldAlignment:false});
    }
    active();
  }

  async function exploreHouseSurfaceGraph(ownerTask, resource, anchor, report, options = {}) {
    const bot = ensureBotReady();
    const legTimeoutMs = options.legTimeoutMs ?? 20000;
    if (!Number.isSafeInteger(legTimeoutMs) || legTimeoutMs < 600 || legTimeoutMs > 20000) {
      throw new TypeError("House surface leg deadline must be a finite 600..20000 milliseconds");
    }
    const context = getExecutionContext() || {};
    const token = context.token || getActiveCancellationToken();
    const generation = ownerTask.executionGeneration;
    const client = bot._client;
    const lease = getCurrentMovementLease();
    const isOwnerCurrent = () => currentBot === bot && bot._client === client && currentTask === ownerTask && ownerTask.executionGeneration === generation
      && (ownerTask.cancellationToken || runtimeToken) === token
      && !token?.cancelled && !token?.pauseRequested && (!lease || isMovementLeaseActive(lease) ||
        activeHouseSurfaceNavigationMove?.task === ownerTask && activeHouseSurfaceNavigationMove.lease === lease &&
          isHouseSurfaceDefenseCurrent(activeHouseSurfaceNavigationMove));
    const assertActive = () => {
      if ([TaskState.PAUSED, TaskState.CANCELLED].includes(ownerTask.status)) {
        throw createAbortError(ownerTask.status === TaskState.PAUSED ? "paused" : "cancelled");
      }
      token?.throwIfRequested();
      options.assertGraphActive?.();
      const defenseFailure = getHouseSurfaceDefenseFailure();
      if (defenseFailure) throw defenseFailure;
      if (!isOwnerCurrent()) {
        recordTaskDiagnostic(ownerTask,'house_graph_owner_preempted',{
          resource,capturedLease:lease?.token,activeLease:activeMovementLease?.token,
          activeKind:activeMovementLease?.kind,taskLease:ownerTask.movementLease?.token,
          botMatches:currentBot===bot,clientMatches:bot._client===client,
          generationMatches:ownerTask.executionGeneration===generation,tokenMatches:ownerTask.cancellationToken===token,
          defensePreviousLease:activeSurvivalInterrupt?.previousLease?.token,defenseFinished:activeSurvivalInterrupt?.finished});
        throw createAbortError("movement_preempted");
      }
      checkTaskSignal();
    };
    let pendingBoundaryDefense=null,graphQueryState=null;
    const readyHouseGraph=async()=>{
      let defended=false;
      for(let chain=0;chain<8;chain++){
      if(chain===0&&graphQueryState?.()?.current&&!activeSurvivalInterrupt&&ownerTask.materialSupply?.materialSource==='self_gathered'){
        const preflight=maybeHandleSurvivalCritical('house_graph_query_preflight');preflight.catch(()=>{});
        if(!activeSurvivalInterrupt)await preflight;
      }
      const frame=activeSurvivalInterrupt;
      if(!(frame&&frame.bot===bot&&frame.client===client&&frame.task===ownerTask&&frame.runGeneration===generation
        &&(frame.workToken||frame.token)===token&&frame.previousLease===lease))break;
      {
        await settleSurvivalDefense('house_resource_graph_boundary');defended=true;
        if(frame.finished&&!frame.error&&frame.surfacePosition
          &&isSurvivalOwnerCurrent(frame)&&isMovementLeaseActive(lease))
          pendingBoundaryDefense={kind:'actual_owned_graph_boundary_defense',defenseOutcome:frame.creeperEscape?.confirmed===true?'escape_confirmed':'completed_owned_defense',from:{...(pendingBoundaryDefense?.from||frame.surfacePosition)},
            actual:toPlainPosition(bot.entity.position),observedAt:Date.now(),originalDeadline:Math.min(pendingBoundaryDefense?.originalDeadline??Infinity,frame.deadline),
            maximumDisplacement:32,maximumVerticalDisplacement:32,oldTargetReached:false};
      }
      if(isMovementLeaseActive(lease))break;
      }
      assertActive();return defended;
    };
    recordTaskDiagnostic(ownerTask,'house_graph_query_native_threats',{resource,actual:toPlainPosition(bot.entity.position),
      threats:Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&e.isValid!==false&&e.position
        &&e.position.distanceTo(bot.entity.position)<=32&&isThreateningMobEntity(e,bot.registry)).slice(0,16)
        .map(e=>({id:e.id,name:e.name,position:toPlainPosition(e.position),distance:e.position.distanceTo(bot.entity.position)}))});
    await readyHouseGraph();
    // Native get-to/look-at goals may settle while physics is still landing.
    // A failed resource approach is not permission to initialize a graph at
    // an airborne rounded coordinate. Wait for real support before any query
    // or registration, retaining the original task/generation/lease.
    if (bot.entity.onGround === false && bot.entity.isInWater === false && bot.entity.isInLava === false) {
      assertActive(); const before = toPlainPosition(bot.entity.position);
      await waitForSurfaceGround('资源图交接'); assertActive();
      recordTaskDiagnostic(ownerTask, 'house_surface_graph_handoff_grounded', { before, actual: toPlainPosition(bot.entity.position),
        onGround: bot.entity.onGround, supportConfirmed: hasGroundedBodySupport(bot), graphNodeCredit: false });
    }
    const graphCheckpoint = options.graphCheckpoint;
    if (graphCheckpoint && (!(resource==='survival_food'&&options.fieldFoodExploration===true)&&!/^(?:house_site_(?:cottage|enchanting_library)|house_camp_recovery_\d+|house_field_wood|house_startup_wood|house_owned_stock_camp)$/.test(resource) ||
        typeof graphCheckpoint.get !== "function" || typeof graphCheckpoint.save !== "function" ||
        typeof options.assertGraphActive !== "function")) {
      throw Object.assign(new Error("独立选址图接线无效"), { code: "house_site_search_graph_adapter_invalid" });
    }
    const getGraphCP = () => graphCheckpoint ? graphCheckpoint.get() : ownerTask.materialSupply?.surfaceGraphs?.[resource];
    graphQueryState=getGraphCP;
    const saveGraphCP = value => {
      assertActive();
      if (graphCheckpoint) { graphCheckpoint.save(value); return; }
      ownerTask.materialSupply = { ...ownerTask.materialSupply, activeSurfaceGraph: resource,
        surfaceGraphs: { ...ownerTask.materialSupply?.surfaceGraphs, [resource]: value } };
    };
    const exclusions = options.excludeBounds || [];
    const finderDeps = { getBot: () => ensureBotReady(), assertActive, Vec3, Movements, GoalBlock: goals.GoalBlock };
    const finder = createLoadedShallowWaterFinder(finderDeps);
    const surfaceFinder = createLoadedSurfaceSwimFinder(finderDeps);
    const excluded = p => exclusions.some(b => p && p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && p.z >= b.minZ && p.z <= b.maxZ);
    const observationNames = ["any_log","house_field_wood","house_startup_wood"].includes(resource)
      ? ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "pale_oak"].map(name => `${name}_log`)
      : resource==="sand"||/^(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/.test(resource) ? [resource] : [];
    const resourceMemory = observationNames.length ? createHouseObservedResourceMemory({
      getBot: () => ensureBotReady(), assertActive, isOwnerCurrent,
      getCP: () => resource==='house_startup_wood'?ownerTask.startupWood?.observedResources:ownerTask.materialSupply?.observedResources?.[resource],
      saveCP: value => { assertActive();
        if(resource==='house_startup_wood'){ownerTask.startupWood={...ownerTask.startupWood,observedResources:value};return;}
        ownerTask.materialSupply = { ...ownerTask.materialSupply,
          observedResources: { ...ownerTask.materialSupply?.observedResources, [resource]: value } }; },
      getGraphState: getGraphCP,
      isCandidateAllowed:block=>!isUnarmedHouseExplorer(bot,ownerTask)
        ||!isWoodBlockName(block.name)||require('./minecraft/houseUnarmedResourceSafety').unarmedResourceTargetSafe(bot,block.position),
      isExcludedPosition: position => excluded(position) || houseResourcePositionExcluded(position),
    }, { resource, names: observationNames }) : null;
    if (resourceMemory && !options.returnToAnchor && !options.observedNode) {
      const observation = resourceMemory.query(); assertActive();
      recordTaskDiagnostic(ownerTask, "house_surface_observed_resource_query", { resource, ...observation, actualMovementPerformed: false });
    }
    const graph = createHouseSurfaceGraph({
      ready:readyHouseGraph,
      resumeInterruptedPassage:async(error,budget)=>{
        const frame=error?.survivalInterrupt;
        if(!frame||frame.bot!==bot||frame.client!==client||frame.task!==ownerTask||frame.runGeneration!==generation
          ||(frame.workToken||frame.token)!==token||frame.previousLease!==lease)return false;
        if(!await resumeHouseResourceAfterSurvival(error,{deadline:budget.deadline,bot}))return false;
        if(frame.creeperEscape?.confirmed&&frame.surfacePosition)pendingBoundaryDefense={
          kind:'actual_owned_graph_boundary_defense',from:{...frame.surfacePosition},actual:toPlainPosition(bot.entity.position),
          observedAt:Date.now(),originalDeadline:budget.deadline,maximumDisplacement:32,maximumVerticalDisplacement:8.05,oldTargetReached:false};
        await readyHouseGraph();
        recordTaskDiagnostic(ownerTask,'house_passage_defense_resumed',{resource,originalDeadline:budget.deadline,
          actual:toPlainPosition(bot.entity.position),blockClearanceCredit:false});return true;
      },
      takeBoundaryDefenseRelocation:()=>{assertActive();const receipt=pendingBoundaryDefense;pendingBoundaryDefense=null;return receipt;},
      getBot: () => ensureBotReady(), assertActive, report, isMovementOwner: isOwnerCurrent,
      isMovementSuspended:()=>activeHouseSurfaceNavigationMove?.task===ownerTask
        &&activeHouseSurfaceNavigationMove.lease===lease&&isHouseSurfaceDefenseCurrent(activeHouseSurfaceNavigationMove),
      ...(resourceMemory ? {
        getObservedResourceTarget: () => resourceMemory.getTarget()||(resource==='house_field_wood'?resourceMemory.getHistoricalHint():null),
        onObservedResourceTargetBlocked: (target, facts) => resourceMemory.defer(target, facts),
        onObservedResourceApproach: facts => resourceMemory.observeApproach(facts),
      } : {}),
      ...(resource==='house_owned_stock_camp'&&options.ownedCombatCoverTarget?{
        getObservedResourceTarget:()=>{assertActive();const goal=options.ownedCombatCoverTarget;
          const owned=require('./minecraft/houseCombatMode').combatCover(ownerTask.materialSupply).some(s=>s.item===goal.item
            &&s.position.x===goal.position.x&&s.position.y===goal.position.y&&s.position.z===goal.position.z);
          if(!owned)return null;const block=bot.blockAt(toVec3(goal.position));
          if(block&&block.name!==goal.item&&!(goal.item==='dirt'&&block.name==='grass_block'))return null;
          return block?{kind:'native_loaded_block_observation',name:goal.item,position:{...goal.position},lastValidatedAt:Date.now(),purpose:'owned_combat_cleanup'}
            :{kind:'recorded_owned_station_hint',name:goal.item,position:{...goal.position},ownershipRecorded:true,purpose:'owned_combat_cleanup',currentPresence:'UNKNOWN',resourceArrival:'NOT_CONFIRMED'};},
      }:{}),
      ...(resource==='house_owned_stock_camp'&&options.ownedConstructionTarget?{
        getObservedResourceTarget:()=>{assertActive();const goal=options.ownedConstructionTarget,block=bot.blockAt(toVec3(goal.position));
          return block?.name===goal.item?{kind:'native_loaded_block_observation',name:goal.item,position:{...goal.position},lastValidatedAt:Date.now(),purpose:'construction_return',resourceArrival:'NOT_CONFIRMED'}:null;},
      }:{}),
      ...(resource==="house_owned_stock_camp"&&options.ownedStockTarget?{
        getObservedResourceTarget:()=>{
          assertActive();const target=options.ownedStockTarget,block=bot.blockAt(toVec3(target.chest));
          return block?.name==="chest"?{kind:"native_loaded_block_observation",name:"chest",position:{...target.chest},
            lastValidatedAt:Date.now(),purpose:'owned_stock_return',resourceArrival:"NOT_CONFIRMED"}:!block?{
              kind:'recorded_owned_station_hint',name:'chest',position:{...target.chest},ownershipRecorded:true,purpose:'owned_stock_return',
              currentPresence:'UNKNOWN',resourceArrival:'NOT_CONFIRMED'}:null;
        },
      }:{}),
      ...(["survival_food","white_wool","leather"].includes(resource)?{
        getObservedResourceTarget:()=>{
          assertActive();
          const animal=Object.values(bot.entities||{}).filter(e=>resource==="survival_food"
            ? ["cow","pig","sheep","chicken","rabbit"].includes(e?.name)&&isHuntableFoodAnimal(e,bot.entity.position,384)
            : e?.position?.distanceTo(bot.entity.position)<=384&&require("./minecraft/houseResourceGatherer").houseMaterialAnimalAllowed(
              bot,e,resource,p=>naturalWalkingFoot(bot,p.floored())))
            .sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position))[0];
          return animal?{kind:"native_loaded_entity_observation",entityId:animal.id,name:animal.name,
            position:toPlainPosition(animal.position.floored()),lastValidatedAt:Date.now()}:null;
        },
        onObservedResourceApproach:facts=>recordTaskDiagnostic(ownerTask,resource==="survival_food"?"house_food_observed_target_approach":"house_material_observed_animal_approach",{resource,...facts}),
      }:{}),
      isStepAllowed: position => {
        if (!position||!allowsUnarmedHouseRangedStep(bot,position,ownerTask)) return false;
        const avoidMelee = isUnarmedHouseExplorer(bot, ownerTask);
        const d=activeSurvivalInterrupt;
        const defensiveAlignment=d?.originAlignmentActive===true&&d.bot===bot&&d.client===client&&d.task===ownerTask
          &&d.runGeneration===generation&&isSurvivalOwnerCurrent(d)&&isMovementLeaseActive(d.lease)
          &&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry
          &&new Vec3(position.x+.5,bot.entity.position.y,position.z+.5).distanceTo(bot.entity.position)<=1
          &&require('./minecraft/houseCreeperEscape').actualFullCubeContacts(bot).some(c=>c.position.x===position.x
            &&c.position.z===position.z&&position.y>=c.position.y&&position.y<=c.top+1);
        return Object.values(bot.entities || {}).filter(entity => (entity?.name === "creeper" || avoidMelee &&
          ["zombie", "zombie_villager", "husk", "drowned", "spider", "cave_spider"].includes(entity?.name))
          && entity.isValid !== false && entity.position&&isThreateningMobEntity(entity,bot.registry)
          && Math.abs(entity.position.y - position.y) < 4).every(entity => {
          const currentDistance = Math.hypot(bot.entity.position.x - entity.position.x, bot.entity.position.z - entity.position.z);
          return Math.hypot(position.x + 0.5 - entity.position.x, position.z + 0.5 - entity.position.z) >= Math.min(7.5, currentDistance - (defensiveAlignment?1:0.5));
        });
      },
      onFailure: error => {
        if (activeHouseSurfaceNavigationMove?.task === ownerTask && activeHouseSurfaceNavigationMove.runGeneration === generation) {
          activeHouseSurfaceNavigationMove.closed = true;
        }
        recordTaskDiagnostic(ownerTask, "house_surface_guard_failure", {
          code: error.code, message: error.message, observedMovement: error.observedMovement });
      },
      onSiteDefenseRelocation:facts=>recordTaskDiagnostic(ownerTask,'house_site_defense_relocated',facts),
      onWaterRecovery:facts=>recordTaskDiagnostic(ownerTask,'house_surface_water_recovery_rejoined',facts),
      onRouteUnavailable: facts => recordTaskDiagnostic(ownerTask, "house_surface_route_target_changed", { resource, ...facts }),
      onGroundedDropAlignment:facts=>recordTaskDiagnostic(ownerTask,'house_surface_drop_brake_aligned',{resource,...facts}),
      onPartialSiteLanding:facts=>recordTaskDiagnostic(ownerTask,'house_site_partial_native_landing',{resource,...facts}),
      onControlledDropBrake: facts => recordTaskDiagnostic(ownerTask, "house_surface_controlled_drop_landed", { resource, ...facts }),
      onProbe: facts => {
        let returnStartCollision;
        if (facts.observedReturnRetry && ['success','noPath'].includes(facts.status)) {
          const from = bot.entity.position.floored();
          returnStartCollision = [];
          for (let x=-1;x<=1;x++) for (let z=-1;z<=1;z++) for (let y=-1;y<=3;y++) {
            const p=from.offset(x,y,z),b=bot.blockAt(p);
            if (!b || !['air','cave_air','void_air'].includes(b.name)) returnStartCollision.push({position:toPlainPosition(p),name:b?.name||null,
              stateId:b?.stateId??null,shapes:b?.shapes??null});
          }
        }
        recordTaskDiagnostic(ownerTask, "house_surface_native_probe_unsettled", {
          resource, ...facts, ...(facts.status==='noPath'&&facts.target?{probeRestrictions:{
            targetStepCosts:[0,1].map(dy=>({dy,costs:(bot.pathfinder.movements?.exclusionAreasStep||[]).map(fn=>{try{const v=fn(bot.blockAt(toVec3(facts.target).offset(0,dy,0)));return Number.isFinite(v)?v:String(v);}catch(error){return error.code||error.message;}})})),
            nearbyThreats:Object.values(bot.entities||{}).filter(e=>e.isValid!==false&&e.position&&isThreateningMobEntity(e,bot.registry)&&bot.entity.position.distanceTo(e.position)<32).slice(0,8).map(e=>({id:e.id,name:e.name,position:toPlainPosition(e.position),distance:bot.entity.position.distanceTo(e.position)}))}}:{}), ...(returnStartCollision?{returnStartCollision,
            locomotion:{usingHeldItem:bot.usingHeldItem,entityFlags:bot.entity.metadata?.[0],livingFlags:bot.entity.metadata?.[8],jumpTicks:bot.jumpTicks,
              controls:{...bot.controlState},position:toPlainPosition(bot.entity.position),velocity:toPlainPosition(bot.entity.velocity),
              onGround:bot.entity.onGround,isInWater:bot.entity.isInWater}}:{}), actualMovementPerformed: false });
      },
      getCP: getGraphCP,
      saveCP: saveGraphCP,
      waterTransportKinds: ["source_water_depth1", "source_water_surface"],
      isWaterRouteThreatened:route=>{
        assertActive();if(!route?.from||!route?.to)return true;
        const armed=Boolean(findInventoryItem(WEAPON_ITEM_PRIORITY)),shield=bot.inventory.slots[45]?.name==="shield";
        return Object.values(bot.entities||{}).some(e=>{
          if(e===bot.entity||e.isValid===false||!e.position||!isThreateningMobEntity(e,bot.registry))return false;
          const ranged=isHouseRangedThreatEntity(e),buffer=ranged?24:e.name==="creeper"?8.5:6;
          if(armed&&bot.health>=12&&(!ranged||shield)&&e.name!=="creeper")return false;
          const x=Math.max(Math.min(route.from.x,route.to.x),Math.min(Math.max(route.from.x,route.to.x),e.position.x));
          const z=Math.max(Math.min(route.from.z,route.to.z),Math.min(Math.max(route.from.z,route.to.z),e.position.z));
          return Math.hypot(e.position.x-x,e.position.z-z)<buffer&&Math.abs(e.position.y-route.from.y)<8;
        });
      },
      discoverWaterRoutes: ({ origin }) => {
        assertActive();
        // Route discovery is optional planning. A physics frame between
        // landing and onGround confirmation must not fail an otherwise dry
        // graph leg or manufacture a water origin.
        if(!bot.entity.onGround||bot.entity.isInWater||bot.entity.isInLava||!hasGroundedBodySupport(bot)){
          recordTaskDiagnostic(ownerTask,'house_surface_water_discovery_deferred',{origin,reason:'native_origin_not_grounded',actualMovementPerformed:false});
          return [];
        }
        const state = getGraphCP();
        const saved = Object.values(state?.nodes || {}).map(node => node.transport?.route).filter(Boolean);
        const shallowSeen = saved.filter(route => route.kind === "loaded_source_water_wade").map(shallowRouteIdentity);
        let discovered = { routes: [], diagnostics: {} };
        try { discovered = finder.find({ origin, seenRouteIds: shallowSeen }); }
        catch (error) {
          if (!["water_bank_gravity_limit", "water_bank_unstable"].includes(error.code)) throw error;
          recordTaskDiagnostic(ownerTask, "house_surface_water_discovery_unavailable", { resource, code: error.code,
            actualMovementPerformed: false, origin });
        }
        recordTaskDiagnostic(ownerTask, "house_surface_water_discovery", { resource, ...discovered.diagnostics,
          plannedRoutes: discovered.routes.length, actualMovementPerformed: false });
        // Shallow routes already observed, or available in this batch, should
        // not consume the surface finder's finite result slots again. This is
        // geometry identity only; it grants no surface traversal credit.
        const surfaceSeen = [...saved, ...discovered.routes.map(candidate => candidate.route)].map(route =>
          surfaceRouteIdentity(route.kind === "loaded_source_water_wade"
            ? { ...route, kind: "loaded_surface_swim", depth: "surface_only" } : route));
        const surfaceDiscovered = surfaceFinder.find({ origin, seenRouteIds: surfaceSeen });
        recordTaskDiagnostic(ownerTask, "house_surface_swim_discovery", { resource, ...surfaceDiscovered.diagnostics,
          plannedRoutes: surfaceDiscovered.routes.length, actualMovementPerformed: false, riverBottomObserved: false });
        return [...surfaceDiscovered.routes, ...discovered.routes].filter(candidate =>
          !candidate.geometry.facts.some(fact => excluded(fact.position))
          && !candidate.approach.plannedPath.some(excluded)).slice(0, 4);
      },
      canDigPassageBlock: block => {
        assertActive();
        if (houseResourcePositionExcluded(block.position)) return false;
        const tool=bot.pathfinder?.bestHarvestTool?.(block);
        return typeof block.canHarvest === "function" && block.canHarvest(tool?.type ?? null);
      },
      digPassageBlock: (block, movements) => executionContextStorage.run({ ...context, miningMovements: movements,
        ...(graphCheckpoint ? { houseSiteSearchAssertActive: options.assertGraphActive } : {}) }, async () => {
        assertActive(); assertHouseResourceDigAllowed(block.position);
        await equipBestTool(block); assertActive();
        if (!block.canHarvest(bot.heldItem?.type ?? null)) throw Object.assign(
          new Error("开路所需工具未实际装备"), { code: "dry_graph_passage_tool_unconfirmed" });
        return physicalDigBlock(block, "开辟短距离通道");
      }),
      traverseWater: (route, options) => traverseHouseSurfaceWater(ownerTask, resource, route, context, assertActive, options),
      actualnativegoto: (goal, movements, budget) => executionContextStorage.run({ ...context, miningMovements: movements,
        ...(graphCheckpoint ? { houseSiteSearchAssertActive: options.assertGraphActive } : {}) }, () => {
        assertActive(); ensureMovements(bot);
        return houseSurfacePathfinderGoto(goal, legTimeoutMs, {...budget,siteExploration:Boolean(graphCheckpoint&&/^house_site_/.test(resource)),
          foodProvisioning:options.fieldFoodExploration===true,
          fieldExploration:Boolean(graphCheckpoint&&(resource==='house_field_wood'||options.fieldFoodExploration===true||options.cleanupExploration===true||Boolean(options.ownedStockTarget))&&!options.returnToAnchor&&!options.observedNode)});
      }),
    }, { timeoutMs: 1200000, legTimeoutMs, maxNodes: 256, maxEdges: 8192, adaptiveLocalFrontier: true,
      preferActualLocalFrontier:(resource!=='house_owned_stock_camp'||Boolean(options.ownedStockTarget))&&!/^house_site_/.test(resource),
      nativeReachableHints: /^house_site_/.test(resource)||["house_field_wood","house_startup_wood","survival_food","sand","house_owned_stock_camp","white_wool","leather"].includes(resource), terrainRecovery: true,
      deferInconclusiveExplorationReplay: /^house_site_/.test(resource)||resource==='house_field_wood'||options.fieldFoodExploration===true||options.cleanupExploration===true||Boolean(options.ownedStockTarget) });
    try {
      if(options.observeResourceWorkOrigin){
        const work=activeHouseResourceWork;
        if(!work||work.closed||work.task!==ownerTask||work.bot!==bot||work.client!==client||work.generation!==generation
          ||work.token!==token||work.lease!==lease||!isMovementLeaseActive(lease))throw createAbortError('movement_preempted');
        const result=await graph.observeResourceWorkOrigin({anchor,observedCurrent:options.observeResourceWorkOrigin,sharedDeadlineMs:work.deadline});
        if(result.confirmed)recordTaskDiagnostic(ownerTask,'house_resource_work_origin_observed',{resource,...result});
        return result;
      }
      if (options.observedNode) return await graph.travelToObservedNode({ anchor, excludeBounds: exclusions,
        nodeId: options.observedNode.nodeId, exactPosition: options.observedNode.position });
      const pendingGraph=getGraphCP(),pendingOrigin=pendingGraph?.pendingWater
        &&pendingGraph.nodes?.[pendingGraph.pendingWater.originNode]?.position;
      if(!options.returnToAnchor&&pendingOrigin
        &&bot.entity.position.distanceTo(toVec3(pendingOrigin))>16
        &&bot.entity.position.distanceTo(toVec3(anchor))<bot.entity.position.distanceTo(toVec3(pendingOrigin))){
        recordTaskDiagnostic(ownerTask,"house_surface_obsolete_transport_rejoin",{resource,
          actual:toPlainPosition(bot.entity.position),pendingOrigin,anchor,arrivalConfirmed:false});
        await graph.returnToAnchor({anchor,excludeBounds:exclusions,rejoinInterruptedSuffix:true});
      }
      return options.returnToAnchor ? await graph.returnToAnchor({ anchor, excludeBounds: exclusions, via: options.via || [],
        rejoinInterruptedSuffix: options.rejoinInterruptedSuffix === true, rejoinMinimumY: options.rejoinMinimumY, returnToCurrentOnly: options.returnToCurrentOnly === true, provisioningReturn:options.provisioningReturn===true,
        survivalProvisioning:options.survivalProvisioning===true&&foodSupplyRunning&&Boolean(context.houseSelfSupply) })
        : await graph.next({ anchor, excludeBounds: exclusions,
          survivalProvisioning:options.survivalProvisioning===true&&foodSupplyRunning&&Boolean(context.houseSelfSupply) });
    }
    catch (error) {
      // Preserve the original guard reason after it closed this exact move.
      if (/^(dry_graph_|surface_swim_|house_creeper_escape_)/.test(String(error.code || ""))) {
        if(error.reconnect)recordTaskDiagnostic(ownerTask,"house_surface_reconnect_unavailable",{resource,...error.reconnect});
        error.originCode = error.code; error.code = `house_surface_${error.code.replace(/^house_/, "")}`;
        throw error;
      }
      token?.throwIfRequested(); checkTaskSignal();
      throw error;
    } finally {
      if (isOwnerCurrent()) {
        appliedMovementsBot = null; appliedMovementsInstance = null; ensureMovements(bot);
      }
    }
  }

  async function recoverHouseLocalRoute(ownerTask, target, deadline = Date.now()+60000, options = {}) {
    const bot=ensureBotReady(),context=getExecutionContext()||{},client=bot._client;
    const generation=ownerTask.executionGeneration,token=context.token||getActiveCancellationToken(),lease=getCurrentMovementLease();
    const active=()=>{
      token?.throwIfRequested();checkTaskSignal();
      const defenseFailure=getHouseSurfaceDefenseFailure();if(defenseFailure)throw defenseFailure;
      if(Date.now()>=deadline)throw createAbortError("house_local_route_timeout");
      if(options.allowStoneOpening===true&&(bot.health<16||bot.food<14))throw createAbortError("house_local_route_opening_survival_limit");
      if(currentBot!==bot||bot._client!==client||currentTask!==ownerTask||ownerTask.executionGeneration!==generation)
        throw createAbortError("movement_preempted");
      const defense=activeSurvivalInterrupt;
      if(lease&&!isMovementLeaseActive(lease)&&!(defense?.previousLease===lease&&defense.miningMove===activeMiningNavigationMove&&isSurvivalOwnerCurrent(defense)))
        throw createAbortError("movement_preempted");
      ensureBotConnectionWritable("house.local_route");
    };
    active();
    const actionBudget=options.defenseActionBudget||{remaining:24,replans:0,dug:0};
    if(actionBudget.remaining<=0)throw createAbortError('house_local_route_action_limit');
    if(hasGroundedBodySupport(bot)&&!naturalWalkingFoot(bot,bot.entity.position.floored())){
      const start=bot.entity.position.clone(),foot=start.floored(),stances=[];
      for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++){
        const p=foot.offset(dx,0,dz),center=p.offset(.5,0,.5);
        if(center.distanceTo(start)<=1.1&&naturalWalkingFoot(bot,p))stances.push(p);
      }
      stances.sort((a,b)=>a.offset(.5,0,.5).distanceTo(start)-b.offset(.5,0,.5).distanceTo(start));
      if(stances.length){
        await houseSurfacePathfinderGoto(new goals.GoalBlock(stances[0].x,stances[0].y,stances[0].z),Math.min(4000,deadline-Date.now()));active();
        recordTaskDiagnostic(ownerTask,'house_local_route_supported_origin',{before:toPlainPosition(start),actual:toPlainPosition(bot.entity.position),centerSupport:naturalWalkingFoot(bot,bot.entity.position.floored())});
      }
    }
    active();const from=toPlainPosition(bot.entity.position.floored()),key=`${from.x},${from.y},${from.z}>${target.x},${target.y},${target.z}`;
    const prior=ownerTask.materialSupply?.localRouteRecovery;
    if(prior?.key===key&&prior.generation===generation&&!prior.defenseRetired)return false;
    const floors=prior?.protectedFloors||[];
    const protectedCells=new Set([...Object.values(ownerTask.materialSupply?.surfaceGraphs||{}).flatMap(getSurfaceGraphProtectedPositions),...floors].map(p=>`${p.x},${p.y},${p.z}`));
    const protectedPosition=p=>houseResourcePositionExcluded(p)||protectedCells.has(`${p.x},${p.y},${p.z}`);
    const routeOptions={blockAt:p=>bot.blockAt(toVec3(p)),from,goal:target,protectedPosition,maxDigs:Math.max(0,18-actionBudget.dug),
      canDig:block=>typeof block.canHarvest==="function"&&block.canHarvest(bot.pathfinder.bestHarvestTool(block)?.type??null)};
    let plan=planHouseLocalRoute(routeOptions);
    if(options.allowStoneOpening===true&&(ownerTask.materialSupply.campBootstrapNonHarvestOpenings||[]).length<18&&target.y>from.y+1&&(!plan||plan.position.y<target.y)){
      const opened=planHouseLocalRoute({...routeOptions,maxNonHarvestableDigs:1,
        canOpenWithoutHarvest:block=>['stone','cobblestone','andesite','granite','diorite'].includes(block.name)&&block.diggable!==false});
      if(opened&&(!plan||opened.position.y>plan.position.y))plan=opened;
    }
    const openingCells=plan?.nonHarvestableOpenings||[];
    active();if(!plan){
      const cells=[];
      for(let dx=-2;dx<=2;dx++)for(let dz=-2;dz<=2;dz++)for(let dy=-1;dy<=3;dy++){
        const p={x:from.x+dx,y:from.y+dy,z:from.z+dz},b=bot.blockAt(toVec3(p));
        cells.push({p,name:b?.name||null,protected:protectedPosition(p)});
      }
      recordTaskDiagnostic(ownerTask,"house_local_route_unavailable",{origin:from,target,cells,actualMovementConfirmed:false});
      return false;
    }
    ownerTask.materialSupply.localRouteRecovery={key,generation,origin:from,target:{...target},plannedSteps:plan.path,protectedFloors:floors,actualMovementConfirmed:false};
    recordTaskDiagnostic(ownerTask,"house_local_route_recovery_planned",{origin:from,target,steps:plan.path.length,plannedDigs:plan.digs,nonHarvestableOpenings:openingCells,resourceCredit:false});
    const navigator=createMiningNavigator({getBot:()=>bot,
      canOpenWithoutHarvest:block=>{active();return options.allowStoneOpening===true&&(ownerTask.materialSupply.campBootstrapNonHarvestOpenings||[]).length<18&&openingCells.some(c=>c.name===block.name
        &&c.stateId===block.stateId&&c.position.x===block.position.x&&c.position.y===block.position.y&&c.position.z===block.position.z);},assertActive:active,maxActions:actionBudget.remaining,movementTimeoutMs:7000,allowLeafSupport:true,allowCeilingClearance:true,allowStableGravitySupport:true,
      equipForBlock:async block=>{active();await equipBestTool(block);active();},
      digBlock:async block=>{active();assertHouseResourceDigAllowed(block.position);
        const nonHarvest=openingCells.some(c=>c.position.x===block.position.x&&c.position.y===block.position.y&&c.position.z===block.position.z)
          &&!block.canHarvest(bot.heldItem?.type??null);
        await physicalDigBlock(block,"安全开辟局部通道");active();
        if(nonHarvest&&['air','cave_air','void_air'].includes(bot.blockAt(block.position)?.name)){
          const proof={position:toPlainPosition(block.position),name:block.name,at:Date.now(),resourceCredit:false};
          ownerTask.materialSupply.campBootstrapNonHarvestOpenings=[...(ownerTask.materialSupply.campBootstrapNonHarvestOpenings||[]),proof];
          recordTaskDiagnostic(ownerTask,'house_camp_nonharvest_opening_confirmed',proof);
        }
      },
      goto:miningPathfinderGoto,
      checkpoint:value=>{active();const old=ownerTask.materialSupply.localRouteRecovery;const protectedFloors=[...new Map([...(old.protectedFloors||[]),...value.breadcrumbs.map(p=>({...p,y:p.y-1}))].map(p=>[`${p.x},${p.y},${p.z}`,p])).values()].slice(-512);ownerTask.materialSupply.localRouteRecovery={...old,navigation:value,protectedFloors};}});
    try{for(const step of plan.path){active();await executionContextStorage.run({...context,houseLocalRouteRecovery:ownerTask,houseLocalRouteDeadline:deadline},
      ()=>navigator.advance(step.direction,{ascend:step.ascend,descend:step.descend}));}}
    catch(error){
      if(!houseLocalRouteDefenseRelocations.has(error)&&error.code==='movement_preempted'
        &&await resumeHouseResourceAfterSurvival(error,{deadline,bot}))houseLocalRouteDefenseRelocations.add(error);
      if(!houseLocalRouteDefenseRelocations.has(error))throw error;
      active();actionBudget.remaining-=navigator.getActionCount();actionBudget.dug+=navigator.getState().dug;actionBudget.replans++;
      if(actionBudget.replans>4||actionBudget.remaining<=0||Date.now()>=deadline||!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry)throw error;
      ownerTask.materialSupply.localRouteRecovery.defenseRetired=true;
      recordTaskDiagnostic(ownerTask,'house_local_route_defense_replanned',{actual:toPlainPosition(bot.entity.position),originalTarget:target,originalDeadline:deadline,
        remainingActions:actionBudget.remaining,replans:actionBudget.replans,originalStepCompleted:false,materialCredit:false});
      return recoverHouseLocalRoute(ownerTask,target,deadline,{...options,defenseActionBudget:actionBudget});
    }
    active();const actual=navigator.getState();
    ownerTask.materialSupply.localRouteRecovery={...ownerTask.materialSupply.localRouteRecovery,actualMovementConfirmed:actual.moves>0};
    recordTaskDiagnostic(ownerTask,"house_local_route_recovery_completed",{actualPosition:toPlainPosition(bot.entity.position),moves:actual.moves,dug:actual.dug});
    return actual.moves>0;
  }

  async function buildHouseEmergencyCover(ownerTask,enemies,{assertActive,deadline}) {
    const bot=ensureBotReady();assertActive();
    const position=toPlainPosition(bot.entity.position),saved=ownerTask.materialSupply.defensiveCover;
    const inside=saved?.plan?.bounds&&position.x>saved.plan.bounds.loX+1&&position.x<saved.plan.bounds.hiX
      &&position.z>saved.plan.bounds.loZ+1&&position.z<saved.plan.bounds.hiZ;
    if(!inside&&!enemies.length)return null;
    const plan=inside?saved.plan:planEmergencyShelter({position,threat:toPlainPosition(enemies[0].position),
      blockAt:p=>bot.blockAt(toVec3(p)),inventory:{dirt:getItemCountByName("dirt"),cobblestone:getItemCountByName("cobblestone")},
      excluded:p=>ownerTask.stepCheckpoint?.furnishedHouse?.phase==="prepare_materials"
        ?executionContextStorage.run({...getExecutionContext(),houseResourceExclusionBounds:[]},()=>houseResourcePositionExcluded(p))
        :houseResourcePositionExcluded(p)});
    recordTaskDiagnostic(ownerTask,"house_emergency_cover_plan",{planned:Boolean(plan),inside:Boolean(inside),enemies:enemies.map(e=>e.name),phase:ownerTask.stepCheckpoint?.furnishedHouse?.phase});
    if(plan){
      for(const spec of saved?.placed||[])require('./minecraft/houseCombatMode').rememberCombatCover(ownerTask.materialSupply,spec);
      let cover=inside?saved:{plan,placed:[]};
      ownerTask.materialSupply.defensiveCover=cover;
      await require('./minecraft/houseEmergencyRoofAccess').completeEmergencyRoofAccess({
        getBot:()=>currentBot,assertActive,blockAt:p=>bot.blockAt(toVec3(p)),count:getItemCountByName,
        threats:()=>require('./minecraft/houseRangedScreen').loadedCoverThreats(bot,terrainSeparatedHouseMelee),
        excluded:houseResourcePositionExcluded,place:(spec,onConfirmed)=>placeFurnishedHouseBlock(spec,onConfirmed),
        remember:spec=>require('./minecraft/houseCombatMode').rememberCombatCover(ownerTask.materialSupply,spec),
        canRemove:block=>bot.canDigBlock(block)&&furnishedHouseDigAvoidsSupport(block.position,bot.entity.position)
          &&!houseCombatCleanupDependencies(ownerTask,assertActive).protectedFloor(toPlainPosition(block.position))
          &&require('./minecraft/houseResourceVisibility').hasHouseResourceSight(bot,block,{assertActive}),
        remove:async block=>{assertActive();const shovel=['dirt','grass_block'].includes(block.name)&&findInventoryItem(['netherite_shovel','diamond_shovel','iron_shovel','stone_shovel','wooden_shovel']);
          if(shovel)await equipInventoryItem(shovel);else await equipBestTool(block);assertActive();await physicalDigBlock(block,'自建掩体顶盖施工通道');},
        retire:spec=>{assertActive();const block=bot.blockAt(toVec3(spec.position));if(!block||!['air','cave_air','void_air'].includes(block.name))throw Object.assign(Error('掩体通道尚未实际变成空气'),{code:'house_recovery_cover_unconfirmed'});
          const same=s=>s.position.x===spec.position.x&&s.position.y===spec.position.y&&s.position.z===spec.position.z;
          ownerTask.materialSupply.defensiveCoverBlocks=(ownerTask.materialSupply.defensiveCoverBlocks||[]).filter(s=>!same(s));
          cover.placed=cover.placed.filter(s=>!same(s));},
        goto:(goal,budget)=>activeHouseSurfaceNavigationMove?pathfinderGoto(goal,Math.min(12000,budget),'自建掩体实际返回内部超时'):houseSurfacePathfinderGoto(goal,Math.min(12000,budget)),
        wait:sleep,record:(type,facts)=>recordTaskDiagnostic(ownerTask,type,facts),
      },{cover,deadline});
      recordTaskDiagnostic(ownerTask,"house_emergency_cover_built",{placed:cover.placed.length,inventory:{dirt:getItemCountByName("dirt"),cobblestone:getItemCountByName("cobblestone")},actual:toPlainPosition(bot.entity.position)});
      return cover;
    }
    return null;
  }


  function houseCombatCleanupDependencies(ownerTask,assertActive){
    const bot=ensureBotReady(),material=ownerTask.materialSupply;
    const reportedSkips=new Set();
    const protectedCells=new Set(Object.values(material.surfaceGraphs||{}).flatMap(getSurfaceGraphProtectedPositions).map(p=>`${p.x},${p.y},${p.z}`));
    for(const route of Object.values(material.quarry?.routes||{}))for(const p of route.navigation?.breadcrumbs||[])protectedCells.add(`${p.x},${p.y-1},${p.z}`);
    const house=ownerTask.stepCheckpoint?.furnishedHouse,owned=new Set(house?.ownedBlockIds||[]);
    if(material.houseAnchor)for(const spec of createFurnishedHouseBlueprint(material.houseAnchor,{profile:material.profile||'cottage'}).blocks)
      if(owned.has(spec.id))protectedCells.add(`${spec.position.x},${spec.position.y},${spec.position.z}`);
    return {material,assertActive,
      position:()=>toPlainPosition(bot.entity.position),blockAt:p=>bot.blockAt(toVec3(p)),
      grounded:()=>hasGroundedBodySupport(bot),dry:()=>inspectSurfaceBody(bot).dry,
      hasThreat:()=>Object.values(bot.entities||{}).some(e=>e!==bot.entity&&e.isValid!==false&&e.position
        &&isThreateningMobEntity(e,bot.registry)&&require('./minecraft/houseCombatCleanupThreat').isCombatCleanupThreat(bot,e,ownerTask.materialSupply,
          {ranged:isHouseRangedThreatEntity(e),recentDamage:Date.now()-Number(combatMemory.lastBotHurtAt||0)<6500})),
      canSee:p=>require('./minecraft/houseDigSight').canSeeHouseDigTarget(bot,toVec3(p),bot.entity.position),
      protectedFloor:p=>houseResourcePositionExcluded(toVec3(p))||protectedCells.has(`${p.x},${p.y},${p.z}`),
      remove:async(spec,revalidate)=>{assertActive();await breakFurnishedHouseBlock(spec.position,{beforeDig:revalidate,noMove:true});assertActive();},
      record:facts=>recordTaskDiagnostic(ownerTask,'house_combat_cover_removed',facts),
      recordSkip:facts=>{const id=`${facts.position.x},${facts.position.y},${facts.position.z}:${facts.reason}`;
        if(reportedSkips.has(id))return;reportedSkips.add(id);
        recordTaskDiagnostic(ownerTask,'house_combat_cleanup_block_deferred',{...facts,actual:toPlainPosition(bot.entity.position)});}};
  }
  async function cleanupHouseCombatCover(ownerTask,assertActive){
    return require('./minecraft/houseCombatMode').cleanupCombatCover(houseCombatCleanupDependencies(ownerTask,assertActive));
  }
  async function followHouseNativeDryConnector(ownerTask,target,deadline){
    return withSurfaceResourceMovements(async()=>{
      const bot=ensureBotReady(),client=bot._client,generation=ownerTask.executionGeneration;
      const profile=bot.pathfinder.movements,lease=getCurrentMovementLease();
      require('./minecraft/houseNativeDryConnector').restrictNativeDryConnectorProfile(profile,{bot,isDefenseOwner:()=>{
        const d=activeSurvivalInterrupt;return Boolean(d&&d.bot===bot&&d.client===client&&d.task===ownerTask
          &&d.runGeneration===generation&&d.previousLease===lease&&isSurvivalOwnerCurrent(d)&&isMovementLeaseActive(d.lease));
      }});
      const active=()=>{checkTaskSignal();if(currentBot!==bot||bot._client!==client||currentTask!==ownerTask
        ||ownerTask.executionGeneration!==generation||bot.pathfinder.movements!==profile||!isMovementLeaseActive(lease))throw createAbortError('movement_preempted');};
      return require('./minecraft/houseNativeDryConnector').followNativeDryConnector({assertActive:active,
        position:()=>toPlainPosition(bot.entity.position),safeFoot:p=>naturalWalkingFoot(bot,toVec3(p)),
        grounded:()=>hasGroundedBodySupport(bot),dry:()=>inspectSurfaceBody(bot).dry,wait:sleep,
        probe:p=>require('./minecraft/houseSurfaceGraph').runGroundedDryConnectorProbe(bot,profile,new goals.GoalBlock(p.x,p.y,p.z),
          {observedOrigin:toPlainPosition(bot.entity.position.floored()),assertActive:active,isOwnerCurrent:()=>currentBot===bot&&bot._client===client&&currentTask===ownerTask
            &&ownerTask.executionGeneration===generation&&bot.pathfinder.movements===profile&&isMovementLeaseActive(lease)}),
        move:(p,until)=>houseSurfacePathfinderGoto(new goals.GoalBlock(p.x,p.y,p.z),Math.min(15000,until-Date.now())),
        record:facts=>{recordTaskDiagnostic(ownerTask,'house_native_dry_connector',facts);
          if(facts.actualMovementPerformed&&facts.arrivalConfirmed)rememberCleanupTransportFoot(ownerTask,facts.target);}},target,{deadline});
    });
  }
  function rememberCleanupTransportFoot(ownerTask,position){
    const saved=ownerTask.materialSupply?.combatCleanupRecordedTransport;
    if(!saved||saved.returnConfirmed||saved.returning||!saved.tracking)return;
    const p={x:Math.floor(position.x),y:Math.floor(position.y),z:Math.floor(position.z)},trail=saved.dryTrail||[];
    if(trail.length&&toVec3(trail.at(-1)).equals(toVec3(p)))return;
    if(!trail.length||toVec3(trail.at(-1)).distanceTo(toVec3(p))<=16)saved.dryTrail=[...trail,p].slice(-256);
  }
  async function returnCleanupRecordedTransport(ownerTask,active,deadline){
    const saved=ownerTask.materialSupply?.combatCleanupRecordedTransport;
    if(!saved||saved.returnConfirmed)return true;
    saved.returning=true;const bot=ensureBotReady();
    const graphOptions={assertGraphActive:active,excludeBounds:[],graphCheckpoint:{get:()=>saved.graph,save:v=>{active();saved.graph=v;}}};
    try{
      if(saved.graph?.pendingWater||saved.graph?.pendingDryTrail){
        await exploreHouseSurfaceGraph(ownerTask,'house_owned_stock_camp',saved.anchor,setTaskProgress,
          {...graphOptions,returnToAnchor:true,returnToCurrentOnly:true,rejoinInterruptedSuffix:true,via:saved.dryTrail||[]});active();
      }
      // A settled old graph can be returned by a newly proven dry route too.
      // Confirm only the real entry arrival; do not credit any old water edge.
      if(await followHouseNativeDryConnector(ownerTask,saved.entry,deadline)){
        saved.returnConfirmed=true;
        recordTaskDiagnostic(ownerTask,'house_combat_cleanup_recorded_transport_returned',{
          entry:saved.entry,actual:toPlainPosition(bot.entity.position),confirmed:true,source:'fresh_native_dry_return',oldTraversalCredit:false});
        return true;
      }
      const trail=saved.dryTrail||[];
      for(let i=saved.returnTrailIndex??trail.length-1;i>=0;i--){
        saved.returnTrailIndex=i;
        active();if(Date.now()>=deadline||!await followHouseNativeDryConnector(ownerTask,trail[i],deadline))return false;
        saved.dryTrail=trail.slice(0,i+1);saved.returnTrailIndex=i-1;
      }
      if(saved.kind==='mining'){
        saved.returnConfirmed=bot.entity.position.floored().equals(toVec3(saved.entry))&&hasGroundedBodySupport(bot);
        recordTaskDiagnostic(ownerTask,'house_combat_cleanup_recorded_transport_returned',{kind:saved.kind,entry:saved.entry,actual:toPlainPosition(bot.entity.position),confirmed:saved.returnConfirmed});
        return saved.returnConfirmed;
      }
      const current=saved.graph?.nodes?.[saved.graph.current]?.position;
      if(!current||!await followHouseNativeDryConnector(ownerTask,current,deadline))return false;
      await exploreHouseSurfaceGraph(ownerTask,'house_owned_stock_camp',saved.anchor,setTaskProgress,
        {...graphOptions,observedNode:{nodeId:saved.entryId,position:saved.entry}});active();
      saved.returnConfirmed=bot.entity.position.floored().equals(toVec3(saved.entry))&&hasGroundedBodySupport(bot);
      recordTaskDiagnostic(ownerTask,'house_combat_cleanup_recorded_transport_returned',{entry:saved.entry,actual:toPlainPosition(bot.entity.position),confirmed:saved.returnConfirmed});
      return saved.returnConfirmed;
    }finally{saved.returning=false;}
  }
  async function approachCleanupRecordedTransport(ownerTask,spec,targets,active,deadline){
    const bot=ensureBotReady();
    if(!await returnCleanupRecordedTransport(ownerTask,active,deadline))return false;
    const material=ownerTask.materialSupply;
    const archives={...material,retiredCamps:[...(material.retiredCamps||[]),{surfaceGraphs:material.surfaceGraphs||{}}]};
    const candidates=require('./minecraft/houseCleanupRecordedRoutes').recordedCleanupRoutes(archives,
      toPlainPosition(bot.entity.position.floored()),spec.position,p=>naturalWalkingFoot(bot,toVec3(p)));
    recordTaskDiagnostic(ownerTask,'house_combat_cleanup_transport_candidates',{target:spec.position,candidates:candidates.map(c=>({index:c.index,resource:c.resource,entry:c.entry,target:c.targetPosition}))});
    const failures=material.combatCleanupRouteFailures||(material.combatCleanupRouteFailures={});
    const routeKey=c=>`${c.entry.x},${c.entry.y},${c.entry.z}`;
    const available=candidates.filter(c=>!failures[routeKey(c)]||Date.now()>=failures[routeKey(c)].until);
    for(const candidate of available.slice(0,3)){
      active();if(Date.now()+1000>=deadline)return false;
      let entryArrived=false;
      try{entryArrived=await followHouseNativeDryConnector(ownerTask,candidate.entry,deadline);}
      catch(error){
        if(['executor_stalled','house_executor_stalled','house_surface_movement_timeout','Timeout','NoPath','no_path','path_timeout'].includes(error.code||error.name)){
          failures[routeKey(candidate)]={until:Date.now()+120000,code:error.code||error.name,actual:toPlainPosition(bot.entity.position)};
          recordTaskDiagnostic(ownerTask,'house_combat_cleanup_transport_entry_deferred',{entry:candidate.entry,target:spec.position,...failures[routeKey(candidate)],
            cells:[-1,0,1].flatMap(dx=>[-1,0,1].flatMap(dz=>[-1,0,1,2].map(dy=>{
              const p=bot.entity.position.floored().offset(dx,dy,dz),b=bot.blockAt(p);
              return {p:toPlainPosition(p),name:b?.name??null,shapes:b?.shapes??null};}))) });
          active();continue;
        }
        throw error;
      }
      if(!entryArrived){failures[routeKey(candidate)]={until:Date.now()+120000,code:'no_confirmed_native_connector',actual:toPlainPosition(bot.entity.position)};continue;}
      delete failures[routeKey(candidate)];
      const graph=candidate.kind==='mining'?null:require('./minecraft/houseRecordedConstructionRoute').confirmRecordedConstructionEntry(candidate,
        toPlainPosition(bot.entity.position.floored()),hasGroundedBodySupport(bot));
      const saved={kind:candidate.kind,anchor:candidate.anchor,entry:candidate.entry,entryId:`${candidate.entry.x},${candidate.entry.y},${candidate.entry.z}`,
        sourceIndex:candidate.index,resource:candidate.resource,target:spec.position,graph,tracking:candidate.kind==='mining',dryTrail:[],returnConfirmed:false};
      ownerTask.materialSupply.combatCleanupRecordedTransport=saved;
      if(candidate.kind==='mining'){
        saved.dryTrail=[toPlainPosition(bot.entity.position.floored())];
        for(let i=1;i<candidate.waypoints.length;i+=4){
          active();const p=candidate.waypoints[Math.min(i+3,candidate.waypoints.length-1)];
          if(!await followHouseNativeDryConnector(ownerTask,p,deadline))break;
        }
      }else{
        await exploreHouseSurfaceGraph(ownerTask,'house_owned_stock_camp',saved.anchor,setTaskProgress,
          {observedNode:{nodeId:candidate.targetNodeId,position:candidate.targetPosition},assertGraphActive:active,excludeBounds:[],
            graphCheckpoint:{get:()=>saved.graph,save:v=>{active();saved.graph=v;}}});active();
        saved.tracking=true;saved.dryTrail=[toPlainPosition(bot.entity.position.floored())];
      }
      recordTaskDiagnostic(ownerTask,'house_combat_cleanup_recorded_transport_arrived',{target:spec.position,actual:toPlainPosition(bot.entity.position),oldRouteTraversalCredit:false});
      for(const p of combatCleanupStandingTargets(ownerTask,spec).slice(0,4)){
        active();if(Date.now()>=deadline)return false;
        if(await followHouseNativeDryConnector(ownerTask,toPlainPosition(p),deadline)
          &&require('./minecraft/houseDigSight').canSeeHouseDigTarget(bot,toVec3(spec.position),bot.entity.position))return true;
      }
      if(!await returnCleanupRecordedTransport(ownerTask,active,deadline))return false;
    }
    return false;
  }
  function combatCleanupStandingTargets(ownerTask,spec){
    const bot=ensureBotReady(),targets=[],coverKeys=new Set(require('./minecraft/houseCombatMode').combatCover(ownerTask.materialSupply).map(s=>`${s.position.x},${s.position.y},${s.position.z}`));
    for(let dx=-3;dx<=3;dx++)for(let dz=-3;dz<=3;dz++)for(const dy of [0,-1,-2,1]){
      const p=toVec3(spec.position).offset(dx,dy,dz),center=p.offset(.5,0,.5);
      if(center.distanceTo(bot.entity.position)>96||coverKeys.has(`${p.x},${p.y-1},${p.z}`)||!naturalWalkingFoot(bot,p)
        ||center.offset(0,1.62,0).distanceTo(toVec3(spec.position).offset(.5,.5,.5))>4.5
        ||!require('./minecraft/houseDigSight').canSeeHouseDigTarget(bot,toVec3(spec.position),center))continue;
      targets.push(p);
    }
    return targets.sort((a,b)=>a.distanceTo(bot.entity.position)-b.distanceTo(bot.entity.position));
  }
  async function approachCleanupFreshGraph(ownerTask,spec,active,deadline){
    const assertParent=active;active=()=>{assertParent();if(Date.now()>=deadline)throw createAbortError('house_combat_cleanup_approach_timeout');};
    const bot=ensureBotReady();active();
    if(!require('./minecraft/houseCombatMode').combatCover(ownerTask.materialSupply).some(s=>s.item===spec.item
      &&s.position.x===spec.position.x&&s.position.y===spec.position.y&&s.position.z===spec.position.z))
      throw createAbortError('house_combat_cleanup_ownership_missing');
    await alignHouseResourceGraphOrigin(ownerTask,Math.min(deadline,Date.now()+12000));active();
    let search=ownerTask.materialSupply.combatCleanupFreshApproach;
    if(!search){search={anchor:toPlainPosition(bot.entity.position.floored()),graph:null,graphSegments:[]};ownerTask.materialSupply.combatCleanupFreshApproach=search;}
    const adapter=()=>({cleanupExploration:true,assertGraphActive:active,excludeBounds:[],ownedCombatCoverTarget:spec,
      graphCheckpoint:{get:()=>search.graph,save:value=>{active();const retained=(search.graphSegments||[]).map(s=>s.graph);
        if(retained.reduce((n,g)=>n+(g.order?.length||0),0)+value.order.length>256
          ||retained.reduce((n,g)=>n+(g.probes||0),0)+value.probes>8192)throw createAbortError('house_combat_cleanup_approach_budget');
        search.graph=value;}}});
    let unresolvedTransportReason=null;
    if(search.graph&&(search.graph.pendingWater||search.graph.pendingDryTrail)){
      try{await exploreHouseSurfaceGraph(ownerTask,'house_owned_stock_camp',search.anchor,()=>{},
        {...adapter(),returnToAnchor:true,returnToCurrentOnly:true,rejoinInterruptedSuffix:true,via:search.observedPath||[]});active();}
      catch(error){active();if(error.code!=='house_surface_dry_graph_transport_origin'
        ||activeHouseSurfaceWater?.isPhysicalOwner()||!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry)throw error;
        unresolvedTransportReason=error.code;
      }
    }
    if(search.graph&&(unresolvedTransportReason||!search.graph.nodes[`${Math.floor(bot.entity.position.x)},${Math.floor(bot.entity.position.y)},${Math.floor(bot.entity.position.z)}`])){
      await require('./minecraft/houseStartupExplorationOrigin').prepareStartupExplorationOrigin({getBot:()=>currentBot,assertActive:active,
        getState:()=>({...search,searchAnchor:search.anchor}),saveState:value=>{active();const {searchAnchor,...rest}=value;
          search={...rest,anchor:searchAnchor};ownerTask.materialSupply.combatCleanupFreshApproach=search;},
        ready:drainStartupOriginDefense,isMotorIdle:()=>activeHouseSurfaceNavigationMove===null&&activeSurvivalInterrupt===null,
        record:facts=>recordTaskDiagnostic(ownerTask,'house_combat_cleanup_actual_origin',facts)}, {deadline,maximumSegments:32,unresolvedTransportReason});active();
    }
    for(let visits=0;visits<24&&bot.entity.position.distanceTo(toVec3(spec.position))>24;visits++){
      active();if(Date.now()>=deadline)return false;
      const result=await exploreHouseSurfaceGraph(ownerTask,'house_owned_stock_camp',search.anchor,()=>{},adapter());active();
      if(result.via)search.observedPath=result.via;
      if(!result.moved&&result.reason!=='finite_attempt_batch_failed')return false;
    }
    for(const target of combatCleanupStandingTargets(ownerTask,spec).slice(0,4)){
      active();if(Date.now()>=deadline)return false;
      if(await followHouseNativeDryConnector(ownerTask,toPlainPosition(target),deadline)){
        recordTaskDiagnostic(ownerTask,'house_combat_cleanup_fresh_approach_confirmed',{target:spec.position,actual:toPlainPosition(bot.entity.position),
          oldRouteTraversalCredit:false,coverRemoved:false});return true;
      }
    }
    return false;
  }

  async function finishHouseCombatCleanup(ownerTask){
    const bot=ensureBotReady(),client=bot._client,generation=ownerTask.executionGeneration,origin=bot.entity.position.floored();
    const active=()=>{checkTaskSignal();if(currentBot!==bot||bot._client!==client||currentTask!==ownerTask||ownerTask.executionGeneration!==generation)throw createAbortError('movement_preempted');};
    const deps=houseCombatCleanupDependencies(ownerTask,active);
    deps.approach=(spec,deadline)=>withSurfaceResourceMovements(async()=>{
      active();if(deps.hasThreat()||!deps.grounded()||!deps.dry())return false;
      const targets=combatCleanupStandingTargets(ownerTask,spec);
      if(bot.entity.position.distanceTo(toVec3(spec.position))>32){
        if(await approachCleanupRecordedTransport(ownerTask,spec,targets,active,deadline))return true;
        return approachCleanupFreshGraph(ownerTask,spec,active,deadline);
      }
      let localRecoveries=0,reachedLocalStance=false,stanceAttempts=0;
      for(const p of targets.slice(0,4)){
        if(stanceAttempts++>=2&&!reachedLocalStance)break;
        active();if(Date.now()>=deadline||deps.hasThreat())return false;
        let arrived=false;
        try{arrived=await followHouseNativeDryConnector(ownerTask,toPlainPosition(p),deadline);active();}
        catch(error){active();if(error.name==='NoPath'||['NoPath','no_path','path_timeout'].includes(error.code))continue;throw error;}
        if(!arrived&&localRecoveries<2&&Date.now()+1000<deadline&&!deps.hasThreat()){
          localRecoveries++;
          const before=bot.entity.position.clone();
          const recovered=await recoverHouseLocalRoute(ownerTask,toPlainPosition(p),Math.min(deadline,Date.now()+20000));active();
          if(recovered&&ownerTask.materialSupply.localRouteRecovery?.navigation?.dug>0)
            ownerTask.materialSupply.combatCleanupPassageRevision=(ownerTask.materialSupply.combatCleanupPassageRevision||0)+1;
          if(bot.entity.position.distanceTo(before)>.5&&deps.grounded()&&deps.dry()){
            rememberCleanupTransportFoot(ownerTask,bot.entity.position.floored());
            recordTaskDiagnostic(ownerTask,'house_combat_cleanup_local_passage',{target:toPlainPosition(p),before:toPlainPosition(before),actual:toPlainPosition(bot.entity.position),localRecoveries});
            arrived=await followHouseNativeDryConnector(ownerTask,toPlainPosition(p),deadline);active();
          }
        }
        if(arrived&&bot.entity.position.floored().equals(p)&&deps.grounded()&&deps.dry()){
          reachedLocalStance=true;
          if(deps.canSee(spec.position))return true;
          recordTaskDiagnostic(ownerTask,'house_combat_cleanup_stance_occluded',{target:spec.position,planned:toPlainPosition(p),
            actual:toPlainPosition(bot.entity.position),nextStrategy:'different_observed_standing_position'});
        }
      }
      return approachCleanupRecordedTransport(ownerTask,spec,targets,active,deadline);
    });
    deps.approachProgress=()=>ownerTask.materialSupply.combatCleanupPassageRevision||0;
    deps.recordDecision=facts=>recordTaskDiagnostic(ownerTask,'house_combat_cleanup_visit',facts);
    ownerTask.materialSupply.combatCleanupOrigin={position:toPlainPosition(origin),at:Date.now(),returnConfirmed:false};
    const result=await require('./minecraft/houseCombatMode').sweepCombatCover(deps);active();
    ownerTask.materialSupply.combatCleanupVerification={...result,at:Date.now()};
    recordTaskDiagnostic(ownerTask,'house_combat_cleanup_verification',{...result,
      ...(result.interrupted?{actual:toPlainPosition(bot.entity.position),grounded:deps.grounded(),dry:deps.dry(),
        threats:Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&e.isValid!==false&&e.position
          &&isThreateningMobEntity(e,bot.registry)&&e.position.distanceTo(bot.entity.position)<=(isHouseRangedThreatEntity(e)?24:10))
          .slice(0,12).map(e=>({id:e.id,name:e.name,position:toPlainPosition(e.position),distance:e.position.distanceTo(bot.entity.position),
            rangedInterrupt:isHouseRangedThreatEntity(e)?require('./minecraft/houseRangedCombat').shouldInterruptWorkForRanged(bot,e,Date.now()-Number(combatMemory.lastBotHurtAt||0)<6500):null}))}:{}),
    });
    if(!await returnCleanupRecordedTransport(ownerTask,active,Date.now()+180000))
      throw Object.assign(Error('清理后的原观察跨水路线尚未实际返回'),{code:'house_combat_cleanup_transport_return_pending'});
    const step=ownerTask.plan?.steps?.[ownerTask.currentStepIndex];
    const continueAtActual=ownerTask.currentStep==='build_furnished_house_phase'&&step?.args?.phase==='prepare_materials'
      &&ownerTask.materialSupply.materialSource==='self_gathered'&&deps.grounded()&&deps.dry()&&!deps.hasThreat()
      &&!ownerTask.materialSupply.combatCleanupFreshApproach?.graph?.pendingWater
      &&!ownerTask.materialSupply.combatCleanupFreshApproach?.graph?.pendingDryTrail;
    if(continueAtActual){
      active();ownerTask.materialSupply.combatCleanupOrigin={...ownerTask.materialSupply.combatCleanupOrigin,
        returnRequired:false,returnConfirmed:false,actualContinuation:toPlainPosition(bot.entity.position)};
      recordTaskDiagnostic(ownerTask,'house_combat_cleanup_continue_at_actual',{actual:toPlainPosition(bot.entity.position),
        originalOrigin:toPlainPosition(origin),returnedToOrigin:false,requiredReturnToOrigin:false,pending:result.pending});
      if(result.pendingWork)throw Object.assign(Error(`还有 ${result.pendingWork} 处自搭战斗障碍未实际清理`),{code:'house_combat_cleanup_pending'});
      return result;
    }
    if(!bot.entity.position.floored().equals(origin)
      &&!await followHouseNativeDryConnector(ownerTask,toPlainPosition(origin),Date.now()+120000))
      throw Object.assign(Error('清理后返回原工作位置尚无已确认路线'),{code:'house_combat_cleanup_return_pending'});
    active();ownerTask.materialSupply.combatCleanupOrigin.returnConfirmed=true;
    if(result.pendingWork)throw Object.assign(Error(`还有 ${result.pendingWork} 处自搭战斗障碍未实际清理`),{code:'house_combat_cleanup_pending'});
    return result;
  }

  function createHouseMaterialRuntime(ownerTask, blueprint, constructionBounds) {
    const bot = ensureBotReady();
    const report = (text) => { checkTaskSignal(); setTaskProgress(text); recordTaskHeartbeat(ownerTask, { actionState: "acting", clearRecoveryReason: true }); };
    const at = (p) => bot.blockAt(toVec3(p));
    const approachObservedOwnedCamp=async target=>{
      const material=ownerTask.materialSupply;
      const stockVisit=bot.health>=16&&bot.food>=14&&bot.entity.position.distanceTo(target)<=96
        &&require('./minecraft/houseOwnedStockCamp').hasOwnedBootstrapWoodHint(material,at);
      const chest=material?.storage?.chests?.find(c=>c.confirmedPlaced===true&&c.position
        &&(at(c.position)?.name==='chest'||stockVisit&&at(c.position)==null));
      if(!chest||!target.equals(toVec3(material.camp.anchor))||!hasGroundedBodySupport(bot)
        ||!findInventoryItem(WEAPON_ITEM_PRIORITY)&&!stockVisit)return false;
      const captured=bot._client,generation=ownerTask.executionGeneration;
      const active=()=>{checkTaskSignal();if(currentBot!==bot||bot._client!==captured||ownerTask.executionGeneration!==generation)throw createAbortError('movement_preempted');};
      const bounds=houseConstructionMaterialBounds(blueprint);
      if(inBounds(bot.entity.position.floored(),[bounds])){
        const origin=bot.entity.position.floored(),candidates=[];
        for(let r=2;r<=20;r+=2)for(const [dx,dz] of [[r,0],[-r,0],[0,r],[0,-r]])for(const dy of [0,-1,1,-2,2]){
          const p=origin.offset(dx,dy,dz);if(!inBounds(p,[bounds])&&naturalWalkingFoot(bot,p))candidates.push(p);
        }
        for(const p of candidates.slice(0,6)){try{await furnishedHouseMoveTo(p);}catch(error){active();continue;}active();if(!inBounds(bot.entity.position.floored(),[bounds]))break;}
      }
      if(inBounds(bot.entity.position.floored(),[bounds])||!naturalWalkingFoot(bot,bot.entity.position.floored()))return false;
      let recovery=material.currentCampApproach;
      const recorded=recovery?.graph?.nodes?.[recovery.graph.current]?.position;
      if(recorded&&bot.entity.position.distanceTo(toVec3(recorded))>32&&!recovery.graph.pendingWater&&!recovery.graph.pendingDryTrail){
        material.currentCampApproachHistory=[...(material.currentCampApproachHistory||[]).slice(-7),recovery];recovery=null;
      }
      if(!recovery||!target.equals(toVec3(recovery.target))){
        recovery={target:toPlainPosition(target),anchor:toPlainPosition(bot.entity.position.floored()),graph:null};material.currentCampApproach=recovery;
      }
      const saveCampGraph=value=>{active();const retained=[...(material.currentCampApproachHistory||[]).flatMap(r=>[r.graph,...(r.graphSegments||[]).map(v=>v.graph)]),
        ...(recovery.graphSegments||[]).map(v=>v.graph)].filter(Boolean);
        if(retained.reduce((n,g)=>n+(g.order?.length||0),0)+value.order.length>256
          ||retained.reduce((n,g)=>n+(g.probes||0),0)+value.probes>8192)throw createAbortError('house_camp_approach_budget_limit');
        recovery.graph=value;};
      const deadline=Date.now()+180000;
      const actualNode=bot.entity.position.floored();
      const nodeKey=`${actualNode.x},${actualNode.y},${actualNode.z}`;
      if(recovery.graph&&recovery.graph.current!==nodeKey&&!recovery.graph.pendingWater&&!recovery.graph.pendingDryTrail){
        await require('./minecraft/houseStartupExplorationOrigin').prepareStartupExplorationOrigin({getBot:()=>currentBot,assertActive:active,
          getState:()=>({...recovery,searchAnchor:recovery.anchor}),saveState:value=>{active();const {searchAnchor,...rest}=value;
            recovery={...rest,anchor:searchAnchor};material.currentCampApproach=recovery;},
          ready:drainStartupOriginDefense,isMotorIdle:()=>!activeHouseSurfaceNavigationMove&&!activeMiningNavigationMove&&!activeSurvivalInterrupt,
          record:facts=>recordTaskDiagnostic(ownerTask,'house_camp_actual_origin_segment',facts)}, {deadline,maximumSegments:32});active();
      }
      for(let i=0;i<24&&bot.entity.position.distanceTo(target)>4;i++){
        active();if(Date.now()>=deadline)throw Object.assign(Error('重新接近自有营地达到本轮时限'),{code:'house_owned_stock_visit_timeout'});
        const result=await exploreHouseSurfaceGraph(ownerTask,'house_owned_stock_camp',recovery.anchor,report,{
          assertGraphActive:active,excludeBounds:[],ownedStockTarget:{anchor:toPlainPosition(target),chest:chest.position},
          graphCheckpoint:{get:()=>recovery.graph,save:saveCampGraph}});
        if(!result?.moved&&(result?.reason!=='finite_attempt_batch_failed'||i%4===3&&stockVisit
          &&bot.entity.position.y<target.y-1&&!recovery.graph?.pendingWater&&!recovery.graph?.pendingDryTrail&&(recovery.openingAttempts||0)<3)){
          if(stockVisit&&bot.entity.position.y<target.y-1&&!recovery.graph?.pendingWater&&!recovery.graph?.pendingDryTrail
            &&(recovery.openingAttempts||0)<3){
            recovery.openingAttempts=(recovery.openingAttempts||0)+1;
            let progressed=false;
            // Complete the bounded ascent before asking surface exploration
            // again; otherwise its only open frontier may undo the first step.
            for(let climb=0;climb<12&&bot.entity.position.y<target.y-1;climb++){
              active();if(Date.now()>=deadline)throw createAbortError('house_owned_stock_visit_timeout');
              const before=bot.entity.position.y;
              const moved=await recoverHouseLocalRoute(ownerTask,toPlainPosition(target),Math.min(deadline,Date.now()+25000),
                {allowStoneOpening:bot.food>=14&&(material.campBootstrapNonHarvestOpenings||[]).length<18});active();
              progressed=progressed||moved;
              if(!moved||bot.entity.position.y<=before+.5)break;
            }
            if(progressed){
              await require('./minecraft/houseStartupExplorationOrigin').prepareStartupExplorationOrigin({getBot:()=>currentBot,assertActive:active,
                getState:()=>({...recovery,searchAnchor:recovery.anchor}),saveState:value=>{active();const {searchAnchor,...rest}=value;
                  recovery={...rest,anchor:searchAnchor};material.currentCampApproach=recovery;},
                ready:drainStartupOriginDefense,isMotorIdle:()=>!activeHouseSurfaceNavigationMove&&!activeMiningNavigationMove&&!activeSurvivalInterrupt,
                record:facts=>recordTaskDiagnostic(ownerTask,'house_camp_opened_origin_segment',facts)}, {deadline,maximumSegments:32});active();continue;
            }
          }
          break;
        }
      }
      active();if(bot.entity.position.distanceTo(target)>32)throw Object.assign(Error('自有营地尚未实际重新抵达'),{code:'house_owned_stock_visit_incomplete'});
      await houseSurfacePathfinderGoto(new goals.GoalBlock(target.x,target.y,target.z),20000);active();
      if(!bot.entity.position.floored().equals(target)||!hasGroundedBodySupport(bot))throw Object.assign(Error('自有营地最终站位未确认'),{code:'house_self_supply_return_unconfirmed'});
      recordTaskDiagnostic(ownerTask,'house_current_camp_fresh_approach_confirmed',{actual:toPlainPosition(bot.entity.position),target:toPlainPosition(target),oldTransportPreserved:true});
      return true;
    };
    const returnHouseCamp = async (anchor, options = {}) => {
      if(!await returnCleanupRecordedTransport(ownerTask,checkTaskSignal,Date.now()+180000))
        throw Object.assign(Error('先恢复清理任务已观察的跨水返程'),{code:'house_combat_cleanup_transport_return_pending'});
      const pendingCleanupReturn=ownerTask.materialSupply?.combatCleanupOrigin;
      if(pendingCleanupReturn&&pendingCleanupReturn.returnRequired!==false&&pendingCleanupReturn.returnConfirmed!==true){
        const returned=await followHouseNativeDryConnector(ownerTask,pendingCleanupReturn.position,Date.now()+120000);checkTaskSignal();
        if(returned){pendingCleanupReturn.returnConfirmed=true;recordTaskDiagnostic(ownerTask,'house_combat_cleanup_return_recovered',{
          target:pendingCleanupReturn.position,actual:toPlainPosition(bot.entity.position),actualArrivalConfirmed:true});}
      }
      if(!activeSurvivalInterrupt&&require('./minecraft/houseCombatMode').combatCover(ownerTask.materialSupply).length){
        const client=bot._client,generation=ownerTask.executionGeneration;
        await cleanupHouseCombatCover(ownerTask,()=>{checkTaskSignal();if(currentBot!==bot||bot._client!==client||currentTask!==ownerTask||ownerTask.executionGeneration!==generation)throw createAbortError('movement_preempted');});
      }
      const target = toVec3(anchor).floored();
      checkTaskSignal();
      if (bot.entity.position.floored().equals(target) && hasGroundedBodySupport(bot)) return;
      if(!findInventoryItem(WEAPON_ITEM_PRIORITY)&&target.equals(toVec3(source.getCamp()))
        &&!activeSurvivalInterrupt&&!activeHouseSurfaceWater&&!activeMiningNavigationMove&&!activeHouseSurfaceNavigationMove
        &&require('./minecraft/houseOwnedStockCamp').hasOwnedBootstrapWoodHint(ownerTask.materialSupply,at)
        &&await approachObservedOwnedCamp(target))return;
      if(options.allowNearbyWork===true&&target.equals(toVec3(source.getCamp()))
        &&require('./minecraft/houseCampWorkStance').canWorkAtOwnedCamp({position:bot.entity.position,anchor:toPlainPosition(target),
          stations:ownerTask.materialSupply?.ownedStations,blockAt:at,grounded:hasGroundedBodySupport(bot),dry:inspectSurfaceBody(bot).dry})){
        ownerTask.materialSupply.campWorkStance={position:toPlainPosition(bot.entity.position),anchor:toPlainPosition(target),graphRootCredit:false};
        recordTaskDiagnostic(ownerTask,'house_owned_camp_work_stance_confirmed',ownerTask.materialSupply.campWorkStance);return;
      }
      if(target.equals(toVec3(source.getCamp()))&&bot.entity.position.distanceTo(target)>12
        &&bot.entity.position.distanceTo(target)<=96&&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry){
        try{
          if(await followHouseNativeDryConnector(ownerTask,toPlainPosition(target),Date.now()+60000)){
            checkTaskSignal();recordTaskDiagnostic(ownerTask,'house_camp_fresh_native_return_confirmed',{
              target:toPlainPosition(target),actual:toPlainPosition(bot.entity.position),miningDigRequired:false});return;
          }
        }catch(error){
          checkTaskSignal();if(!['executor_stalled','house_surface_movement_timeout','Timeout','NoPath','no_path','path_timeout'].includes(error.code||error.name))throw error;
        }
      }
      if(target.equals(toVec3(source.getCamp()))&&bot.entity.position.distanceTo(target)<=32
        &&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry
        &&ownerTask.materialSupply?.storage?.chests?.some(c=>c.confirmedPlaced===true&&at(c.position)?.name==='chest')){
        try{
          await houseSurfacePathfinderGoto(new goals.GoalBlock(target.x,target.y,target.z),15000);checkTaskSignal();
          if(bot.entity.position.floored().equals(target)&&hasGroundedBodySupport(bot)){
            recordTaskDiagnostic(ownerTask,'house_owned_camp_local_arrival_confirmed',{actual:toPlainPosition(bot.entity.position),target:toPlainPosition(target),historicalRoutePreserved:true});return;
          }
        }catch(error){
          checkTaskSignal();if(!require('./minecraft/houseCampReturnRecovery').isCampReturnRouteFailure(error))throw error;
          if((error.name==='NoPath'||error.code==='NoPath')&&bot.entity.position.y<target.y-1){
            const client=bot._client,generation=ownerTask.executionGeneration,deadline=Date.now()+60000;
            const active=()=>{checkTaskSignal();if(currentBot!==bot||bot._client!==client||currentTask!==ownerTask||ownerTask.executionGeneration!==generation)throw createAbortError('movement_preempted');};
            const rejoined=await require('./minecraft/houseCampRejoin').rejoinOwnedCampRoute({assertActive:active,deadline,target:toPlainPosition(target),
              position:()=>toPlainPosition(bot.entity.position),recover:(goal,budget)=>recoverHouseLocalRoute(ownerTask,goal,budget),
              rejoin:()=>houseSurfacePathfinderGoto(new goals.GoalBlock(target.x,target.y,target.z),15000),
              record:facts=>recordTaskDiagnostic(ownerTask,'house_camp_local_upward_rejoin_progress',facts)});
            active();if(rejoined&&bot.entity.position.floored().equals(target)&&hasGroundedBodySupport(bot))return;
            // Near is not reachable. Keep the new physical escape stance and
            // continue the independent camp approach instead of rewinding an
            // unrelated old mine route back into the same low pocket.
            if(await approachObservedOwnedCamp(target))return;
          }
        }
      }
      if(ownerTask.materialSupply?.campReturnRouteDeferred&&await approachObservedOwnedCamp(target)){
        ownerTask.materialSupply.campReturnRouteDeferred=null;return;
      }
      const quarry=ownerTask.materialSupply?.quarry;
      if(quarry?.anchor&&bot.entity.position.y<quarry.anchor.y-1){
        const client=bot._client,generation=ownerTask.executionGeneration,token=getActiveCancellationToken(),lease=getCurrentMovementLease();
        const active=()=>{token?.throwIfRequested();checkTaskSignal();ensureMovementLeaseActive(lease);
          if(currentBot!==bot||bot._client!==client||currentTask!==ownerTask||ownerTask.executionGeneration!==generation)throw createAbortError("movement_preempted");};
        await require("./minecraft/houseInterruptedQuarryReturn").returnInterruptedHouseQuarry({
          getBot:()=>currentBot,assertActive:active,getQuarry:()=>ownerTask.materialSupply?.quarry,
          waitGround:()=>waitForSurfaceGround("恢复原矿道返程"),goto:miningPathfinderGoto,
          getOwnedCover:()=>require("./minecraft/houseCombatMode").combatCover(ownerTask.materialSupply),
          recoverLocal:(goal,deadline)=>recoverHouseLocalRoute(ownerTask,goal,deadline),
          clearOwnedCover:async spec=>{active();await breakFurnishedHouseBlock(spec.position);active();},
          saveNavigation:(resource,navigation,facts)=>{active();const q=ownerTask.materialSupply.quarry;
            ownerTask.materialSupply.quarry={...q,routes:{...q.routes,[resource]:{...q.routes[resource],navigation}}};
            if(facts)recordTaskDiagnostic(ownerTask,"house_quarry_actual_cursor_reconciled",facts);},
          record:facts=>recordTaskDiagnostic(ownerTask,"house_interrupted_quarry_returned",facts),
        });
        checkTaskSignal();if(bot.entity.position.floored().equals(target)&&hasGroundedBodySupport(bot))return;
      }
      if(!target.equals(toVec3(source.getCamp()))&&bot.entity.position.distanceTo(target)<=32
        &&naturalWalkingFoot(bot,target)){
        await houseSurfacePathfinderGoto(new goals.GoalBlock(target.x,target.y,target.z),20000);checkTaskSignal();
        if(!bot.entity.position.floored().equals(target)||!hasGroundedBodySupport(bot))throw Object.assign(Error("已观察原有营地的近距离重返未确认"),{code:"house_prior_camp_local_return_unconfirmed"});
        return;
      }
      if(target.equals(toVec3(source.getCamp()))&&bot.entity.position.distanceTo(target)>96){
        const field=require("./minecraft/houseRetiredCampRoute").selectFieldCampReturn(ownerTask.materialSupply,
          toPlainPosition(bot.entity.position.floored()),p=>naturalWalkingFoot(bot,toVec3(p)));
        if(field){
          const client=bot._client,generation=ownerTask.executionGeneration,capturedCamp=JSON.stringify(source.getCamp());
          const active=()=>{checkTaskSignal();if(currentBot!==bot||bot._client!==client||ownerTask.executionGeneration!==generation
            ||JSON.stringify(source.getCamp())!==capturedCamp)throw createAbortError("movement_preempted");};
          recordTaskDiagnostic(ownerTask,"house_field_camp_return_started",{entry:field.entry,target:field.target,camp:field.camp,arrivalConfirmed:false});
          if(!await followHouseNativeDryConnector(ownerTask,field.entry,Date.now()+30000)){
            await houseSurfacePathfinderGoto(new goals.GoalBlock(field.entry.x,field.entry.y,field.entry.z),20000);active();
            await waitForSurfaceGround('返营路线入口');active();
          }
          if(!bot.entity.position.floored().equals(toVec3(field.entry))||!hasGroundedBodySupport(bot))throw Object.assign(Error("重生返营未实际接回原探索入口"),{code:"house_camp_recovery_entry_unconfirmed"});
          ownerTask.materialSupply.campRecovery={schema:1,kind:"field_wood_camp_return",
            graph:require("./minecraft/houseRetiredCampRoute").fieldCampReturnCheckpoint(field,toPlainPosition(bot.entity.position.floored())),entryConfirmed:true};
          await exploreHouseSurfaceGraph(ownerTask,"house_field_wood",field.graph.anchor,report,{
            // A distant root may be outside loaded chunks. The ordinary graph
            // return freshly checks successive recorded parent legs as chunks
            // load; observed-node travel requires its target already loaded.
            ...(toVec3(field.target).equals(toVec3(field.graph.anchor))
              ?{returnToAnchor:true,rejoinInterruptedSuffix:true,via:[]}
              :{observedNode:{position:field.target}}),assertGraphActive:active,excludeBounds:[],
            graphCheckpoint:{get:()=>ownerTask.materialSupply.campRecovery.graph,save:value=>{active();ownerTask.materialSupply.campRecovery.graph=value;}}});active();
          await houseSurfacePathfinderGoto(new goals.GoalBlock(target.x,target.y,target.z),20000);active();
          if(!bot.entity.position.floored().equals(target)||!hasGroundedBodySupport(bot))throw Object.assign(Error("原营地末段未实际抵达"),{code:"house_camp_recovery_suffix_unconfirmed"});
          recordTaskDiagnostic(ownerTask,"house_field_camp_return_confirmed",{actual:toPlainPosition(bot.entity.position),inventoryRecoveryCredit:false});return;
        }
      }
      if (!target.equals(toVec3(source.getCamp()))&&bot.entity.position.distanceTo(target)>32
        ||bot.inventory.items().every(i=>FOOD_ITEM_PRIORITY.includes(i.name)||i.name==="rotten_flesh")&&bot.entity.position.distanceTo(target)>64) {
        const route=require("./minecraft/houseRetiredCampRoute").selectRetiredCampRoute(
          {...ownerTask.materialSupply,camp:{...ownerTask.materialSupply.camp,anchor:toPlainPosition(target)}},
          toPlainPosition(bot.entity.position.floored()),p=>naturalWalkingFoot(bot,toVec3(p)));
        if(route){
          const capturedCamp=JSON.stringify(source.getCamp()),generation=ownerTask.executionGeneration,client=bot._client;
          const active=()=>{checkTaskSignal();if(currentBot!==bot||bot._client!==client||ownerTask.executionGeneration!==generation
            ||JSON.stringify(source.getCamp())!==capturedCamp)throw createAbortError("movement_preempted");};
          recordTaskDiagnostic(ownerTask,"house_archived_camp_route_recovery_started",{archive:route.index,entry:route.entry,target:route.target,inventoryRecoveryCredit:false});
          await houseSurfacePathfinderGoto(new goals.GoalBlock(route.entry.x,route.entry.y,route.entry.z),20000);active();
          if(!bot.entity.position.floored().equals(toVec3(route.entry))||!hasGroundedBodySupport(bot))throw Object.assign(Error("旧路线入口未实际抵达"),{code:"house_camp_recovery_entry_unconfirmed"});
          const checkpoint=JSON.parse(JSON.stringify(route.graph));
          checkpoint.current=`${route.entry.x},${route.entry.y},${route.entry.z}`;checkpoint.resumeNode=checkpoint.current;
          ownerTask.materialSupply.campRecovery={schema:1,archive:route.index,resource:route.resource,graph:checkpoint,entryConfirmed:true,inventoryRecoveryCredit:false};
          await exploreHouseSurfaceGraph(ownerTask,`house_camp_recovery_${route.index}`,route.graph.anchor,report,{
            observedNode:{position:route.target},assertGraphActive:active,excludeBounds:[],
            graphCheckpoint:{get:()=>ownerTask.materialSupply.campRecovery.graph,save:value=>{active();ownerTask.materialSupply.campRecovery.graph=value;}}});active();
          for(const p of [...route.suffix,toPlainPosition(target)]){
            await houseSurfacePathfinderGoto(new goals.GoalBlock(p.x,p.y,p.z),20000);active();
            if(!bot.entity.position.floored().equals(toVec3(p))||!hasGroundedBodySupport(bot))throw Object.assign(Error("旧路线后缀未实际抵达"),{code:"house_camp_recovery_suffix_unconfirmed"});
          }
          recordTaskDiagnostic(ownerTask,"house_archived_camp_route_recovered",{archive:route.index,actual:toPlainPosition(bot.entity.position),inventoryRecoveryCredit:false});
          return;
        }
      }
      const preferredResource = options.resource || getExecutionContext()?.houseSurfaceResource || ownerTask.materialSupply?.activeSurfaceGraph;
      // A food search may be rooted at the respawn site. Returning to the
      // actual workshop must select that camp's own observed graph, not replay
      // a foreign-root pending water crossing from the food-search context.
      const resource=require("./minecraft/houseCampReturnTrace").selectHouseCampGraph(ownerTask.materialSupply,toPlainPosition(target),preferredResource);
      if(resource&&resource!==preferredResource)recordTaskDiagnostic(ownerTask,"house_camp_return_graph_selected",{
        preferredResource,resource,target:toPlainPosition(target),actual:toPlainPosition(bot.entity.position),arrivalConfirmed:false});
      const graph = resource && ownerTask.materialSupply?.surfaceGraphs?.[resource];
      if (graph) {
        const observed = houseCampGroundedTraces.get(ownerTask);
        const actualKey = bot.entity.position.floored().toString();
        const campKey = `${target.x},${target.y},${target.z}`;
        const freshCampExit = observed?.bot === bot && observed.client === bot._client && observed.anchor === campKey
          && graph.current === campKey && observed.path.at(-1)?.toString() === actualKey ? observed.path.map(toPlainPosition) : null;
        // A stale resource tour is not the route of a new local camp operation.
        // If already back at the graph root, reconnect locally with a NEW
        // native probe/physical leg rather than replaying old transport nodes.
        const localCampRejoin = graph.current === campKey
          && bot.entity.position.distanceTo(target) <= 12 ? [toPlainPosition(target)] : null;
        const observedResourceExit = require("./minecraft/houseCampReturnTrace").selectHouseCampReturnTrace(
          ownerTask.materialSupply, graph, toPlainPosition(bot.entity.position.floored()));
        let via = options.via || freshCampExit || localCampRejoin || observedResourceExit
          || ownerTask.materialSupply?.surfaceResources?.searches?.[resource]?.observedPath || [];
        if(resource==='survival_food'){
          const compact=require('./minecraft/houseCampTrace').compactObservedReturnTrace(via,{anchor:toPlainPosition(target),requiredNode:graph.current,
            pendingTransport:Boolean(graph.pendingWater||graph.pendingDryTrail||Object.values(graph.nodes).some(n=>n.transport))});
          if(compact.removed){recordTaskDiagnostic(ownerTask,'house_food_return_closed_loops_omitted',{
            before:via.length,after:compact.path.length,oldTraversalCredit:false,originalTracePreserved:true});via=compact.path;}
        }
        const recoveryDeadline=Date.now()+60000;
        const priorRecovery=ownerTask.materialSupply?.localRouteRecovery;
        const recoveredFoot=priorRecovery?.navigation?.breadcrumbs?.at(-1);
        const atRecoveryEnd=priorRecovery?.actualMovementConfirmed&&recoveredFoot
          &&bot.entity.position.floored().equals(toVec3(recoveredFoot));
        const recordedReturnFoot=graph.nodes?.[graph.current]?.position;
        let rejoinMinimumY=atRecoveryEnd?(priorRecovery.rejoinMinimumY
          ??((recoveredFoot.y>priorRecovery.origin.y+1&&target.y>priorRecovery.origin.y
            ||recordedReturnFoot&&recoveredFoot.y>recordedReturnFoot.y+1&&target.y>recordedReturnFoot.y)?recoveredFoot.y:null)):null;
        const recoveryOrigins=new Set();
        for(let recovery=0;;recovery++){
          try {
            await exploreHouseSurfaceGraph(ownerTask,resource,anchor,report,{returnToAnchor:true,via,rejoinInterruptedSuffix:true,rejoinMinimumY,excludeBounds:[],provisioningReturn:ownerTask.materialSupply?.provisioningReturnNeeded===true});
            break;
          } catch(error) {
            if(['house_surface_water_hostile_retreat','house_surface_surface_swim_survival_limit'].includes(error.code)){
              ownerTask.materialSupply.campReturnRouteDeferred={resource,at:Date.now(),reason:error.code,actual:toPlainPosition(bot.entity.position)};
              if(hasGroundedBodySupport(bot)&&await approachObservedOwnedCamp(target)){
                ownerTask.materialSupply.campReturnRouteDeferred=null;return;
              }
            }
            if(error.code==='house_surface_dry_graph_rejoin_unconfirmed'&&recovery<2&&Date.now()<recoveryDeadline){
              const entries=require('./minecraft/houseCampReturnTrace').campReturnRejoinTargets(via,
                toPlainPosition(bot.entity.position),p=>naturalWalkingFoot(bot,toVec3(p)));
              let rejoined=false;
              for(const entry of entries){
                checkTaskSignal();if(Date.now()>=recoveryDeadline)break;
                if(await followHouseNativeDryConnector(ownerTask,entry,recoveryDeadline)){
                  rejoined=true;recordTaskDiagnostic(ownerTask,'house_camp_observed_food_trace_rejoined',{
                    entry,actual:toPlainPosition(bot.entity.position),oldTraversalCredit:false});break;
                }
              }
              if(rejoined)continue;
            }
            if(['house_surface_dry_graph_transport_origin','house_surface_dry_graph_resume_position',
              'house_surface_dry_graph_native_no_path','house_surface_dry_graph_rejoin_unconfirmed'].includes(error.code)
              &&await approachObservedOwnedCamp(target))return;
            const rejoin=error.observedDryLeg?.target||error.reconnect?.target||toPlainPosition(target);
            const recoveryKey=bot.entity.position.floored().toString();
            const distantReconnect=error.code==="house_surface_dry_graph_rejoin_unconfirmed"
              &&error.reconnect?.allowed===true&&error.reconnect.grounded===true&&error.reconnect.naturalFoot===true
              &&(error.reconnect.distance>32||error.reconnect.reason==='foreign_suffix_after_unconfirmed_connectors');
            if(recovery>=8||recoveryOrigins.has(recoveryKey)||Date.now()>=recoveryDeadline
              ||!distantReconnect&&!/^house_surface_dry_graph_(native_no_path|probe_inconclusive|movement_timeout|leg_timeout|route_changed)$/.test(String(error.code||""))
              ||!await recoverHouseLocalRoute(ownerTask,rejoin,recoveryDeadline))throw error;
            recoveryOrigins.add(recoveryKey);
            const recoveryOrigin=ownerTask.materialSupply?.localRouteRecovery?.origin;
            if(recoveryOrigin&&bot.entity.position.y>recoveryOrigin.y+1&&target.y>recoveryOrigin.y)
              rejoinMinimumY=Math.floor(bot.entity.position.y);
            ownerTask.materialSupply.localRouteRecovery.rejoinMinimumY=rejoinMinimumY;
            checkTaskSignal();
          }
        }
        checkTaskSignal();
        if (!bot.entity.position.floored().equals(target) || !hasGroundedBodySupport(bot)) {
          throw Object.assign(new Error("没有沿本资源的已确认运输路线回到营地"), { code: "house_self_supply_return_unconfirmed" });
        }
        const returnedGraph=ownerTask.materialSupply?.surfaceGraphs?.[resource];
        if(require("./minecraft/houseResourceExplorationReturn").deferEscapedExplorationBranch(
          returnedGraph,rejoinMinimumY,toPlainPosition(bot.entity.position.floored())))
          recordTaskDiagnostic(ownerTask,"house_escaped_exploration_branch_deferred",{
            resource,minimumY:rejoinMinimumY,actual:toPlainPosition(bot.entity.position),actualCampReturnConfirmed:true});
        return;
      }
      const typedRoutesExist = Object.values(ownerTask.materialSupply?.surfaceGraphs || {}).some(value => value.pendingWater
        || Object.values(value.nodes || {}).some(node => node.transport));
      if (typedRoutesExist) throw Object.assign(new Error("返营缺少原资源运输路线，保留任务"), { code: "house_surface_return_resource_missing" });
      const freshLocalReturn=target.equals(toVec3(source.getCamp()))&&bot.entity.position.distanceTo(target)<=32
        &&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry&&naturalWalkingFoot(bot,target);
      // With no transport graph, a nearby owned camp needs an actually new
      // checked return, not a replay of optional old tree-approach positions.
      for (const point of [...(freshLocalReturn?[]:options.via || [])].reverse()) {
        checkTaskSignal();
        const waypoint = toVec3(point).floored();
        if (bot.entity.position.floored().equals(waypoint) && hasGroundedBodySupport(bot)) continue;
        await pathfinderGoto(new goals.GoalBlock(waypoint.x, waypoint.y, waypoint.z), DEFAULT_PATHFIND_TIMEOUT_MS, "沿自采地表路线返营超时");
        await waitForSurfaceGround("沿自采路线返营"); checkTaskSignal();
      }
      const returnDeadline=Date.now()+60000;
      await require('./minecraft/houseCampReturnRecovery').returnCampWithLocalRecovery({
        assertActive:()=>{checkTaskSignal();ensureMovementLeaseActive(getCurrentMovementLease());},
        positionKey:()=>bot.entity.position.floored().toString(),
        native:budget=>freshLocalReturn?houseSurfacePathfinderGoto(new goals.GoalBlock(target.x,target.y,target.z),budget,{deadline:returnDeadline})
          :pathfinderGoto(new goals.GoalBlock(target.x,target.y,target.z),budget,'自给采集返回固定营地超时'),
        recover:deadline=>recoverHouseLocalRoute(ownerTask,toPlainPosition(target),deadline),
      },{deadline:returnDeadline});
      await waitForSurfaceGround("返回自给施工营地"); checkTaskSignal();
      if (!bot.entity.position.floored().equals(target) || Math.abs(bot.entity.position.y - target.y) > 0.075
        || !safeSurfaceFoot(bot.entity.position)) throw Object.assign(new Error("没有在固定自给营地真实落稳"), { code: "house_self_supply_return_unconfirmed" });
      if(freshLocalReturn)recordTaskDiagnostic(ownerTask,'house_camp_fresh_local_return_confirmed',{
        actual:toPlainPosition(bot.entity.position),target:toPlainPosition(target),oldTraceTraversalCredit:false,historicalTracePreserved:true});
    };
    const resumeCampAfterSurvival = async(error,deadline)=>{
      const context=getExecutionContext(),task=context?.task,lease=context?.movementLease,client=bot._client;
      let frame=error.survivalInterrupt;
      if(!frame||!task||task!==ownerTask)return false;
      const identity=()=>{context.token?.throwIfRequested();checkTaskSignal();
        if(currentBot!==bot||bot._client!==client||currentTask!==task||task.executionGeneration!==context.runGeneration
          ||task.cancellationToken!==context.token||frame.bot!==bot||frame.client!==client||frame.task!==task
          ||frame.runGeneration!==context.runGeneration||(frame.workToken||frame.token)!==context.token
          ||frame.previousLease!==lease)throw createAbortError('movement_preempted');};
      for(let n=0;n<4;n++){
        identity();
        while(!frame.finished){identity();if(Date.now()>=deadline)throw error;
          await Promise.race([frame.finishedPromise,sleep(20)]);}
        identity();if(frame.error)throw frame.error;
        if(activeSurvivalInterrupt&&activeSurvivalInterrupt!==frame){frame=activeSurvivalInterrupt;continue;}
        ensureMovementLeaseActive(lease);
        if(!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry)throw Object.assign(Error('营地自卫后尚未实际落稳'),{code:'house_surface_defense_ground_unconfirmed'});
        recordTaskDiagnostic(task,'house_camp_craft_survival_resumed',{actual:toPlainPosition(bot.entity.position),sameTask:true,inventoryRecheckRequired:true});
        return true;
      }
      throw error;
    };
    const runAtHouseCamp = async (route, action) => {
      const anchor = source.getCamp();
      await returnHouseCamp(anchor, {...route,allowNearbyWork:true});
      const context = getExecutionContext() || {}, generation = ownerTask.executionGeneration;
      const client = bot._client, lease = getCurrentMovementLease(), token = context.token || getActiveCancellationToken();
      let via = [];
      const observeCampWork = () => {
        if (currentBot !== bot || bot._client !== client || currentTask !== ownerTask || ownerTask.executionGeneration !== generation
          || token?.cancelled || token?.pauseRequested || !isMovementLeaseActive(lease) || !hasGroundedBodySupport(bot)) return;
        const p = toPlainPosition(bot.entity.position.floored());
        // A body may touch an adjacent support while its center is not a
        // valid integer standing target. Never persist that as GoalBlock.
        if (Math.abs(bot.entity.position.y-p.y)>.075 || !naturalWalkingFoot(bot,p)) return;
        via = appendObservedCampPoint(via,p,anchor);
      };
      bot.on("physicsTick", observeCampWork);
      try {
        observeCampWork();
        const result = await action(); checkTaskSignal(); observeCampWork();
        if (via.length > 4096) throw Object.assign(new Error("营地操作实际路线超过有限观察上限"), { code: "house_surface_camp_work_route_limit" });
        await returnHouseCamp(anchor, { resource: route.resource, via,allowNearbyWork:true });
        return result;
      } finally { bot.removeListener("physicsTick", observeCampWork); }
    };

    const capacityFor = (name) => {
      const stack = bot.registry.itemsByName[name]?.stackSize || 64;
      return bot.inventory.slots.slice(9, 45).reduce((n, item) => n + (!item ? stack : item.name === name ? stack - item.count : 0), 0);
    };
    let source;
    const acquireFluidMaterial = (name, amount, context) => {
      const captured = getExecutionContext() || {};
      const owner = { bot, client: bot._client, task: ownerTask, token: captured.token || getActiveCancellationToken(),
        generation: ownerTask.executionGeneration, lease: getCurrentMovementLease(),
        contextLease: captured.movementLease, contextGeneration: captured.runGeneration };
      const isOwnerCurrent = () => currentBot === bot && bot._client === owner.client && currentTask === ownerTask &&
        ownerTask.executionGeneration === owner.generation && !owner.token?.cancelled && !owner.token?.pauseRequested &&
        (!owner.lease || isMovementLeaseActive(owner.lease));
      const assertOwner = () => {
        owner.token?.throwIfRequested(); checkTaskSignal();
        if (!isOwnerCurrent()) throw createAbortError("movement_preempted");
        ensureBotConnectionWritable("house.fluid");
      };
      const isOwnerContext = () => {
        const current = getExecutionContext();
        return current?.task === captured.task && current?.token === captured.token &&
          current?.runGeneration === owner.contextGeneration && current?.movementLease === owner.contextLease &&
          current?.houseSelfSupply === source;
      };
      const fluid = createHouseFluidMaterialProvider({
        ownerTask, source, getBot: () => currentBot, createProvider: createHouseFluidResources,
        captureOwner: () => owner, assertOwner, isOwnerCurrent, isOwnerContext,
        sourceGuardSupportsOwnedCancel: true, runPhysicalAction, report,
        abortOwner: error => {
          if (!isOwnerCurrent()) return;
          ownerTask.watchdogAbortCode = error.code; ownerTask.watchdogAbortMessage = error.message;
          owner.token?.pause();
        },
        guardNative: (_owner, nativeContext, action) => withHouseNativeSourceGuard(bot, {
          assertActive: () => { assertOwner(); nativeContext.beforeSend(); }, isOwnerContext,
          allowNativeCancel: isOwnedFluidNativeCancel,
        }, action),
        equipNative: async itemName => {
          assertOwner();
          const items = bot.inventory.items().filter(item => item.name === itemName)
            .sort((a, b) => remainingHouseToolDurability(b) - remainingHouseToolDurability(a));
          if (!items.length) throw Object.assign(new Error(`缺少原生流体操作物品 ${itemName}`), { code: "house_fluid_item_missing" });
          await equipInventoryItem(items[0]); assertOwner();
        },
        withMovements: (movements, action) => executionContextStorage.run({ ...captured, miningMovements: movements }, () => {
          assertOwner(); ensureMovements(bot); return action();
        }),
        restoreMovements: previous => {
          if (previous) {
            bot.pathfinder.setMovements(previous); appliedMovementsBot = bot; appliedMovementsInstance = previous;
          } else { appliedMovementsBot = null; appliedMovementsInstance = null; ensureMovements(bot); }
        },
        goto: (goal, options) => pathfinderGoto(goal, options.timeoutMs, "原生流体采集移动超时", owner.lease,
          { preserveMovements: true, isOwnerCurrent }),
        waitGround: async (_position, nativeContext) => {
          await waitForSurfaceGround("原生流体采集移动"); assertOwner(); nativeContext.assertActive();
        },
        returnHouseCamp,
        prepareCapacity: async (resource, _additional, rawContext) => {
          await source.stash({ ...rawContext.requirements, [resource]: rawContext.targetCount, stick: 16 }); assertOwner();
        },
        getProtectedPositions: () => {
          const routes = Object.values(ownerTask.materialSupply?.quarry?.routes || {}).map(route => route.navigation);
          routes.push(ownerTask.diamondExpedition?.navigation);
          const positions = routes.flatMap(route => route?.breadcrumbs || []);
          const floors = positions.map(p => ({ x: p.x, y: p.y - 1, z: p.z }));
          floors.push(...Object.values(ownerTask.materialSupply?.surfaceGraphs || {}).flatMap(getSurfaceGraphProtectedPositions));
          return [...new Map(floors.map(p => [`${p.x},${p.y},${p.z}`, p])).values()];
        },
      });
      return fluid.acquireRaw(name, amount, context);
    };
    let lastSurvivalBootstrapProbe=0;
    const needsLocalCleanupTools=()=>{
      const weapon=findInventoryItem(WEAPON_ITEM_PRIORITY),pick=findInventoryItem(PICKAXE_ITEM_NAMES);
      if(weapon&&pick)return false;
      if(!weapon&&!pick)return true;
      const table=ownerTask.materialSupply?.ownedStations?.crafting_table;
      return table?.confirmedPlaced===true&&table.position&&bot.entity.position.distanceTo(toVec3(table.position))<=12
        &&at(table.position)?.name==='crafting_table';
    };
    const safeCleanupToolBootstrap=()=>getExecutionContext()?.cleanupToolPreparation===ownerTask.taskId
      &&bot.health>=14&&bot.food>=8&&needsLocalCleanupTools()
      &&hasGroundedBodySupport(bot)&&naturalWalkingFoot(bot,bot.entity.position.floored())&&!imminentSurvivalThreat();
    const safeLocalSurvivalBootstrap=()=>bot.health>0&&bot.health<10&&Number.isFinite(bot.food)&&bot.food>=0&&bot.food<18
      &&!findInventoryItem(WEAPON_ITEM_PRIORITY)&&!findInventoryItem(PICKAXE_ITEM_NAMES)
      &&hasGroundedBodySupport(bot)&&naturalWalkingFoot(bot,bot.entity.position.floored())&&!immediateFoodThreat(bot);
    const gatherer = createHouseResourceGatherer({
      approachRevision:4,
      getBot: () => ensureBotReady(), assertActive: checkTaskSignal, report, capacityFor,
      allowSurvivalBootstrap:safeLocalSurvivalBootstrap,
      observeAnimals: facts => recordTaskDiagnostic(ownerTask,'house_material_animal_observation',facts),
      resumeAfterSurvival: resumeHouseResourceAfterSurvival,
      withResource: async ({ resource, anchor }, action) => {
        const outer = getExecutionContext() || {}, parent = outer.houseSurfaceResource;
        if (parent && parent !== resource) await returnHouseCamp(anchor, { resource: parent });
        checkTaskSignal();
        return executionContextStorage.run({ ...outer, houseSurfaceResource: resource }, action);
      },
      getCheckpoint: () => ownerTask.materialSupply?.surfaceResources,
      setCheckpoint: value => { checkTaskSignal(); ownerTask.materialSupply = { ...ownerTask.materialSupply, surfaceResources: value }; },
      withSurface: withSurfaceResourceMovements, safeFoot: safeSurfaceFoot,
      findBlocks: findHouseSurfaceMaterialBlocks,
      isCurrentDigTargetReady:block=>{
        checkTaskSignal();const fresh=block?.position&&bot.blockAt(block.position);
        return fresh?.stateId===block.stateId&&bot.canDigBlock(fresh)===true
          &&furnishedHouseStandingSafely(bot.entity.position)&&furnishedHouseDigAvoidsSupport(block.position,bot.entity.position)
          &&require('./minecraft/houseResourceVisibility').hasHouseResourceSight(bot,fresh,{assertActive:checkTaskSignal});
      },
      opportunistic:async({resource})=>{
        if(!["white_wool","leather","sugar_cane"].includes(resource))return;
        const last=ownerTask.materialSupply.opportunisticWork,position=bot.entity.position;
        if(last&&Date.now()-last.at<20000||last?.position&&toVec3(last.position).distanceTo(position)<5)return;
        const context=getExecutionContext(),client=bot._client,generation=ownerTask.executionGeneration;
        const active=()=>{checkTaskSignal();if(currentBot!==bot||bot._client!==client||ownerTask.executionGeneration!==generation
          ||getExecutionContext()?.token!==context?.token||getExecutionContext()?.houseSelfSupply!==source)throw createAbortError("movement_preempted");};
        const oreDrops={coal_ore:"coal",deepslate_coal_ore:"coal",iron_ore:"raw_iron",deepslate_iron_ore:"raw_iron",copper_ore:"raw_copper",gold_ore:"raw_gold"};
        const counts=()=>Object.fromEntries([...new Set(bot.inventory.items().map(i=>i.name))].map(name=>[name,getItemCountByName(name)]));
        const logCount=()=>bot.inventory.items().filter(i=>isWoodBlockName(i.name)).reduce((n,i)=>n+i.count,0);
        const urgent=()=>bot.health<6||bot.food<8||!hasGroundedBodySupport(bot)||immediateFoodThreat(bot)
          ||Object.values(bot.entities||{}).some(e=>e.position?.distanceTo(bot.entity.position)<=8
            &&require("./minecraft/houseResourceGatherer").houseMaterialAnimalAllowed(bot,e,resource,p=>naturalWalkingFoot(bot,p.floored())));
        ownerTask.materialSupply.opportunisticWork={at:Date.now(),position:toPlainPosition(position)};
        const result=await require("./minecraft/houseOpportunisticWork").runHouseOpportunisticWork({getBot:()=>currentBot,assertActive:active,urgent,counts,logCount,
          freeSlots:()=>bot.inventory.slots.slice(9,45).filter(i=>!i).length,
          scan:kind=>findNearestBlocksByNames(kind==="wood"?["oak_log","birch_log","spruce_log","acacia_log","jungle_log","dark_oak_log","mangrove_log","cherry_log","pale_oak_log"]:Object.keys(oreDrops),4.4,12),
          excluded:p=>houseResourcePositionExcluded(p)||Object.values(ownerTask.materialSupply.surfaceGraphs||{}).some(g=>getSurfaceGraphProtectedPositions(g).some(q=>q.x===p.x&&q.y===p.y&&q.z===p.z)),
          canDigSafely:b=>furnishedHouseStandingSafely(bot.entity.position)&&furnishedHouseDigAvoidsSupport(b.position,bot.entity.position)
            &&[new Vec3(0,1,0),new Vec3(0,-1,0),new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1)].every(d=>{
              const n=bot.blockAt(b.position.plus(d));return n&&!["water","lava","fire","soul_fire","bubble_column","magma_block"].includes(n.name);}),
          wantsOre:(name,block)=>getItemCountByName(oreDrops[name])<(/copper|gold/.test(name)?16:32)
            &&Boolean(bot.inventory.items().find(i=>PICKAXE_ITEM_NAMES.includes(i.name)&&remainingHouseToolDurability(i)>=8&&block.canHarvest(i.type))),
          equip:b=>equipBestTool(b),dig:b=>physicalDigBlock(b,"主线途中顺手采集"),
          collect:async()=>{await sleep(1200);active();},
        });active();
        if(result.acted)recordTaskDiagnostic(ownerTask,"house_opportunistic_work_observed",{resource,...result});
      },
      ensureFood: async () => {
        if(getExecutionContext()?.survivalMaintenance){await maintainCarriedSurvival();return;}
        if(foodSupplyRunning)return;
        await maintainSurvival();
        if(!ownerTask.materialSupply?.ownedStations?.furnace&&bot.food<8)await ensureHouseBootstrapFood(12);
      },
      ensureWeapon: async route => {
        if(route.resource==="white_wool"&&!findInventoryItem(["shears"])){
          const stock=source.storage.getStock(),iron=getItemCountByName("iron_ingot")+getItemCountByName("raw_iron")
            +Number(stock.iron_ingot||0)+Number(stock.raw_iron||0);
          if(iron>=2)await runAtHouseCamp(route,()=>source.ensure({shears:1}));
        }
        if (!findInventoryItem(WEAPON_ITEM_PRIORITY)) {
        await runAtHouseCamp(route, () => source.ensure({ wooden_sword: 1 }));
      } },
      hunt: async(entity,anchor,maxDistance,options={})=>{
        if(options.material!=="white_wool"||!findInventoryItem(["shears"]))return huntFoodAnimal(entity,anchor,maxDistance);
        const context=getExecutionContext(),client=bot._client,generation=ownerTask.executionGeneration;
        const active=()=>{checkTaskSignal();if(currentBot!==bot||bot._client!==client||ownerTask.executionGeneration!==generation
          ||getExecutionContext()?.task!==context?.task||getExecutionContext()?.token!==context?.token
          ||getExecutionContext()?.houseSelfSupply!==source)throw createAbortError("movement_preempted");};
        const result=await require("./minecraft/houseSheepShearing").shearHouseSheep({getBot:()=>currentBot,assertActive:active,
          safeFoot:p=>naturalWalkingFoot(bot,p.floored()),count:()=>getItemCountByName("white_wool"),sleep,
          approach:(live,budget)=>pathfinderGoto(new goals.GoalFollow(live,2),Math.min(26000,budget),"接近白羊剪毛超时"),
          equip:()=>physicalEquip(findInventoryItem(["shears"]),"hand","装备自制剪刀"),
          activate:live=>runBotWritableAction("bot.activateEntity",{targetId:live.id,reason:"shear_owned_task_white_wool"},async()=>{active();await bot.activateEntity(live);active();}),
          collect:position=>collectNearbyDroppedItems({position,radius:5,timeoutMs:5000}),
        },entity);active();recordTaskDiagnostic(ownerTask,"house_sheep_sheared_and_wool_picked_up",result);
      },
      ensureTool: async (name, block) => {
        if(name==='dirt'){
          const shovel=()=>bot.inventory.items().find(i=>/_shovel$/.test(i.name)&&remainingHouseToolDurability(i)>=8);
          if(!shovel()){
            await runAtHouseCamp({resource:name},()=>source.ensure({wooden_shovel:1}));checkTaskSignal();
          }
          const tool=shovel();
          if(!tool)throw Object.assign(Error('采土前尚未实际取得耐用铲子'),{code:'house_resource_shovel_missing'});
          await equipInventoryItem(tool);return;
        }
        const picks = name === "raw_iron" ? ["stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"] : PICKAXE_ITEM_NAMES;
        if (["cobblestone", "coal", "raw_iron", "lapis_lazuli"].includes(name)) {
          let tool = bot.inventory.items().find(item => picks.includes(item.name) && remainingHouseToolDurability(item) >= 8 && block.canHarvest(item.type));
          if (!tool) {
            const toolName = name === "raw_iron" || getItemCountByName("cobblestone") >= 3 ? "stone_pickaxe" : "wooden_pickaxe";
            await runAtHouseCamp({ resource: name }, () => source.ensure({ [toolName]: getItemCountByName(toolName) + 1 }));
            tool = bot.inventory.items().find(item => picks.includes(item.name) && remainingHouseToolDurability(item) >= 8 && block.canHarvest(item.type)); }
          if (!tool) throw Object.assign(new Error(`未取得可采出 ${block.name} 的耐用工具`), { code: "house_resource_tool_missing" });
          await equipInventoryItem(tool);
        } else await equipBestTool(block);
      },
      reachDig: createHouseResourceReach({
        getBot: () => ensureBotReady(),
        captureActive: capturedBot => {
          const context=getExecutionContext()||{},client=capturedBot._client,generation=ownerTask.executionGeneration;
          const token=context.token||getActiveCancellationToken(),lease=getCurrentMovementLease();
          return () => {
            token?.throwIfRequested();checkTaskSignal();
            if(currentBot!==capturedBot||capturedBot._client!==client||currentTask!==ownerTask
              ||ownerTask.executionGeneration!==generation||(ownerTask.cancellationToken||runtimeToken)!==token
              ||lease&&!isMovementLeaseActive(lease))throw createAbortError("movement_preempted");
            ensureBotConnectionWritable("house.resource.reach");
          };
        },
        avoidsSupport: furnishedHouseDigAvoidsSupport, standingSafely: furnishedHouseStandingSafely,
        getDeadline:()=>activeHouseResourceWork?.deadline,
        recoverApproach:(block,{deadline})=>recoverHouseLocalRoute(ownerTask,{...toPlainPosition(block.position),
          y:Math.min(block.position.y,Math.floor(bot.entity.position.y)+1)},deadline),
        clearSight:async (target,options)=>{
          const {clearHouseResourceSight}=require("./minecraft/houseResourceSight");
          const cleared=await clearHouseResourceSight({getBot:()=>ensureBotReady(),assertActive:checkTaskSignal,
            standingSafely:()=>hasGroundedBodySupport(bot)&&furnishedHouseStandingSafely(bot.entity.position),
            canClear:leaf=>!houseResourcePositionExcluded(leaf.position)&&furnishedHouseDigAvoidsSupport(leaf.position,bot.entity.position),
            dig:leaf=>physicalDigBlock(leaf,"清理挡住天然材料的树叶")},target,options);
          if(cleared)recordTaskDiagnostic(ownerTask,"house_resource_sight_cleared",{target:toPlainPosition(target.position),leaves:cleared,resourceCredit:false});
          return cleared;
        },
        moveToBlock: (block,{deadline}) => pathfinderGoto(new goals.GoalLookAtBlock(block.position, bot.world, { reach: 4.5 }),
          Math.max(1,Math.min(10000,deadline-Date.now())), "前往天然建材超时",getCurrentMovementLease(),
          {resourceApproachTimeout:true}),
        onRecovered: facts => recordTaskDiagnostic(ownerTask, "house_resource_native_plan_failed_but_reachable", facts),
        onVisibilityRecovered:facts=>recordTaskDiagnostic(ownerTask,"house_resource_native_visibility_rechecked",facts),
      }),
      returnExploration: async (anchor, options) => {
        checkTaskSignal();
        const graph=ownerTask.materialSupply?.surfaceGraphs?.[options.resource];
        const expected=graph?.current&&graph.nodes?.[graph.current]?.position;
        if(!expected)return returnHouseCamp(anchor,options);
        if(!graph.pendingWater&&!graph.pendingDryTrail&&bot.entity.position.distanceTo(toVec3(expected))<=32){
          const actual=await exploreHouseSurfaceGraph(ownerTask,options.resource,anchor,report,{
            observeResourceWorkOrigin:graph.current,excludeBounds:[]});
          checkTaskSignal();if(actual?.confirmed===true)return;
        }
        let returned;
        await require("./minecraft/houseResourceExplorationReturn").returnHouseResourceExploration({
          assertActive:checkTaskSignal,
          rejoin:async()=>{returned=await exploreHouseSurfaceGraph(ownerTask,options.resource,anchor,report,{returnToAnchor:true,
            returnToCurrentOnly:true,rejoinInterruptedSuffix:true,via:options.via,excludeBounds:[]});},
          returnCamp:async()=>{
            await returnHouseCamp(anchor,options);
            // Fresh camp shortcuts confirm physical arrival without replaying
            // the old resource graph. Let that graph validate the actual known
            // node and reconcile its cursor before publishing a rejoin receipt.
            returned=await exploreHouseSurfaceGraph(ownerTask,options.resource,anchor,report,{returnToAnchor:true,
              returnToCurrentOnly:true,rejoinInterruptedSuffix:true,via:[],excludeBounds:[]});
          },
          onCampRecovery:error=>recordTaskDiagnostic(ownerTask,"house_resource_rejoin_camp_recovery",{
            resource:options.resource,code:error.code,actual:toPlainPosition(bot.entity.position),arrivalConfirmed:false}),
        });
        checkTaskSignal();
        const reconciledGraph=ownerTask.materialSupply?.surfaceGraphs?.[options.resource];
        const reconciled=reconciledGraph?.nodes?.[reconciledGraph.current]?.position;
        if(returned?.confirmed!==true||returned.current!==reconciledGraph?.current
          ||!reconciledGraph?.order?.includes(reconciledGraph.current)||!reconciled
          ||!bot.entity.position.floored().equals(toVec3(reconciled))||!hasGroundedBodySupport(bot))
          throw Object.assign(new Error("没有实际接回当前探索节点"),{code:"house_surface_exploration_rejoin_unconfirmed"});
        recordTaskDiagnostic(ownerTask,"house_resource_exploration_node_rejoined",{resource:options.resource,actual:toPlainPosition(bot.entity.position)});
      },
      onCandidateFailure: facts => recordTaskDiagnostic(ownerTask, "house_resource_candidate_rejected", facts),
      waitGround: () => waitForSurfaceGround("采集自然建材"),
      canDigSafely: (block) => {
        if (!furnishedHouseStandingSafely(bot.entity.position) || !furnishedHouseDigAvoidsSupport(block.position, bot.entity.position)
          || houseResourcePositionExcluded(block.position)) return false;
        if (Object.values(ownerTask.materialSupply?.surfaceGraphs || {}).some(graph => getSurfaceGraphProtectedPositions(graph).some(p =>
          p.x === block.position.x && p.z === block.position.z && p.y === block.position.y))) return false;
        return [new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)].every(delta => {
          const neighbor = bot.blockAt(block.position.plus(delta));
          return neighbor && !["lava", "fire", "soul_fire", "magma_block"].includes(neighbor.name)
            && (block.name === "sugar_cane" || !["water", "bubble_column"].includes(neighbor.name));
        });
      },
      dig: physicalDigBlock, collectDrops: collectNearbyDroppedItems,
      explore: (position) => exploreNextSurfacePosition([toVec3(position)], { detailed: true }), returnCamp: returnHouseCamp,
      isExplorationPosition: (resource, position, anchor) => {
        const graph = ownerTask.materialSupply?.surfaceGraphs?.[resource];
        return graph ? Boolean(graph.nodes?.[`${position.x},${position.y},${position.z}`])
          : position.x === anchor.x && position.y === anchor.y && position.z === anchor.z;
      },
      // These are movement routes. Source mutation bounds include the camp
      // itself and must not make its observed walking origin inaccessible.
      nextExploration: ({ resource, anchor }) => exploreHouseSurfaceGraph(ownerTask, resource, anchor, report, { excludeBounds: [] }),
    });
    const acquireQuarryMaterial = async (name, amount, context) => {
      const captured = getExecutionContext() || {};
      const client = bot._client, generation = ownerTask.executionGeneration, dimension = bot.game?.dimension;
      const token = captured.token || getActiveCancellationToken(), lease = getCurrentMovementLease();
      const isOwnerCurrent = () => currentBot === bot && bot._client === client && bot.game?.dimension === dimension && currentTask === ownerTask
        && ownerTask.executionGeneration === generation && (ownerTask.cancellationToken || runtimeToken) === token
        && !token?.cancelled && !token?.pauseRequested && (!lease || isMovementLeaseActive(lease));
      const assertOwner = () => {
        context.assertActive(); token?.throwIfRequested(); checkTaskSignal();
        if (!isOwnerCurrent()) throw createAbortError("movement_preempted");
        ensureBotConnectionWritable("house.quarry.entry");
      };
      assertOwner();
      if (captured.houseSelfSupply !== source) throw createAbortError("movement_preempted");
      await returnHouseCamp(context.anchor); assertOwner();
      const prior = ownerTask.materialSupply?.quarryEntry;
      const resourceGraph = prior?.resourceGraph || ownerTask.materialSupply?.activeSurfaceGraph || "any_log";
      const entryExcluded = p => {
        if (inBounds(p, constructionBounds)) return true;
        const supply = ownerTask.materialSupply;
        const owned = [...Object.values(supply?.ownedStations || {}).map(item => item.position),
          ...(supply?.storage?.chests || []).map(item => item.position)];
        return owned.some(q => q && p.x === q.x && p.z === q.z && p.y >= q.y - 1 && p.y <= q.y + 2);
      };
      const protectedDig = p => {
        if (inBounds(p, context.exclusionBounds || []) || houseResourcePositionExcluded(p)) return true;
        return Object.entries(ownerTask.materialSupply?.quarry?.routes || {}).some(([other, route]) => other !== name
          && (route.navigation?.breadcrumbs || []).some(q => p.x === q.x && p.z === q.z && p.y === q.y - 1));
      };
      const resolver = createHouseQuarryEntry({ getBot: () => currentBot,
        getObservedGraph: graphName => ownerTask.materialSupply?.surfaceGraphs?.[graphName],
        blockAt: at, assertActive: assertOwner,
        isOwnerContext: () => isOwnerCurrent() && getExecutionContext()?.houseSelfSupply === source,
        isExcludedEntry: entryExcluded, isProtectedDig: protectedDig,
      }, { camp: context.anchor, resourceGraph });
      let entry;
      if (prior) entry = resolver.revalidate(prior);
      else {
        // Nearby logs need not create a graph. Walking on sand is valid, but
        // that observation cannot authorize excavating from a gravity floor.
        // Discover real stable nodes with the existing native transport guard.
        const discoveryDeadline = Date.now() + 120000;
        const assertDiscovery = () => {
          // The graph's existing captured defense may temporarily own controls.
          // This permits only that exact surface frame, never foreign actors or
          // quarry writes; resolver/arrival/supply checks still use assertOwner.
          if (isOwnerCurrent()) assertOwner();
          else {
            context.assertActive(); token?.throwIfRequested(); checkTaskSignal();
            const move = activeHouseSurfaceNavigationMove;
            if (currentBot !== bot || bot._client !== client || bot.game?.dimension !== dimension || currentTask !== ownerTask
                || ownerTask.executionGeneration !== generation || (ownerTask.cancellationToken || runtimeToken) !== token
                || move?.bot !== bot || move.task !== ownerTask || move.lease !== lease || !isHouseSurfaceDefenseCurrent(move)) {
              throw createAbortError("movement_preempted");
            }
            ensureBotConnectionWritable("house.quarry.entry.discovery");
          }
          if (Date.now() >= discoveryDeadline) throw Object.assign(
            new Error("寻找稳定矿道入口达到本轮有限时限"), { code: "house_quarry_entry_search_timeout" });
        };
        for (let attempt = 0; ; attempt += 1) {
          assertDiscovery();
          try { entry = resolver.choose(); break; }
          catch (error) {
            if (error.code !== "house_quarry_entry_pending" || attempt >= 8) throw error;
          }
          const outcome = await exploreHouseSurfaceGraph(ownerTask, resourceGraph, context.anchor, report,
            { excludeBounds: [], assertGraphActive: assertDiscovery });
          assertDiscovery();
          recordTaskDiagnostic(ownerTask, "house_quarry_entry_native_discovery", {
            attempt: attempt + 1, maximumAttempts: 8, originalDeadline: discoveryDeadline,
            moved: outcome?.moved === true, reason: outcome?.reason || null,
            actualPosition: toPlainPosition(bot.entity.position), quarryEntryConfirmed: false });
        }
      }
      const saveEntry = value => {
        assertOwner(); entry = value;
        ownerTask.materialSupply = { ...ownerTask.materialSupply, quarryEntry: value };
      };
      saveEntry(entry);
      const travel = async position => {
        assertOwner();
        if (entry.routeKind === "same_camp") {
          if (!bot.entity.position.floored().equals(toVec3(context.anchor)) || !hasGroundedBodySupport(bot)) {
            throw Object.assign(new Error("固定营地矿道入口没有真实落稳"), { code: "house_quarry_entry_arrival_unconfirmed" });
          }
          return;
        }
        if (entry.routeKind !== "observed_graph_node") {
          throw Object.assign(new Error("矿道入口缺少原地表运输类型"), { code: "house_quarry_entry_checkpoint_unconfirmed" });
        }
        await exploreHouseSurfaceGraph(ownerTask, resourceGraph, context.anchor, report,
          { observedNode: { nodeId: `${position.x},${position.y},${position.z}`, position }, excludeBounds: [] });
        assertOwner();
        if (!bot.entity.position.floored().equals(toVec3(position)) || !hasGroundedBodySupport(bot)) {
          throw Object.assign(new Error("矿道运输没有确认实际干燥到达"), { code: "house_quarry_entry_arrival_unconfirmed" });
        }
      };
      const toEntry = async () => {
        assertOwner(); saveEntry(resolver.revalidate(entry));
        await travel(entry.position); assertOwner(); saveEntry(resolver.confirm(entry));
      };
      const toCamp = async () => {
        assertOwner();
        // The quarry must physically retrace its mining route to the entry.
        // A saved surface node never authorizes skipping that underground leg.
        saveEntry(resolver.confirm(entry));
        await travel(context.anchor); assertOwner(); saveEntry(resolver.revalidate(entry));
      };
      const supplyAtCamp = async action => {
        await toCamp(); assertOwner();
        const result = await action(); assertOwner();
        await returnHouseCamp(context.anchor, { resource: resourceGraph }); assertOwner();
        await toEntry(); assertOwner(); return result;
      };
      await toEntry(); assertOwner();
      const { createHouseQuarry } = require("./minecraft/houseQuarry");
      const quarry = createHouseQuarry({
        getBot: () => currentBot, assertActive: assertOwner, report,
        hasFurnace:()=>{const p=ownerTask.materialSupply?.ownedStations?.furnace?.position;return Boolean(p&&at(p)?.name==="furnace");},
        isProtectedDig: protectedDig,
        resumeAfterSurvival: resumeHouseResourceAfterSurvival,
        returnEntryAfterSurvival: async () => {
          assertOwner();await returnHouseCamp(context.anchor,{resource:resourceGraph});assertOwner();
          await toEntry();assertOwner();
          recordTaskDiagnostic(ownerTask,'house_quarry_supply_entry_rejoined',{
            actual:toPlainPosition(bot.entity.position),entry:entry.position,originalQuarryCursorPreserved:true,
            materialCredit:false,frontierArrivalConfirmed:false});
        },
        getCP: () => ownerTask.materialSupply?.quarry,
        saveCP: value => { assertOwner(); ownerTask.materialSupply = { ...ownerTask.materialSupply, quarry: value }; },
        prepareCapacity: options => {
          assertOwner();
          if(capacityFor(name)>=amount&&bot.inventory.slots.slice(9,45).filter(i=>!i).length>=4)return true;
          return supplyAtCamp(() => source.stash({ ...context.requirements, ...options.preserve }));
        },
        ensureSticks: count => {
          assertOwner();
          return getItemCountByName("stick") >= count ? true : supplyAtCamp(() => ensureSticks(count));
        },
        ensureFood: async options => {
          assertOwner();
          // Eating a carried meal is local maintenance, not a new camp trip.
          // Do not ignore food in the backpack until health or hunger is critical.
          if(findBestFoodItem()&&bot.food<=18&&hasGroundedBodySupport(bot)){
            await maintainSurvival();assertOwner();
          }
          if(bot.food>=8&&bot.health>=6&&!(bot.health<10&&bot.food<18))return true;
          return supplyAtCamp(async()=>{await maintainSurvival();assertOwner();return true;});
        },
        ensurePickaxe: async (block, options) => {
          assertOwner();
          const preparationOnly = options.preparationOnly === true;
          const needsStone = preparationOnly ? ["raw_iron", "lapis_lazuli"].includes(options.resource)
            : ["iron_ore", "deepslate_iron_ore", "lapis_ore", "deepslate_lapis_ore"].includes(block.name);
          const accepted = needsStone
            ? ["stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"] : PICKAXE_ITEM_NAMES;
          const harvests = tool => preparationOnly || block.canHarvest(tool.type);
          const reserveAllows=tool=>options.preserveIronReserve!==true||require('./minecraft/houseQuarry').canSpendQuarryPickaxe(bot,block,tool);
          let item = bot.inventory.items().find(tool => accepted.includes(tool.name)
            && remainingHouseToolDurability(tool) >= (options.minDurability || 8) && harvests(tool)&&reserveAllows(tool));
          if (item) { await equipInventoryItem(item); assertOwner(); return item; }
          return supplyAtCamp(async () => {
            const toolName = !accepted.includes("wooden_pickaxe") || getItemCountByName("cobblestone") >= 3 ? "stone_pickaxe" : "wooden_pickaxe";
            // A deep fishbone trip consumes several stone tools. Craft a
            // bounded reserve during this real camp visit instead of walking
            // the entire return route once per exhausted pickaxe.
            await source.ensure({ [toolName]: getItemCountByName(toolName) + 3 }); assertOwner();
            item = bot.inventory.items().find(tool => accepted.includes(tool.name)
              && remainingHouseToolDurability(tool) >= 8 && harvests(tool)&&reserveAllows(tool));
            if (!item) throw Object.assign(new Error("自采矿道缺少可用镐子"), { code: "house_resource_tool_missing" });
            await equipInventoryItem(item); assertOwner(); return item;
          });
        },
        equipItem: equipInventoryItem, digBlock: physicalDigBlock,
        ensureLighting: () => supplyAtCamp(async()=>{
          assertOwner();
          const recipeBatches=Math.ceil(Math.max(0,32-getItemCountByName('torch'))/4);
          if(recipeBatches)await source.takeOwnedStock({torch:32,coal:recipeBatches,charcoal:recipeBatches,stick:recipeBatches});assertOwner();
          const batch=require('./minecraft/houseQuarryLighting').quarryLightingBatch(getItemCountByName('torch'),getItemCount(TORCH_FUEL_ITEM_NAMES));
          if(!batch.batches)return;
          // Charcoal closes the bootstrap loop without mining coal in darkness.
          const fuelMissing=batch.missingFuel;
          if(fuelMissing){
            const wood=getAvailableLogName()||ownerTask.materialSupply?.camp?.logName||"oak_log";
            const planks=LOG_TO_PLANK[wood];
            await source.ensure({[wood]:fuelMissing,[planks]:batch.smeltingPlanks,stick:batch.sticks});assertOwner();
            await executeSmeltItem({args:{inputItems:[wood],output:"charcoal",additionalCount:fuelMissing}});assertOwner();
          }else {await source.ensure({stick:batch.sticks});assertOwner();}
          // After a furnace window, use a fresh native table window for this
          // small recipe too. Repeated live inventory-grid attempts consumed
          // inputs without a confirmed output; never repeat that failed strategy.
          const table=await source.ensureStation("crafting_table");assertOwner();
          await require('./minecraft/houseQuarryLighting').craftQuarryLighting({assertActive:assertOwner,
            count:()=>getItemCountByName('torch'),craft:additional=>craftItemByName('torch',additional,table)});assertOwner();
        }),
        lightRoute: (navigation,previous) => require("./minecraft/houseQuarryLighting").lightHouseQuarry({
          getBot:()=>currentBot,assertActive:assertOwner,isExcluded:p=>inBounds(p,context.exclusionBounds||[]),
          place:async p=>{
            assertOwner();const target=toVec3(p),floor=bot.blockAt(target.offset(0,-1,0));
            const item=findInventoryItem(["torch"]);
            if(!item)throw Object.assign(Error("矿道照明缺少火把"),{code:"house_quarry_torches_required"});
            await equipInventoryItem(item);assertOwner();
            await physicalPlaceBlock(floor,new Vec3(0,1,0),target,"torch");assertOwner();
            const until=Date.now()+1200;
            while(bot.blockAt(target)?.name!=="torch"&&Date.now()<until){await sleep(50);assertOwner();}
            if(bot.blockAt(target)?.name!=="torch")throw Object.assign(Error("没有确认矿道火把"),{code:"house_quarry_torch_unconfirmed"});
            recordTaskDiagnostic(ownerTask,"house_quarry_torch_confirmed",{position:p,actual:"torch",materialCredit:false});
          },
        },navigation,previous),
        collectDrops: options => options?.allowMovement === false ? sleep(500) : collectNearbyDroppedItems(options),
        navigationOptions: { goto: miningPathfinderGoto,
          isOwnedDefenseActive: () => {
            const defense=activeSurvivalInterrupt,move=activeMiningNavigationMove;
            return Boolean(defense && !defense.finished && defense.miningMove===move && move?.bot===bot
              && move.task===ownerTask && move.lease===lease && defense.previousLease===lease
              && (defense.workToken||defense.token)===token && isSurvivalOwnerCurrent(defense)
              && isMovementLeaseActive(defense.lease) && !token?.cancelled && !token?.pauseRequested);
          },
          settleOwnedDefense: async () => {
            const defense=activeSurvivalInterrupt;
            if(defense?.miningMove?.bot===bot && defense.task===ownerTask && defense.previousLease===lease
              && (defense.workToken||defense.token)===token) await settleSurvivalDefense('quarry_navigation_drain');
          },
        },
      });
      try {
        const result = await withSurfaceResourceMovements(() =>
          quarry.gather(name, amount, { anchor: entry.position, excludeBounds: context.exclusionBounds }));
        assertOwner(); await toCamp(); assertOwner(); return result;
      } catch (error) {
        const recoverable = /^house_quarry_(?:search_timeout|search_limit|supply_limit|food_required|low_health|no_safe_route)$/.test(String(error.code || ""));
        const unknownRoute = error.retreatError || error.rejections?.some(item => item.code === "MINING_UNLOADED");
        if (recoverable && !unknownRoute) {
          try { assertOwner(); await toCamp(); }
          catch (returnError) { error.quarryEntryReturnError = { code: returnError.code, message: returnError.message }; }
        }
        throw error;
      }
    };
    const imminentSurvivalThreat=()=>Object.values(bot.entities||{}).some(e=>{
      if(e===bot.entity||e.isValid===false||!isThreateningMobEntity(e,bot.registry)||!e.position)return false;
      if(terrainSeparatedHouseMelee(bot,e))return false;
      const range=e.name==="creeper"?8.5:isHouseRangedThreatEntity(e)?24:4.5;
      return e.position.distanceTo(bot.entity.position)<=range&&(!isHouseRangedThreatEntity(e)
        ||require('./minecraft/houseRangedCombat').shouldInterruptWorkForRanged(bot,e,Date.now()-Number(combatMemory.lastBotHurtAt||0)<6500)
          &&!require("./minecraft/houseRangedCover").isHouseRangedPursuitDeferred(bot,e)&&!rangedCoverConfirmed(bot,bot.entity.position,[e]));
    });
    const survivalScheduler = createSurvivalScheduler({
      assertActive:checkTaskSignal,
      observe:()=>({health:bot.health,food:bot.food,safe:hasGroundedBodySupport(bot)&&safeSurfaceFoot(bot.entity.position),
        threat:imminentSurvivalThreat(),
        hasMeal:Boolean(findBestFoodItem()),canProvision:Boolean(source.getCamp()),
        reserveLow:readyFoodPoints()<4,
        localFoodAvailable:Boolean(ownerTask.materialSupply?.ownedStations?.furnace
          &&at(ownerTask.materialSupply.ownedStations.furnace.position)?.name==="furnace"&&findInventoryItem(WEAPON_ITEM_PRIORITY)
          &&Object.values(bot.entities||{}).some(e=>isHuntableFoodAnimal(e,bot.entity.position,8)))}),
      defend:async()=>{await settleSurvivalDefense("survival_scheduler");checkTaskSignal();},
      eat:()=>ensureNutrition(20,{anchor:source.getCamp(),recoveryThresholdOnly:true}),
      recover:()=>prepareHouseRecovery({targetHealth:14,assertActive:checkTaskSignal,
        observe:()=>({health:bot.health,food:bot.food,safe:hasGroundedBodySupport(bot)&&safeSurfaceFoot(bot.entity.position),
          threat:imminentSurvivalThreat()}),
        defend:()=>settleSurvivalDefense("scheduled_recovery"),canProvision:()=>Boolean(source.getCamp()),
        provisionMinimumHealth:()=>Number.MIN_VALUE,hasFood:()=>Boolean(findBestFoodItem()),eat:()=>ensureNutrition(20,{anchor:source.getCamp(),recoveryThresholdOnly:true}),
        onProgress:value=>recordTaskHeartbeat(ownerTask,{actionState:"acting",checkpoint:{kind:"scheduled_recovery",...value}})}),
      provision:()=>ensureFoodSupply(8,{anchor:source.getCamp(),minFoodPoints:8,surfaceMaintenance:true}),
      record:(type,facts)=>recordTaskDiagnostic(ownerTask,type,facts),
    });
    let starterObservationAt=0;
    const prepareStarterNight=async()=>{
      const starter=require('./minecraft/houseStarterAlcove'),saved=ownerTask.materialSupply?.starterAlcove;
      const enclosed=starter.starterAlcoveConfirmed(bot,saved?.plan);
      if(Date.now()-starterObservationAt>5000){starterObservationAt=Date.now();recordTaskDiagnostic(ownerTask,'house_starter_native_readiness',{
        timeOfDay:bot.time?.timeOfDay,age:bot.time?.age,health:bot.health,food:bot.food,enclosed,
        hasWeapon:Boolean(findInventoryItem(WEAPON_ITEM_PRIORITY)),hasPick:Boolean(findInventoryItem(PICKAXE_ITEM_NAMES)),
        imminentThreat:imminentSurvivalThreat(),grounded:hasGroundedBodySupport(bot),dry:safeSurfaceFoot(bot.entity.position),actual:toPlainPosition(bot.entity.position)});}
      if(!enclosed&&(findInventoryItem(WEAPON_ITEM_PRIORITY)||findInventoryItem(PICKAXE_ITEM_NAMES)
        ||!Number.isFinite(bot.time?.timeOfDay)||bot.time.timeOfDay<12000||bot.health<14||bot.food<8
        ||imminentSurvivalThreat()||!hasGroundedBodySupport(bot)||!safeSurfaceFoot(bot.entity.position)))return false;
      const client=bot._client,generation=ownerTask.executionGeneration,token=ownerTask.cancellationToken,lease=getCurrentMovementLease();
      const active=()=>{checkTaskSignal();if(currentBot!==bot||bot._client!==client||currentTask!==ownerTask
        ||ownerTask.executionGeneration!==generation||ownerTask.cancellationToken!==token||!isMovementLeaseActive(lease))throw createAbortError('movement_preempted');};
      const result=await withSurfaceResourceMovements(()=>starter.prepareStarterAlcove({
        getBot:()=>currentBot,assertActive:active,isOwnerCurrent:()=>currentTask===ownerTask&&isMovementLeaseActive(lease),
        resumeAfterDefense:(error,options)=>resumeHouseResourceAfterSurvival(error,{deadline:options.deadline,bot}),
        getState:()=>ownerTask.materialSupply.starterAlcove,
        saveState:value=>{active();const previous=ownerTask.materialSupply.starterAlcove;
          if(previous?.plan&&value.plan!==previous.plan&&JSON.stringify(value.plan)!==JSON.stringify(previous.plan)){
            if((ownerTask.materialSupply.starterAlcoveHistory||[]).length>=32)throw Object.assign(Error('起步土坡历史已到原有限上限'),{code:'house_starter_history_limit'});
            ownerTask.materialSupply.starterAlcoveHistory=[...(ownerTask.materialSupply.starterAlcoveHistory||[]),previous];
          }
          ownerTask.materialSupply.starterAlcove=value;},
        excluded:houseResourcePositionExcluded,hasThreat:imminentSurvivalThreat,
        hasConstructionThreat:()=>Object.values(bot.entities||{}).some(e=>e!==bot.entity&&e.isValid!==false&&e.position
          &&isThreateningMobEntity(e,bot.registry)&&e.position.distanceTo(bot.entity.position)<=16&&!terrainSeparatedHouseMelee(bot,e)),
        countDirt:()=>getItemCountByName('dirt'),
        goto:(goal,budget)=>houseSurfacePathfinderGoto(goal,Math.min(15000,budget),{fieldExploration:true}),
        dig:block=>physicalDigBlock(block,'起步土坡避难点'),place:spec=>placeFurnishedHouseBlock(spec),
        rememberSeal:spec=>require('./minecraft/houseCombatMode').rememberCombatCover(ownerTask.materialSupply,spec),
        retireSeal:spec=>{active();const same=s=>s.position.x===spec.position.x&&s.position.y===spec.position.y&&s.position.z===spec.position.z;
          ownerTask.materialSupply.defensiveCoverBlocks=(ownerTask.materialSupply.defensiveCoverBlocks||[]).filter(s=>!same(s));
          if(ownerTask.materialSupply.defensiveCover)ownerTask.materialSupply.defensiveCover.placed=ownerTask.materialSupply.defensiveCover.placed.filter(s=>!same(s));},
        exitThreatPresent:()=>Object.values(bot.entities||{}).some(e=>e!==bot.entity&&e.isValid!==false&&e.position
          &&isThreateningMobEntity(e,bot.registry)&&e.position.distanceTo(bot.entity.position)<(e.name==='creeper'?10:isHouseRangedThreatEntity(e)?16:5)),
        report:setTaskProgress,record:(type,facts)=>recordTaskDiagnostic(ownerTask,type,facts),
        onNativeClock:facts=>recordTaskHeartbeat(ownerTask,{actionState:'waiting_for_native_daylight',checkpoint:{kind:'starter_alcove_native_clock',...facts}}),
      }),{deadline:Date.now()+900000});active();
      if(!result.used)recordTaskDiagnostic(ownerTask,'house_starter_native_plan_unavailable',{reason:result.reason,timeOfDay:bot.time?.timeOfDay,actual:toPlainPosition(bot.entity.position)});
      return result.used===true;
    };
    const maintainCarriedSurvival=async()=>{
      const context=getExecutionContext();
      if(context?.carriedMealMaintenance||foodConsumptionFlights.has(bot)||activeSurvivalInterrupt
        ||!hasGroundedBodySupport(bot)||!safeSurfaceFoot(bot.entity.position)||imminentSurvivalThreat()
        ||bot.health>=14||bot.health<=0)return null;
      const carried=()=>selectBootstrapFood(bot.inventory.items(),{health:bot.health,food:bot.food});
      if(bot.food<18&&!carried())return null;
      return executionContextStorage.run({...context,carriedMealMaintenance:true},()=>withSurfaceResourceMovements(async()=>{
        checkTaskSignal();const deadline=Date.now()+90000;
        const active=()=>{checkTaskSignal();if(Date.now()>=deadline)throw Object.assign(Error('随身进食恢复达到原有限时限'),{code:'house_local_meal_timeout'});};
        const meal=await restoreLocalSurvivalMeal({assertActive:active,
          observe:()=>({maintenance:true,hasWeapon:Boolean(findInventoryItem(WEAPON_ITEM_PRIORITY)),hasEmergencyMeal:Boolean(carried()),health:bot.health,food:bot.food}),
          acquireAndEat:()=>ensureHouseBootstrapFood(18,{deadline:Math.min(deadline,Date.now()+35000),carriedOnly:true})});
        active();
        if(meal)recordTaskDiagnostic(ownerTask,'house_nested_survival_meal_confirmed',meal);
        if(bot.food>=18&&bot.health<14){
          await safeBotLookAt(bot.entity.position.offset(0,-1,0),true,{reason:'carried_meal_passive_recovery'});active();
          await prepareHouseRecovery({targetHealth:14,assertActive:active,
            observe:()=>({health:bot.health,food:bot.food,safe:hasGroundedBodySupport(bot)&&safeSurfaceFoot(bot.entity.position),threat:imminentSurvivalThreat()}),
            defend:()=>settleSurvivalDefense('carried_meal_passive_recovery'),
            hasFood:()=>Boolean(carried()),eat:()=>ensureHouseBootstrapFood(20,{deadline:Math.min(deadline,Date.now()+35000),carriedOnly:true}),
            onProgress:facts=>recordTaskHeartbeat(ownerTask,{actionState:'acting',checkpoint:{kind:'carried_meal_native_recovery',...facts}})});
          active();recordTaskDiagnostic(ownerTask,'house_nested_native_health_recovered',{health:bot.health,food:bot.food,originalDeadline:deadline});
        }
        return meal;
      },{deadline:Date.now()+90000}));
    };
    const maintainSurvival=async()=>{
      if(require('./minecraft/houseCombatMode').combatCover(ownerTask.materialSupply).length)
        recordTaskDiagnostic(ownerTask,'house_combat_cleanup_boundary_observed',{
          nestedSurvival:Boolean(getExecutionContext()?.survivalMaintenance),health:bot.health,food:bot.food,
          activeDefense:Boolean(activeSurvivalInterrupt),grounded:hasGroundedBodySupport(bot),dry:safeSurfaceFoot(bot.entity.position)});
      if(getExecutionContext()?.survivalMaintenance)return maintainCarriedSurvival();
      return executionContextStorage.run({...getExecutionContext(),survivalMaintenance:true},async()=>{
        await maintainCarriedSurvival();checkTaskSignal();
        await prepareStarterNight();checkTaskSignal();
        await survivalScheduler.runBoundary();checkTaskSignal();
        if(!hasGroundedBodySupport(bot)&&bot.entity.isInWater!==true&&bot.entity.isInLava!==true)await waitForSurfaceGround('起步避难准备');
        await prepareStarterNight();checkTaskSignal();
        // Urgent meals/defense may finish first, but ordinary production must
        // reconcile owned combat obstacles even when already near the camp.
        if(require('./minecraft/houseCombatMode').combatCover(ownerTask.materialSupply).length){
          if(activeSurvivalInterrupt)await settleSurvivalDefense('combat_cleanup_boundary');
          checkTaskSignal();
          if(!safeSurfaceFoot(bot.entity.position)&&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry)
            await alignHouseResourceGraphOrigin(ownerTask,Date.now()+12000);
          checkTaskSignal();
          if(!hasGroundedBodySupport(bot))await waitForSurfaceGround('战后清理');
          // Initial native water/ground flags may not exist at the first
          // boundary. Retry the shelter prerequisite after actual landing,
          // before committing the empty survivor to a long wood search.
          await prepareStarterNight();checkTaskSignal();
          if(activeSurvivalInterrupt||imminentSurvivalThreat()||bot.health<12||bot.food<8
            ||!hasGroundedBodySupport(bot)||!safeSurfaceFoot(bot.entity.position)){
            throw Object.assign(Error('先完成自卫与安全恢复，再清理战斗障碍继续原任务'),{code:'house_combat_cleanup_pending'});
          }
          const remoteCover=require('./minecraft/houseCombatMode').combatCover(ownerTask.materialSupply)
            .some(spec=>bot.entity.position.distanceTo(toVec3(spec.position))>32);
          if(remoteCover&&needsLocalCleanupTools()&&bot.health>=14){
            await executionContextStorage.run({...getExecutionContext(),cleanupToolPreparation:ownerTask.taskId},async()=>{
              recordTaskDiagnostic(ownerTask,'house_cleanup_local_tools_started',{health:bot.health,food:bot.food,
                cleanupPending:require('./minecraft/houseCombatMode').combatCover(ownerTask.materialSupply).length,originalTaskResumed:false});
              await source.prepareSurvivalTools({deadline:Date.now()+600000,localWorkshopOnly:true});checkTaskSignal();
              if(!findInventoryItem(WEAPON_ITEM_PRIORITY))throw Object.assign(Error('远程清障前尚未实际取得基础武器'),{code:'house_cleanup_weapon_pending'});
              if(!findInventoryItem(PICKAXE_ITEM_NAMES))throw Object.assign(Error('远程清障前尚未实际取得基础镐'),{code:'house_cleanup_pick_pending'});
              recordTaskDiagnostic(ownerTask,'house_cleanup_local_weapon_confirmed',{weapon:bot.heldItem?.name,
                cleanupPending:require('./minecraft/houseCombatMode').combatCover(ownerTask.materialSupply).length,originalTaskResumed:false});
            });
          }
          if(bot.food<18){
            recordTaskDiagnostic(ownerTask,'house_cleanup_food_preparation_started',{health:bot.health,food:bot.food,
              weapon:bot.heldItem?.name,originalTaskResumed:false});
            await ensureHouseBootstrapFood(18,{deadline:Date.now()+180000,nutritionFirst:true});checkTaskSignal();
          }
          if(bot.food<18||bot.health<12||activeSurvivalInterrupt||imminentSurvivalThreat()
            ||!hasGroundedBodySupport(bot)||!safeSurfaceFoot(bot.entity.position))
            throw Object.assign(Error('远程清障准备尚未实际确认安全生命与口粮'),{code:'house_combat_cleanup_pending'});
          if(remoteCover&&findInventoryItem(WEAPON_ITEM_PRIORITY)
            &&getItemCountByName('dirt')+getItemCountByName('cobblestone')<32){
            recordTaskDiagnostic(ownerTask,'house_cleanup_cover_reserve_started',{dirt:getItemCountByName('dirt'),
              cobblestone:getItemCountByName('cobblestone'),required:32,originalTaskResumed:false});
            await source.ensure({dirt:Math.max(0,32-getItemCountByName('cobblestone'))});checkTaskSignal();
            if(getItemCountByName('dirt')+getItemCountByName('cobblestone')<32)
              throw Object.assign(Error('远程清障前尚未实际取得临时掩体材料'),{code:'house_cleanup_cover_reserve_pending'});
            recordTaskDiagnostic(ownerTask,'house_cleanup_cover_reserve_confirmed',{dirt:getItemCountByName('dirt'),
              cobblestone:getItemCountByName('cobblestone'),granted:false,originalTaskResumed:false});
          }
          if(bot.food<18||bot.health<12||activeSurvivalInterrupt||imminentSurvivalThreat()
            ||!hasGroundedBodySupport(bot)||!safeSurfaceFoot(bot.entity.position))
            throw Object.assign(Error('远程清障准备尚未实际确认安全生命与口粮'),{code:'house_combat_cleanup_pending'});
          await finishHouseCombatCleanup(ownerTask);checkTaskSignal();
          const pending=require('./minecraft/houseCombatMode').combatCover(ownerTask.materialSupply).length;
          require('./minecraft/houseCombatMode').transitionCombat(ownerTask.materialSupply,pending?'cleanup_pending':'resumed',{cleanupPending:pending});
          recordTaskDiagnostic(ownerTask,pending?'house_combat_cleanup_required':'house_combat_task_resumed',ownerTask.materialSupply.combatMode);
        }
      });
    };
    source = createHouseSelfSupplyRuntime({
      getBot: () => ensureBotReady(), assertActive: checkTaskSignal, report, blockAt: at,
      canPrepareSurvivalTools:()=>{
        const allowed=safeLocalSurvivalBootstrap()||safeCleanupToolBootstrap()
          ||getExecutionContext()?.foodWeaponReplacement===ownerTask.taskId&&bot.health>=14&&bot.food>=12
            &&!findInventoryItem(WEAPON_ITEM_PRIORITY)&&hasGroundedBodySupport(bot)&&naturalWalkingFoot(bot,bot.entity.position.floored())&&!imminentSurvivalThreat()
            &&bot.inventory.items().reduce((n,i)=>n+(i.name.endsWith('_log')?4*i.count:i.name.endsWith('_planks')?i.count:0),0)>=12;
        const logs=bot.findBlocks({matching:b=>b&&b.name.endsWith('_log'),point:bot.entity.position,maxDistance:6,count:3});
        if(Date.now()-lastSurvivalBootstrapProbe>10000){
          lastSurvivalBootstrapProbe=Date.now();
          recordTaskDiagnostic(ownerTask,"house_survival_tools_readiness",{allowed,health:bot.health,food:bot.food,
            position:toPlainPosition(bot.entity.position),grounded:hasGroundedBodySupport(bot),
            dry:naturalWalkingFoot(bot,bot.entity.position.floored()),threat:immediateFoodThreat(bot),
            cleanupPreparation:getExecutionContext()?.cleanupToolPreparation===ownerTask.taskId,imminentThreat:imminentSurvivalThreat(),
            nearby:Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&e.isValid!==false&&e.position
              &&e.position.distanceTo(bot.entity.position)<=32).slice(0,24).map(e=>({id:e.id,name:e.name,type:e.type,
                threatening:isThreateningMobEntity(e,bot.registry),distance:e.position.distanceTo(bot.entity.position),position:toPlainPosition(e.position)})),
            campDistance:bot.entity.position.distanceTo(toVec3(source.getCamp())),logs:logs.map(toPlainPosition)});
        }
        // No nearby trunk means switch to the existing bounded wood graph,
        // which uses observed-resource hints. It is not a reason to repeat an
        // empty food ring. Every actual dig still stays within6m of its leg.
        return allowed;
      },
      leaveConstructionInterior:async()=>{
        const p=bot.entity.position,a=blueprint.anchor,d=blueprint.dimensions,door=blueprint.furniture?.door;
        if(!d||!door||p.x<a.x||p.x>a.x+d.width||p.z<a.z||p.z>a.z+d.depth||Math.abs(p.y-a.y)>8)return;
        if(at(door.lower)?.name!=='oak_door'||at(door.upper)?.name!=='oak_door')return;
        await withFurnishedHouseMovements(async()=>{
          await furnishedHouseMoveTo(door.lower,2);checkTaskSignal();
          if(at(door.lower).getProperties?.().open!==true){await safeBotActivateBlock(at(door.lower));await sleep(180);checkTaskSignal();}
          if(![door.lower,door.upper].every(p=>at(p)?.getProperties?.().open===true))throw Object.assign(Error('采料前房门未实际开启'),{code:'house_furniture_unusable'});
          await furnishedHouseMoveTo(blueprint.entrance.outside);checkTaskSignal();
          recordTaskDiagnostic(ownerTask,'house_resource_interior_exit_confirmed',{actual:toPlainPosition(bot.entity.position),target:blueprint.entrance.outside});
        });
      },
      onPreparationStage:(stage,facts)=>recordTaskDiagnostic(ownerTask,"house_preparation_stage",{stage,...facts,
        ...(["crafting_table","storage"].includes(stage)?{stations:Object.values(ownerTask.materialSupply?.ownedStations||{}).map(e=>({position:e.position,actual:at(e.position)?.name,properties:at(e.position)?.getProperties?.()})),
          chests:(ownerTask.materialSupply?.storage?.chests||[]).map(e=>({position:e.position,actual:at(e.position)?.name,properties:at(e.position)?.getProperties?.()}))}:{})}),
      withCampWork: action => runAtHouseCamp({ resource: getExecutionContext()?.houseSurfaceResource || ownerTask.materialSupply?.activeSurfaceGraph }, action),
      getCheckpoint: () => ownerTask.materialSupply,
      setCheckpoint: (value, options) => { if (!options?.confirmedFact) checkTaskSignal(); ownerTask.materialSupply = value; },
      isSourceContext: candidate => getExecutionContext()?.houseSelfSupply === candidate && (getExecutionContext()?.task || currentTask) === ownerTask,
      withContext: (runtime, bounds, action) => {
        const outer = getExecutionContext() || {};
        return executionContextStorage.run({ ...outer, houseSelfSupply: runtime, selfSupplyOnly: true, houseResourceExclusionBounds: bounds }, () =>
          withHouseNativeSourceGuard(bot, { assertActive: () => { checkTaskSignal(); ensureMovementLeaseActive(getCurrentMovementLease()); },
            allowNativeCancel: (bot, name, data) => isOwnedFluidNativeCancel(bot, name, data) || isOwnedHouseNativeDigCancel(bot, name, data) || isOwnedNaturalHouseXPCancel(bot, name, data),
            beforeSend: (_bot, packetName, payload) => {
              if (packetName === "block_dig" && [0, 2].includes(payload?.status)) assertHouseResourceDigAllowed(payload.location);
            },
            isOwnerContext: () => getExecutionContext()?.houseSelfSupply === runtime }, () => withSurfaceResourceMovements(action)));
      },
      onOperationTimeout: error => {
        const context = getExecutionContext();
        if (currentTask === ownerTask && (context?.runGeneration == null || ownerTask.executionGeneration === context.runGeneration)) {
          ownerTask.watchdogAbortCode = error.code; ownerTask.watchdogAbortMessage = error.message;
          ownerTask.cancellationToken?.pause();
        }
      },
      chooseCamp: async (_blueprint, bounds) => {
        const reservation = ownerTask.siteSearch?.reservation;
        if (reservation) {
          checkTaskSignal();
          if (reservation.houseAnchor?.x !== _blueprint.anchor.x || reservation.houseAnchor?.y !== _blueprint.anchor.y ||
              reservation.houseAnchor?.z !== _blueprint.anchor.z || reservation.profile !== _blueprint.profile) {
            throw Object.assign(new Error("原选址营地不能用于另一房屋"), { code: "house_site_search_reservation_changed" });
          }
          const captured = getExecutionContext() || {}, generation = ownerTask.executionGeneration, lease = getCurrentMovementLease();
          const client = bot._client, token = captured.token || getActiveCancellationToken();
          const assertCampOwner = () => {
            token?.throwIfRequested(); checkTaskSignal();
            const now = getExecutionContext();
            if (currentBot !== bot || bot._client !== client || currentTask !== ownerTask || ownerTask.executionGeneration !== generation ||
                ownerTask.movementLease !== lease || lease && !isMovementLeaseActive(lease) ||
                now?.task !== captured.task || now?.token !== captured.token || now?.runGeneration !== captured.runGeneration ||
                now?.movementLease !== captured.movementLease) throw createAbortError("movement_preempted");
          };
          const proof = validateNaturalSiteReservation({ reservation, profile: _blueprint.profile,
            ownerIdentity: { taskId: ownerTask.taskId, generation }, bot, assertActive: assertCampOwner,
            inspectHouseSite: require('./minecraft/naturalHouseSites').inspectCreatableHouseSite,
            blockAt: position => { assertCampOwner(); const block = at(position); assertCampOwner(); return block; } });
          assertCampOwner();
          if (!proof.valid) throw Object.assign(new Error("原选址地形或实际营地已变化，保留原任务"),
            { code: "house_site_search_reservation_changed", reason: proof.reason });
          return proof.camp;
        }
        const boundary = bounds[0];
        const points = [];
        for (const x of [boundary.minX - 8, boundary.maxX + 8]) for (let z = boundary.minZ - 8; z <= boundary.maxZ + 8; z += 4) points.push({ x, z });
        for (const z of [boundary.minZ - 8, boundary.maxZ + 8]) for (let x = boundary.minX - 8; x <= boundary.maxX + 8; x += 4) points.push({ x, z });
        points.sort((a, b) => Math.hypot(a.x - bot.entity.position.x, a.z - bot.entity.position.z) - Math.hypot(b.x - bot.entity.position.x, b.z - bot.entity.position.z));
        const site = (x, z, nearY) => {
          for (let dy = 0; dy <= 12; dy += 1) for (const offset of dy ? [dy, -dy] : [0]) {
            const p = { x, y: nearY + offset, z };
            if (!inBounds(p, bounds) && [at(p), at({ ...p, y: p.y + 1 })].every(block => ["air", "cave_air", "void_air"].includes(block?.name))
              && safeSurfaceFoot(toVec3(p))) return p;
          }
          return null;
        };
        for (const point of points) {
          checkTaskSignal();
          const anchor = site(point.x, point.z, Math.floor(bot.entity.position.y));
          if (!anchor) continue;
          const candidates = [];
          for (let radius = 2; radius <= 8; radius += 2) for (const [dx, dz] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius], [radius, radius], [-radius, radius], [radius, -radius], [-radius, -radius]]) {
            const p = site(anchor.x + dx, anchor.z + dz, anchor.y);
            if (p && candidates.every(q => p.x !== q.x || p.z !== q.z)) candidates.push(p);
          }
          if (candidates.length >= 10) return { anchor, stations: { crafting_table: candidates[0], furnace: candidates[1] }, storageSites: candidates.slice(2, 10) };
        }
        throw Object.assign(new Error("尚未找到建筑范围外可自建工作台与仓库的安全营地"), { code: "house_self_supply_no_camp" });
      },
      survivalBeforeReturn:async()=>{
        if(bot.health<14&&bot.food<18||ownerTask.materialSupply?.provisioningReturnNeeded&&bot.health<14
          &&bot.entity.position.distanceTo(toVec3(source.getCamp()))>12)await maintainSurvival();
      },
      updateResourceBounds:bounds=>{getExecutionContext().houseResourceExclusionBounds=bounds;},
      shouldBootstrapField:async()=>{
        checkTaskSignal();
        const hasWeapon=Boolean(findInventoryItem(WEAPON_ITEM_PRIORITY)),hasPick=Boolean(findInventoryItem(PICKAXE_ITEM_NAMES));
        if(!hasWeapon&&!hasPick&&bot.entity.position.distanceTo(toVec3(source.getCamp()))>32){
          await alignHouseResourceGraphOrigin(ownerTask,Date.now()+12000,getExecutionContext()?.houseResourceExclusionBounds||constructionBounds);checkTaskSignal();
        }
        const facts={health:bot.health,food:bot.food,campDistance:bot.entity.position.distanceTo(toVec3(source.getCamp())),
          hasWeapon:Boolean(findInventoryItem(WEAPON_ITEM_PRIORITY)),hasPick:Boolean(findInventoryItem(PICKAXE_ITEM_NAMES)),
          grounded:hasGroundedBodySupport(bot),dryFoot:naturalWalkingFoot(bot,bot.entity.position.floored())};
        facts.ownedBootstrapStockHint=facts.health>=16&&facts.food>=14&&facts.campDistance<=96
          &&require('./minecraft/houseOwnedStockCamp').hasOwnedBootstrapWoodHint(ownerTask.materialSupply,at);
        const ownedTablePosition=ownerTask.materialSupply?.ownedStations?.crafting_table?.position;
        facts.ownedWorkshopObservation=ownedTablePosition?(at(ownedTablePosition)?.name||'UNKNOWN'):'NO_OWNED_WORKSHOP';
        const selected=shouldBootstrapField(facts);
        recordTaskDiagnostic(ownerTask,'house_field_bootstrap_strategy',{...facts,selected,actual:toPlainPosition(bot.entity.position)});
        return selected;
      },
      restorePriorCamp:async(state,request={})=>{
        const activeWorkshop=Boolean(Object.keys(state.ownedStations||{}).length);
        if(activeWorkshop&&!request.requirements?.glass&&!request.woolReuse)return null;
        for(const prior of require('./minecraft/houseOwnedStockCamp').latestOwnedCampArchives(state)){
          const stockVisit=activeWorkshop&&(require("./minecraft/houseOwnedStockCamp").ownsNeededGlass(prior,request.requirements,getItemCountByName)
            ||bot.entity.position.distanceTo(toVec3(prior.camp.anchor))<=32
              &&require('./minecraft/houseOwnedStockCamp').ownsGlassInputs(prior,request.requirements,getItemCountByName)
            ||request.woolReuse===true&&require("./minecraft/houseOwnedStockCamp").ownsUsefulWoolStock(prior,getItemCountByName));
          if(activeWorkshop&&!stockVisit)continue;
          // An empty-handed respawn must obtain local tools before another
          // exposed archive tour. Keep all ownership and stock receipts.
          if(!findInventoryItem(WEAPON_ITEM_PRIORITY)&&!findInventoryItem(PICKAXE_ITEM_NAMES)
            &&(!prior.camp?.anchor||bot.entity.position.distanceTo(toVec3(prior.camp.anchor))>12))continue;
          if(request.localOnly===true&&(!['x','y','z'].every(k=>Number.isSafeInteger(prior.camp?.anchor?.[k]))
            ||bot.entity.position.distanceTo(toVec3(prior.camp?.anchor))>12
            ||!naturalWalkingFoot(bot,toVec3(prior.camp?.anchor))
            ||Object.entries(prior.ownedStations||{}).some(([name,value])=>at(value.position)?.name!==name)
            ||!prior.storage?.chests?.some(c=>at(c.position)?.name==="chest")))continue;
          if(!prior.ownedStations?.crafting_table||!prior.ownedStations?.furnace||!prior.storage?.chests?.length)continue;
          if(require("./minecraft/houseRetiredCampRoute").retiredCampKnownUnusable(prior.camp,at)){
            recordTaskDiagnostic(ownerTask,"house_prior_camp_known_unusable",{anchor:prior.camp.anchor,reason:"loaded_actual_entry_changed",stockCredit:false});
            continue;
          }
          const route=require("./minecraft/houseRetiredCampRoute").selectRetiredCampRoute(
            {...state,camp:prior.camp},toPlainPosition(bot.entity.position.floored()),p=>naturalWalkingFoot(bot,toVec3(p)));
          if(stockVisit&&!route&&bot.entity.position.distanceTo(toVec3(prior.camp.anchor))>32){
            if(!findInventoryItem(WEAPON_ITEM_PRIORITY)||!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry
              ||bot.entity.position.distanceTo(toVec3(prior.camp.anchor))>384
              ||at(prior.storage.chests[0].position)&&at(prior.storage.chests[0].position).name!=="chest")continue;
            const captured=bot._client,generation=ownerTask.executionGeneration;
            const active=()=>{checkTaskSignal();if(currentBot!==bot||bot._client!==captured||ownerTask.executionGeneration!==generation)
              throw createAbortError("movement_preempted");};
            const existing=ownerTask.materialSupply.ownedStockRecovery;
            if(!existing||!existing.graph?.nodes?.[`${Math.floor(bot.entity.position.x)},${Math.floor(bot.entity.position.y)},${Math.floor(bot.entity.position.z)}`]
              ||JSON.stringify(existing.target)!==JSON.stringify(prior.camp.anchor)){
              ownerTask.materialSupply.ownedStockRecovery={target:{...prior.camp.anchor},anchor:toPlainPosition(bot.entity.position.floored()),graph:null,
                previous:existing?{target:existing.target,anchor:existing.anchor,graph:existing.graph}:null};
            }
            const recovery=ownerTask.materialSupply.ownedStockRecovery,deadline=Date.now()+180000;
            recordTaskDiagnostic(ownerTask,"house_owned_stock_camp_visit_started",{target:prior.camp.anchor,glassReceipt:true,inventoryCredit:false});
            for(let i=0;i<24&&bot.entity.position.distanceTo(toVec3(prior.camp.anchor))>24;i++){
              active();if(Date.now()>=deadline)throw Object.assign(Error("前往旧自有物资营地达到本轮时限"),{code:"house_owned_stock_visit_timeout"});
              const result=await exploreHouseSurfaceGraph(ownerTask,"house_owned_stock_camp",recovery.anchor,report,{
                assertGraphActive:active,excludeBounds:[],ownedStockTarget:{anchor:prior.camp.anchor,chest:prior.storage.chests[0].position},
                graphCheckpoint:{get:()=>recovery.graph,save:value=>{active();recovery.graph=value;}}});
              active();if(!result?.moved&&result?.reason!=="finite_attempt_batch_failed")break;
            }
            active();if(bot.entity.position.distanceTo(toVec3(prior.camp.anchor))>32)
              throw Object.assign(Error("尚未实际抵达旧物资营地附近，保留运输路线"),{code:"house_owned_stock_visit_incomplete"});
          }
          if(!route&&!(bot.entity.position.distanceTo(toVec3(prior.camp.anchor))<=32&&naturalWalkingFoot(bot,toVec3(prior.camp.anchor))))continue;
          // A nearby archived camp has its own origin. Revalidate a fresh
          // local dry connection instead of feeding it the active camp graph.
          if(!route)await houseSurfacePathfinderGoto(new goals.GoalBlock(prior.camp.anchor.x,prior.camp.anchor.y,prior.camp.anchor.z),20000);
          else await returnHouseCamp(prior.camp.anchor);
          checkTaskSignal();
          if(!bot.entity.position.floored().equals(toVec3(prior.camp.anchor))||!hasGroundedBodySupport(bot))throw Object.assign(Error("原有营地未实际重返"),{code:"house_prior_camp_return_unconfirmed"});
          const ownedStations=Object.fromEntries(Object.entries(prior.ownedStations).filter(([name,value])=>at(value.position)?.name===name));
          const chests=prior.storage.chests.filter(c=>at(c.position)?.name==="chest").map(c=>({...c,stock:{}}));
          recordTaskDiagnostic(ownerTask,"house_prior_owned_camp_reobserved",{anchor:prior.camp.anchor,stations:Object.keys(ownedStations),chests:chests.map(c=>c.position),stockCredit:false});
          return {...prior,ownedStations,storage:{...prior.storage,chests}};
        }
        return null;
      },
      relocateDestroyedCamp:async(camp,request={})=>{
        checkTaskSignal();
        const origin=bot.entity.position.clone(),enemies=Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&e.isValid!==false&&isThreateningMobEntity(e,bot.registry)&&e.position);
        const ranged=isHouseRangedThreatEntity;
        const threatened=p=>enemies.some(e=>e.position.distanceTo(toVec3(p))<(ranged(e)?24:e.name==="creeper"?8.5:6));
        const exposedCamp=enemies.some(e=>ranged(e)&&e.position.distanceTo(toVec3(camp.anchor))<24
          &&!require("./minecraft/houseRangedCover").isHouseRangedPursuitDeferred(bot,e)&&!rangedCoverConfirmed(bot,toVec3(camp.anchor),[e]));
        const unsafeCamp=exposedCamp&&!findInventoryItem(WEAPON_ITEM_PRIORITY);
        const fieldBootstrap=request.fieldBootstrap===true&&!findInventoryItem(WEAPON_ITEM_PRIORITY)&&!findInventoryItem(PICKAXE_ITEM_NAMES)
          &&bot.entity.position.distanceTo(toVec3(camp.anchor))>32
          &&bot.inventory.items().reduce((n,i)=>n+(i.name.endsWith('_log')?4*i.count:i.name.endsWith('_planks')?i.count:0),0)>=8;
        // Respawn can unload a distant, intact camp. Missing observations are
        // not evidence of explosion damage and must not discard its ownership.
        if(!fieldBootstrap&&[camp.anchor,{...camp.anchor,y:camp.anchor.y+1},{...camp.anchor,y:camp.anchor.y-1}].some(p=>!at(p)))return null;
        if(safeSurfaceFoot(toVec3(camp.anchor))&&!unsafeCamp&&!fieldBootstrap||!hasGroundedBodySupport(bot)||activeHouseSurfaceWater?.isPhysicalOwner())return null;
        const {planHouseCampRelocation}=require("./minecraft/houseCampRelocation");
        const plan=planHouseCampRelocation({from:toPlainPosition(bot.entity.position.floored()),blockAt:at,
          excluded:p=>inBounds(p,constructionBounds)||Object.values(camp.stations).some(q=>q.x===p.x&&q.z===p.z),
          threatened,preferNearby:fieldBootstrap,stepAllowed:p=>enemies.every(e=>e.position.distanceTo(toVec3(p))>=Math.min(ranged(e)?24:8.5,e.position.distanceTo(origin)-.5))});
        recordTaskDiagnostic(ownerTask,"house_camp_relocation_plan",{old:camp.anchor,candidate:plan?.camp.anchor||null,steps:plan?.path.length||0});
        if(!plan)return null;
        const deadline=Date.now()+45000,active=()=>{checkTaskSignal();if(Date.now()>deadline)throw Object.assign(Error("迁移营地行走超时"),{code:"house_camp_relocation_timeout"});};
        for(let i=1;i<plan.path.length;i++){
          active();const from=plan.path[i-1],to=plan.path[i];
          if(!bot.entity.position.floored().equals(toVec3(from))||!safeSurfaceFoot(toVec3(to)))throw Object.assign(Error("迁营路线实际状态已变化"),{code:"house_camp_relocation_changed"});
          const nav=createMiningNavigator({getBot:()=>bot,assertActive:active,preserveMovements:true,maxActions:2,movementTimeoutMs:4000,goto:miningPathfinderGoto,
            digBlock:async()=>{throw Error("迁营优先使用天然通路，禁止额外开挖");}});
          await nav.advance({x:to.x-from.x,z:to.z-from.z},{ascend:to.y>from.y,descend:to.y<from.y});active();
        }
        if(!bot.entity.position.floored().equals(toVec3(plan.camp.anchor))||!hasGroundedBodySupport(bot))throw Object.assign(Error("迁营未实际落地"),{code:"house_camp_relocation_unconfirmed"});
        if([plan.camp.anchor,...Object.values(plan.camp.stations),...plan.camp.storageSites].some(p=>!safeSurfaceFoot(toVec3(p))
          ||![at(p),at({...p,y:p.y+1})].every(b=>classifyMiningBlock(b).passable)))throw Object.assign(Error("迁营到达后设施用地发生变化"),{code:"house_camp_relocation_changed"});
        recordTaskDiagnostic(ownerTask,"house_camp_relocated",{old:camp.anchor,camp:plan.camp,health:bot.health});return plan.camp;
      },
      repairCampAccess:async()=>{
        const anchor=source.getCamp();checkTaskSignal();
        if(!anchor||safeSurfaceFoot(toVec3(anchor))||bot.health<6||bot.food<8
          ||bot.entity.position.distanceTo(toVec3(anchor))>8||!hasGroundedBodySupport(bot))return;
        const {planHouseCampAccess,repairHouseCampAccess}=require("./minecraft/houseCampAccess");
        const bodyCells=new Set(Object.values(ownerTask.materialSupply?.quarry?.routes||{}).flatMap(r=>r.navigation?.breadcrumbs||[])
          .flatMap(p=>[`${p.x},${p.y},${p.z}`,`${p.x},${p.y+1},${p.z}`]));
        const plan=()=>planHouseCampAccess({from:toPlainPosition(bot.entity.position.floored()),goal:anchor,blockAt:at,
          protectedBody:p=>bodyCells.has(`${p.x},${p.y},${p.z}`)});
        const preview=plan();recordTaskDiagnostic(ownerTask,"house_camp_access_plan",{actual:toPlainPosition(bot.entity.position),anchor,
          steps:preview?.steps.length??null,blocks:preview?.blocks.length??null});
        if(!preview)return;
        const deadline=Date.now()+90000,materialCount=()=>getItemCountByName("dirt")+getItemCountByName("cobblestone");
        const active=()=>{checkTaskSignal();if(Date.now()>=deadline)throw Object.assign(Error("营地入口修复达到原时限"),{code:"house_camp_access_timeout"});};
        const result=await repairHouseCampAccess({assertActive:active,plan,blockAt:at,
          at:p=>bot.entity.position.floored().equals(toVec3(p))&&hasGroundedBodySupport(bot),
          acquire:async needed=>{
            const attempted=new Set();
            while(materialCount()<needed){
              active();const candidates=findHouseSurfaceMaterialBlocks(["dirt","grass_block"],6,32)
                .filter(b=>!attempted.has(b.position.toString())&&!houseResourcePositionExcluded(b.position)
                  &&furnishedHouseDigAvoidsSupport(b.position,bot.entity.position)&&bot.canDigBlock(b)&&bot.canSeeBlock(b));
              const block=candidates[0];if(!block||attempted.size>=20)throw Object.assign(Error("附近没有可安全取得的入口修复泥土"),{code:"house_camp_access_materials_missing"});
              attempted.add(block.position.toString());await equipBestTool(block);await physicalDigBlock(block,"修复自有营地入口取土");active();
              await collectNearbyDroppedItems({position:block.position,radius:2,timeoutMs:1800});active();
            }
          },
          place:async p=>{
            active();const item=["dirt","cobblestone"].find(name=>getItemCountByName(name)>0);
            if(!item)throw Object.assign(Error("入口修复材料已不足"),{code:"house_camp_access_materials_missing"});
            const context=getExecutionContext();
            await createEstatePlacement({getBot:()=>ensureBotReady(),assertActive:active,isOwnerContext:()=>getExecutionContext()===context,
              placeNative:placeFurnishedHouseBlock}).place({id:`camp-access:${p.x},${p.y},${p.z}`,item,position:p,properties:{}},()=>{
                if(at(p)?.name===item)ownerTask.materialSupply.campRepairs=[...(ownerTask.materialSupply.campRepairs||[]),{position:{...p},item,confirmedPlaced:true}];
              });active();
          },
          move:async(from,to)=>{
            const profile=bot.pathfinder.movements,drop=profile.maxDropDown;profile.maxDropDown=Math.min(drop,2);
            try{const nav=createMiningNavigator({getBot:()=>ensureBotReady(),assertActive:active,preserveMovements:true,maxActions:2,
              movementTimeoutMs:4000,goto:miningPathfinderGoto,digBlock:async()=>{throw Error("入口已清空，禁止额外开挖");}});
              await nav.advance({x:to.x-from.x,z:to.z-from.z},{ascend:to.y>from.y});active();
            }finally{if(currentBot===bot&&currentTask===ownerTask&&bot.pathfinder.movements===profile)profile.maxDropDown=drop;}
          }});
        active();recordTaskDiagnostic(ownerTask,"house_camp_access_repaired",{...result,actual:toPlainPosition(bot.entity.position),health:bot.health});
      },
      recoverBeforeReturn: async()=>{
        const perchedDryFoot=hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry
          &&!naturalWalkingFoot(bot,bot.entity.position.floored());
        // A supported dry edge needs a local stance, not a water rescue.
        // Keep the normal surface owner so an interrupt can hand control back.
        if(perchedDryFoot&&!activeHouseSurfaceWater?.isPhysicalOwner()){
          await alignHouseResourceGraphOrigin(ownerTask,Date.now()+12000,
            getExecutionContext()?.houseResourceExclusionBounds||constructionBounds);checkTaskSignal();
        }
        if(bot.entity.isInWater===true&&!activeHouseSurfaceWater?.isPhysicalOwner()){
          const client=bot._client,generation=ownerTask.executionGeneration,lease=getCurrentMovementLease();
          const assertRescue=()=>{checkTaskSignal();ensureMovementLeaseActive(lease);if(currentBot!==bot||bot._client!==client||currentTask!==ownerTask||ownerTask.executionGeneration!==generation)throw createAbortError("movement_preempted");};
          const {escapeEmergencyShore}=require("./minecraft/houseEmergencyShore");
          await escapeEmergencyShore({getBot:()=>currentBot,Vec3,Movements,GoalBlock:goals.GoalBlock,
            assertActive:assertRescue,isDryFoot:p=>naturalWalkingFoot(bot,p),isGrounded:()=>hasGroundedBodySupport(bot),
            setActive:profile=>{activeEmergencyShore=profile?{bot,profile,lease}:null;},
            goto:(goal,options)=>pathfinderGoto(goal,options.timeoutMs,"意外落水上岸超时",lease,{...options,preserveMovements:true}),
            record:(type,facts)=>recordTaskDiagnostic(ownerTask,type,facts)});
          assertRescue();
        }
        if(!hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry){
          await waitForSurfaceGround("恢复原采集路线");checkTaskSignal();
        }
        if(hasGroundedBodySupport(bot)&&safeSurfaceFoot(bot.entity.position)&&findBestFoodItem()&&bot.food<20){
          await maintainSurvival();checkTaskSignal();
        }
        const carriedShield=findInventoryItem(["shield"]);
        if(bot.inventory.slots[45]?.name!=="shield"&&carriedShield){
          await physicalEquip(carriedShield,"off-hand","返营前装备已有盾牌");checkTaskSignal();
        }
        const nearby=()=>Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&e.isValid!==false&&isThreateningMobEntity(e,bot.registry)&&e.position?.distanceTo(bot.entity.position)<=16&&!terrainSeparatedHouseMelee(bot,e)
          &&(e.name!=="enderman"||isHostileEntityRelevant(e,bot.entity,{maxDistance:16,maxBotDistance:16})));
        const priorBusy=survivalInterruptRunning;
        let recoveryCover=null,result;
        const existingCover=ownerTask.materialSupply.defensiveCover?.plan?.bounds;
        const insideCover=existingCover&&bot.entity.position.x>existingCover.loX+1&&bot.entity.position.x<existingCover.hiX
          &&bot.entity.position.z>existingCover.loZ+1&&bot.entity.position.z<existingCover.hiZ;
        if(!priorBusy&&(bot.health<6||insideCover)){
          try{
            if(bot.inventory.slots[45]?.name==="shield")await runBotWritableAction("bot.activateItem",{offHand:true,reason:"recovery_startup"},async()=>{checkTaskSignal();bot.activateItem(true);});
            const settleUntil=Date.now()+500;
            while(Date.now()<settleUntil){checkTaskSignal();const e=nearby()[0];if(e)await safeBotLookAt(e.position.offset(0,e.height||1,0),true,{reason:"recovery_perception"});await sleep(25);}
            if(bot.health>10&&nearby().some(e=>["zombie","zombie_villager","husk","drowned","spider","cave_spider"].includes(e.name)&&e.position.distanceTo(bot.entity.position)<=3)){
              await settleSurvivalDefense("recovery_close_melee");checkTaskSignal();
            }
            const enemies=nearby();
            if(insideCover||enemies.length>0&&enemies.every(emergencyCoverThreatSupported)){
              recoveryCover=await buildHouseEmergencyCover(ownerTask,enemies,{assertActive:checkTaskSignal,deadline:Date.now()+15000});
            }
            result=await prepareHouseRecovery({targetHealth:6,assertActive:checkTaskSignal,
              observe:()=>{const enemies=nearby();return {health:bot.health,food:bot.food,
                safe:hasGroundedBodySupport(bot)&&safeSurfaceFoot(bot.entity.position),threat:imminentSurvivalThreat(),
                covered:Boolean(recoveryCover&&emergencyShelterConfirmed({plan:recoveryCover.plan,position:bot.entity.position,blockAt:p=>bot.blockAt(toVec3(p)),threats:enemies,
                  raycast:(from,to)=>{const start=toVec3(from),delta=toVec3(to).minus(start);return bot.world.raycast(start,delta.unit(),delta.norm());}}))};},
              onProgress:value=>recordTaskHeartbeat(ownerTask,{actionState:"acting",checkpoint:{kind:"natural_recovery",...value}}),
              defend:()=>settleSurvivalDefense("startup_recovery"),
              canProvision:()=>Boolean(source.getCamp()&&!imminentSurvivalThreat()),
              provisionMinimumHealth:()=>Number.MIN_VALUE,
              hasFood:()=>Boolean(findBestFoodItem()),eat:()=>ensureNutrition(20,{anchor:source.getCamp()})});
          }catch(error){
            recordTaskDiagnostic(ownerTask,"house_recovery_blocked",{code:error.code,health:bot.health,food:bot.food,
              actual:toPlainPosition(bot.entity.position),onGround:bot.entity.onGround,width:bot.entity.width,height:bot.entity.height,
              actualSupport:hasGroundedBodySupport(bot),centerFoot:safeSurfaceFoot(bot.entity.position),
              body:inspectSurfaceBody(bot),threats:nearby().map(e=>({name:e.name,position:toPlainPosition(e.position)}))});
            throw error;
          }finally{ /* Urgent survival retains its own lease throughout recovery. */ }
        }
        if(result?.recovered)recordTaskDiagnostic(ownerTask,"house_natural_recovery_confirmed",{...result,covered:Boolean(recoveryCover)});
        if(result?.needsProvision){ownerTask.materialSupply.provisioningReturnNeeded=true;recordTaskDiagnostic(ownerTask,"house_recovery_needs_provision",result);}
        if(recoveryCover){
          const first=selectEmergencyExit({plan:recoveryCover.plan,placed:recoveryCover.placed,position:bot.entity.position,threat:nearby()[0]?.position});
          try{
            for(const p of recoveryCover.placed.filter(p=>first&&p.position.x===first.x&&p.position.z===first.z).sort((a,b)=>b.position.y-a.position.y)){
              checkTaskSignal();const block=bot.blockAt(toVec3(p.position));if(!matchesFurnishedHouseBlock(block,p))continue;
              await equipBestTool(block);await physicalDigBlock(block,"打开自己搭建的临时掩体出口");
            }
          }finally{ /* Opening an owned exit does not suppress urgent defense. */ }
          recordTaskDiagnostic(ownerTask,"house_emergency_cover_exit_opened",{target:first,health:bot.health,actual:toPlainPosition(bot.entity.position)});
          await maybeHandleSurvivalCritical("recovered_ranged_threat");
        }
      },
      returnCamp: returnHouseCamp, reach: position => furnishedHouseMoveTo(position, 2), openContainer: physicalOpenContainer,
      clearStationVegetation:position=>executionContextStorage.run({...getExecutionContext(),houseCampVegetationClear:{position:{...position},bot,task:ownerTask,generation:ownerTask.executionGeneration}},async()=>{
        checkTaskSignal();const plant=at(position);
        if(!require("./minecraft/houseSelfSupplyRuntime").isCampReplaceablePlant(plant))throw Object.assign(Error("设施清理目标不再是可替换自然植物"),{code:"house_camp_vegetation_changed"});
        await furnishedHouseMoveTo(position,2);checkTaskSignal();
        const fresh=at(position);if(fresh?.stateId!==plant.stateId)throw Object.assign(Error("设施清理前植物状态改变"),{code:"house_camp_vegetation_changed"});
        await physicalDigBlock(fresh,"清理自建营地设施位置的自然植物");checkTaskSignal();
      }),
      provision:async(_anchor,options={})=>{
        await maintainSurvival();
        checkTaskSignal();
        if(options.expedition===true){
          const house=ownerTask.stepCheckpoint?.furnishedHouse,owned=new Set(house?.ownedBlockIds||[]),roof=blueprint.blocks.filter(s=>s.phase==='roof'&&!s.derived);
          const shelterFirst=require('./minecraft/houseDefenseReadiness').canFinishShelterBeforeIronUpgrade(bot,{phase:house?.phase,roofComplete:roof.length>0&&roof.every(s=>owned.has(s.id))});
          const needsMining=!shelterFirst&&(!require("./minecraft/houseShieldState").getHouseShield(bot)
            ||require("./minecraft/houseIronEquipment").equipmentPlan(bot).ironNeeded>0);
          const reserve=require('./minecraft/houseIronEquipment').ironExpeditionFoodPoints(bot);
          if(needsMining&&readyFoodPoints()<reserve){
            await ensureFoodSupply(8,{anchor:source.getCamp(),minFoodPoints:reserve});checkTaskSignal();
          }
        }
        ownerTask.materialSupply.provisioningReturnNeeded=false;
      },
      equipSurvivalWeapon: equipBestWeapon,
      prepareBasicEquipment: async () => {
        if(!immediateFoodThreat(bot)&&hasGroundedBodySupport(bot)){
          const dropped=Object.values(bot.entities||{}).filter(e=>e.name==="item"&&e.isValid!==false&&e.position?.distanceTo(bot.entity.position)<=6)
            .map(entity=>({entity,item:entity.getDroppedItem?.()})).find(v=>v.item&&/_(sword|pickaxe|axe)$/.test(v.item.name));
          if(dropped)await collectNearbyDroppedItems({position:dropped.entity.position,radius:6,timeoutMs:2500});
          checkTaskSignal();
        }
        // The table already exists. Resolve exact sword/pick prerequisites
        // before a reserve harvest; three logs must not trigger an unarmed tour.
        if (!findInventoryItem(WEAPON_ITEM_PRIORITY)) await source.ensure({wooden_sword:1});
        checkTaskSignal();
        await equipBestWeapon();
        if (!findInventoryItem(PICKAXE_ITEM_NAMES)) await source.ensure({wooden_pickaxe:1});
        checkTaskSignal();
        const basicTools = {};
        if (!findInventoryItem(["stone_sword","iron_sword","diamond_sword","netherite_sword"])) basicTools.stone_sword=1;
        if (!findInventoryItem(["stone_pickaxe","iron_pickaxe","diamond_pickaxe","netherite_pickaxe"])) basicTools.stone_pickaxe=1;
        if (!findInventoryItem(AXE_ITEM_PRIORITY)) basicTools.stone_axe=1;
        // Plan all remaining basic tools together. Their stone and wood must
        // not start separate camp-to-resource trips for each recipe.
        // Shield wood belongs to the following defense phase; it must not
        // postpone a stone weapon when current wood already covers the tools.
        const basicStock=basicTools;
        if(Object.keys(basicStock).length){
          const prefetched=await source.recipes.prefetchRaw(basicStock);checkTaskSignal();
          recordTaskDiagnostic(ownerTask,"house_basic_material_batch_prepared",prefetched);
        }
        if (!findInventoryItem(["stone_sword","iron_sword","diamond_sword","netherite_sword"])) await source.ensure({stone_sword:1});
        if (!findInventoryItem(["stone_pickaxe","iron_pickaxe","diamond_pickaxe","netherite_pickaxe"])) await source.ensure({stone_pickaxe:1});
        if (!findInventoryItem(AXE_ITEM_PRIORITY)) await source.ensure({stone_axe:1});
        checkTaskSignal();
        await equipBestWeapon();
        recordTaskDiagnostic(ownerTask,"house_basic_equipment_prepared",{health:bot.health,food:bot.food,inventory:bot.inventory.items().filter(i=>/_(sword|pickaxe)$/.test(i.name)).map(i=>({name:i.name,count:i.count}))});
      },
      activateCampBed:block=>safeBotActivateBlock(block),
      prepareDefense: async () => {
        await maintainSurvival();checkTaskSignal();
        if (!findInventoryItem(WEAPON_ITEM_PRIORITY)) await source.ensure({stone_sword:1});
        if (!findInventoryItem(AXE_ITEM_PRIORITY)) await source.ensure({stone_axe:1});
        checkTaskSignal();
        const {getHouseShield}=require("./minecraft/houseShieldState");
        let shield=getHouseShield(bot,32);
        if(!shield){await source.ensure({shield:require("./minecraft/houseShieldState").shieldCraftTarget(bot)});checkTaskSignal();shield=getHouseShield(bot,32);}
        if(!shield)throw Object.assign(Error("未实际取得基础盾牌"),{code:"house_defense_shield_missing"});
        if(!shield.equipped)await physicalEquip(shield.item,"off-hand","基础盾牌");
        checkTaskSignal();
        if(bot.inventory.slots[45]?.name!=="shield")throw Object.assign(Error("基础盾牌尚未实际装备到副手"),{code:"house_defense_shield_unconfirmed"});
        await source.takeOwnedStock({cobblestone:32,dirt:16});checkTaskSignal();
        if(getItemCountByName('cobblestone')+getItemCountByName('dirt')<12){
          await source.ensure({cobblestone:16});checkTaskSignal();
        }
        recordTaskDiagnostic(ownerTask,'house_defense_building_reserve_confirmed',{
          cobblestone:getItemCountByName('cobblestone'),dirt:getItemCountByName('dirt'),granted:false});
        const house=ownerTask.stepCheckpoint?.furnishedHouse,owned=new Set(house?.ownedBlockIds||[]),roof=blueprint.blocks.filter(s=>s.phase==='roof'&&!s.derived);
        if(require('./minecraft/houseDefenseReadiness').canFinishShelterBeforeIronUpgrade(bot,{phase:house?.phase,roofComplete:roof.length>0&&roof.every(s=>owned.has(s.id))})){
          recordTaskDiagnostic(ownerTask,'house_iron_upgrade_deferred_until_shelter_ready',{phase:house.phase,kitAccepted:false,finalEquipmentCheckRequired:true});
          return;
        }
        const equipment=await require("./minecraft/houseIronEquipment").prepareHouseIronEquipment({
          getBot:()=>bot,assertActive:checkTaskSignal,ensure:requirements=>source.ensure(requirements),
          availableIron:()=>{const stock=source.storage.getStock();return getItemCountByName("iron_ingot")+getItemCountByName("raw_iron")
            +Number(stock.iron_ingot||0)+Number(stock.raw_iron||0);},
          provision:async()=>{
            await maintainSurvival();checkTaskSignal();
            const reserve=require('./minecraft/houseIronEquipment').ironExpeditionFoodPoints(bot);
            if(readyFoodPoints()<reserve)await ensureFoodSupply(8,{anchor:source.getCamp(),minFoodPoints:reserve});
          },
          equip:(item,destination)=>physicalEquip(item,destination,"铁制生存装备"),
          report:evidence=>recordTaskDiagnostic(ownerTask,"house_iron_equipment_confirmed",evidence),
        });
        checkTaskSignal();await equipBestWeapon();
        recordTaskDiagnostic(ownerTask,"house_defense_equipment_prepared",{shieldEquipped:bot.inventory.slots[45]?.name==="shield",equipment});
      },
      prepareFieldPlanks: async (target,exclusionBounds) => {
        checkTaskSignal();
        if(getItemCountByName('oak_planks')>=target)return;
        if(!getItemCountByName('oak_log')){
          const searchDeadline = Date.now() + 600000, maximumAdvances = 64;
          for(let attempt=0;attempt<=maximumAdvances;attempt++){
            try{await gatherer.gather('oak_log',1,{anchor:source.getCamp(),
              exclusionBounds,deferCampReturn:true,finishTree:true,localOnly:true,deadline:Math.min(searchDeadline,Date.now()+30000)});break;}
            catch(error){
              checkTaskSignal();if(error.code!=='house_resource_local_wood_unavailable'||attempt===maximumAdvances||Date.now()>=searchDeadline)throw error;
              recordTaskDiagnostic(ownerTask,'house_field_wood_search_continues',{attempt:attempt+1,maximumAdvances,deadline:searchDeadline,actual:toPlainPosition(bot.entity.position),materialCredit:false});
              if(inBounds(bot.entity.position.floored(),exclusionBounds)){
                const origin=bot.entity.position.floored(),candidates=[];
                for(let r=2;r<=16;r+=2)for(const [dx,dz] of [[r,0],[-r,0],[0,r],[0,-r]])for(const dy of [0,-1,1,-2,2]){
                  const p=origin.offset(dx,dy,dz);
                  if(!inBounds(p,exclusionBounds)&&naturalWalkingFoot(bot,p))candidates.push(p);
                }
                let left=false;
                for(const p of candidates.slice(0,6)){
                  try{await furnishedHouseMoveTo(p);checkTaskSignal();}catch(moveError){checkTaskSignal();continue;}
                  if(!inBounds(bot.entity.position.floored(),exclusionBounds)&&hasGroundedBodySupport(bot)){left=true;break;}
                }
                if(!left)throw error;
              }
              await alignHouseResourceGraphOrigin(ownerTask,searchDeadline,exclusionBounds);checkTaskSignal();
              let search=ownerTask.materialSupply.fieldPlankSearch;
              if(search&&!search.graph)search=null;
              const recorded=search?.graph?.nodes?.[search.graph.current]?.position;
              if(recorded&&!bot.entity.position.floored().equals(toVec3(recorded))){
                if(search.graph.pendingWater||search.graph.pendingDryTrail){
                  await exploreHouseSurfaceGraph(ownerTask,'house_field_wood',search.anchor,report,{
                    excludeBounds:exclusionBounds,assertGraphActive:checkTaskSignal,returnToAnchor:true,returnToCurrentOnly:true,rejoinInterruptedSuffix:true,
                    graphCheckpoint:{get:()=>ownerTask.materialSupply.fieldPlankSearch.graph,save:value=>{checkTaskSignal();ownerTask.materialSupply.fieldPlankSearch.graph=value;}}});
                }else if(!await followHouseNativeDryConnector(ownerTask,recorded,Date.now()+30000)){
                  throw Object.assign(Error('木板补给尚未实际重接已观察搜索位置'),{code:'house_field_planks_rejoin_pending'});
                }
                checkTaskSignal();
              }
              if(!search){
                if(!hasGroundedBodySupport(bot))throw error;
                search={anchor:toPlainPosition(bot.entity.position.floored()),graph:null};ownerTask.materialSupply.fieldPlankSearch=search;
              }
              await exploreHouseSurfaceGraph(ownerTask,'house_field_wood',search.anchor,report,{
                excludeBounds:exclusionBounds,assertGraphActive:checkTaskSignal,
                graphCheckpoint:{get:()=>ownerTask.materialSupply.fieldPlankSearch.graph,
                  save:value=>{checkTaskSignal();ownerTask.materialSupply.fieldPlankSearch.graph=value;}}});
            }
          }
          checkTaskSignal();
        }
        const item=bot.registry.itemsByName.oak_planks;
        const recipe=bot.recipesFor(item.id,null,1,null)?.find(r=>!r.requiresTable&&r.result?.count===4);
        if(!recipe||!getItemCountByName('oak_log'))return;
        const before=getItemCountByName('oak_planks');
        await physicalCraft(recipe,1,null,'oak_planks');checkTaskSignal();
        const until=Date.now()+2500;
        while(getItemCountByName('oak_planks')<before+4&&Date.now()<until){await sleep(50);checkTaskSignal();}
        if(getItemCountByName('oak_planks')<before+4)throw Object.assign(Error('随身木板合成未确认实际入账'),{code:'house_materials_no_progress'});
        recordTaskDiagnostic(ownerTask,'house_field_planks_confirmed',{before,after:getItemCountByName('oak_planks'),target});
      },
      bootstrapWood: async options => {
        const names = ['oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak'];
        const existing = () => names.map(name => ({ logName: `${name}_log`, plankName: `${name}_planks` }))
          .find(entry => getItemCountByName(entry.logName) + getItemCountByName(entry.plankName) > 0);
        // An intact/provisional camp nearby does not supply tools to an empty
        // inventory. Use the same bounded field prerequisite search until a
        // real weapon/pick exists, including a healthy respawn beside camp.
        const localOnly=!findInventoryItem(WEAPON_ITEM_PRIORITY)&&!findInventoryItem(PICKAXE_ITEM_NAMES);
        const {fieldWoodUsage,beginFieldWoodBudget,chargeFieldWoodBudget}=require('./minecraft/houseFieldWoodPlanningBudget');
        const requestedDeadline=Math.min(Date.now()+600000,Number.isFinite(options.deadline)?options.deadline:Infinity);
        const budget=beginFieldWoodBudget(ownerTask.materialSupply.fieldWoodPlanningBudget,{generation:ownerTask.executionGeneration,
          usage:fieldWoodUsage(ownerTask.materialSupply.fieldWoodSearch,ownerTask.materialSupply.fieldWoodSearchHistory||[]),deadline:requestedDeadline});
        ownerTask.materialSupply.fieldWoodPlanningBudget=budget;
        const deadline=budget.deadline;
        const maximumAttempts=65;
        for(let attempt=0;attempt<maximumAttempts;attempt++){
          checkTaskSignal();
          const woodUnits=bot.inventory.items().reduce((sum,i)=>sum+(i.name.endsWith('_log')?4*i.count:i.name.endsWith('_planks')?i.count:0),0);
          // Table4 + sticks2 + wooden sword2 =8 planks. Craft/equip the
          // first weapon before searching for the third log needed by a pick.
          const missingLogs=Math.ceil(Math.max(0,8-woodUnits)/4);
          if(!missingLogs)break;
          try{await gatherer.gather("any_log",missingLogs,{...options,deferCampReturn:true,finishTree:false,localOnly,deadline});break;}
          catch(error){
            checkTaskSignal();
            if(!localOnly||error.code!=="house_resource_local_wood_unavailable"||attempt>=maximumAttempts-1||Date.now()>=deadline)throw error;
            const from=toPlainPosition(bot.entity.position);
            const client=bot._client,generation=ownerTask.executionGeneration,token=getActiveCancellationToken();
            const active=()=>{token?.throwIfRequested();checkTaskSignal();if(currentBot!==bot||bot._client!==client||currentTask!==ownerTask||ownerTask.executionGeneration!==generation)throw createAbortError("movement_preempted");
              if(Date.now()>=deadline)throw Object.assign(Error("就地找木材达到原有限时限"),{code:"house_resource_leg_limit"});};
            active();
            await alignHouseResourceGraphOrigin(ownerTask,deadline,options.exclusionBounds||[]);active();
            let search=ownerTask.materialSupply.fieldWoodSearch;
            let actual=bot.entity.position.floored();
            let recorded=search?.graph?.nodes?.[search.graph.current]?.position;
            if(recorded&&actual.distanceTo(toVec3(recorded))>32&&hasGroundedBodySupport(bot)&&naturalWalkingFoot(bot,actual)){
              const reuse=require('./minecraft/houseFieldWoodGraphReuse').reuseNearbyFieldWoodGraph({search,
                history:ownerTask.materialSupply.fieldWoodSearchHistory||[],actual:toPlainPosition(actual)});
              if(reuse){active();ownerTask.materialSupply.fieldWoodSearchHistory=reuse.history;
                ownerTask.materialSupply.fieldWoodSearch=search=reuse.search;recorded=search.graph.nodes[search.graph.current].position;
                recordTaskDiagnostic(ownerTask,'house_field_wood_retained_graph_selected',reuse.evidence);}
            }
            const retainedGraphs=()=>[...(ownerTask.materialSupply.fieldWoodSearchHistory||[]).flatMap(s=>[...(s.graphSegments||[]).map(v=>v.graph),s.graph]),
              ...(ownerTask.materialSupply.fieldWoodSearch?.graphSegments||[]).map(v=>v.graph)].filter(Boolean);
            const saveFieldGraph=value=>{active();const usage=fieldWoodUsage({...ownerTask.materialSupply.fieldWoodSearch,graph:value},ownerTask.materialSupply.fieldWoodSearchHistory||[]);
              ownerTask.materialSupply.fieldWoodPlanningBudget=chargeFieldWoodBudget(ownerTask.materialSupply.fieldWoodPlanningBudget,usage);
              ownerTask.materialSupply.fieldWoodSearch.graph=value;};
            const fieldAdapter=()=>({excludeBounds:[],assertGraphActive:active,survivalProvisioning:options.survivalBootstrap===true,
              graphCheckpoint:{get:()=>ownerTask.materialSupply.fieldWoodSearch.graph,save:saveFieldGraph}});
            if(recorded&&!search.graph.pendingWater&&!search.graph.pendingDryTrail
              &&search.graph.current!==`${actual.x},${actual.y},${actual.z}`&&actual.distanceTo(toVec3(recorded))<=32
              &&hasGroundedBodySupport(bot)&&naturalWalkingFoot(bot,actual)){
              const observed=await withSurfaceResourceMovements(()=>exploreHouseSurfaceGraph(ownerTask,'house_field_wood',search.anchor,report,{
                ...fieldAdapter(),observeResourceWorkOrigin:search.graph.current}),{deadline});
              active();search=ownerTask.materialSupply.fieldWoodSearch;actual=bot.entity.position.floored();
              recorded=search.graph?.nodes?.[search.graph.current]?.position;
              if(observed?.confirmed)recordTaskDiagnostic(ownerTask,'house_field_wood_existing_graph_origin_observed',{
                ...observed,retainedSegments:retainedGraphs().length,newSegmentCredit:false,originalDeadline:deadline});
            }
            if(recorded&&!search.graph.pendingWater&&!search.graph.pendingDryTrail
              &&search.graph.current!==`${actual.x},${actual.y},${actual.z}`&&actual.distanceTo(toVec3(recorded))<=32
              &&hasGroundedBodySupport(bot)&&naturalWalkingFoot(bot,actual)){
              // A temporary field search is not a fixed camp return. Retain
              // its spent graph and begin at the actual settled native actor.
              const oldCount=retainedGraphs().length;
              if(oldCount>=budget.baseline.segments+32)throw Object.assign(Error('就地木材搜索有限站位段已用尽'),{code:'house_field_wood_origin_segment_limit'});
              await require('./minecraft/houseStartupExplorationOrigin').prepareStartupExplorationOrigin({getBot:()=>currentBot,assertActive:active,
                getState:()=>({...search,searchAnchor:search.anchor}),
                saveState:value=>{active();const {searchAnchor,...rest}=value;search={...rest,anchor:searchAnchor};ownerTask.materialSupply.fieldWoodSearch=search;},
                ready:drainStartupOriginDefense,isMotorIdle:()=>activeHouseSurfaceNavigationMove===null&&activeSurvivalInterrupt===null,
                record:facts=>recordTaskDiagnostic(ownerTask,'house_field_wood_actual_origin_segment',facts)}, {deadline,maximumSegments:32});
              active();actual=bot.entity.position.floored();recorded=search.graph?.nodes?.[search.graph.current]?.position;
            }
            if(search?.graph&&(!recorded||actual.distanceTo(toVec3(recorded))>32)
              &&(!search.graph?.pendingWater||require("./minecraft/houseFieldWoodRecovery").isDisplacedFieldWaterSearch(search,actual))&&!search.graph?.pendingDryTrail
              &&hasGroundedBodySupport(bot)&&naturalWalkingFoot(bot,actual)){
              recordTaskDiagnostic(ownerTask,"house_field_wood_displaced_search_archived",{anchor:search.anchor,actual:toPlainPosition(actual),pendingWaterPreserved:Boolean(search.graph?.pendingWater),transportCompletionCredit:false});
              if(retainedGraphs().length>=budget.baseline.segments+32)throw Object.assign(Error('就地木材搜索有限站位段已用尽'),{code:'house_field_wood_origin_segment_limit'});
              ownerTask.materialSupply.fieldWoodSearchHistory=[...(ownerTask.materialSupply.fieldWoodSearchHistory||[]),search];search=null;
            }
            if(!search){
              if(!hasGroundedBodySupport(bot)||!naturalWalkingFoot(bot,actual))throw Object.assign(Error("就地资源图需要实际干燥起点"),{code:"house_field_wood_origin_unconfirmed"});
              search={anchor:toPlainPosition(actual),graph:null};ownerTask.materialSupply.fieldWoodSearch=search;
            }
            const outcome=await exploreHouseSurfaceGraph(ownerTask,"house_field_wood",search.anchor,report,fieldAdapter());
            active();if(outcome?.moved!==true){
              if(outcome?.reason==='finite_attempt_batch_failed'){
                recordTaskDiagnostic(ownerTask,'house_field_wood_search_batch_retained',{attempt:attempt+1,originalDeadline:deadline,materialCredit:false,nodeBudgetReset:false,probeBudgetReset:false});
                continue;
              }
              await withSurfaceResourceMovements(async()=>{
                active();const profile=bot.pathfinder.movements,from=bot.entity.position.floored();
                const probes=[];for(const [dx,dz] of [[0,-1],[0,1],[-1,0],[1,0]]){
                  const p=from.offset(dx,0,dz),block=bot.blockAt(p),r=bot.pathfinder.getPathTo(profile,new goals.GoalBlock(p.x,p.y,p.z),100);
                  probes.push({target:toPlainPosition(p),status:r.status,pathCount:r.path?.length,
                    costs:profile.exclusionAreasStep.map(fn=>{try{const n=fn(block);return Number.isFinite(n)?n:String(n);}catch(e){return e.code||e.message;}})});
                }
                recordTaskDiagnostic(ownerTask,'house_field_wood_exhaustion_native_recheck',{actual:toPlainPosition(bot.entity.position),outcome:outcome?.reason,probes,nearbyThreats:Object.values(bot.entities||{}).filter(e=>e.isValid!==false&&e.position&&isThreateningMobEntity(e,bot.registry)&&bot.entity.position.distanceTo(e.position)<32).slice(0,12).map(e=>({id:e.id,name:e.name,position:toPlainPosition(e.position),distance:bot.entity.position.distanceTo(e.position),terrainSeparated:terrainSeparatedHouseMelee(bot,e)}))});
              },{deadline});
              throw error;
            }
            recordTaskDiagnostic(ownerTask,"house_field_wood_search_relocated",{from,actual:toPlainPosition(bot.entity.position),attempt:attempt+1,materialCredit:false});
          }
        }
        checkTaskSignal(); return existing();
      },
      placeNative: (spec, confirmed) => {
        const context = getExecutionContext();
        return createEstatePlacement({ getBot: () => ensureBotReady(), assertActive: checkTaskSignal,
          isOwnerContext: () => getExecutionContext() === context, placeNative: placeFurnishedHouseBlock }).place(spec, confirmed);
      },
      craftRecipe: async (recipe, repeats, context) => {
        for (let i = 0; i < repeats; i += 1) {
          context.assertActive();
          if (context.table) await moveNearBlock(context.table, 3);
          const before = getItemCountByName(context.item);
          await require('./minecraft/houseInterruptedCraft').craftWithSurvivalRecovery({assertActive:context.assertActive,
            count:()=>getItemCountByName(context.item),craft:()=>physicalCraft(recipe,1,context.table,context.item),
            resume:resumeCampAfterSurvival},{target:before+recipe.result.count,deadline:Date.now()+35000});
          const deadline = Date.now() + 2500;
          while (getItemCountByName(context.item) < before + recipe.result.count) {
            context.assertActive(); if (Date.now() >= deadline) throw Object.assign(new Error("原生合成没有确认本次配方产出"), { code: "house_materials_no_progress" });
            await sleep(50);
          }
          await sleep(150); context.assertActive();
        }
      },
      recoverOwnedFurnace: (request, context) => recoverHouseOwnedFurnace(request, context.assertActive),
      smeltBatch: (batch, context) => { context.assertActive(); return executeSmeltItem({ args: { input: batch.input, output: batch.output, additionalCount: batch.count } }); },
      acquireRaw: async (name, amount, context) => {
        context.assertActive();
        const parentResource = getExecutionContext()?.houseSurfaceResource;
        if (parentResource && parentResource !== name) await returnHouseCamp(context.anchor, { resource: parentResource });
        context.assertActive();
        if (["cobblestone", "raw_iron", "coal", "lapis_lazuli"].includes(name)) {
          return acquireQuarryMaterial(name, amount, context);
        }
        if (name === "diamond") {
          const target = Math.max(5, context.targetCount);
          const restore = {};
          for (const item of bot.inventory.items()) if (!/_(?:pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/.test(item.name)
            && !bot.registry.foodsByName?.[item.name] && !["diamond", "stick", "shield", "shears", "bucket", "water_bucket"].includes(item.name)) {
            restore[item.name] = (restore[item.name] || 0) + item.count;
          }
          await source.stash({ diamond: target, stick: 64 }); context.assertActive();
          for (let trip = 0; ; trip += 1) {
            try { await executeDiamondExpedition({ args: { block: "diamond", expedition: true, count: target } }); break; }
            catch (error) {
              context.assertActive();
              if (error.code !== "mining_inventory_full" || trip >= 8) throw error;
              await returnHouseCamp(context.anchor);
              await source.stash({ diamond: target, stick: 64, oak_planks: 32, cobblestone: 20, iron_ingot: 6, raw_iron: 6 });
              context.assertActive();
            }
          }
          context.assertActive(); await source.stash({ diamond: target, stick: 16 });
          await source.takeOwnedStock(restore); await source.ensure(restore); context.assertActive();
          await returnHouseCamp(context.anchor); return;
        }
        if (["obsidian", "water_bucket"].includes(name)) return acquireFluidMaterial(name, amount, context);
        return gatherer.gather(name, amount, { anchor: context.anchor, exclusionBounds: context.exclusionBounds });
      },
    }, blueprint, constructionBounds);
    source.runXPAtCamp = action => runAtHouseCamp({ resource: "cactus" }, action);
    source.returnXPCamp = returnHouseCamp;
    source.maintainSurvival = maintainSurvival;
    return source;
  }

  async function finishNaturalHouseXP(ownerTask, blueprint) {
    const bot = ensureBotReady(), captured = getExecutionContext() || {};
    const token = captured.token || getActiveCancellationToken(), generation = ownerTask.executionGeneration;
    const lease = getCurrentMovementLease(), client = bot._client;
    const capture = { task: ownerTask, bot, client, token, lease, generation };
    const frame = naturalXPStepWatchdogFrames.get(ownerTask);
    const budget = readNaturalXPStageBudget(frame, capture);
    const identity = () => currentBot === bot && bot._client === client && currentTask === ownerTask &&
      ownerTask.executionGeneration === generation && ownerTask.cancellationToken === token &&
      ownerTask.movementLease === lease && isMovementLeaseActive(lease);
    const assertOwner = () => {
      token?.throwIfRequested(); checkTaskSignal();
      if (!identity()) throw createAbortError("movement_preempted");
      if (naturalXPStepWatchdogFrames.get(ownerTask) !== frame) throw Object.assign(new Error("原XP步骤时限归属已变更"), { code: "house_xp_stage_budget_pending" });
      readNaturalXPStageBudget(frame, capture);
    };
    const source = createHouseMaterialRuntime(ownerTask, blueprint, [houseConstructionMaterialBounds(blueprint)]);
    await source.withContext(async () => {
      // Return on the resource's existing typed route first. Once actually at
      // camp, graph.returnToAnchor may record that observed root without
      // moving or fabricating a two-point path. Local XP work then uses cactus.
      await source.returnXPCamp(source.getCamp(), { resource: ownerTask.materialSupply?.activeSurfaceGraph }); assertOwner();
      if (!ownerTask.materialSupply?.surfaceGraphs?.cactus) {
        await exploreHouseSurfaceGraph(ownerTask, "cactus", source.getCamp(), text => { assertOwner(); setTaskProgress(text); }, { returnToAnchor: true, via: [], excludeBounds: [] });
      }
      assertOwner();
    });
    const host = createNaturalHouseXPHost({
      source, getBot: () => currentBot, getCurrentTask: () => currentTask,
      getExecutionContext, isMovementLeaseActive, assertActive: assertOwner,
      getCP: () => ownerTask.materialSupply?.naturalXPHost,
      saveCP: value => { assertOwner(); ownerTask.materialSupply = { ...ownerTask.materialSupply, naturalXPHost: value }; },
      recordConfirmedFact: fact => {
        // Native placement can finish at a public pause. Preserve only its
        // captured original-task fact, never a new actor's phase or control.
        ownerTask.nativeXPFacts = [...(ownerTask.nativeXPFacts || []), fact].slice(-4096);
        const old = ownerTask.materialSupply?.naturalXPHost;
        if (ownerTask.executionGeneration !== generation || naturalXPStepWatchdogFrames.get(ownerTask) !== frame || old?.taskId !== ownerTask.taskId || fact.kind !== "owned_xp_furnace_placement") return;
        ownerTask.materialSupply = { ...ownerTask.materialSupply, naturalXPHost: { ...old,
          stations: old.stations.map(entry => entry.position.x === fact.position.x && entry.position.y === fact.position.y && entry.position.z === fact.position.z
            ? { ...entry, confirmedOwned: true, debitConfirmed: false, emptyAuthorized: false } : entry) } };
      },
      placeNative: placeFurnishedHouseBlock,
      reachDry: async (position, options = {}) => {
        assertOwner();
        const target = toVec3(position), range = options.range || 4.5;
        await furnishedHouseReach(target, feet => furnishedHouseStandingSafely(feet) &&
          Math.hypot(feet.x - target.x - .5, feet.z - target.z - .5) <= range &&
          feet.offset(0, bot.entity.eyeHeight || 1.62, 0).distanceTo(target.offset(.5, .5, .5)) <= 4.5,
        "自然经验原生交互"); assertOwner();
      },
      returnCamp: (anchor, options) => source.returnXPCamp(anchor, options),
      ensureFood: () => source.runXPAtCamp(async () => {
        assertOwner(); const anchor = source.getCamp();
        await ensureFoodSupply(8, { anchor, minFoodPoints: 24 });
        if (bot.food < 18) await ensureNutrition(20, { anchor }); assertOwner();
      }),
      digNative: block => physicalDigBlock(block, "天然仙人掌顶节或花"),
      // This is a passive native pickup opportunity, never a manufactured
      // drop. The host still requires an actual named raw inventory increase.
      collectDrops: async options => { if (options.allowMovement !== false) throw new Error("XP field pickup must remain passive"); await sleep(500); assertOwner(); },
      nextExploration: options => exploreHouseSurfaceGraph(ownerTask, "cactus", options.anchor, text => {
        assertOwner(); setTaskProgress(text);
      }, { excludeBounds: [] }),
      allowNativeCancel: (actualBot, name, data) => isOwnedHouseNativeDigCancel(actualBot, name, data),
      onOperationAbort: error => {
        if (!identity() || naturalXPStepWatchdogFrames.get(ownerTask) !== frame) return;
        ownerTask.watchdogAbortCode = error.code; ownerTask.watchdogAbortMessage = error.message;
        token?.pause();
      },
      getFurniturePositions: () => blueprint.blocks.filter(entry => ["furnace", "smoker", "blast_furnace"].includes(entry.item)).map(entry => entry.position),
      ownedEnchantmentTable: async () => {
        assertOwner(); const position = blueprint.furniture.enchantingTable;
        const state = ownerTask.stepCheckpoint?.[blueprint.schema === 2 ? "furnishedHouse" : "estate"];
        const spec = blueprint.blocks.find(entry => entry.item === "enchanting_table" && entry.position.x === position?.x && entry.position.y === position?.y && entry.position.z === position?.z);
        if (!spec || state?.sourceProfile !== blueprint.profile || !state.ownedBlockIds?.includes(spec.id) ||
          !matchesFurnishedHouseBlock(bot.blockAt(toVec3(position)), spec)) {
          throw Object.assign(new Error("没有确认本任务实际放置的附魔台"), { code: "house_xp_owned_table_adapter_pending" });
        }
        return { position, confirmedOwned: true, ownerTaskId: ownerTask.taskId };
      },
      report: text => { assertOwner(); setTaskProgress(text); recordTaskHeartbeat(ownerTask, { actionState: "acting", clearRecoveryReason: true }); },
    }, { totalMs: budget.xpBudgetMs });
    return host.finish();
  }

  function remainingHouseToolDurability(item) {
    const maximum = Number(currentBot?.registry.itemsByName[item.name]?.maxDurability);
    return Number.isFinite(maximum) && maximum > 0 ? maximum - Number(item.durabilityUsed || 0) : 0;
  }

  async function verifyOriginalTaskHouseFurniture(ownerTask, blueprint) {
    const bot = ensureBotReady(), context = getExecutionContext(), client = bot._client;
    const token = context?.token || getActiveCancellationToken(), lease = getCurrentMovementLease(), generation = ownerTask.executionGeneration;
    const identity = () => {
      token?.throwIfRequested(); checkTaskSignal();
      const now = getExecutionContext();
      if (currentBot !== bot || bot._client !== client || currentTask !== ownerTask || ownerTask.executionGeneration !== generation
        || ownerTask.cancellationToken !== token || now?.task !== ownerTask || now.token !== token || now.movementLease !== lease)
        throw createAbortError('movement_preempted');
    };
    const owner = () => { identity(); ensureMovementLeaseActive(lease); };
    const ready = async () => {
      identity();
      if (activeSurvivalInterrupt) await settleSurvivalDefense('furniture_original_task_handoff');
      owner();
      if (require('./minecraft/houseCombatMode').combatCover(ownerTask.materialSupply).length) {
        await withCurrentHouseMaterialRuntime(source => source.maintainSurvival()); owner();
      }
    };
    const Item = require('prismarine-item')(bot.version);
    return require('./minecraft/houseFurnitureUse').verifyHouseFurnitureUse({
      getBot: () => bot, taskId: ownerTask.taskId, now: Date.now, sleep, vec: toVec3,
      assertIdentity: identity, assertOwner: owner, ready, position: () => toPlainPosition(bot.entity.position), decodeItem: item => Item.fromNotch(item),
      ensure: items => prepareFurnishedHouseMaterials(items, { anchor: blueprint.anchor, profile: blueprint.profile }),
      maintain: () => withCurrentHouseMaterialRuntime(source => source.maintainSurvival()),
      heartbeat: () => { owner(); recordTaskHeartbeat(ownerTask, { actionState: 'waiting_for_physical_signal', clearRecoveryReason: true }); },
      move: async (position, range) => { await ready(); return furnishedHouseMoveTo(position, range); },
      reach: async position => {
        await ready(); const target = toVec3(position);
        await returnToHouseConstruction(target); owner();
        return furnishedHouseReach(target, feet => feet.offset(0, bot.entity.eyeHeight || 1.62, 0).distanceTo(target.offset(.5, .5, .5)) <= 4.5, '家具实际交互');
      },
      craft: (recipe, block) => physicalCraft(recipe, 1, block, 'wooden_pickaxe'),
      native: (name, action, assertUseActive) => require('./minecraft/houseNativeSourceGuard').withHouseNativeSourceGuard(bot, {
        isOwnerContext: () => getExecutionContext()?.task === ownerTask && getExecutionContext()?.token === token,
        assertActive: () => { assertUseActive(); owner(); }
      }, () => runBotWritableAction(`house.furniture.${name}`, { taskId: ownerTask.taskId }, action)),
      record: (name, evidence) => {
        owner(); setTaskProgress(`家具实际使用：${name}`); recordTaskHeartbeat(ownerTask, { actionState: 'acting', clearRecoveryReason: true });
        recordTaskDiagnostic(ownerTask, 'house_furniture_actual_use', { name, ...evidence });
      }
    }, blueprint);
  }

  async function executeBuildFurnishedHousePhase(step) {
    const bot = ensureBotReady();
    const ownerTask = currentTask;
    if(step.args?.phase==='prepare_materials'&&ownerTask.materialSupply?.materialSource==='self_gathered'
      &&(bot.health<16||bot.food<14)){
      await withCurrentHouseMaterialRuntime(()=>restoreHouseWorkNutrition(ownerTask));checkTaskSignal();
    }
    if(ownerTask.materialSupply?.materialSource==='self_gathered'
      &&(bot.health<14||bot.food<18||require('./minecraft/houseCombatMode').combatCover(ownerTask.materialSupply).length)){
      await withCurrentHouseMaterialRuntime(source=>source.maintainSurvival());checkTaskSignal();
    }
    const builder = createFurnishedHouseBuilder({
      planSitePreparation: options => require('./minecraft/naturalHouseSites').inspectCreatableHouseSite(options),
      planFoundation: options => require('./minecraft/naturalHouseSites').planHouseSiteFoundation(options),
      getFoundationEstimate:({blueprint})=>{
        const reservation=ownerTask.siteSearch?.reservation;
        if(reservation?.kind!=='actual_loaded_house_site_and_camp'||reservation.profile!==blueprint.profile
          ||!['x','y','z'].every(k=>reservation.houseAnchor?.[k]===blueprint.anchor[k])
          ||!Number.isSafeInteger(reservation.confirmedAt)||reservation.confirmedAt<=0
          ||!Array.isArray(reservation.terrainPreparation?.foundation))return null;
        return reservation.terrainPreparation.foundation.length;
      },
      onSitePrepared: facts => recordTaskDiagnostic(currentTask,'house_terrain_preparation_confirmed',facts),
      getBot: () => ensureBotReady(), assertActive: checkTaskSignal,
      getCheckpoint: () => ownerTask?.stepCheckpoint?.furnishedHouse,
      setCheckpoint: (state) => updateTaskCheckpoint(ownerTask, { furnishedHouse: state }),
      recordOwnedBlock: (spec, scaffold) => {
        // A confirmed native placement may settle just as the user pauses.
        // Record only ownership on the captured task; never issue a new action
        // or overwrite a newer execution's phase/control state.
        const latest = ownerTask?.stepCheckpoint?.furnishedHouse;
        if (!latest || latest.schema !== 2 || latest.sourceProfile !== step.args?.profile) return;
        const next = scaffold ? { ...latest, ownedScaffold: [...(latest.ownedScaffold || []),
          { position: toPlainPosition(spec.position), item: spec.item }] } : { ...latest,
          ownedBlockIds: [...new Set([...(latest.ownedBlockIds || []), spec.id])] };
        ownerTask.stepCheckpoint = { ...ownerTask.stepCheckpoint, furnishedHouse: next };
      },
      report: (message) => { setTaskProgress(message); recordTaskHeartbeat(currentTask, { actionState: "acting", clearRecoveryReason: true }); },
      getItemCount: getItemCountByName, prepareMaterials: (items, options) => prepareFurnishedHouseMaterials(items, { ...options, reserveFunctionalInputs: true }),
      prepareFinalEquipment:async()=>{
        if(ownerTask.materialSupply?.materialSource!=='self_gathered')return;
        const urgentProvision=require('./minecraft/survivalScheduler').selectSurvivalJob({health:bot.health,food:bot.food,
          safe:true,hasMeal:false,canProvision:true,threat:false})==='provision';
        if(!urgentProvision&&require('./minecraft/houseIronEquipment').carriedIronEquipmentVerified(bot)){
          recordTaskDiagnostic(ownerTask,'house_final_equipment_carried_verified',{health:bot.health,food:bot.food,
            actualKit:require('./minecraft/houseIronEquipment').equipmentPlan(bot).entries.map(e=>({kind:e.kind,item:e.item.name,slot:e.slot??null})),
            campTripRequired:false});
        }else await prepareFurnishedHouseMaterials({}, {anchor:ownerTask.materialSupply.houseAnchor,profile:ownerTask.materialSupply.profile,requireFullEquipment:true});
        checkTaskSignal();await finishHouseCombatCleanup(ownerTask);
      },
      placeBlock: async spec=>{
        if(ownerTask.materialSupply?.materialSource==='self_gathered'
          &&(bot.health<18||bot.food<18||activeSurvivalInterrupt
            ||require('./minecraft/houseCombatMode').combatCover(ownerTask.materialSupply).length)){
          await withCurrentHouseMaterialRuntime(source=>source.maintainSurvival());checkTaskSignal();
        }
        return placeFurnishedHouseBlock(spec);
      }, breakBlock: breakFurnishedHouseBlock,
      moveTo: furnishedHouseMoveTo, activateBlock: async (block) => {
        checkTaskSignal();
        await safeBotActivateBlock(block);
        await sleep(180);
        checkTaskSignal();
      },
      openCraftingTable: (block) => runBotWritableAction("bot.openBlock", { itemName: "crafting_table" }, () =>
        withTimeout(bot.openBlock(block), DEFAULT_CONTAINER_TIMEOUT_MS, "打开工作台超时")),
      openContainer: physicalOpenContainer, openFurnace: physicalOpenFurnace,
      openEnchantmentTable: (block) => runBotWritableAction("bot.openEnchantmentTable", { itemName: "enchanting_table" }, () =>
        withTimeout(bot.openEnchantmentTable(block), DEFAULT_CONTAINER_TIMEOUT_MS, "打开附魔台超时")),
      verifyActualFurnitureUse: ownerTask.materialSupply?.materialSource === 'self_gathered'
        ? blueprint => blueprint.profile === 'cottage' ? verifyOriginalTaskHouseFurniture(ownerTask, blueprint) : null : null,
      chooseAnchor: chooseFurnishedHouseAnchor, getBlueprint: createFurnishedHouseBlueprint,
    });
    if (step.args?.phase === "prepare_materials") return builder.run(step.args);
    return withFurnishedHouseMovements(async () => {
      await returnFieldHouseWood(ownerTask);
      let result;
      try{result=await builder.run(step.args);}
      catch(error){
        checkTaskSignal();const old=ownerTask.stepCheckpoint?.furnishedHouse;
        if(step.args?.phase!=="clear_site"||!require("./minecraft/houseUnbuiltSiteRecovery").canReselectUnbuiltHouse(error,old))throw error;
        const oldSearch=ownerTask.siteSearch;
        ownerTask.siteSearchHistory=[...(ownerTask.siteSearchHistory||[]),{reason:error.code,checkpoint:oldSearch}];ownerTask.siteSearch=null;
        recordTaskDiagnostic(ownerTask,"house_unbuilt_site_reselection_started",{oldAnchor:old.anchor,reason:error.message,oldSiteUntouched:true});
        await waitForSurfaceGround("重新选择尚未开工的房屋位置");checkTaskSignal();
        const anchor=await chooseFurnishedHouseAnchor(step.args.profile);checkTaskSignal();
        if(['x','y','z'].every(k=>anchor[k]===old.anchor[k]))throw error;
        ownerTask.houseSiteHistory=[...(ownerTask.houseSiteHistory||[]),{checkpoint:old,reason:error.code,at:Date.now()}];
        if(ownerTask.materialSupply)ownerTask.materialSupply={...ownerTask.materialSupply,houseAnchor:{...anchor}};
        await builder.run({...step.args,phase:"prepare_materials",anchor});checkTaskSignal();
        result=await builder.run({...step.args,anchor});
      }
      if (isSelfGatheredLibraryFinish(ownerTask, step)) {
        // Uses the existing native furniture checks without crediting final verify.
        await builder.verifyFurniture(); checkTaskSignal();
        const saved = ownerTask.stepCheckpoint.furnishedHouse;
        await finishNaturalHouseXP(ownerTask, createFurnishedHouseBlueprint(saved.anchor, { profile: saved.sourceProfile }));
      }
      return result;
    });
  }

  function createEstateNativeRuntime(ownerTask) {
    const bot = ensureBotReady();
    const adapter = createEstateNativeAdapter({
      getBot: () => ensureBotReady(), assertActive: checkTaskSignal,
      getFarmCheckpoint: () => ownerTask?.stepCheckpoint?.estateFarm,
      setFarmCheckpoint: (_owner, state) => updateTaskCheckpoint(ownerTask, { estateFarm: state }),
      report: (message) => { setTaskProgress(message); recordTaskHeartbeat(ownerTask, { actionState: "acting", clearRecoveryReason: true }); },
      reach: furnishedHouseReach, standingSafely: furnishedHouseStandingSafely, digAvoidsSupport: furnishedHouseDigAvoidsSupport,
      moveTo: furnishedHouseMoveTo, placeBlock: placeFurnishedHouseBlock,
      equip: async (name) => {
        const item = findInventoryItem([name]);
        if (!item) throw Object.assign(new Error(`农田缺少 ${name}`), { code: "farm_materials_missing" });
        return equipInventoryItem(item);
      },
      dig: async (block) => { checkTaskSignal(); await equipBestTool(block); checkTaskSignal(); return physicalDigBlock(block, block.displayName || block.name); },
      lookAt: safeBotLookAt, activateItem: () => physicalActivateItem("倒入农田水源"),
      activateBlock: (block, face, cursor, beforeSend) => {
        const ownerContext = getExecutionContext();
        return runBotWritableAction("bot.activateBlock", { itemName: bot.heldItem?.name }, () =>
          withEstateNativeInteractionGuard(bot, { assertActive: () => { checkTaskSignal(); beforeSend?.(); }, isOwnerContext: () => getExecutionContext() === ownerContext },
            () => bot.activateBlock(block, face, cursor)));
      }, wait: sleep,
      openCraftingTable: (block) => runBotWritableAction("bot.openBlock", { itemName: "crafting_table" }, () =>
        withTimeout(bot.openBlock(block), DEFAULT_CONTAINER_TIMEOUT_MS, "打开工作台超时")),
      openContainer: physicalOpenContainer, openFurnace: physicalOpenFurnace,
      openEnchantmentTable: (block) => runBotWritableAction("bot.openEnchantmentTable", { itemName: "enchanting_table" }, () =>
        withTimeout(bot.openEnchantmentTable(block), DEFAULT_CONTAINER_TIMEOUT_MS, "打开附魔台超时")),
    });
    return adapter;
  }

  function chooseEstateAnchor(profile) {
    const bot = ensureBotReady();
    const origin = bot.entity.position.floored();
    for (const [dx, dz] of [[4, 4], [-32, 4], [4, -32], [-32, -32]]) {
      const anchor = toPlainPosition(origin.offset(dx, 0, dz));
      const blueprint = createEstateBlueprint(anchor, { profile });
      if (!blueprint.siteRequirements.dryGroundCells.every((p) => isSafeSupportBlock(bot.blockAt(toVec3(p))))) continue;
      if (profile === "riverside_villa" && !blueprint.blocks.filter((s) => s.component === "villa_dock" && s.phase === "floor")
        .every((s) => bot.blockAt(toVec3(s.position).offset(0, -1, 0))?.name === "water")) continue;
      return anchor;
    }
    throw Object.assign(new Error(profile === "riverside_villa"
      ? "附近没有同时满足干燥主楼、农田和同高度水面码头的已加载河岸，请带我到合适河岸后恢复"
      : "附近没有足够大的已加载平地，请带我到宽阔平地后恢复"), { code: "estate_no_safe_site" });
  }

  async function placeEstateNativeBlock(blueprint, spec, onConfirmed) {
    const bot = ensureBotReady();
    const ownerContext = getExecutionContext();
    const task = ownerContext?.task || currentTask;
    const generation = task?.executionGeneration;
    const lease = getCurrentMovementLease();
    const identity = () => currentBot === bot && currentTask === task && task?.executionGeneration === generation
      && task?.movementLease === lease && isMovementLeaseActive(lease);
    const assertOwner = () => { checkTaskSignal(); if (!identity()) throw createAbortError("movement_preempted"); };
    const dock = createEstateDockPlacement({
      getBot: () => ensureBotReady(), assertActive: assertOwner, isOwnerCurrent: identity,
      moveTo: furnishedHouseMoveTo, standingSafely: furnishedHouseStandingSafely,
      equip: async (name) => { assertOwner(); const item = findInventoryItem([name]);
        if (!item) throw Object.assign(new Error(`码头建材不足：${name}`), { code: "house_materials_missing" });
        await equipInventoryItem(item); assertOwner(); },
      setControl: (name, value) => { assertOwner(); bot.setControlState(name, value); },
      stopOwnMovement: ({ controls, releaseSneak }) => {
        // This callback runs synchronously inside native catch-up physics ticks.
        // Pausing can stop its own controls; a foreign lease cannot be touched.
        if (!identity()) return;
        for (const name of controls) if (name !== "sneak") bot.setControlState(name, false);
        if (releaseSneak) bot.setControlState("sneak", false);
      },
      look: async (yaw, pitch) => {
        assertOwner();
        await runBotWritableAction("bot.look", { reason: "estate_dock" }, () => bot.look(yaw, pitch, false));
        assertOwner();
        await withTimeout(bot.waitForTicks(1), 2500, "码头原生朝向确认超时"); assertOwner();
      },
      waitTick: (timeoutMs) => withTimeout(bot.waitForTicks(1), Math.min(2500, timeoutMs), "码头原生步进确认超时"),
      canPlace: (reference, face, target, feet) => {
        if (!furnishedHouseStandingSafely(feet) || placementIntersectsPlayer(target, feet)) return false;
        const eye = feet.offset(0, Number(bot.entity.eyeHeight) || 1.62, 0);
        const point = reference.position.offset(0.5 + face.x * 0.5, 0.5, 0.5 + face.z * 0.5);
        const goal = new goals.GoalPlaceBlock(target, bot.world, { range: 4.5, faces: [face.scaled(-1)] });
        return eye.distanceTo(point) <= 4.5 && goal.getFaceAndRef(eye) !== null;
      },
      placeAgainst: (reference, face, target, item, options) => withEstateNativeInteractionGuard(bot, {
        assertActive: () => { assertOwner(); options.beforeSend(); },
        isOwnerContext: () => getExecutionContext() === ownerContext,
      }, () => physicalPlaceBlock(reference, face, target, item, { onPlaced: options.onConfirmed, isOwnerCurrent: identity })),
      report: (text) => { assertOwner(); setTaskProgress(text); recordTaskHeartbeat(task, { actionState: "acting", clearRecoveryReason: true }); },
    });
    return createEstatePlacement({
      getBot: () => ensureBotReady(), assertActive: checkTaskSignal,
      isOwnerContext: () => getExecutionContext() === ownerContext,
      placeNative: (entry, confirmed) => entry.component === "villa_dock" && entry.phase === "floor"
        ? dock.place({ blueprint, spec: entry, onConfirmed: confirmed }) : placeFurnishedHouseBlock(entry, confirmed),
    }).place(spec, onConfirmed);
  }

  async function executeBuildEstate(step) {
    const bot = ensureBotReady();
    const ownerTask = currentTask;
    const args = step.args || {};
    const originalArgs = (ownerTask?.completionPlan?.steps || ownerTask?.plan?.steps || [])
      .find(entry => entry.skill === "build_estate")?.args || args;
    const useExternalSupply = originalArgs.useNearbySupplyChests === true && originalArgs.materialSource !== "self_gathered";
    if (!useExternalSupply && args.useNearbySupplyChests === true) throw Object.assign(new Error("恢复任务不能把自采来源改成玩家补给箱"), { code: "estate_source_permission_changed" });
    const report = (message) => { setTaskProgress(message); recordTaskHeartbeat(ownerTask, { actionState: "acting", clearRecoveryReason: true }); };
    let blueprint;
    let depots;
    const inBounds = (p, b) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY - 2 && p.y <= b.maxY + 2 && p.z >= b.minZ && p.z <= b.maxZ;
    function initializeSupply() {
      if (blueprint) return;
      const state = ownerTask?.stepCheckpoint?.estate;
      if (!useExternalSupply && state?.depots?.length) throw Object.assign(new Error("原自采庄园记录中出现外部补给箱，保留现场并停止"), { code: "estate_source_permission_changed" });
      blueprint = createEstateBlueprint(state?.anchor || args.anchor, { profile: args.profile });
      depots = useExternalSupply ? state?.depots || args.depots : [];
      if (!depots) depots = useExternalSupply
        ? findNearestBlocksByNames(["chest", "barrel"], 24, 32).map((b) => toPlainPosition(b.position))
          .filter((p) => !inBounds(p, blueprint.workBounds)).slice(0, 8) : [];
      if (!Array.isArray(depots) || depots.some((p) => inBounds(p, blueprint.workBounds))) {
        throw Object.assign(new Error("指定补给箱不能位于建筑或临时施工范围内"), { code: "estate_invalid_depot" });
      }
      updateTaskCheckpoint(ownerTask, { estate: { ...state, depots: depots.map((p) => ({ ...p })) } });
    }
    const supply = createEstateMaterialSupply({
      getBot: () => ensureBotReady(), assertActive: checkTaskSignal, report,
      isDepotAllowed: (position) => depots?.some((p) => p.x === position.x && p.y === position.y && p.z === position.z) === true
        && !inBounds(position, blueprint.workBounds),
      reachDepot: (position) => furnishedHouseMoveTo(position, 2),
      openDepot: async (position) => {
        checkTaskSignal();
        const block = bot.blockAt(toVec3(position));
        if (!["chest", "barrel"].includes(block?.name)) throw Object.assign(new Error("指定补给位置已不是箱子或木桶"), { code: "estate_depot_changed" });
        const opened = await physicalOpenContainer(block);
        return { containerItems: () => opened.containerItems(), close: () => opened.close(),
          withdraw: (type, metadata, amount) => runBotWritableAction("container.withdraw", { itemName: bot.registry.items[type]?.name },
            () => opened.withdraw(type, metadata, amount)) };
      },
    });
    const adapter = createEstateNativeRuntime(ownerTask);
    const builder = createEstateBuilder({
      getBot: () => ensureBotReady(), assertActive: checkTaskSignal,
      getCheckpoint: () => ownerTask?.stepCheckpoint?.estate,
      setCheckpoint: (state) => updateTaskCheckpoint(ownerTask, { estate: state }),
      recordOwnedBlock: (spec, scaffold) => {
        const latest = ownerTask?.stepCheckpoint?.estate;
        if (latest?.schema !== 1 || latest.sourceProfile !== args.profile) return;
        const next = scaffold ? { ...latest, ownedScaffold: [...(latest.ownedScaffold || []).filter((p) =>
          p.position.x !== spec.position.x || p.position.y !== spec.position.y || p.position.z !== spec.position.z), { ...spec, position: toPlainPosition(spec.position) }] }
          : { ...latest, ownedBlockIds: [...new Set([...(latest.ownedBlockIds || []), spec.id])] };
        ownerTask.stepCheckpoint = { ...ownerTask.stepCheckpoint, estate: next };
      },
      report, getItemCount: getItemCountByName, chooseAnchor: chooseEstateAnchor, selectSite: chooseEstateAnchor,
      prepareMaterials: async (requirements) => {
        initializeSupply(); await adapter.openConstructionDoors(blueprint); checkTaskSignal();
        return useExternalSupply
          ? supply.ensure(requirements, depots)
          : createHouseMaterialRuntime(ownerTask, blueprint, [houseConstructionMaterialBounds(blueprint)]).run(requirements);
      },
      placeBlock: async (spec, onConfirmed) => {
        initializeSupply(); await adapter.openConstructionDoors(blueprint); checkTaskSignal();
        return placeEstateNativeBlock(blueprint, spec, onConfirmed);
      },
      breakBlock: async (position, options) => {
        initializeSupply(); await adapter.openConstructionDoors(blueprint); checkTaskSignal();
        return breakFurnishedHouseBlock(position, options);
      },
      moveTo: async (position, range) => {
        initializeSupply(); await adapter.openConstructionDoors(blueprint); checkTaskSignal();
        return furnishedHouseMoveTo(position, range);
      },
      activateBlock: async (block) => { checkTaskSignal(); await safeBotActivateBlock(block); await sleep(180); checkTaskSignal(); },
      verifyFurniture: async (actualBlueprint) => {
        const checks = await adapter.verifyFurniture(actualBlueprint); checkTaskSignal();
        const furniture = actualBlueprint.furniture;
        if (checks?.craftingTable?.confirmed !== true || checks?.enchantingTable?.confirmed !== true || checks?.bookshelves?.confirmed !== true ||
          checks.bookshelves.effectiveCount < 15 || checks.chests?.length !== (furniture.chests || [furniture.chest]).length ||
          checks.furnaces?.length !== (furniture.furnaces || [furniture.furnace]).length || checks.beds?.length !== (furniture.beds || [furniture.bed]).length ||
          ![...(checks.chests || []), ...(checks.furnaces || []), ...(checks.beds || [])].every(check => check.confirmed === true)) {
          throw Object.assign(new Error("全部原生家具窗口、床和有效书架没有确认"), { code: "estate_furniture_unconfirmed" });
        }
        if (!useExternalSupply && originalArgs.materialSource === "self_gathered") await finishNaturalHouseXP(ownerTask, actualBlueprint);
        return checks;
      }, verifyRoutes: adapter.verifyRoutes,
      buildFarm: async (spec) => {
        initializeSupply();
        const needs = { wheat_seeds: 0, water_bucket: 0, dirt: 0 };
        for (const plot of spec.plots) {
          const water = bot.blockAt(toVec3(plot.water));
          if (water?.name !== "water" || Number(water.getProperties().level) !== 0) needs.water_bucket += 1;
          for (const crop of plot.crops) {
            if (bot.blockAt(toVec3(crop.position))?.name !== "wheat") needs.wheat_seeds += 1;
            if (["air", "cave_air", "void_air"].includes(bot.blockAt(toVec3(crop.soilPosition))?.name)) needs.dirt += 1;
          }
        }
        if (!["wooden_hoe", "stone_hoe", "iron_hoe", "diamond_hoe", "netherite_hoe", "golden_hoe"].some((name) => getItemCountByName(name))) needs.iron_hoe = 1;
        if (useExternalSupply) await supply.ensure(needs, depots);
        else await createHouseMaterialRuntime(ownerTask, blueprint, [houseConstructionMaterialBounds(blueprint)]).run(needs);
        checkTaskSignal();
        const farm = await adapter.farmFor(ownerTask).build(spec);
        const deadline = Date.now() + 420000;
        while (true) {
          checkTaskSignal();
          const hydrated = spec.plots.flatMap((plot) => plot.soil).filter((p) => {
            const block = bot.blockAt(toVec3(p));
            return block?.name === "farmland" && Number(block.getProperties().moisture) === 7;
          }).length;
          if (hydrated === 48) return { ...farm, hydratedCount: hydrated, hydrationVerified: true };
          if (Date.now() >= deadline) throw Object.assign(new Error(`原版自然灌溉尚未全部确认：${hydrated}/48，请稍后恢复`), { code: "farm_hydration_unconfirmed" });
          report(`等待原版水源自然灌溉：${hydrated}/48 格湿度7`);
          await sleep(1000);
        }
      },
    });
    return withFurnishedHouseMovements(() => builder.run(args));
  }

  async function executeSkill(step) {
    const skill = String(step?.skill || "").trim();
    if (!skill) {
      throw new Error("任务步骤缺少 skill");
    }
    const executionContext = {
      itemNeedsCraftingTable,
    };
    const execution = actionRegistry.getExecutionDescriptor(step, executionContext);
    const runtimeGroup = actionRegistry.getExecutionRuntimeGroup(step, executionContext);
    const runtimeKey = actionRegistry.getExecutionRuntimeKey(step, executionContext);
    const runtimeArgs = actionRegistry.getExecutionRuntimeArgs(step, executionContext);

    if (skill === "follow_player") {
      return executeFollowPlayer(step);
    }
    if (skill === "go_to_position") {
      return executeGoToPosition(step);
    }
    if (skill === "collect_block" || skill === "mine_resource" || skill === "gather_stone") {
      return executeMineResource(step);
    }
    if (skill === "gather_wood") {
      return executeMineResource({
        ...step,
        args: {
          ...step.args,
          block: "wood",
          label: "木头",
        },
      });
    }
    if (skill === "harvest_crops") {
      return executeHarvestCrops(step);
    }
    if (skill === "plant_crops") {
      return executePlantCrops(step);
    }
    if (skill === "attack_hostile") {
      return executeAttackHostile(step);
    }
    if (skill === "escort_player") {
      return executeEscortPlayer(step);
    }
    if (skill === "place_block") {
      return executePlaceBlock(step);
    }
    if (skill === "break_block") {
      return executeBreakBlock(step);
    }
    if (skill === "deposit_items") {
      return executeDepositItems(step);
    }
    if (skill === "withdraw_items") {
      return executeWithdrawItems(step);
    }
    const groupedSkillHandlers = {
      ensure_infrastructure: async () => {
        const anchorPosition = runtimeArgs.position || null;
        const infrastructureHandlers = {
          crafting_table: async () => ensureCraftingTableAvailable(anchorPosition),
          furnace: async () => ensureFurnaceAvailable(anchorPosition),
          container: async () => ensureContainerAvailable(anchorPosition),
          lighting: async () =>
            ensureLightingAround(runtimeArgs.position, {
              radius: Number(runtimeArgs.radius) || 6,
              minLights: Number(runtimeArgs.minLights) || 3,
              minSpacing: Number(runtimeArgs.minSpacing) || 3,
            }),
          bed: async () => ensureBedAvailable(anchorPosition),
          nether_portal: async () => ensureNetherPortalAvailable(anchorPosition),
        };
        const handler = infrastructureHandlers[runtimeKey];
        if (!handler) {
          throw new Error(`ensure_infrastructure 不支持 kind=${runtimeKey}`);
        }
        await handler();
      },
      maintain_self: async () => {
        const maintainSelfHandlers = {
          eat_if_needed: async () => ensureNutrition(clamp(Number(runtimeArgs.minFood) || 16, 10, 20)),
          restock_food: async () =>
            ensureFoodSupply(clamp(Number(runtimeArgs.minCount) || DEFAULT_FOOD_RESERVE_COUNT, 1, 32)),
          pickup_nearby_drops: async () =>
            collectNearbyDroppedItems({
              radius: Number(runtimeArgs.radius) || 6,
              timeoutMs: Number(runtimeArgs.timeoutMs) || 3000,
              idleGraceMs: Number(runtimeArgs.idleGraceMs) || 400,
            }),
          sleep_if_night: async () =>
            sleepAtNearbyBed({
              maxDistance: Number(runtimeArgs.maxDistance) || 10,
              waitMs: Number(runtimeArgs.waitMs) || 8000,
            }),
          enter_nether_portal: async () =>
            enterNearbyNetherPortal({
              maxDistance: Number(runtimeArgs.maxDistance) || 12,
              waitMs: Number(runtimeArgs.waitMs) || 20000,
            }),
          use_eye_of_ender: async () =>
            useEyeOfEnderForStrongholdSearch({
              waitMs: Number(runtimeArgs.waitMs) || 2500,
            }),
          fill_end_portal_frames: async () =>
            fillNearbyEndPortalFrames({
              maxDistance: Number(runtimeArgs.maxDistance) || 48,
            }),
          enter_end_portal: async () =>
            enterNearbyEndPortal({
              maxDistance: Number(runtimeArgs.maxDistance) || 24,
              waitMs: Number(runtimeArgs.waitMs) || 15000,
            }),
          stabilize_end_spawn: async () =>
            stabilizeEndSpawn({
              minFood: Number(runtimeArgs.minFood) || 16,
            }),
          break_end_crystal: async () =>
            breakNearbyEndCrystal({
              maxDistance: Number(runtimeArgs.maxDistance) || 48,
              timeoutMs: Number(runtimeArgs.timeoutMs) || 12000,
            }),
          attack_ender_dragon: async () =>
            attackEnderDragonBasic({
              maxDistance: Number(runtimeArgs.maxDistance) || 96,
              timeoutMs: Number(runtimeArgs.timeoutMs) || 12000,
            }),
          recover_end_fight: async () =>
            recoverForEndFight({
              minFood: Number(runtimeArgs.minFood) || 18,
              waitMs: Number(runtimeArgs.waitMs) || 1800,
            }),
          reposition_end_fight: async () =>
            repositionForEndFight({
              maxDistance: Number(runtimeArgs.maxDistance) || 24,
              waitMs: Number(runtimeArgs.waitMs) || 900,
            }),
          hold_end_fight_window: async () =>
            holdForEnderDragonWindow({
              maxDistance: Number(runtimeArgs.maxDistance) || 24,
              waitMs: Number(runtimeArgs.waitMs) || 1600,
            }),
          approach_end_victory_marker: async () =>
            approachEndVictoryMarker({
              maxDistance: Number(runtimeArgs.maxDistance) || 64,
              range: Number(runtimeArgs.range) || 3,
            }),
        };
        const handler = maintainSelfHandlers[runtimeKey];
        if (!handler) {
          throw new Error(`maintain_self 不支持 action=${runtimeKey}`);
        }
        await handler();
      },
      craft_item: async () => {
        const itemName = runtimeKey;
        if (!itemName) {
          throw new Error("craft_item 缺少 item");
        }
        const count = clamp(Number(execution.count) || 1, 1, 32);
        if (itemName === "stick") {
          await ensureSticks(count);
          return;
        }
        const craftingTable = execution.needsCraftingTable
          ? await ensureCraftingTableAvailable()
          : null;
        await craftItemByName(itemName, count, craftingTable);
      },
      smelt_item: async () => {
        await executeSmeltItem({
          ...step,
          args: runtimeArgs || step.args || {},
        });
      },
      build_structure: async () =>
        executeBuildStructure({
          ...step,
          args: runtimeArgs || step.args || {},
        }),
      build_furnished_house_phase: async () => executeBuildFurnishedHousePhase({ ...step, args: runtimeArgs || step.args || {} }),
      build_estate: async () => executeBuildEstate({ ...step, args: runtimeArgs || step.args || {} }),
      build_small_house_phase: async () =>
        executeBuildSmallHousePhase({
          ...step,
          args: runtimeArgs || step.args || {},
        }),
    };
    const groupedHandler = groupedSkillHandlers[runtimeGroup];
    if (groupedHandler) {
      await groupedHandler();
      return;
    }
    throw new Error(`当前还不支持技能 ${skill}`);
  }

  function buildAutonomousMaintenancePlan(options = {}) {
    if (!currentBot?.entity) {
      return null;
    }
    const excludedIntents = new Set(
      (Array.isArray(options.excludeIntents) ? options.excludeIntents : [])
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    );
    const isExcluded = (intent) => excludedIntents.has(String(intent || "").trim());
    const playerName = getBestKnownPlayerName();
    const playerTarget = playerName ? findPlayerTarget(playerName) : null;
    const nearbyHostiles = getNearbyHostiles();
    if (
      nearbyHostiles.length &&
      Number(nearbyHostiles[0]?.distance || 99) <= 10 &&
      !playerTarget?.entity
    ) {
      return null;
    }
    if (Number.isFinite(currentBot.health) && currentBot.health < 10) {
      return null;
    }
    const distanceToPlayer = playerTarget?.position
      ? getDistance(currentBot.entity.position, playerTarget.position)
      : Number.POSITIVE_INFINITY;
    const nearestDroppedItem = findNearestDroppedItemEntity({
      position: currentBot.entity.position,
      radius: 6,
      maxDistance: 6,
    });
    const timeInfo = getTimeOfDayInfo();
    const nearbyContainer = findNearbyContainer(12);
    const nearbyCraftingTable = findNearbyCraftingTable(12);
    const nearbyFurnaceBlock = findNearbyFurnace(12);
    const nearbyBed = findNearbyBed(12);
    const inventoryEntryCount = getInventoryEntryCount();
    const hasNearbyBase = Boolean(nearbyContainer || nearbyCraftingTable || nearbyFurnaceBlock);
    const workAreaCenter = getCompanionWorkAreaCenter({ playerTarget });
    const workAreaAnchor = workAreaCenter || playerTarget?.position || currentBot.entity.position;
    const distanceToWorkArea = workAreaCenter
      ? getHorizontalDistance(currentBot.entity.position, workAreaCenter)
      : Number.POSITIVE_INFINITY;
    const nearbyTorchCount = countNearbyBlocksByNames(TORCH_BLOCK_NAMES, workAreaAnchor, 6, 3);
    const recentlyBuiltHouse = hasRecentTaskOutcome(
      "build_small_house",
      [TaskState.COMPLETED],
      30 * 60 * 1000
    );
    const recentlyFailedHouse = hasRecentTaskOutcome(
      "build_small_house",
      [TaskState.BLOCKED, TaskState.FAILED],
      8 * 60 * 1000
    );
    const recentlyFailedStorage = hasRecentTaskOutcome(
      "autonomous_prepare_storage",
      [TaskState.BLOCKED, TaskState.FAILED],
      8 * 60 * 1000
    );
    const recentlyFailedCraftingStation = hasRecentTaskOutcome(
      "autonomous_prepare_crafting_table",
      [TaskState.BLOCKED, TaskState.FAILED],
      8 * 60 * 1000
    );
    const recentlyFailedFurnaceStation = hasRecentTaskOutcome(
      "autonomous_prepare_furnace",
      [TaskState.BLOCKED, TaskState.FAILED],
      8 * 60 * 1000
    );
    const recentlyFailedLighting = hasRecentTaskOutcome(
      "autonomous_prepare_lighting",
      [TaskState.BLOCKED, TaskState.FAILED],
      8 * 60 * 1000
    );
    const recentlyFailedWorkArea = hasRecentTaskOutcome(
      "autonomous_settle_work_area",
      [TaskState.BLOCKED, TaskState.FAILED],
      10 * 60 * 1000
    );
    const recentlyFailedSleep = hasRecentTaskOutcome(
      "autonomous_sleep_until_morning",
      [TaskState.BLOCKED, TaskState.FAILED],
      8 * 60 * 1000
    );
    const recentlyFailedFoodStock = hasRecentTaskOutcome(
      "autonomous_stock_food",
      [TaskState.BLOCKED, TaskState.FAILED],
      8 * 60 * 1000
    );
    const hasAxe = Boolean(findInventoryItem(AXE_ITEM_PRIORITY));
    const hasPickaxe = Boolean(findInventoryItem(PICKAXE_ITEM_NAMES));
    const hasIronPickaxeOrBetter = hasDiamondMiningPickaxe();
    const hasWeapon = Boolean(findInventoryItem(WEAPON_ITEM_PRIORITY));
    const hasBedItem = Boolean(findInventoryItem(BED_ITEM_NAMES));
    const craftableBedName = getCraftableBedItemName();
    const foodReserveCount = getFoodReserveCount();
    const plantingReserveCount = getPlantingReserveCount();
    const woodStock = getItemCount(ANY_PLANKS) + getTotalLogCount() * 4;
    const cobbleStock = getItemCountByName("cobblestone");
    const ironStock = getItemCountByName("iron_ingot") + getItemCount(IRON_ORE_ITEM_NAMES);
    const fuelStock = getItemCount(SMELT_FUEL_ITEM_PRIORITY);
    const nearbyFoodCropCount = findNearestMatureCropBlocks(["wheat", "carrots", "potatoes"], 20, 12).length;
    const nearbyPlantableFarmlandCount = findPlantableFarmlandTargets(["wheat", "carrots", "potatoes"], 20, 12).length;
    const outputBacklogCount = getItemCount(
      ["cobblestone", "coal", "raw_iron", "iron_ingot", "wheat", ...ANY_PLANKS, ...Object.keys(LOG_TO_PLANK)]
    );
    const nearbyLog = findNearestBlockByNames(
      Object.keys(LOG_TO_PLANK),
      getLearnedSearchRadius("wood", 48, 72)
    );
    const nearbyStone = findNearestBlockByNames(
      ["stone", "cobblestone"],
      getLearnedSearchRadius("stone", 36, 72)
    );
    const nearbyIron = findNearestBlockByNames(
      ["iron_ore", "deepslate_iron_ore"],
      getLearnedSearchRadius("iron", 40, 80)
    );
    const nearbyCoal = findNearestBlockByNames(
      ["coal_ore", "deepslate_coal_ore"],
      getLearnedSearchRadius("coal", 36, 72)
    );
    const nearbyDiamond = findNearestBlockByNames(
      ["diamond_ore", "deepslate_diamond_ore"],
      getLearnedSearchRadius("diamond", 48, 96)
    );
    const nearbyObsidian = findNearestBlockByNames(
      ["obsidian"],
      getLearnedSearchRadius("obsidian", 24, 64)
    );
    const nearbyGravel = findNearestBlockByNames(
      ["gravel"],
      getLearnedSearchRadius("gravel", 24, 48)
    );
    const nearbyEnderman = findSpecificHostileEntity(
      ["enderman"],
      playerTarget?.entity || null,
      18,
      {
        protectEntity: playerTarget?.entity || null,
        maxBotDistance: 24,
      }
    );
    const nearbyBlaze = findSpecificHostileEntity(
      ["blaze"],
      playerTarget?.entity || null,
      18,
      {
        protectEntity: playerTarget?.entity || null,
        maxBotDistance: 24,
      }
    );
    const dragonProgress = getDragonProgressionSnapshot();
    const returnStep = playerName
      ? actionRegistry.createActionStep("follow_player", {
          playerName,
          distance: 3,
          once: true,
        })
      : null;
    const workAreaTorchCount = countNearbyBlocksByNames(
      TORCH_BLOCK_NAMES,
      workAreaAnchor,
      6,
      4
    );

    const foodItem = findBestFoodItem();
    if (!isExcluded("autonomous_maintain_food") && Number.isFinite(currentBot.food) && currentBot.food < 14 && foodItem) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_maintain_food", {
        returnStep,
        distanceToPlayer,
      });
    }

    if (!isExcluded("autonomous_pickup_drops") && nearestDroppedItem) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_pickup_drops", {
        returnStep,
        distanceToPlayer,
      });
    }

    if (
      !isExcluded("autonomous_guard_player") &&
      playerTarget?.entity
    ) {
      const playerThreat = findHostileEntity(playerTarget.entity, 12, {
        protectEntity: playerTarget.entity,
        maxBotDistance: 20,
      });
      if (playerThreat) {
        return actionRegistry.buildAutonomousTaskPlan("autonomous_guard_player", {
          returnStep,
          distanceToPlayer,
        });
      }
    }

    if (
      !isExcluded("autonomous_build_companion_house") &&
      playerTarget?.entity &&
      Number.isFinite(distanceToPlayer) &&
      distanceToPlayer <= 10 &&
      timeInfo.isLate &&
      !hasNearbyBase &&
      !recentlyBuiltHouse &&
      !recentlyFailedHouse &&
      woodStock >= 20
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_build_companion_house", {
        returnStep,
        distanceToPlayer,
      });
    }

    if (
      !isExcluded("autonomous_prepare_shelter_materials") &&
      playerTarget?.entity &&
      Number.isFinite(distanceToPlayer) &&
      distanceToPlayer <= 12 &&
      timeInfo.isLate &&
      !hasNearbyBase &&
      !recentlyBuiltHouse &&
      woodStock < 20 &&
      nearbyLog
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_prepare_shelter_materials", {
        returnStep,
        distanceToPlayer,
      }, {
        getLearnedSearchRadius,
      });
    }

    if (
      !isExcluded("autonomous_settle_work_area") &&
      playerTarget?.entity &&
      Number.isFinite(distanceToPlayer) &&
      distanceToPlayer <= 12 &&
      !recentlyFailedWorkArea
    ) {
      const workAreaSteps = [];
      if (!nearbyCraftingTable && !recentlyFailedCraftingStation && (woodStock >= 4 || nearbyLog)) {
        workAreaSteps.push(
          actionRegistry.createActionStep("ensure_infrastructure", {
            kind: "crafting_table",
            position: workAreaAnchor,
          })
        );
      }
      if (
        hasPickaxe &&
        !nearbyFurnaceBlock &&
        !recentlyFailedFurnaceStation &&
        (nearbyIron || nearbyCoal || getItemCount(IRON_ORE_ITEM_NAMES) > 0) &&
        (cobbleStock >= 8 || nearbyStone)
      ) {
        workAreaSteps.push(
          actionRegistry.createActionStep("ensure_infrastructure", {
            kind: "furnace",
            position: workAreaAnchor,
          })
        );
      }
      if (
        !nearbyContainer &&
        !recentlyFailedStorage &&
        inventoryEntryCount >= 12 &&
        (woodStock >= 8 || nearbyLog)
      ) {
        workAreaSteps.push(
          actionRegistry.createActionStep("ensure_infrastructure", {
            kind: "container",
            position: workAreaAnchor,
          })
        );
      }
      if (
        !nearbyBed &&
        hasNearbyBase &&
        !timeInfo.isNight &&
        !recentlyFailedSleep &&
        (hasBedItem || craftableBedName)
      ) {
        workAreaSteps.push(
          actionRegistry.createActionStep("ensure_infrastructure", {
            kind: "bed",
            position: workAreaAnchor,
          })
        );
      }
      if (
        (hasNearbyBase || workAreaSteps.length >= 2 || timeInfo.isLate) &&
        !recentlyFailedLighting &&
        workAreaTorchCount < (hasNearbyBase ? 4 : 3) &&
        (getItemCountByName("torch") > 0 || getItemCount(TORCH_FUEL_ITEM_NAMES) > 0 || nearbyCoal) &&
        (getItemCountByName("stick") > 0 || woodStock >= 2 || nearbyLog)
      ) {
        workAreaSteps.push(
          actionRegistry.createActionStep("ensure_infrastructure", {
            kind: "lighting",
            position: workAreaAnchor,
            radius: 6,
            minLights: hasNearbyBase ? 4 : 3,
            minSpacing: 3,
          })
        );
      }
      if (workAreaSteps.length >= 2) {
        return actionRegistry.buildAutonomousTaskPlan("autonomous_settle_work_area", {
          returnStep,
          distanceToPlayer,
          workAreaSteps,
        });
      }
    }

    if (
      !isExcluded("autonomous_prepare_storage") &&
      playerTarget?.entity &&
      Number.isFinite(distanceToPlayer) &&
      distanceToPlayer <= 12 &&
      !nearbyContainer &&
      !recentlyFailedStorage &&
      inventoryEntryCount >= 18 &&
      (woodStock >= 8 || nearbyLog)
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_prepare_storage", {
        returnStep,
        distanceToPlayer,
        workAreaAnchor,
      });
    }

    if (
      !isExcluded("autonomous_prepare_lighting") &&
      playerTarget?.entity &&
      Number.isFinite(distanceToPlayer) &&
      distanceToPlayer <= 12 &&
      (timeInfo.isLate || (hasNearbyBase && timeInfo.isNight)) &&
      nearbyTorchCount < (hasNearbyBase ? 4 : 3) &&
      !recentlyFailedLighting &&
      (getItemCountByName("torch") > 0 || getItemCount(TORCH_FUEL_ITEM_NAMES) > 0 || nearbyCoal) &&
      (getItemCountByName("stick") > 0 || woodStock >= 2 || nearbyLog)
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_prepare_lighting", {
        returnStep,
        distanceToPlayer,
        workAreaAnchor,
        hasNearbyBase,
      });
    }

    if (
      !isExcluded("autonomous_sleep_until_morning") &&
      playerTarget?.entity &&
      Number.isFinite(distanceToPlayer) &&
      distanceToPlayer <= 8 &&
      timeInfo.isNight &&
      !recentlyFailedSleep &&
      nearbyHostiles.filter((entity) => Number(entity?.distance || 99) <= 12).length === 0 &&
      (nearbyBed || hasBedItem || craftableBedName)
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_sleep_until_morning", {
        returnStep,
        distanceToPlayer,
        workAreaAnchor,
        nearbyBed,
      });
    }

    if (
      !isExcluded("autonomous_stock_food") &&
      playerTarget?.entity &&
      Number.isFinite(distanceToPlayer) &&
      distanceToPlayer <= 12 &&
      foodReserveCount < DEFAULT_FOOD_RESERVE_COUNT &&
      !recentlyFailedFoodStock &&
      (nearbyContainer || getItemCountByName("wheat") >= 3 || nearbyFoodCropCount > 0)
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_stock_food", {
        returnStep,
        distanceToPlayer,
        minCount: DEFAULT_FOOD_RESERVE_COUNT,
      });
    }

    if (
      !isExcluded("autonomous_harvest_food_inputs") &&
      playerTarget?.entity &&
      Number.isFinite(distanceToPlayer) &&
      distanceToPlayer <= 12 &&
      nearbyFoodCropCount >= 3 &&
      foodReserveCount < DEFAULT_FOOD_RESERVE_COUNT + 2
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_harvest_food_inputs", {
        returnStep,
        distanceToPlayer,
        count: nearbyFoodCropCount,
        maxDistance: 20,
      });
    }

    if (
      !isExcluded("autonomous_replant_farm") &&
      playerTarget?.entity &&
      Number.isFinite(distanceToPlayer) &&
      distanceToPlayer <= 12 &&
      nearbyPlantableFarmlandCount >= 3 &&
      nearbyContainer &&
      (findInventoryItem(["wheat_seeds", "carrot", "potato"]) || nearbyFoodCropCount > 0)
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_replant_farm", {
        returnStep,
        distanceToPlayer,
        harvestCount: nearbyFoodCropCount,
        plantCount: nearbyPlantableFarmlandCount,
        maxDistance: 20,
      });
    }

    if (
      !isExcluded("autonomous_stock_planting_inputs") &&
      playerTarget?.entity &&
      Number.isFinite(distanceToPlayer) &&
      distanceToPlayer <= 12 &&
      nearbyContainer &&
      nearbyPlantableFarmlandCount >= 2 &&
      plantingReserveCount < 6
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_stock_planting_inputs", {
        returnStep,
        distanceToPlayer,
        count: 6,
      });
    }

    if (
      !isExcluded("autonomous_consolidate_outputs") &&
      nearbyContainer &&
      inventoryEntryCount >= 14 &&
      outputBacklogCount >= 24
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_consolidate_outputs", {
        returnStep,
        distanceToPlayer,
      });
    }

    if (
      !isExcluded("autonomous_organize_inventory") &&
      nearbyContainer &&
      inventoryEntryCount >= 24
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_organize_inventory", {
        returnStep,
        distanceToPlayer,
      });
    }

    if (
      !isExcluded("autonomous_prepare_crafting_table") &&
      playerTarget?.entity &&
      Number.isFinite(distanceToPlayer) &&
      distanceToPlayer <= 12 &&
      !nearbyCraftingTable &&
      !recentlyFailedCraftingStation &&
      (woodStock >= 4 || nearbyLog)
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_prepare_crafting_table", {
        returnStep,
        distanceToPlayer,
        workAreaAnchor,
      });
    }

    if (
      !isExcluded("autonomous_prepare_furnace") &&
      playerTarget?.entity &&
      Number.isFinite(distanceToPlayer) &&
      distanceToPlayer <= 12 &&
      hasPickaxe &&
      !nearbyFurnaceBlock &&
      !recentlyFailedFurnaceStation &&
      (nearbyIron || nearbyCoal || getItemCount(IRON_ORE_ITEM_NAMES) > 0) &&
      (cobbleStock >= 8 || nearbyStone)
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_prepare_furnace", {
        returnStep,
        distanceToPlayer,
        workAreaAnchor,
      });
    }

    if (
      !isExcluded("autonomous_stock_coal") &&
      playerTarget?.entity &&
      Number.isFinite(distanceToPlayer) &&
      distanceToPlayer <= 12 &&
      hasPickaxe &&
      fuelStock < 4 &&
      nearbyCoal
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_stock_coal", {
        returnStep,
        distanceToPlayer,
        count: 4,
      }, {
        getLearnedSearchRadius,
      });
    }

    if (
      !isExcluded("autonomous_prepare_diamond_pickaxe") &&
      dragonProgress.stage === "collect_diamonds" &&
      nearbyDiamond &&
      Number.isFinite(distanceToPlayer) &&
      distanceToPlayer <= 16
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_prepare_diamond_pickaxe", {
        returnStep,
        distanceToPlayer,
        count: Math.max(3 - getItemCountByName("diamond"), 1),
      }, {
        getLearnedSearchRadius,
      });
    }

    if (
      !isExcluded("autonomous_craft_diamond_pickaxe") &&
      dragonProgress.stage === "craft_diamond_pickaxe"
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_craft_diamond_pickaxe", {
        returnStep,
        distanceToPlayer,
      });
    }

    if (
      !isExcluded("autonomous_collect_obsidian") &&
      dragonProgress.stage === "collect_obsidian" &&
      nearbyObsidian &&
      Number.isFinite(distanceToPlayer) &&
      distanceToPlayer <= 18
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_collect_obsidian", {
        returnStep,
        distanceToPlayer,
        count: Math.max(10 - getItemCountByName("obsidian"), 1),
      }, {
        getLearnedSearchRadius,
      });
    }

    if (
      !isExcluded("autonomous_collect_flint") &&
      dragonProgress.stage === "collect_flint" &&
      nearbyGravel
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_collect_flint", {
        returnStep,
        distanceToPlayer,
        count: 1,
      }, {
        getLearnedSearchRadius,
      });
    }

    if (
      !isExcluded("autonomous_craft_flint_and_steel") &&
      dragonProgress.stage === "craft_flint_and_steel"
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_craft_flint_and_steel", {
        returnStep,
        distanceToPlayer,
      });
    }

    if (
      !isExcluded("autonomous_collect_ender_pearls") &&
      dragonProgress.stage === "collect_ender_pearls" &&
      hasWeapon &&
      nearbyEnderman
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_collect_ender_pearls", {
        returnStep,
        distanceToPlayer,
      });
    }

    if (
      !isExcluded("autonomous_collect_blaze_rods") &&
      dragonProgress.stage === "collect_blaze_rods" &&
      hasWeapon &&
      nearbyBlaze
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_collect_blaze_rods", {
        returnStep,
        distanceToPlayer,
      });
    }

    if (
      !isExcluded("autonomous_search_blaze_area") &&
      dragonProgress.stage === "collect_blaze_rods" &&
      String(currentBot.game?.dimension || "").includes("nether") &&
      hasWeapon &&
      !nearbyBlaze
    ) {
      const scoutTarget = getNetherBlazeScoutTarget();
      if (scoutTarget) {
        return actionRegistry.buildAutonomousTaskPlan("autonomous_search_blaze_area", {
          scoutTarget,
        });
      }
    }

    if (
      !isExcluded("autonomous_craft_eyes_of_ender") &&
      dragonProgress.stage === "craft_eyes_of_ender"
    ) {
      const craftCount = Math.max(
        1,
        Math.min(
          12 - getItemCountByName("eye_of_ender"),
          getItemCountByName("ender_pearl"),
          getItemCountByName("blaze_powder") + getItemCountByName("blaze_rod") * 2
        )
      );
      return actionRegistry.buildAutonomousTaskPlan("autonomous_craft_eyes_of_ender", {
        returnStep,
        distanceToPlayer,
        craftCount,
        needsBlazePowder: getItemCountByName("blaze_powder") < craftCount,
      });
    }

    if (
      !isExcluded("autonomous_build_nether_portal") &&
      dragonProgress.stage === "build_nether_portal"
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_build_nether_portal", {
        returnStep,
        distanceToPlayer,
        workAreaAnchor,
      });
    }

    if (
      !isExcluded("autonomous_enter_nether") &&
      dragonProgress.stage === "enter_nether"
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_enter_nether", {});
    }

    if (
      !isExcluded("autonomous_return_overworld") &&
      dragonProgress.stage === "return_overworld"
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_return_overworld", {});
    }

    if (
      !isExcluded("autonomous_locate_stronghold") &&
      dragonProgress.stage === "locate_stronghold"
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_locate_stronghold", {
        lastEyeTrace: dragonProgress.lastEyeTrace
          ? {
              x: dragonProgress.lastEyeTrace.x,
              y: dragonProgress.lastEyeTrace.y || currentBot.entity.position.y,
              z: dragonProgress.lastEyeTrace.z,
            }
          : null,
      });
    }

    if (
      !isExcluded("autonomous_advance_stronghold") &&
      dragonProgress.stage === "stronghold_ready" &&
      dragonProgress.lastEyeTrace
    ) {
      const advanceTarget = getStrongholdAdvanceTarget({
        stepDistance: dragonProgress.locateAttempts >= 4 ? 128 : 96,
      });
      if (advanceTarget) {
        return actionRegistry.buildAutonomousTaskPlan("autonomous_advance_stronghold", {
          advanceTarget,
          shouldRefreshEye:
            getItemCountByName("eye_of_ender") > 1 &&
            shouldRefreshStrongholdLocate({
              minTravelDistance: dragonProgress.locateAttempts >= 4 ? 72 : 56,
              maxLocateAgeMs: 30_000,
            }),
        });
      }
    }

    if (
      !isExcluded("autonomous_search_portal_room") &&
      dragonProgress.stage === "search_portal_room"
    ) {
      const strongholdTarget = getStrongholdStructureTarget({
        maxDistance: 64,
      });
      if (strongholdTarget) {
        return actionRegistry.buildAutonomousTaskPlan("autonomous_search_portal_room", {
          target: strongholdTarget,
        });
      }
    }

    if (
      !isExcluded("autonomous_approach_end_portal_room") &&
      dragonProgress.stage === "approach_end_portal_room"
    ) {
      const portalRoomTarget = getStrongholdStructureTarget({
        maxDistance: 64,
      });
      if (portalRoomTarget) {
        return actionRegistry.buildAutonomousTaskPlan("autonomous_approach_end_portal_room", {
          target: portalRoomTarget,
        });
      }
    }

    if (
      !isExcluded("autonomous_fill_end_portal") &&
      dragonProgress.stage === "fill_end_portal"
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_fill_end_portal", {});
    }

    if (
      !isExcluded("autonomous_enter_end") &&
      dragonProgress.stage === "enter_end"
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_enter_end", {});
    }

    if (
      !isExcluded("autonomous_stabilize_end") &&
      dragonProgress.stage === "stabilize_end"
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_stabilize_end", {});
    }

    if (
      !isExcluded("autonomous_reposition_end_fight") &&
      dragonProgress.stage === "reposition_end_fight"
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_reposition_end_fight", {});
    }

    if (
      !isExcluded("autonomous_recover_end_fight") &&
      dragonProgress.stage === "recover_end_fight"
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_recover_end_fight", {});
    }

    if (
      !isExcluded("autonomous_clear_end_crystals") &&
      dragonProgress.stage === "clear_end_crystals"
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_clear_end_crystals", {});
    }

    if (
      !isExcluded("autonomous_approach_end_crystal") &&
      dragonProgress.stage === "approach_end_crystal"
    ) {
      const crystalTarget = getEndCrystalApproachTarget({
        maxDistance: 64,
        maxHorizontalDistance: 12,
        maxVerticalGap: 8,
      });
      if (crystalTarget) {
        return actionRegistry.buildAutonomousTaskPlan("autonomous_approach_end_crystal", {
          target: crystalTarget,
        });
      }
    }

    if (
      !isExcluded("autonomous_wait_ender_dragon_window") &&
      dragonProgress.stage === "wait_ender_dragon_window"
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_wait_ender_dragon_window", {});
    }

    if (
      !isExcluded("autonomous_complete_end_fight") &&
      dragonProgress.stage === "complete_end_fight"
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_complete_end_fight", {});
    }

    if (
      !isExcluded("autonomous_hold_dragon_victory") &&
      dragonProgress.stage === "dragon_run_complete" &&
      String(currentBot.game?.dimension || "").includes("the_end") &&
      dragonProgress.completionMarker?.position
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_hold_dragon_victory", {
        marker: dragonProgress.completionMarker.position,
      });
    }

    if (
      !isExcluded("autonomous_attack_ender_dragon") &&
      dragonProgress.stage === "attack_ender_dragon"
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_attack_ender_dragon", {});
    }

    if (
      !isExcluded("autonomous_return_to_work_area") &&
      workAreaCenter &&
      Number.isFinite(distanceToWorkArea) &&
      distanceToWorkArea > 10 &&
      (!playerTarget?.entity || distanceToPlayer > 10)
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_return_to_work_area", {
        x: workAreaAnchor.x,
        y: workAreaAnchor.y,
        z: workAreaAnchor.z,
      });
    }

    if (
      !isExcluded("autonomous_return_to_player") &&
      returnStep &&
      distanceToPlayer > 8 &&
      Number.isFinite(distanceToPlayer)
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_return_to_player", {
        returnStep,
        distanceToPlayer,
        goal: "return near the player and stay in companion range",
        replyText: "我先回到你附近，别离你太远了。",
      });
    }

    if (!isExcluded("autonomous_prepare_axe") && !hasAxe && nearbyLog) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_prepare_axe", {
        returnStep,
        distanceToPlayer,
      });
    }

    if (
      !isExcluded("autonomous_stock_iron") &&
      hasPickaxe &&
      getItemCountByName("iron_ingot") < 6 &&
      (nearbyIron || ironStock >= 2) &&
      (getItemCount(SMELT_FUEL_ITEM_PRIORITY) > 0 || nearbyCoal)
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_stock_iron", {
        returnStep,
        distanceToPlayer,
        oreInInventory: getItemCount(IRON_ORE_ITEM_NAMES),
        ironOreItemNames: IRON_ORE_ITEM_NAMES,
      }, {
        getLearnedSearchRadius,
      });
    }

    if (
      !isExcluded("autonomous_progress_diamond") &&
      hasIronPickaxeOrBetter &&
      nearbyDiamond &&
      Number.isFinite(distanceToPlayer) &&
      distanceToPlayer <= 12
    ) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_progress_diamond", {
        returnStep,
        distanceToPlayer,
        count: 1,
      }, {
        getLearnedSearchRadius,
      });
    }

    if (!isExcluded("autonomous_prepare_pickaxe") && !hasPickaxe && (nearbyStone || woodStock >= 3)) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_prepare_pickaxe", {
        returnStep,
        distanceToPlayer,
        woodStock,
        shouldGatherWood: woodStock < 6 && Boolean(nearbyLog),
      });
    }

    if (
      !isExcluded("autonomous_prepare_iron_pickaxe") &&
      !hasIronPickaxeOrBetter &&
      hasPickaxe &&
      (ironStock >= 3 || nearbyIron) &&
      (getItemCount(SMELT_FUEL_ITEM_PRIORITY) > 0 || nearbyCoal)
    ) {
      const steps = buildIronPickaxeProgressionSteps({
        includeFinalCraft: true,
        requiredIronIngots: 3,
      });
      return actionRegistry.buildAutonomousTaskPlan("autonomous_prepare_iron_pickaxe", {
        returnStep,
        distanceToPlayer,
        progressionSteps: steps,
      });
    }

    if (!isExcluded("autonomous_prepare_weapon") && !hasWeapon && (cobbleStock >= 2 || woodStock >= 2)) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_prepare_weapon", {
        returnStep,
        distanceToPlayer,
        hasCobble: cobbleStock >= 2,
        needsWood: woodStock < 2 && Boolean(nearbyLog),
      });
    }

    if (!isExcluded("autonomous_stock_wood") && woodStock < 12 && nearbyLog) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_stock_wood", {
        returnStep,
        distanceToPlayer,
      });
    }

    if (!isExcluded("autonomous_stock_cobblestone") && hasPickaxe && cobbleStock < 16 && nearbyStone) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_stock_cobblestone", {
        returnStep,
        distanceToPlayer,
      });
    }

    if (!isExcluded("autonomous_return_to_player") && returnStep && distanceToPlayer > 6 && Number.isFinite(distanceToPlayer)) {
      return actionRegistry.buildAutonomousTaskPlan("autonomous_return_to_player", {
        returnStep,
        distanceToPlayer,
        goal: "return near the player and wait",
        replyText: "我先回到你附近待命，方便继续接任务。",
      });
    }

    return null;
  }

  function submitAutonomousPlan(plan, options = {}) {
    if (!plan || currentTask || !currentBot?.entity) {
      return false;
    }
    if (isStrictExecutorMode() && options.force !== true) {
      rememberBackgroundAgenda(plan, {
        phase: options.phase || plan.phase || autonomousState.lastPhase || "wait",
      });
      autonomousState.suppressedByForeground = Boolean(getForegroundTaskPublic());
      return false;
    }
    const compiledPlan = compileTaskScriptPlan(plan.replyText || plan.intent || "自主发育", plan);
    rememberBackgroundAgenda(compiledPlan, {
      phase: options.phase || compiledPlan.phase || plan.phase || autonomousState.lastPhase || "wait",
    });
    const planAnchor =
      compiledPlan.steps
        ?.map((step) => step?.args?.position)
        .map(toPlainPosition)
        .find(Boolean) || getCompanionWorkAreaCenter();
    if (planAnchor) {
      rememberAutonomousWorkAreaCenter(planAnchor);
    }
    autonomousState.running = true;
    autonomousState.lastPhase = String(
      options.phase || compiledPlan.phase || plan.phase || ""
    ).trim() || "wait";
    autonomousState.lastDecisionAt = Date.now();
    currentTask = {
      taskId: `task-${taskCounter++}`,
      source: "autonomous",
      userCommand: compiledPlan.replyText || "自主发育",
      intent: compiledPlan.intent,
      status: TaskState.PLANNING,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      currentStep: compiledPlan.steps[0]?.skill || "",
      currentStepIndex: 0,
      progressText: "自主任务已规划，准备执行",
      error: "",
      errorCode: "",
      plan: compiledPlan,
      contextSnapshot: getWorldContext(),
      replyText: compiledPlan.replyText || "我先自己补一点基础物资。",
      recoveryCount: 0,
      maxRecoveryAttempts: 2,
      turnPhase: "planning",
      actionState: "queued",
      stageKind: null,
      stepCheckpoint: null,
      waitingForPhysicalSignalSince: null,
      lastHeartbeatAt: null,
      lastPhysicalHeartbeatAt: null,
      lastPrimitiveStartedAt: null,
      lastRecoveryReason: null,
      lastProgressAt: Date.now(),
      aiMidTaskRevisionCount: 0,
      logs: [],
      cancellationToken: createRuntimeToken(),
    };
    initializeTaskRuntimeMetadata(currentTask, "autonomous_task_created");
    currentTask.scriptMatch = {
      key: String(compiledPlan?.scriptMeta?.key || "").trim() || null,
      source: String(compiledPlan?.scriptMeta?.source || "").trim() || null,
      matchedFrom: String(compiledPlan?.scriptMeta?.matchedFrom || "").trim() || null,
      revision: Number(compiledPlan?.scriptMeta?.revision || 0) || 0,
      score: Number(compiledPlan?.scriptMeta?.matchScore || 0) || null,
      rerankMode: String(compiledPlan?.scriptMeta?.rerankMode || "").trim() || null,
    };
    recordTaskDiagnostic(currentTask, "task_planned", {
      scriptEngine: currentTask.scriptEngine,
      scriptMatch: currentTask.scriptMatch,
      stepCount: compiledPlan.steps.length,
    });
    addTaskLog("info", currentTask.replyText);
    if (String(compiledPlan?.scriptMeta?.source || "").trim() === "learned_success") {
      addTaskLog(
        "info",
        `自主脑已复用固化脚本 ${String(compiledPlan.scriptMeta.key || "").trim()} v${Number(compiledPlan.scriptMeta.revision || 0)}`
      );
      if (String(compiledPlan?.scriptMeta?.matchedFrom || "").trim()) {
        addTaskLog(
          "info",
          `这次自主推进借用了相似脚本 ${String(compiledPlan.scriptMeta.matchedFrom || "").trim()}。`
        );
      }
    }
    setTaskTurnPhase(currentTask, "planning", {
      progressText: "自主任务已规划，准备执行",
    });
    broadcastTaskEvent("planned", {
      taskId: currentTask.taskId,
      message: currentTask.replyText,
      autonomous: true,
    });
    broadcastTaskStatus();
    broadcastContextSnapshot();
    const autonomousRunTaskId = currentTask.taskId;
    void safeAsyncTick("task_execution_fault", () => runTaskExecution(currentTask), {
      task: currentTask,
      broadcastError: false,
      onFailure: (error) => failRunTaskExecutionIfStillActive(autonomousRunTaskId, error),
    });
    return true;
  }

  function createReturnToPlayerStepForRecovery() {
    const playerName = getBestKnownPlayerName();
    if (!playerName) {
      return null;
    }
    return actionRegistry.createActionStep("follow_player", {
      playerName,
      distance: 3,
      once: true,
    });
  }

  function buildCraftRecoveryPlan(itemName = "", task = null) {
    const returnStep = task?.source === "autonomous" ? createReturnToPlayerStepForRecovery() : null;
    return actionRegistry.buildCraftRecoveryPlan(itemName, {
      returnStep,
    });
  }

  function hasDiamondMiningPickaxe() {
    return Boolean(findInventoryItem(["netherite_pickaxe", "diamond_pickaxe", "iron_pickaxe"]));
  }

  function hasDiamondPickaxeOrBetter() {
    return Boolean(findInventoryItem(["netherite_pickaxe", "diamond_pickaxe"]));
  }

  function hasPortalIgnitionTool() {
    return Boolean(findInventoryItem(["flint_and_steel"]));
  }

  function getDragonProgressionSnapshot() {
    const dimension = String(currentBot?.game?.dimension || "").trim() || "unknown";
    const ironPickaxeReady = hasDiamondMiningPickaxe();
    const diamondPickaxeReady = hasDiamondPickaxeOrBetter();
    const diamonds = getItemCountByName("diamond");
    const obsidian = getItemCountByName("obsidian");
    const flint = getItemCountByName("flint");
    const portalIgnitionReady = hasPortalIgnitionTool();
    const netherPortalReady = Boolean(findNearbyNetherPortal(16)) || dimension.includes("nether");
    const enderPearls = getItemCountByName("ender_pearl");
    const blazeRods = getItemCountByName("blaze_rod");
    const blazePowder = getItemCountByName("blaze_powder");
    const eyesOfEnder = getItemCountByName("eye_of_ender");
    const locateAttempts = Number(dragonRunState.locateAttempts || 0);
    const fortressNearby = Boolean(findNearbyNetherFortressBlock(64));
    const strongholdNearby = Boolean(findNearbyStrongholdBlock(64));
    const endPortalFrameNearby = Boolean(findNearbyEndPortalFrame(64));
    const endPortalActive = Boolean(findNearbyEndPortalBlock(32));
    const endPortalFrameStats = endPortalFrameNearby ? getNearbyEndPortalFrameStats(48) : null;
    const endCrystalWindow = dimension.includes("the_end")
      ? getEndCrystalWindowState({
          maxDistance: 48,
          maxHorizontalDistance: 12,
          maxVerticalGap: 8,
        })
      : { visible: false, attackable: false, horizontalDistance: null, verticalGap: null };
    const nearbyEndCrystal = Boolean(endCrystalWindow.visible);
    const nearbyEnderDragon = Boolean(findNearbyEnderDragon(96));
    const endVictoryMarker = dimension.includes("the_end") ? findEndVictoryMarker(64) : null;
    const dragonWindow = dimension.includes("the_end")
      ? getEnderDragonWindowState({
          maxDistance: 96,
          maxHorizontalDistance: 18,
          maxVerticalGap: 10,
        })
      : { visible: false, attackable: false, horizontalDistance: null, verticalGap: null };
    const unsafeEndPosition = dimension.includes("the_end") && isEndFightPositionUnsafe({
      minY: 45,
      maxDistance: 16,
      maxSafeDistance: 8,
    });
    const health = Number.isFinite(currentBot?.health) ? Number(currentBot.health) : null;
    const food = Number.isFinite(currentBot?.food) ? Number(currentBot.food) : null;
    const endFightNeedsRecovery =
      dimension.includes("the_end") &&
      ((Number.isFinite(health) && health < 12) || (Number.isFinite(food) && food < 12));
    const recentLocateAttempt = Date.now() - Number(dragonRunState.lastLocateAt || 0) < 60 * 1000;
    const shouldRelocateStronghold = shouldRefreshStrongholdLocate({
      minTravelDistance: locateAttempts >= 4 ? 72 : 56,
      maxLocateAgeMs: 45_000,
    });
    const dragonRunCompleted = Number(dragonRunState.completedAt || 0) > 0;

    let stage = "tooling";
    let label = "补终局工具链";
    if (dragonRunCompleted) {
      stage = "dragon_run_complete";
      label = "末影龙已击败";
    } else if (!ironPickaxeReady) {
      stage = "iron_pickaxe";
      label = "准备铁镐";
    } else if (!diamondPickaxeReady) {
      stage = diamonds >= 3 ? "craft_diamond_pickaxe" : "collect_diamonds";
      label = diamonds >= 3 ? "合成钻石镐" : "收集钻石";
    } else if (obsidian < 10) {
      stage = "collect_obsidian";
      label = "收集黑曜石";
    } else if (!portalIgnitionReady) {
      stage = flint > 0 ? "craft_flint_and_steel" : "collect_flint";
      label = flint > 0 ? "合成打火石" : "收集燧石";
    } else if (enderPearls < 6) {
      stage = "collect_ender_pearls";
      label = "收集末影珍珠";
    } else if (blazeRods < 6 && blazePowder < 12) {
      stage = dimension.includes("nether")
        ? "collect_blaze_rods"
        : netherPortalReady
          ? "enter_nether"
          : "build_nether_portal";
      label = dimension.includes("nether")
        ? "收集烈焰棒"
        : netherPortalReady
          ? "进入下界"
          : "搭建下界门";
    } else if (eyesOfEnder < 12) {
      stage = "craft_eyes_of_ender";
      label = "合成末影之眼";
    } else if (dimension.includes("nether") && netherPortalReady) {
      stage = "return_overworld";
      label = "返回主世界";
    } else if (dimension.includes("the_end")) {
      if (unsafeEndPosition) {
        stage = "reposition_end_fight";
        label = "回到末地安全落脚点";
      } else if (endFightNeedsRecovery) {
        stage = "recover_end_fight";
        label = "恢复末地战斗状态";
      } else if (!nearbyEnderDragon && !nearbyEndCrystal && endVictoryMarker) {
        stage = "complete_end_fight";
        label = "末地战斗收尾";
      } else if (endCrystalWindow.attackable) {
        stage = "clear_end_crystals";
        label = "清理末地水晶";
      } else if (nearbyEndCrystal) {
        stage = "approach_end_crystal";
        label = "靠近可处理的末地水晶";
      } else if (dragonWindow.visible && !dragonWindow.attackable) {
        stage = "wait_ender_dragon_window";
        label = "等待末影龙接战窗口";
      } else if (nearbyEnderDragon) {
        stage = "attack_ender_dragon";
        label = "攻击末影龙";
      } else {
        stage = "stabilize_end";
        label = "在末地站稳";
      }
    } else if (endPortalActive) {
      stage = "enter_end";
      label = "进入末地";
    } else if (endPortalFrameStats?.total >= 8 && (endPortalFrameStats.emptyFrames?.length || 0) > 0) {
      stage = "fill_end_portal";
      label = "补末地门框";
    } else if (endPortalFrameNearby) {
      stage = "approach_end_portal_room";
      label = "接近末地门房间";
    } else if (strongholdNearby) {
      stage = "search_portal_room";
      label = "沿强要塞结构继续搜索门房";
    } else if (!recentLocateAttempt || shouldRelocateStronghold) {
      stage = "locate_stronghold";
      label = "定位要塞";
    } else {
      stage = "stronghold_ready";
      label = "沿要塞方向继续推进";
    }

    return {
      stage,
      label,
      dimension,
      ironPickaxeReady,
      diamondPickaxeReady,
      portalIgnitionReady,
      netherPortalReady,
      fortressNearby,
      strongholdNearby,
      endPortalFrameNearby,
      endPortalActive,
      nearbyEndCrystal,
      nearbyEndCrystalReachable: Boolean(endCrystalWindow.attackable),
      endCrystalHorizontalDistance: Number.isFinite(endCrystalWindow.horizontalDistance)
        ? Number(endCrystalWindow.horizontalDistance.toFixed(1))
        : null,
      endCrystalVerticalGap: Number.isFinite(endCrystalWindow.verticalGap)
        ? Number(endCrystalWindow.verticalGap.toFixed(1))
        : null,
      nearbyEnderDragon,
      endVictoryMarker: endVictoryMarker
        ? {
            name: String(endVictoryMarker.name || "").trim() || null,
            position: {
              x: Number(endVictoryMarker.position.x.toFixed(1)),
              y: Number(endVictoryMarker.position.y.toFixed(1)),
              z: Number(endVictoryMarker.position.z.toFixed(1)),
            },
          }
        : null,
      dragonAttackWindowOpen: Boolean(dragonWindow.attackable),
      dragonHorizontalDistance: Number.isFinite(dragonWindow.horizontalDistance)
        ? Number(dragonWindow.horizontalDistance.toFixed(1))
        : null,
      dragonVerticalGap: Number.isFinite(dragonWindow.verticalGap)
        ? Number(dragonWindow.verticalGap.toFixed(1))
        : null,
      unsafeEndPosition,
      endFightNeedsRecovery,
      health,
      food,
      endPortalFrameStats: endPortalFrameStats
        ? {
            total: endPortalFrameStats.total,
            filled: endPortalFrameStats.filled,
            empty: endPortalFrameStats.emptyFrames.length,
          }
        : null,
      diamonds,
      obsidian,
      flint,
      enderPearls,
      blazeRods,
      blazePowder,
      eyesOfEnder,
      completedAt: Number(dragonRunState.completedAt || 0) || null,
      completionMarker: dragonRunState.completionMarker || null,
      locateAttempts: Number(dragonRunState.locateAttempts || 0),
      lastEyeTrace: dragonRunState.lastEyeTrace || null,
      lastNetherScoutAt: Number(dragonRunState.lastNetherScoutAt || 0) || null,
      lastStrongholdAdvanceAt: Number(dragonRunState.lastStrongholdAdvanceAt || 0) || null,
    };
  }

  function buildIronPickaxeProgressionSteps(options = {}) {
    return actionRegistry.buildToolProgressionPlan("iron_pickaxe_progression", {
      includeFinalCraft: options.includeFinalCraft !== false,
      requiredIronIngots: clamp(Number(options.requiredIronIngots) || 3, 1, 8),
      hasStoneOrBetter: Boolean(
        findInventoryItem(["netherite_pickaxe", "diamond_pickaxe", "iron_pickaxe", "stone_pickaxe"])
      ),
      hasIronOrBetter: hasDiamondMiningPickaxe(),
      ironIngots: getItemCountByName("iron_ingot"),
      rawIron: getItemCount(IRON_ORE_ITEM_NAMES),
      hasFuel: getItemCount(SMELT_FUEL_ITEM_PRIORITY) > 0,
      deferFuelPreparation: true,
      hasFurnace: Boolean(findNearbyFurnace(10)) || Boolean(findInventoryItem(["furnace"])),
      ironOreItemNames: IRON_ORE_ITEM_NAMES,
      getLearnedSearchRadius,
    });
  }

  function expandPlanWithPrerequisites(plan) {
    if (!plan || plan.mode !== "task" || !Array.isArray(plan.steps) || !plan.steps.length) {
      return plan;
    }
    plan = convertSmallHousePlanToPlaybook(plan);
    if (plan.steps.some((step) => ["mine_resource", "collect_block"].includes(String(step?.skill || "")) && getResourceLearningKey(step.args?.block) === "diamond")) {
      return {
        ...plan,
        steps: plan.steps.map((step) =>
          ["mine_resource", "collect_block"].includes(String(step?.skill || "")) &&
          getResourceLearningKey(step.args?.block) === "diamond"
            ? { ...step, args: { ...step.args, expedition: true } }
            : step
        ),
        replyText: plan.intent === "mine_diamond_resource"
          ? "我会准备工具和补给，开阶梯下矿、寻找铁矿并熔炼铁镐，再探矿直到背包收到目标钻石；危险路线会绕开或撤退。"
          : plan.replyText,
      };
    }
    return plan;
  }

  function buildRecoveryPlan(task, classified) {
    return taskRecovery.buildRecoveryPlan(task, classified);
  }

  function normalizePlannerResult(payload, fallbackReply = "") {
    return plannerSafety.normalizePlannerResult(payload, fallbackReply);
  }

  function getRegistryActionIdSet() {
    return plannerSafety.getRegistryActionIdSet();
  }

  function collectInvalidPlanStepSkills(plan) {
    return plannerSafety.collectInvalidPlanStepSkills(plan);
  }

  function getPlanApprovalReasons(plan) {
    return plannerSafety.getPlanApprovalReasons(plan);
  }

  function rejectPlannerScriptlet(source = "") {
    return plannerSafety.rejectPlannerScriptlet(source);
  }

  function materializePlannerScriptlet(plan) {
    return plannerSafety.materializePlannerScriptlet(plan);
  }

  const heuristicPlanner = createHeuristicPlanner({ actionRegistry, getLearnedSearchRadius });

  async function aiPlanner(command, contextSnapshot) {
    const config = deps.readConfig();
    const promptMessages = plannerPrompts.buildAiPlannerPromptMessages({
      command,
      contextSnapshot,
    });
    const raw = await deps.requestPlannerCompletion({
      config,
      promptMessages,
    });
    return normalizePlannerResult(deps.parseJsonObjectFromText(raw), "");
  }

  async function aiReviseTaskPlan(task, classified, plannerContext) {
    const config = deps.readConfig?.() || {};
    const failedIdx = clamp(Number(task?.currentStepIndex) || 0, 0, 48);
    const planSlice = {
      intent: task?.plan?.intent,
      goal: task?.plan?.goal,
      replyText: task?.plan?.replyText,
      scriptMeta: task?.plan?.scriptMeta,
      steps: Array.isArray(task?.plan?.steps) ? task.plan.steps : [],
    };
    const userPayload = {
      userCommand: String(task?.userCommand || "").trim(),
      failure: {
        code: String(classified?.code || "").trim(),
        message: String(classified?.message || "").trim(),
        stepIndex: failedIdx,
        failedStep: task?.plan?.steps?.[failedIdx] || null,
      },
      currentPlan: planSlice,
      context: plannerContext,
    };
    const promptMessages = plannerPrompts.buildAiRevisionPromptMessages({
      userPayload,
    });
    let raw = "";
    try {
      raw = await deps.requestPlannerCompletion({
        config,
        promptMessages,
        temperature: 0.12,
      });
    } catch (error) {
      deps.broadcastMinecraftError?.(`AI 修订任务计划失败：${error?.message || "unknown"}`);
      return null;
    }
    const parsed = deps.parseJsonObjectFromText(raw);
    const normalized = materializePlannerScriptlet(normalizePlannerResult(parsed, ""), {
      command: task?.userCommand || "",
      context: plannerContext,
      failure: userPayload.failure,
    });
    if (!normalized || normalized.mode !== "task" || !normalized.steps.length) {
      return null;
    }
    normalized.intent = String(normalized.intent || task?.plan?.intent || "generic_task").trim() || "generic_task";
    normalized.goal = String(normalized.goal || task?.plan?.goal || task?.userCommand || "").trim();
    if (!normalized.replyText) {
      normalized.replyText = "已根据卡点修订任务脚本，准备继续执行。";
    }
    return normalized;
  }

  function shouldAttemptAiRefinement(heuristicPlan) {
    return plannerSafety.shouldAttemptAiRefinement(heuristicPlan);
  }

  async function planCommand(command, context) {
    const heuristic = normalizePlannerResult(heuristicPlanner(command, context));
    if (heuristic?.intent === 'invalid_quantity') return heuristic;
    const effectiveAiConfig = deps.readConfig?.() || {};
    const snapshot = queryRuntime.createPlannerContext({
      explicitContext: context,
      taskScriptHints: heuristic?.mode === "task" ? getTaskScriptPlanningHints(command, heuristic) : null,
    });
    if (heuristic?.mode === "task" && (canDirectDispatch(command, heuristic) || heuristic.intent === "mine_diamond_resource" || heuristic.intent === "build_estate" || heuristic.intent === "build_furnished_house" || isStrictExecutorMode() || !shouldAttemptAiRefinement(heuristic))) {
      heuristic.scriptMeta = {
        ...(heuristic.scriptMeta && typeof heuristic.scriptMeta === "object"
          ? cloneSerializable(heuristic.scriptMeta, {}) || {}
          : {}),
        plannerMode: canDirectDispatch(command, heuristic) ? 'registered_skill_direct' : "heuristic-fallback",
        effectiveAiProvider: String(effectiveAiConfig.aiProvider || "").trim() || null,
      };
      return heuristic;
    }
    const inhibited = reflexManager.shouldInhibitAI();
    brain.setInhibitedByReflex(inhibited, inhibited ? reflexManager.getState().activeReflex || "reflex" : "");
    if (inhibited) {
      return {
        mode: "chat",
        intent: "reflex_inhibited",
        goal: "",
        steps: [],
        replyText: "当前正在处理快速反应，稍等一下再让我做复杂规划。",
      };
    }
    try {
      const aiResult = materializePlannerScriptlet(await aiPlanner(command, snapshot), {
        command,
        context: snapshot,
      });
      if (aiResult?.mode === "task" && aiResult.steps.length) {
        aiResult.scriptMeta = {
          ...(aiResult.scriptMeta && typeof aiResult.scriptMeta === "object"
            ? cloneSerializable(aiResult.scriptMeta, {}) || {}
            : {}),
          plannerMode: "ai",
          effectiveAiProvider: String(effectiveAiConfig.aiProvider || "").trim() || null,
        };
        if (heuristic?.postTaskMode && !aiResult.postTaskMode) {
          aiResult.postTaskMode = heuristic.postTaskMode;
          aiResult.postTaskArgs = heuristic.postTaskArgs || null;
        }
        if (heuristic?.intent && !aiResult.intent) {
          aiResult.intent = heuristic.intent;
        }
        if (heuristic?.replyText && !aiResult.replyText) {
          aiResult.replyText = heuristic.replyText;
        }
        return aiResult;
      }
      if (aiResult?.mode === "chat" && aiResult.replyText) {
        if (heuristic?.mode === "task") {
          heuristic.scriptMeta = {
            ...(heuristic.scriptMeta && typeof heuristic.scriptMeta === "object"
              ? cloneSerializable(heuristic.scriptMeta, {}) || {}
              : {}),
            plannerMode: "heuristic-fallback",
            effectiveAiProvider: String(effectiveAiConfig.aiProvider || "").trim() || null,
          };
        }
        return heuristic?.mode === "task" ? heuristic : aiResult;
      }
    } catch (error) {
      deps.broadcastMinecraftError?.(
        `任务规划器回退到本地规则：${error?.message || "AI 任务规划失败"}`
      );
    }
    if (heuristic?.mode === "task") {
      heuristic.scriptMeta = {
        ...(heuristic.scriptMeta && typeof heuristic.scriptMeta === "object"
          ? cloneSerializable(heuristic.scriptMeta, {}) || {}
          : {}),
        plannerMode: "heuristic-fallback",
        effectiveAiProvider: String(effectiveAiConfig.aiProvider || "").trim() || null,
      };
    }
    return heuristic;
  }

  async function attemptAiMidTaskRevision(task, classified) {
    if (String(classified?.code || "").startsWith("mining_")) return null;
    if (Number(task.recoveryCount || 0) >= clamp(Number(task.maxRecoveryAttempts) || 0, 0, 12)) return null;
    const cfg = deps.readConfig?.() || {};
    if (cfg.mcAiMidTaskRevision !== true) {
      return null;
    }
    const maxAi = clamp(Number(cfg.mcAiMidTaskRevisionMaxPerTask) || 0, 0, 6);
    if (maxAi <= 0) {
      return null;
    }
    const used = Number(task.aiMidTaskRevisionCount || 0) || 0;
    if (used >= maxAi) {
      return null;
    }
    if (reflexManager.shouldInhibitAI()) {
      return null;
    }
    const snapshot = queryRuntime.createPlannerContext({
      explicitContext: {},
      taskScriptHints: null,
    });
    const aiPlan = await aiReviseTaskPlan(task, classified, snapshot);
    if (!aiPlan || aiPlan.mode !== "task" || !aiPlan.steps?.length) {
      return null;
    }
    const approvalReasons = getPlanApprovalReasons(aiPlan);
    if (approvalReasons.length) {
      addTaskLog("warn", `AI 修订需要人工确认，已拒绝自动应用：${approvalReasons.join("；")}`);
      return null;
    }
    const command = String(task.userCommand || "").trim();
    const failedIdx = clamp(Number(task.currentStepIndex) || 0, 0, Math.max(0, task.plan.steps.length - 1));
    const failedStep = task.plan.steps[failedIdx];
    const objectiveKey = actionRegistry.getStepObjectiveKey(failedStep, { getResourceLearningKey });
    const repairIndex = aiPlan.steps.findIndex((step) => actionRegistry.getStepObjectiveKey(step, { getResourceLearningKey }) === objectiveKey);
    if (repairIndex < 0) {
      addTaskLog("warn", "AI 修订删除了当前目标步骤，已拒绝替换原任务。");
      return null;
    }
    const repairSteps = aiPlan.steps.slice(0, repairIndex + 1);
    const repairTarget = repairSteps[repairIndex];
    repairSteps[repairIndex] = {
      ...failedStep,
      args: { ...(failedStep.args || {}), ...actionRegistry.pickStepExecutionTuning(repairTarget.args || {}) },
    };
    let mergedPlan = {
      ...actionRegistry.continueTaskPlan(task, repairSteps, { replyText: aiPlan.replyText }),
      scriptMeta: {
        ...(task.plan?.scriptMeta && typeof task.plan.scriptMeta === "object"
          ? cloneSerializable(task.plan.scriptMeta, {}) || {}
          : {}),
        plannerMode: "ai_mid_revision",
        effectiveAiProvider: String(cfg.aiProvider || "").trim() || null,
      },
    };
    mergedPlan = expandPlanWithPrerequisites(mergedPlan);
    mergedPlan = compileTaskScriptPlan(command, mergedPlan);
    const badSkills = collectInvalidPlanStepSkills(mergedPlan);
    if (badSkills.length) {
      addTaskLog("warn", `AI 修订计划仍含无效步骤：${badSkills.join("、")}，跳过本次修订。`);
      return null;
    }
    // This plan contains only the repaired current stage and unfinished suffix; no completed prefix to skip.
    const resumeIdx = 0;
    task.aiMidTaskRevisionCount = used + 1;
    const scriptKey =
      String(mergedPlan?.scriptMeta?.key || "").trim() || getTaskScriptKey(mergedPlan, command);
    const scriptBucket = ensureLearningTaskScriptBucket(scriptKey, mergedPlan.intent || task.plan?.intent || "");
    if (scriptBucket) {
      scriptBucket.revision = Math.max(0, Number(scriptBucket.revision || 0) || 0) + 1;
      scriptBucket.lastReason = "ai_mid_task_revision";
      scriptBucket.lastOutcome = "recovering";
      scriptBucket.lastUsedAt = Date.now();
      scriptBucket.recentCommands = limitArray(
        [...(scriptBucket.recentCommands || []), String(task.userCommand || "").trim()].filter(Boolean),
        6
      );
      scriptBucket.recentNotes = limitArray(
        [
          ...(scriptBucket.recentNotes || []),
          `AI 中途修订 v${scriptBucket.revision}：${String(classified?.message || "").trim() || classified.code}`,
        ].filter(Boolean),
        8
      );
      markLearningSnapshotDirty();
    }
    mergedPlan = annotateTaskScriptRevision(mergedPlan, {
      key: scriptKey,
      revision: Math.max(0, Number(scriptBucket?.revision || 0) || 0),
      source: "ai_mid_task_revision",
      revisedFrom: String(task.plan?.scriptMeta?.source || "").trim() || "generated",
      lastFailure: String(classified?.code || "").trim() || "unknown",
    });
    if (String(aiPlan.reasoning || "").trim()) {
      addTaskLog("info", `AI 修订思路：${String(aiPlan.reasoning).trim()}`);
    }
    return {
      plan: mergedPlan,
      resumeIdx,
      replyText: mergedPlan.replyText || aiPlan.replyText,
    };
  }

  async function verifyTaskCompletion(task) {
    ensureBotReady();
    const intent = normalizeLearningIntent(task?.intent || task?.plan?.intent || "");
    if (intent === "mine_diamond_resource") {
      const originalSteps = task.completionPlan?.steps || task.plan?.steps || [];
      const target = originalSteps.find((step) => String(step?.skill || "") === "mine_resource" && getResourceLearningKey(step.args?.block) === "diamond");
      const requiredCount = target ? clamp(Number(target.args?.count) || 1, 1, 256) : null;
      const actualCount = getItemCountByName("diamond");
      if (requiredCount == null || actualCount < requiredCount) {
        const error = new Error(requiredCount == null ? "钻石任务缺少原始采集目标，不能标记完成" : `钻石目标尚未完成：背包 ${actualCount}/${requiredCount}，不能标记完成`);
        error.code = "completion_verification_failed";
        throw error;
      }
    }
    if (intent === "build_furnished_house") {
      const steps = task.completionPlan?.steps || task.plan?.steps || [];
      const profile = steps.find((step) => step.skill === "build_furnished_house_phase")?.args?.profile;
      const state = task.stepCheckpoint?.furnishedHouse;
      const summary = state?.verificationSummary;
      if (!profile || summary?.schema !== 2 || summary.sourceProfile !== profile || state.sourceProfile !== profile ||
          summary.missingBlocks !== 0 || !Array.isArray(summary.stateMismatches) || summary.stateMismatches.length ||
          !Array.isArray(summary.clearanceViolations) || summary.clearanceViolations.length ||
          summary.furnitureVerified !== true || (state.ownedScaffold || []).length) {
        throw Object.assign(new Error("精装小屋的结构、方块状态或家具真实校验没有通过，不能标记完成"), { code: "completion_verification_failed" });
      }
    }
    if (intent === "build_estate") {
      const original = (task.completionPlan?.steps || task.plan?.steps || []).find((s) => s.skill === "build_estate");
      const state = task.stepCheckpoint?.estate;
      const summary = state?.verificationSummary;
      const sameAnchor = state?.anchor && ["x", "y", "z"].every((k) => Number.isInteger(state.anchor[k]) && summary?.anchor?.[k] === state.anchor[k]
        && (!original?.args?.anchor || original.args.anchor[k] === state.anchor[k]));
      if (!original?.args?.profile || !sameAnchor || state?.schema !== 1 || state.sourceProfile !== original.args.profile ||
          summary?.schema !== 1 || summary.sourceProfile !== original.args.profile || summary.missingBlocks !== 0 ||
          !Array.isArray(summary.stateMismatches) || summary.stateMismatches.length ||
          !Array.isArray(summary.clearanceViolations) || summary.clearanceViolations.length ||
          summary.furnitureVerified !== true || summary.routeVerified !== true || summary.farmVerified !== true ||
          (state.ownedScaffold || []).length) {
        throw Object.assign(new Error("城堡或别墅的原始款式、完整结构、通路、家具和农田尚未全部通过，不能完成"), { code: "estate_completion_unverified" });
      }
    }
    if (intent === "build_small_house") {
      const steps = task.completionPlan?.steps || task.plan?.steps || [];
      const hasBuildStep = steps.some((step) => String(step?.skill || "").trim() === "build_structure");
      const hasPlaybook = steps.some((step) => String(step?.skill || "").trim() === "build_small_house_phase");
      if (hasPlaybook) {
        const verificationSummary = task?.stepCheckpoint?.verificationSummary || null;
        if (!verificationSummary || Number(verificationSummary.missingBlocks || 0) !== 0) {
          const error = new Error("小木屋最终校验没有通过，不能标记完成");
          error.code = "completion_verification_failed";
          throw error;
        }
      } else if (!hasBuildStep) {
        const error = new Error("小木屋任务缺少建造步骤，不能标记完成");
        error.code = "completion_verification_failed";
        throw error;
      }
    }
    recordTaskDiagnostic(task, "completion_verified", {
      intent,
      botPosition: toPlainPosition(currentBot?.entity?.position || null),
    });
    return true;
  }

  async function runTaskExecution(task, testOptions = {}) {
    if (!task || currentTask?.taskId !== task.taskId || task.cancellationToken?.cancelled) return;
    if (task.status === TaskState.PAUSED || task.cancellationToken?.pauseRequested) return;
    task.automaticSurvivalRecovery=false;
    const runGeneration = Number(task.executionGeneration || 0) + 1;
    task.executionGeneration = runGeneration;
    const isCurrentRun = () => currentTask?.taskId === task.taskId && task.executionGeneration === runGeneration &&
      !task.cancellationToken?.cancelled && !task.cancellationToken?.pauseRequested && task.status !== TaskState.PAUSED;
    if (!task.completionPlan) task.completionPlan = cloneSerializable(task.plan, {}) || {};
    if (task?.planApproval?.required && task.planApproval.confirmed !== true) {
      task.status = TaskState.PAUSED;
      task.actionState = "awaiting_confirmation";
      task.progressText = `等待确认：${(task.planApproval.reasons || []).join("；")}`;
      setAgentMode(TaskState.PAUSED);
      broadcastTaskStatus(true);
      return;
    }
    try {
      brain.advanceTurn(task, "dispatch", {
        kind: task?.source || "task_execution",
      });
      task.movementLease = claimMovementLease("task", task.taskId);
      return await executionContextStorage.run(
        {
          task,
          token: task.cancellationToken || runtimeToken || null,
          movementLease: task.movementLease,
          runGeneration,
        },
        async () => {
          try {
            task.status = TaskState.RUNNING;
            task.startedAt = task.startedAt || Date.now();
            task.actionState = "queued";
            task.lastHeartbeatAt = null;
            task.lastRecoveryReason = null;
            setAgentMode(TaskState.RUNNING);
            setTaskTurnPhase(task, "preparing", {
              progressText: "正在进入任务执行回合",
            });
            addTaskLog("info", task.replyText || "任务开始执行");

            for (let index = task.currentStepIndex; index < task.plan.steps.length; index += 1) {
              checkTaskSignal();
              task.currentStepIndex = index;
              task.currentStep = task.plan.steps[index].skill;
              const stageMatch = findBestLearnedStageScript(task.intent || task.plan?.intent || "", task.plan.steps[index]);
              task.activeStageScript = stageMatch?.bucket
                ? {
                    key: String(stageMatch.key || "").trim(),
                    revision: Number(stageMatch.bucket.revision || 0),
                    stageKind: String(stageMatch.bucket.stageKind || getStageKindForStep(task.plan.steps[index])),
                    source: Number(stageMatch.bucket.success || 0) > 0 ? "library" : "generated",
                    score: Number(stageMatch.score || 0),
                    revisionReason: String(stageMatch.bucket.lastReason || "").trim() || null,
                  }
                : {
                    key: getStageScriptKey(task.intent || task.plan?.intent || "", task.plan.steps[index]),
                    revision: 0,
                    stageKind: getStageKindForStep(task.plan.steps[index]),
                    source: "generated",
                    score: 0,
                    revisionReason: null,
                  };
              const stepArgs = task.plan.steps[index]?.args || {};
              const isReturnStep =
                task.currentStep === "follow_player" && stepArgs.once === true;
              setTaskActionState(task, "preparing", {
                checkpoint: {
                  skill: task.currentStep,
                  stepIndex: index,
                },
              });
              setTaskTurnPhase(task, isReturnStep ? "returning" : "preparing", {
                progressText: isReturnStep ? "正在回到玩家附近" : "正在准备当前步骤",
              });
              if (Number.isFinite(currentBot?.food) && currentBot.food < 12) {
                try {
                  await ensureNutrition(16);
                } catch (error) {
                  const currentFood = Number.isFinite(currentBot?.food) ? currentBot.food : 20;
                  addTaskLog(
                    currentFood <= 6 ? "error" : "warn",
                    currentFood <= 6
                      ? `当前饱食度过低且补给失败：${error?.message || "无法继续补食物"}`
                      : `当前没有现成食物，先继续执行任务：${error?.message || "补食物失败"}`
                  );
                  if (currentFood <= 6) {
                    throw error;
                  }
                }
              }
              addTaskLog("info", `开始步骤 ${index + 1}/${task.plan.steps.length}：${task.currentStep}`);
              recordTaskDiagnostic(task, "step_started", {
                step: task.currentStep,
                stepIndex: index,
                args: stepArgs,
                activeStageScript: task.activeStageScript,
              });
              broadcastTaskEvent("step_started", {
                taskId: task.taskId,
                step: task.currentStep,
                stepIndex: index,
              });
              await (testOptions.executeStep || executeStepWithWatchdog)(task, task.plan.steps[index], {
                beforeExecute: async () => {
                  setTaskActionState(task, "waiting_for_physical_signal", {
                    checkpoint: {
                      skill: task.currentStep,
                      stepIndex: index,
                    },
                  });
                  setTaskTurnPhase(task, isReturnStep ? "returning" : "executing", {
                    progressText: isReturnStep ? "正在执行回位步骤" : "正在执行当前步骤",
                  });
                },
              });
              checkTaskSignal();
              setTaskActionState(task, "completed", {
                recoveryReason: null,
              });
              rememberStageScriptOutcome(task, task.plan.steps[index], TaskState.COMPLETED, "", {
                lastHeartbeatAt: Number(task.lastPhysicalHeartbeatAt || task.lastHeartbeatAt || 0) || null,
                activePrimitive: String(task.stepCheckpoint?.activePrimitive || "").trim() || null,
              });
              brain.advanceTurn(task, "verify", {
                kind: "step_completed",
              });
              brain.recordLearning("");
              addTaskLog("success", `完成步骤：${task.currentStep}`);
              recordTaskDiagnostic(task, "step_completed", {
                step: task.currentStep,
                stepIndex: index,
                activePrimitive: String(task.stepCheckpoint?.activePrimitive || "").trim() || null,
              });
              broadcastTaskEvent("step_completed", {
                taskId: task.taskId,
                step: task.currentStep,
                stepIndex: index,
              });
            }

            setTaskTurnPhase(task, "finishing", {
              progressText: "正在整理任务结果",
            });
            await verifyTaskCompletion(task);
            checkTaskSignal();
            brain.advanceTurn(task, "learn", {
              kind: "task_finishing",
            });
            task.status = TaskState.COMPLETED;
            task.errorCode = "";
            task.finishedAt = Date.now();
            task.actionState = "completed";
            task.progressText = "任务已完成";
            addTaskLog("success", "任务已完成");
            recordTaskDiagnostic(task, "task_completed", {
              stepCount: task.plan.steps.length,
            });
            finishTaskDiagnostics(task, TaskState.COMPLETED);
            const shouldKeepGuarding =
              normalizeLearningIntent(task.intent) === "escort_player" &&
              task.plan?.postTaskMode === "escort_player";
            const nextPassiveEscortArgs = shouldKeepGuarding ? task.plan?.postTaskArgs || {} : null;
            recordTaskMemory(task, TaskState.COMPLETED);
            taskHistory = [...limitArray(taskHistory, 19), { ...task, logs: [...task.logs] }];
            if (task.source !== "autonomous") {
              setForegroundTaskState(task);
            } else {
              clearBackgroundAgenda();
            }
            releaseMovementLease(task.movementLease);
            currentTask = null;
            autonomousState.running = false;
            autonomousState.suppressedByForeground = false;
            autonomousState.nextAllowedAt = Date.now() + (task.source === "autonomous" ? 5000 : 6000);
            setAgentMode("idle");
            if (nextPassiveEscortArgs) {
              activatePassiveEscort(nextPassiveEscortArgs);
            } else {
              clearPassiveEscort();
            }
            brain.completeTurn(task, {
              status: "completed",
            });
            broadcastTaskEvent("completed", {
              taskId: task.taskId,
              message: "任务已完成",
            });
            broadcastTaskStatus();
            broadcastContextSnapshot();
            scheduleIdleTransportFlush();
          } catch (error) {
            throw error;
          }
        }
      );
    } catch (error) {
      if (!currentTask || task.taskId !== currentTask.taskId || task.executionGeneration !== runGeneration) {
        return;
      }
      // A foreground provisioning failure must not cancel the emergency move
      // that currently owns this same task. Manual pause/cancel still wins.
      const defending=activeSurvivalInterrupt,defenseWaitUntil=Date.now()+35000;
      if(defending?.task===task&&defending.runGeneration===runGeneration&&!defending.finished){
        while(currentTask===task&&task.executionGeneration===runGeneration&&task.status===TaskState.RUNNING
          &&!task.cancellationToken?.pauseRequested&&!task.cancellationToken?.cancelled&&!defending.finished&&Date.now()<defenseWaitUntil){
          await Promise.race([defending.finishedPromise,sleep(50)]);
        }
        if(currentTask!==task||task.executionGeneration!==runGeneration)return;
      }
      if (task.status === TaskState.CANCELLED) return;
      if (error?.code === "paused" || task.status === TaskState.PAUSED || task.cancellationToken?.pauseRequested) {
        brain.completeTurn(task, {
          status: "paused",
        });
        task.status = TaskState.PAUSED;
        task.actionState = "recovering";
        task.lastRecoveryReason = "paused";
        setTaskTurnPhase(task, "paused", {
          progressText: "任务已暂停",
        });
        clearPassiveEscort();
        releaseMovementLease(task.movementLease);
        autonomousState.running = false;
        autonomousState.suppressedByForeground = task.source !== "autonomous";
        autonomousState.nextAllowedAt = Date.now() + 6000;
        setAgentMode(TaskState.PAUSED);
        if (task.source !== "autonomous") {
          setForegroundTaskState(task);
        } else {
          clearBackgroundAgenda();
        }
        return;
      }
      if (error?.code === "cancelled") {
        brain.completeTurn(task, {
          status: "cancelled",
        });
        task.status = TaskState.CANCELLED;
        task.errorCode = "cancelled";
        task.finishedAt = Date.now();
        task.actionState = "recovering";
        task.lastRecoveryReason = "cancelled";
        setTaskTurnPhase(task, "failed", {
          progressText: "任务已取消",
        });
        addTaskLog("warn", "任务已取消");
        clearPassiveEscort();
        releaseMovementLease(task.movementLease);
        await softResetBotRuntime("任务取消后清理残留动作", {
          closeWindow: true,
          cooldownMs: 180,
        });
        recordTaskMemory(task, TaskState.CANCELLED);
        taskHistory = [...limitArray(taskHistory, 19), { ...task, logs: [...task.logs] }];
        if (task.source !== "autonomous") {
          setForegroundTaskState(task);
        } else {
          clearBackgroundAgenda();
        }
        currentTask = null;
        autonomousState.running = false;
        autonomousState.suppressedByForeground = false;
        autonomousState.nextAllowedAt = Date.now() + (task.source === "autonomous" ? 5000 : 5000);
        setAgentMode("idle");
        broadcastTaskStatus();
        broadcastContextSnapshot();
        scheduleIdleTransportFlush();
        return;
      }
      const classified = classifyTaskError(error);
      recordTaskDiagnostic(task, "task_error_classified", {
        ...(error.graphOrigin?{graphOrigin:error.graphOrigin}:{}),
        ...(error.originFacts?{originFacts:error.originFacts}:{}),
        status: classified.status,
        code: classified.code,
        message: classified.message,
        rawError: error?.message || String(error || ""),
        ...(error?.materialTransaction?{materialTransaction:error.materialTransaction}:{}),
        ...(error.trailReconciliation?{trailReconciliation:error.trailReconciliation}:{}),
        ...(error instanceof TypeError||['NoPath','Timeout'].includes(error?.name)||/checkpoint_changed$|movement_preempted|wrong_expansion_origin|trail_reconciliation_required/.test(String(error.code||''))?{sourceFrames:String(error.stack||'').split('\n').slice(1,9)}:{}),
        detailSource: lastDisconnectDetailSource || null,
      });
      if (String(classified.code || "").startsWith("mining_") || String(classified.code || "").startsWith("estate_") || String(classified.code || "").startsWith("farm_") || String(classified.code || "").startsWith("house_") ||
          (error?.code === "house_materials_missing" && task.intent === "build_furnished_house")) {
        // Keep the route and original goal available for explicit resume after resupply or a world change.
        task.status = TaskState.PAUSED;
        task.error = classified.message;
        task.errorCode = classified.code;
        task.actionState = "blocked";
        task.finishedAt = null;
        task.automaticSurvivalRecovery=require('./minecraft/houseAutomaticRecovery').selfGatheredHouseWork(task);
        task.automaticWorkRecovery=deps.readConfig?.().mcTaskAutoRecovery===true
          ?require('./minecraft/houseAutomaticRecovery').armHouseRecovery(task,classified.code,Date.now()):null;
        task.cancellationToken?.pause?.();
        if (error.houseWaterForeignActor !== true) {
          const safety=activeSurvivalInterrupt;
          const preservesSafety=task.automaticSurvivalRecovery&&safety?.task===task&&safety.automaticRecovery
            &&safety.runGeneration===task.executionGeneration&&safety.bot===currentBot&&safety.client===currentBot?._client
            &&isMovementLeaseActive(safety.lease)&&!safety.token.cancelled&&!safety.token.pauseRequested;
          releaseMovementLease(task.movementLease);
          if(!preservesSafety){stopBotActions();clearPassiveEscort();}
          else recordTaskDiagnostic(task,"house_work_paused_survival_retained",{workPaused:true,survivalLease:safety.lease.token,originalSurvivalDeadline:safety.deadline,workProgressCredit:false});
        }
        setTaskTurnPhase(task, "paused", { progressText: `${classified.message}；处理后可点恢复继续原任务` });
        addTaskLog("warn", task.progressText);
        if (task.source !== "autonomous") setForegroundTaskState(task);
        autonomousState.running = false;
        autonomousState.suppressedByForeground = true;
        setAgentMode(TaskState.PAUSED);
        broadcastTaskStatus(true);
        broadcastContextSnapshot();
        return;
      }
      const failedStep = task.plan?.steps?.[Number(task.currentStepIndex) || 0] || null;
      if (failedStep) {
        rememberStageScriptOutcome(task, failedStep, classified.status || TaskState.FAILED, classified.code, {
          activePrimitive: String(task.stepCheckpoint?.activePrimitive || "").trim() || null,
          lastRecoveryReason: classified.code,
          recoveryCount: Number(task.recoveryCount || 0) || 0,
        });
      }
      brain.advanceTurn(task, "learn", {
        kind: "failure",
      });
      brain.recordLearning(classified.code);
      const isConnectionFailure = isConnectionFailureCode(classified.code);
      if (isConnectionFailure && (await attemptReconnectForTask(task, classified)) && isCurrentRun()) {
        void safeAsyncTick("task_execution_fault", () => runTaskExecution(task), {
          task,
          broadcastError: false,
          onFailure: (error) => failRunTaskExecutionIfStillActive(task.taskId, error),
        });
        return;
      }
      let recoveryPlan = buildRecoveryPlan(task, classified);
      if (isConnectionFailure) {
        recoveryPlan = null;
      }
      if (recoveryPlan) {
        if (recoveryPlan.noEffectRevision) {
          classified.status = TaskState.BLOCKED;
          classified.code = "no_effect_revision";
          classified.message = recoveryPlan.replyText || "这次修订没有带来有效变化，已停止重复重试。";
          recoveryPlan = null;
        }
      }
      if (recoveryPlan) {
        const scriptKey =
          String(task.plan?.scriptMeta?.key || "").trim() || getTaskScriptKey(task.plan, task.userCommand);
        const scriptBucket = ensureLearningTaskScriptBucket(scriptKey, task.intent || task.plan?.intent || "");
        if (scriptBucket) {
          scriptBucket.revision = Math.max(0, Number(scriptBucket.revision || 0) || 0) + 1;
          scriptBucket.lastReason = classified.code;
          scriptBucket.lastOutcome = classified.status;
          scriptBucket.lastUsedAt = Date.now();
          scriptBucket.recentCommands = limitArray(
            [...(scriptBucket.recentCommands || []), String(task.userCommand || "").trim()].filter(Boolean),
            6
          );
          scriptBucket.recentNotes = limitArray(
            [
              ...(scriptBucket.recentNotes || []),
              `修订 v${scriptBucket.revision}：${classified.message}`,
            ].filter(Boolean),
            8
          );
          markLearningSnapshotDirty();
        }
        // Builders already revise the failed stage; revising the suffix again can change later goals/phases.
        recoveryPlan = annotateTaskScriptRevision(recoveryPlan, {
          key: scriptKey,
          revision: Math.max(0, Number(scriptBucket?.revision || 0) || 0),
          source: "recovery_revision",
          revisedFrom: String(task.plan?.scriptMeta?.source || "").trim() || "generated",
          lastFailure: classified.code,
        });
        if (!isCurrentRun()) return;
        task.recoveryCount = clamp(Number(task.recoveryCount) || 0, 0, 12) + 1;
        task.status = TaskState.PLANNING;
        task.error = "";
        task.errorCode = classified.code;
        task.finishedAt = null;
        task.actionState = "recovering";
        task.lastRecoveryReason = classified.code;
        task.currentStepIndex = 0;
        task.currentStep = recoveryPlan.steps[0]?.skill || "";
        brain.advanceTurn(task, "plan_or_reuse", {
          kind: "recovery_revision",
        });
        setTaskTurnPhase(task, "recovering", {
          progressText: "上一步受阻，正在自动重规划",
        });
        task.plan = recoveryPlan;
        task.plan = actionRegistry.compilePlan(task.plan);
        task.replyText = recoveryPlan.replyText || task.replyText;
        task.contextSnapshot = getWorldContext();
        addTaskLog("warn", classified.message);
        addTaskLog(
          "info",
          task.replyText
            ? `${task.replyText} 这次我会带着修订后的脚本继续跑。`
            : "正在自动重规划并修订任务脚本"
        );
        broadcastTaskEvent("replanned", {
          taskId: task.taskId,
          reason: classified.code,
          message: task.replyText || "任务已自动重规划",
          recoveryCount: task.recoveryCount,
          autonomous: task.source === "autonomous",
        });
        void safeAsyncTick("task_execution_fault", () => runTaskExecution(task), {
          task,
          broadcastError: false,
          onFailure: (error) => failRunTaskExecutionIfStillActive(task.taskId, error),
        });
        return;
      }
      let aiRecovery = null;
      if (!recoveryPlan && !isConnectionFailure) {
        try {
          aiRecovery = await attemptAiMidTaskRevision(task, classified);
        } catch (revisionError) {
          addTaskLog("warn", `AI 中途修订异常：${revisionError?.message || revisionError}`);
        }
      }
      if (!isCurrentRun()) return;
      if (aiRecovery?.plan) {
        task.recoveryCount = clamp(Number(task.recoveryCount) || 0, 0, 12) + 1;
        task.status = TaskState.PLANNING;
        task.error = "";
        task.errorCode = String(classified.code || "").trim() || "ai_mid_task_revision";
        task.finishedAt = null;
        task.actionState = "recovering";
        task.lastRecoveryReason = "ai_mid_task_revision";
        task.currentStepIndex = clamp(
          Number(aiRecovery.resumeIdx) || 0,
          0,
          Math.max(0, aiRecovery.plan.steps.length - 1)
        );
        task.currentStep = aiRecovery.plan.steps[task.currentStepIndex]?.skill || "";
        brain.advanceTurn(task, "plan_or_reuse", {
          kind: "ai_mid_task_revision",
        });
        setTaskTurnPhase(task, "recovering", {
          progressText: "规则恢复未覆盖，已用 AI 修订脚本并续跑",
        });
        task.plan = aiRecovery.plan;
        task.plan = actionRegistry.compilePlan(task.plan);
        task.replyText = aiRecovery.replyText || task.replyText;
        task.contextSnapshot = getWorldContext();
        addTaskLog(
          "info",
          task.replyText
            ? `${task.replyText}（从步骤 ${task.currentStepIndex + 1}/${task.plan.steps.length} 继续）`
            : `已从步骤 ${task.currentStepIndex + 1}/${task.plan.steps.length} 继续执行修订后的脚本。`
        );
        broadcastTaskEvent("replanned", {
          taskId: task.taskId,
          reason: "ai_mid_task_revision",
          message: task.replyText || "AI 已修订任务脚本",
          recoveryCount: task.recoveryCount,
          autonomous: task.source === "autonomous",
        });
        void safeAsyncTick("task_execution_fault", () => runTaskExecution(task), {
          task,
          broadcastError: false,
          onFailure: (error) => failRunTaskExecutionIfStillActive(task.taskId, error),
        });
        return;
      }
      if (isConnectionFailure && task.reconnectState?.enabled) {
        task.status = TaskState.PAUSED;
        task.error = "";
        task.errorCode = classified.code;
        task.actionState = "recovering";
        task.lastRecoveryReason = "waiting_for_reconnect";
        task.finishedAt = null;
        if (task.reconnectState) {
          task.reconnectState.status = "waiting_supervisor";
          task.reconnectState.lastReason = classified.code;
          task.reconnectState.lastAttemptAt = Date.now();
        }
        setTaskTurnPhase(task, "paused", {
          progressText: "连接中断，正在后台持续重连，稍后自动从最近步骤续跑",
        });
        addTaskLog(
          "warn",
          `连接中断且任务内重连已用尽，转入后台持续重连：${classified.message || classified.code}`
        );
        clearPassiveEscort();
        releaseMovementLease(task.movementLease);
        recordTaskDiagnostic(task, "task_parked_for_reconnect", {
          code: classified.code,
          message: classified.message,
          stepIndex: task.currentStepIndex,
          step: task.currentStep,
        });
        brain.completeTurn(task, {
          status: "paused",
        });
        autonomousState.running = false;
        autonomousState.suppressedByForeground = task.source !== "autonomous";
        setAgentMode(TaskState.PAUSED);
        broadcastTaskEvent("replanned", {
          taskId: task.taskId,
          reason: "waiting_for_reconnect",
          message: "连接中断，正在后台持续重连，稍后自动续跑",
          autonomous: task.source === "autonomous",
        });
        broadcastTaskStatus(true);
        broadcastContextSnapshot();
        deps.requestReconnectSupervision?.({
          reason: classified.code,
          taskId: task.taskId,
        });
        return;
      }
      task.status = classified.status;
      task.error = classified.message;
      task.errorCode = classified.code;
      task.actionState = "recovering";
      task.lastRecoveryReason = classified.code;
      setTaskTurnPhase(task, "failed", {
        progressText: classified.message,
      });
      task.finishedAt = Date.now();
      addTaskLog(classified.status === "blocked" ? "warn" : "error", task.error);
      clearPassiveEscort();
      releaseMovementLease(task.movementLease);
      if (
        (!isConnectionFailure &&
          actionRegistry.shouldResetRuntimeFor(
            task.plan?.steps?.[Number(task.currentStepIndex) || 0] || {},
            classified.code
          )) ||
        (!isConnectionFailure && String(classified.code || "").trim() === "generic_failure")
      ) {
        await softResetBotRuntime(`任务${classified.status === "blocked" ? "受阻" : "失败"}后清理执行残留`, {
          closeWindow: true,
          cooldownMs: 220,
        });
      }
      if (!isCurrentRun()) return;
      recordTaskDiagnostic(task, classified.status === TaskState.BLOCKED ? "task_blocked" : "task_failed", {
        code: classified.code,
        message: task.error,
      });
      finishTaskDiagnostics(task, classified.status === TaskState.BLOCKED ? TaskState.BLOCKED : TaskState.FAILED);
      recordTaskMemory(task, classified.status === TaskState.BLOCKED ? TaskState.BLOCKED : TaskState.FAILED);
      taskHistory = [...limitArray(taskHistory, 19), { ...task, logs: [...task.logs] }];
      if (task.source !== "autonomous") {
        setForegroundTaskState(task);
      } else {
        clearBackgroundAgenda();
      }
      currentTask = null;
      brain.failTurn(task, classified.code, {
        status: classified.status,
      });
      autonomousState.running = false;
      autonomousState.suppressedByForeground = false;
      autonomousState.nextAllowedAt = Date.now() + (task.source === "autonomous" ? 7000 : 8000);
      setAgentMode("idle");
      broadcastTaskEvent(classified.status === "blocked" ? "blocked" : "failed", {
        taskId: task.taskId,
        message: task.error,
        reason: classified.code,
      });
      broadcastTaskStatus();
      broadcastContextSnapshot();
      scheduleIdleTransportFlush();
    }
  }

  function failSubmittedCommandPlanningTask(task, message, reasonCode = "planning_failed") {
    if (!task || currentTask?.taskId !== task.taskId) {
      return;
    }
    const normalizedMessage = String(message || "任务规划失败").trim() || "任务规划失败";
    const code = String(reasonCode || "planning_failed").trim() || "planning_failed";
    brain.failTurn(task, code, {
      status: "failed",
    });
    task.status = TaskState.FAILED;
    task.error = normalizedMessage;
    task.errorCode = code;
    task.progressText = normalizedMessage;
    task.finishedAt = Date.now();
    task.actionState = "recovering";
    task.lastRecoveryReason = code;
    setTaskTurnPhase(task, "failed", {
      progressText: normalizedMessage,
    });
    addTaskLog("error", normalizedMessage);
    recordTaskMemory(task, TaskState.FAILED);
    taskHistory = [...limitArray(taskHistory, 19), { ...task, logs: [...task.logs] }];
    setForegroundTaskState(task);
    currentTask = null;
    autonomousState.running = false;
    autonomousState.suppressedByForeground = false;
    autonomousState.nextAllowedAt = Date.now() + 5000;
    setAgentMode("idle");
    broadcastTaskEvent("failed", {
      taskId: task.taskId,
      message: normalizedMessage,
      reason: code,
    });
    broadcastTaskStatus(true);
    broadcastContextSnapshot();
    scheduleIdleTransportFlush();
  }

  function failRunTaskExecutionIfStillActive(taskId, error) {
    if (!taskId || !currentTask || currentTask.taskId !== taskId) {
      return;
    }
    if (![TaskState.RUNNING, TaskState.PAUSED].includes(currentTask.status)) {
      return;
    }
    const normalizedMessage = describeRuntimeFaultMessage(error);
    brain.failTurn(currentTask, "runtime_async_fault", {
      status: "failed",
    });
    currentTask.status = TaskState.FAILED;
    currentTask.error = normalizedMessage;
    currentTask.errorCode = "runtime_async_fault";
    currentTask.progressText = normalizedMessage;
    currentTask.finishedAt = Date.now();
    currentTask.actionState = "recovering";
    currentTask.lastRecoveryReason = "runtime_async_fault";
    setTaskTurnPhase(currentTask, "failed", {
      progressText: normalizedMessage,
    });
    addTaskLog("error", `执行器异步异常：${normalizedMessage}`);
    clearPassiveEscort();
    releaseMovementLease(currentTask.movementLease);
    recordTaskMemory(currentTask, TaskState.FAILED);
    taskHistory = [...limitArray(taskHistory, 19), { ...currentTask, logs: [...currentTask.logs] }];
    if (currentTask.source !== "autonomous") {
      setForegroundTaskState(currentTask);
    } else {
      clearBackgroundAgenda();
    }
    const endedTaskId = currentTask.taskId;
    currentTask = null;
    autonomousState.running = false;
    autonomousState.suppressedByForeground = false;
    autonomousState.nextAllowedAt = Date.now() + 8000;
    setAgentMode("idle");
    broadcastTaskEvent("failed", {
      taskId: endedTaskId,
      message: normalizedMessage,
      reason: "runtime_async_fault",
    });
    broadcastTaskStatus(true);
    broadcastContextSnapshot();
    scheduleIdleTransportFlush();
  }

  async function finalizeSubmittedCommandPlanning(task, payload = {}, effectiveContext = {}) {
    if (!task || currentTask?.taskId !== task.taskId) {
      return;
    }
    const planningGeneration = Number(task.planningGeneration || 0);
    const isPlanningActive = () => currentTask?.taskId === task.taskId &&
      task.status === TaskState.PLANNING && !task.cancellationToken?.cancelled &&
      Number(task.planningGeneration || 0) === planningGeneration;
    const command = String(task.userCommand || payload.command || "").trim();
    await sleep(0);
    try {
      if (!isPlanningActive()) return;
      brain.advanceTurn(task, "classify", {
        kind: "submitted_command",
      });
      const reflexPlan = reflexManager.maybeBuildReflexPlan(command, effectiveContext);
      brain.setInhibitedByReflex(Boolean(reflexPlan), reflexPlan ? "reflex_plan" : "");
      brain.advanceTurn(task, "query_context", {
        kind: reflexPlan ? "reflex_plan" : "planner_context",
      });
      let plan = reflexPlan
        ? normalizePlannerResult(reflexPlan)
        : await planCommand(command, effectiveContext);
      if (!isPlanningActive()) return;
      if (!plan || plan.mode !== "task" || !plan.steps.length) {
        throw new Error(plan?.replyText || "没有把这条指令规划成可执行任务");
      }
      plan = expandPlanWithPrerequisites(plan);
      brain.advanceTurn(task, "plan_or_reuse", {
        kind: String(plan.intent || "task").trim() || "task",
      });
      plan = compileTaskScriptPlan(command, plan, {
        scriptMatch: await chooseLearnedTaskScriptWithAi(command, plan),
      });
      if (!isPlanningActive()) return;
      let invalidSkills = collectInvalidPlanStepSkills(plan);
      if (invalidSkills.length) {
        addTaskLog(
          "warn",
          `规划里含有未注册的步骤（${invalidSkills.join("、")}），正在尝试用本地启发式计划替换。`
        );
        const fallbackRaw = normalizePlannerResult(heuristicPlanner(command, effectiveContext));
        if (!fallbackRaw || fallbackRaw.mode !== "task" || !fallbackRaw.steps.length) {
          throw new Error(
            `规划中含有本版本不支持的操作：${invalidSkills.join("、")}。请换一种说法或简化任务。`
          );
        }
        plan = expandPlanWithPrerequisites(fallbackRaw);
        brain.advanceTurn(task, "plan_or_reuse", {
          kind: String(plan.intent || "task").trim() || "task",
        });
        plan = compileTaskScriptPlan(command, plan, {
          scriptMatch: await chooseLearnedTaskScriptWithAi(command, plan),
        });
        invalidSkills = collectInvalidPlanStepSkills(plan);
        if (invalidSkills.length) {
          throw new Error(`本地回退计划仍含有不支持的操作：${invalidSkills.join("、")}。`);
        }
        addTaskLog("info", "已改用本地启发式任务脚本继续执行。");
      }
      brain.advanceTurn(task, "compile_actions", {
        kind: "registry_compile",
      });
      const fallbackPlayerName = String(effectiveContext.playerName || "").trim();
      if (fallbackPlayerName) {
        for (const step of plan.steps) {
          if (
            ["follow_player", "escort_player"].includes(String(step?.skill || "").trim()) &&
            !String(step?.args?.playerName || "").trim()
          ) {
            step.args.playerName = fallbackPlayerName;
          }
        }
        if (plan.postTaskMode === "escort_player" && plan.postTaskArgs && !String(plan.postTaskArgs.playerName || "").trim()) {
          plan.postTaskArgs.playerName = fallbackPlayerName;
        }
      }
      if (!isPlanningActive()) {
        return;
      }
      task.intent = plan.intent;
      task.currentStep = plan.steps[0]?.skill || "";
      task.currentStepIndex = 0;
      task.plan = plan;
      const approvalReasons = getPlanApprovalReasons(plan);
      task.planApproval = {
        required: approvalReasons.length > 0,
        confirmed: approvalReasons.length === 0,
        reasons: approvalReasons,
        confirmedAt: approvalReasons.length === 0 ? Date.now() : null,
      };
      task.scriptEngine = {
        ...(task.scriptEngine && typeof task.scriptEngine === "object" ? task.scriptEngine : {}),
        mode: String(plan?.scriptMeta?.scriptEngine || task.scriptEngine?.mode || "json"),
        lastReason: String(plan?.scriptMeta?.scriptEngineReason || "").trim() || null,
      };
      task.scriptMatch = {
        key: String(plan?.scriptMeta?.key || "").trim() || null,
        source: String(plan?.scriptMeta?.source || "").trim() || null,
        matchedFrom: String(plan?.scriptMeta?.matchedFrom || "").trim() || null,
        revision: Number(plan?.scriptMeta?.revision || 0) || 0,
        score: Number(plan?.scriptMeta?.matchScore || 0) || null,
        rerankMode: String(plan?.scriptMeta?.rerankMode || "").trim() || null,
      };
      recordTaskDiagnostic(task, "task_planned", {
        scriptEngine: task.scriptEngine,
        scriptMatch: task.scriptMatch,
        stepCount: plan.steps.length,
      });
      task.contextSnapshot = getWorldContext();
      const planSummaryText = String(plan.planSummary || "").trim();
      const replyCore = String(plan.replyText || "").trim();
      task.progressText = planSummaryText || replyCore || "任务规划完成，准备执行";
      task.replyText =
        planSummaryText && replyCore && planSummaryText !== replyCore
          ? `${planSummaryText} — ${replyCore}`
          : planSummaryText || replyCore || plan.replyText;
      task.turnPhase = "planning";
      task.actionState = "queued";
      addTaskLog("info", task.replyText || plan.replyText || "任务已创建");
      const reasoningText = String(plan.reasoning || "").trim();
      if (reasoningText) {
        addTaskLog("info", `思路：${reasoningText}`);
      }
      if (String(plan?.scriptMeta?.source || "").trim() === "learned_success") {
        const sk = String(plan.scriptMeta.key || "").trim();
        const mf = String(plan.scriptMeta.matchedFrom || "").trim();
        addTaskLog(
          "info",
          `已加载固化脚本 ${sk || "（未命名键）"} v${Number(plan.scriptMeta.revision || 0)}${
            mf ? `（相似匹配自 ${mf}）` : ""
          }`
        );
      } else if (Number(plan?.scriptMeta?.scriptLibraryHit || 0) > 0) {
        addTaskLog(
          "info",
          `脚本库命中 ${Number(plan.scriptMeta.scriptLibraryHit || 0)} 个成功阶段，将按阶段脚本组合执行。`
        );
      } else {
        addTaskLog("info", "我会先生成一版任务脚本，执行中继续修正它。");
      }
      setTaskTurnPhase(task, "planning", {
        progressText: planSummaryText || replyCore || "任务规划完成，准备执行",
      });
      broadcastTaskEvent("planned", {
        taskId: task.taskId,
        message: task.replyText || plan.replyText || "任务已规划",
      });
      broadcastTaskStatus(true);
      broadcastContextSnapshot();
      if (task.planApproval.required) {
        task.status = TaskState.PAUSED;
        task.actionState = "awaiting_confirmation";
        task.progressText = `等待确认：${approvalReasons.join("；")}`;
        setTaskTurnPhase(task, "paused", {
          progressText: task.progressText,
        });
        setAgentMode(TaskState.PAUSED);
        setForegroundTaskState(task);
        addTaskLog("warn", task.progressText);
        broadcastTaskEvent("confirmation_required", {
          taskId: task.taskId,
          message: task.progressText,
          reasons: approvalReasons,
        });
        broadcastTaskStatus(true);
        return;
      }
      brain.advanceTurn(task, "dispatch", {
        kind: "task_execution",
      });
      void safeAsyncTick("task_execution_fault", () => runTaskExecution(task), {
        task,
        broadcastError: false,
        onFailure: (error) => failRunTaskExecutionIfStillActive(task.taskId, error),
      });
    } catch (error) {
      if (!isPlanningActive()) {
        return;
      }
      failSubmittedCommandPlanningTask(task, error?.message || "任务规划失败", "planning_failed");
    }
  }

  async function submitCommand(payload = {}) {
    const command = String(payload.command || "").trim();
    if (!command) {
      throw new Error("任务命令不能为空");
    }
    ensureBotReady();
    if (activeHouseSurfaceWater?.task === currentTask) {
      const previousTask = currentTask;
      previousTask.status = TaskState.PAUSED;
      previousTask.cancellationToken?.pause?.();
      const water = await settleHouseSurfaceWater(previousTask, "replaced");
      if (currentTask !== previousTask || water.foreignLease || water.capturedTaskCurrent === false) {
        throw Object.assign(new Error("原跨水操作已被其他执行者接管，保留其控制状态"), { code: "house_surface_water_foreign_owner" });
      }
      if (water.holding || !water.actualDry) {
        markHouseWaterPausePending(previousTask, false);
        throw Object.assign(new Error(previousTask.error), { code: previousTask.errorCode });
      }
    }
    clearPassiveEscort({
      stopBot: !currentTask,
    });
    if (
      currentTask &&
      currentTask.status === TaskState.RUNNING &&
      currentTask.source !== "autonomous" &&
      payload.replaceCurrent !== true
    ) {
      throw new Error("当前已有任务在执行，请先暂停/停止或勾选替换当前任务");
    }
    if (currentTask) {
      const wasAutonomous = currentTask.source === "autonomous";
      if (runtimeToken) {
        runtimeToken.cancel("cancelled");
      }
      releaseMovementLease(currentTask.movementLease);
      await softResetBotRuntime("新任务接管前，先清理上一个执行上下文", {
        closeWindow: true,
        cooldownMs: 220,
      });
      currentTask.status = TaskState.CANCELLED;
      currentTask.progressText = "已被新任务替换";
      currentTask.finishedAt = Date.now();
      recordTaskMemory(currentTask, TaskState.CANCELLED);
      taskHistory = [...limitArray(taskHistory, 19), { ...currentTask, logs: [...currentTask.logs] }];
      if (currentTask.source !== "autonomous") {
        setForegroundTaskState(currentTask);
      } else {
        rememberBackgroundAgenda(currentTask.plan, {
          phase: autonomousState.lastPhase || "wait",
        });
      }
      currentTask = null;
      autonomousState.running = false;
      autonomousState.suppressedByForeground = false;
      autonomousState.nextAllowedAt = Date.now() + (wasAutonomous ? 4000 : 5000);
      scheduleIdleTransportFlush();
    }

    const effectiveContext = {
      ...(payload.context || {}),
      playerName:
        String(payload.context?.playerName || "").trim() || getBestKnownPlayerName(),
    };
    const configSnapshot = deps.readConfig?.() || {};
    const panelMaxRecovery = clamp(
      Number(configSnapshot.mcTaskMaxRecoveryAttempts) || 8,
      3,
      12
    );
    brain.enqueueTurn({
      source: String(payload.source || "panel"),
      kind: "submitted_command",
    });
    setAgentMode(TaskState.PLANNING);
    currentTask = {
      taskId: `task-${taskCounter++}`,
      source: String(payload.source || "panel"),
      userCommand: command,
      intent: "planning",
      status: TaskState.PLANNING,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      currentStep: "",
      currentStepIndex: 0,
      progressText: "任务已接收，正在规划",
      error: "",
      errorCode: "",
      plan: {
        mode: "task",
        intent: "planning",
        goal: command,
        steps: [],
        replyText: "任务已接收，正在规划",
        scriptMeta: {
          plannerMode: "queued",
        },
      },
      contextSnapshot: null,
      submittedContext: cloneSerializable(effectiveContext, {}) || {},
      planningGeneration: 0,
      planningPaused: false,
      replyText: "任务已接收，正在规划",
      recoveryCount: 0,
      aiMidTaskRevisionCount: 0,
      maxRecoveryAttempts: String(payload.source || "panel") === "autonomous" ? 2 : panelMaxRecovery,
      turnPhase: "planning",
      actionState: "queued",
      stageKind: null,
      stepCheckpoint: null,
      waitingForPhysicalSignalSince: null,
      lastHeartbeatAt: null,
      lastPhysicalHeartbeatAt: null,
      lastPrimitiveStartedAt: null,
      lastRecoveryReason: null,
      lastProgressAt: Date.now(),
      activeStageScript: null,
      currentRegistryAction: null,
      actionContractType: null,
      movementLease: null,
      logs: [],
      cancellationToken: createRuntimeToken(),
    };
    initializeTaskRuntimeMetadata(currentTask, "submitted_task_created");
    brain.beginTurn(currentTask, "observe", {
      kind: String(payload.source || "panel"),
    });
    autonomousState.suppressedByForeground = true;
    setForegroundTaskState(currentTask);
    runtimeToken = currentTask.cancellationToken;
    addTaskLog("info", "任务已接收，正在规划；界面会先返回，规划完成后自动开始执行。");
    setTaskTurnPhase(currentTask, "planning", {
      progressText: "任务已接收，正在规划",
    });
    broadcastTaskEvent("accepted", {
      taskId: currentTask.taskId,
      message: "任务已接收",
    });
    broadcastTaskStatus(true);
    broadcastContextSnapshot();
    const planningTaskSnapshot = currentTask;
    void safeAsyncTick("autonomy_plan_fault", () => finalizeSubmittedCommandPlanning(planningTaskSnapshot, payload, effectiveContext), {
      task: planningTaskSnapshot,
      broadcastError: false,
      onFailure: (error) => {
        if (!planningTaskSnapshot?.taskId) {
          return;
        }
        if (currentTask?.taskId !== planningTaskSnapshot.taskId) {
          return;
        }
        if (currentTask.status !== TaskState.PLANNING) {
          return;
        }
        failSubmittedCommandPlanningTask(
          planningTaskSnapshot,
          describeRuntimeFaultMessage(error),
          "planning_runtime_fault"
        );
      },
    });
    return publicTask(currentTask);
  }

  function attachBot(bot) {
    developmentRespawnInventory.attach(bot);
    detachHouseThreatWarning();
    if (activeHouseSurfaceWater && (activeHouseSurfaceWater.bot !== bot || activeHouseSurfaceWater.client !== bot?._client)) revokeHouseWaterConnection();
    eventManager.detachSources();
    currentBot = bot;
    if (bot) {
      const client = bot._client;
      const closeNeutralGaze=require('./minecraft/houseNeutralGaze').installHouseNeutralGaze({bot,
        shouldGuard:()=>currentBot===bot&&currentTask?.status===TaskState.RUNNING
          &&currentTask.materialSupply?.materialSource==='self_gathered'&&!activeSurvivalInterrupt
          &&isMovementLeaseActive(currentTask.movementLease)&&bot.pathfinder?.isMoving?.()===true,
        record:(type,facts)=>{if(currentTask?.materialSupply?.materialSource==='self_gathered')recordTaskDiagnostic(currentTask,type,facts);}});
      const warnHouseThreat = () => {
        const task = currentTask, anchor = task?.materialSupply?.camp?.anchor;
        if (currentBot === bot && bot._client === client && task?.status === TaskState.RUNNING && anchor
            && task.movementLease && isMovementLeaseActive(task.movementLease)) {
          const p = bot.entity.position.floored(), campKey = `${anchor.x},${anchor.y},${anchor.z}`;
          const previous = houseCampGroundedTraces.get(task);
          if (!inspectSurfaceBody(bot).dry) houseCampGroundedTraces.delete(task);
          else if (hasGroundedBodySupport(bot)) {
            if (Math.abs(bot.entity.position.y - p.y) > 0.075 || !dryFoot(bot, p)) {
              houseCampGroundedTraces.delete(task);
            } else if (p.x === anchor.x && p.y === anchor.y && p.z === anchor.z) {
              houseCampGroundedTraces.set(task, { bot, client, anchor: campKey, path: [p] });
            } else if (previous?.bot === bot && previous.client === client && previous.anchor === campKey
                && !previous.path.at(-1).equals(p)) {
              if (previous.path.length < 4096) previous.path.push(p);
              else houseCampGroundedTraces.delete(task);
            }
          }
        }
        const resourceEscapeThreat = findHouseResourceEscapeThreat(bot, task);
        if (currentBot !== bot || bot._client !== client || survivalInterruptRunning ||
            !(activeHouseSurfaceNavigationMove?.bot === bot || activeHouseSurfaceWater?.bot === bot || activeHouseResourceWork?.bot===bot ||
              resourceEscapeThreat ||task?.status===TaskState.RUNNING&&task.materialSupply?.materialSource==="self_gathered" ||
              (task?.status === TaskState.RUNNING && task.materialSupply?.materialSource === "self_gathered" && anchor
                && task.movementLease && isMovementLeaseActive(task.movementLease)
                && Math.hypot(bot.entity.position.x - anchor.x, bot.entity.position.z - anchor.z) <= 12
                && Math.abs(bot.entity.position.y - anchor.y) <= 3 && hasGroundedBodySupport(bot)))) return;
        if (!Object.values(bot.entities || {}).some(entity => entity?.name === "creeper" && entity.isValid !== false
            && entity.position?.distanceTo(bot.entity.position) <= 8.5) && !findUnarmedSiteMeleeThreat(bot, task) && !resourceEscapeThreat && !findHouseRangedThreat(bot) && !nearbyHouseResourceThreats(bot).some(e=>e.position.distanceTo(bot.entity.position)<=4.5)) return;
        void safeAsyncTick("combat_interrupt_fault", () => maybeHandleSurvivalCritical("house_creeper_proximity"), { broadcastError: false });
      };
      const buoyancy=createEmergencyBuoyancy({getBot:()=>currentBot,
        isHandled:()=>Boolean(activeEmergencyShore?.bot===bot)||Boolean(activeHouseSurfaceWater?.isPhysicalOwner())
          ||currentTask?.materialSupply?.materialSource!=="self_gathered",
        isDryGrounded:()=>!bot.entity.isInWater&&!bot.entity.isInLava&&hasGroundedBodySupport(bot),
        record:(type,facts)=>recordTaskDiagnostic(currentTask,type,facts)});
      // Mineflayer supplies the native damage_event source after decoding its
      // optional ID+1. Capture it before generic hurt/health listeners run.
      const observeSelfAggressor=(hurt,source)=>{
        if(currentBot!==bot||bot._client!==client||hurt!==bot.entity)return;
        const sourceKnown=require('./minecraft/entitySemantics').recordObservedSelfAggressor(bot,hurt,source);
        combatMemory.lastBotHurtAt=Date.now();
        require('./minecraft/houseRangedCover').clearHouseRangedPursuits(bot);
        if(sourceKnown)recordTaskDiagnostic(currentTask,'native_self_aggressor_observed',{targetId:source.id,targetName:source.name,
          source:'mineflayer.entityHurt.native_damage_event',expiresMs:15000});
        else recordTaskDiagnostic(currentTask,'native_self_hurt_observed',{sourceKnown:false,
          source:'mineflayer.entityHurt.native_damage_event',actual:toPlainPosition(bot.entity.position)});
        void maybeHandleSurvivalCritical('native_self_aggressor').catch(error=>reportRuntimeFault('combat_interrupt_fault',error,{broadcastError:false}));
      };
      bot.prependListener('entityHurt',observeSelfAggressor);
      const keepBreathing=()=>buoyancy.tick();
      bot.on("physicsTick", warnHouseThreat);bot.on("physicsTick",keepBreathing);
      detachHouseThreatWarning = () => { closeNeutralGaze();buoyancy.close();bot.removeListener("entityHurt",observeSelfAggressor);bot.removeListener("physicsTick",keepBreathing);bot.removeListener("physicsTick", warnHouseThreat); detachHouseThreatWarning = () => {}; };
    }
    defaultMovements = null;
    appliedMovementsBot = null;
    appliedMovementsInstance = null;
    lastPathfinderGoalSignature = "";
    lastPathfinderMotorWriteAt = 0;
    runtimeDiagnostics.resetRuntimeFault();
    runtimeDiagnostics.resetBotWrite();
    resetDisconnectEventTrail();
    lastDisconnectPath = "";
    lastDisconnectDetailSource = "";
    lastDisconnectObservedAt = 0;
    brain.setInhibitedByReflex(false, "");
    brain.clearRegistryAction();
    combatMemory.lastBotHealth = Number.isFinite(bot?.health) ? Number(bot.health) : null;
    combatMemory.lastBotHurtAt = 0;
    combatMemory.lastProtectedPlayerHurtAt = 0;
    combatMemory.lastProtectedPlayerName = "";
    invalidateScanCaches();
    invalidateWorldContextCache();
    if (currentBot) {
      eventManager.bindMineflayer(currentBot);
    }
    broadcastContextSnapshot();
    broadcastTaskStatus();
  }

  function initializeBotRuntime() {
    require('./minecraft/nativeCollisionCompatibility').installNativeCollisionCompatibility(currentBot?.version);
    if (!currentBot?.entity) {
      return false;
    }
    ensureMovements(currentBot);
    return true;
  }

  function detachBot(reason = "server_disconnected") {
    developmentRespawnInventory.detach();
    detachHouseThreatWarning();
    revokeHouseWaterConnection();
    lastDisconnectDetailSource = classifyDisconnectDetailSource(reason);
    lastDisconnectObservedAt = Date.now();
    const preserveActiveTaskForReconnect =
      Boolean(currentTask?.reconnectState?.enabled) &&
      !["manual_disconnect", "transport_restart", "bot_death"].includes(lastDisconnectDetailSource);
    const preservedTask = preserveActiveTaskForReconnect ? currentTask : null;
    lastDisconnectPath = getDisconnectPath(lastDisconnectDetailSource);
    passiveEscort = null;
    autonomousState.running = false;
    autonomousState.nextAllowedAt = 0;
    autonomousState.workAreaCenter = null;
    autonomousState.suppressedByForeground = false;
    clearBackgroundAgenda();
    activeMovementLease = null;
    endMovementSession();
    combatMemory.lastBotHealth = null;
    combatMemory.lastBotHurtAt = 0;
    combatMemory.lastProtectedPlayerHurtAt = 0;
    combatMemory.lastProtectedPlayerName = "";
    invalidateScanCaches();
    invalidateWorldContextCache();
    knownPlayers = new Map();
    dragonRunState = {
      locateAttempts: 0,
      lastLocateAt: 0,
      lastEyeTrace: null,
      netherScoutIndex: 0,
      lastNetherScoutAt: 0,
      lastStrongholdAdvanceAt: 0,
      completedAt: 0,
      completionMarker: null,
    };
    eventManager.detachSources();
    reflexManager.reset();
    brain.setInhibitedByReflex(false, "");
    brain.clearRegistryAction();
    if (runtimeToken) {
      runtimeToken.cancel(reason);
    }
    if (currentTask) {
      if (preserveActiveTaskForReconnect) {
        currentTask.status = TaskState.PLANNING;
        currentTask.actionState = "recovering";
        currentTask.lastRecoveryReason = getConnectionFailureTaskCode(lastDisconnectDetailSource, reason);
        currentTask.errorCode = currentTask.lastRecoveryReason;
        currentTask.progressText = String(reason || "Minecraft 连接已断开，等待自动重连").trim();
        recordTaskDiagnostic(currentTask, "bot_detached_for_reconnect", {
          reason,
          detailSource: lastDisconnectDetailSource,
        });
      } else {
        brain.failTurn(currentTask, reason, {
          status: "failed",
        });
        currentTask.status = TaskState.FAILED;
        currentTask.error = reason;
        currentTask.errorCode = reason;
        currentTask.progressText = reason;
        currentTask.finishedAt = Date.now();
        finishTaskDiagnostics(currentTask, TaskState.FAILED);
        recordTaskMemory(currentTask, TaskState.FAILED);
        taskHistory = [...limitArray(taskHistory, 19), { ...currentTask, logs: [...currentTask.logs] }];
        if (currentTask.source !== "autonomous") {
          setForegroundTaskState(currentTask);
        }
        currentTask = null;
      }
    }
    if (currentBot) {
      try {
        currentBot.pathfinder?.setGoal?.(null);
      } catch (_) {}
      try {
        currentBot.clearControlStates?.();
      } catch (_) {}
      try {
        currentBot.stopDigging?.();
      } catch (_) {}
      try {
        currentBot.deactivateItem?.();
      } catch (_) {}
    }
    currentBot = null;
    defaultMovements = null;
    appliedMovementsBot = null;
    appliedMovementsInstance = null;
    lastPathfinderGoalSignature = "";
    lastPathfinderMotorWriteAt = 0;
    runtimeDiagnostics.resetBotWrite();
    setAgentMode(preservedTask ? TaskState.PLANNING : "idle");
    broadcastTaskStatus();
    broadcastContextSnapshot();
    scheduleIdleTransportFlush();
  }

  async function handleMessage(msg, ws) {
    if (!msg || typeof msg !== "object") {
      return false;
    }
    if (msg.type === "mc_command_query") {
      sendSnapshot(ws);
      return true;
    }
    if (msg.type === "mc_diagnostics_query" || msg.type === "mc_learning_query") {
      ws?.send?.(
        JSON.stringify({
          type: "mc_agent_diagnostics",
          diagnostics: publicTaskDiagnostics(currentTask) || getLastTaskDiagnostics() || null,
          learning: getLearningLibrarySummary(),
        })
      );
      return true;
    }
    if (msg.type === "mc_command_submit" || msg.type === "mc_command_replace") {
      const task = await submitCommand({
        command: msg.command,
        replaceCurrent: msg.type === "mc_command_replace" ? true : msg.replaceCurrent === true,
        context: msg.context,
        source: msg.source,
      });
      if (ws) {
        ws.send(
          JSON.stringify({
            type: "mc_task_status",
            task,
            history: taskHistory.map(taskPublicState.publicTaskSummary).filter(Boolean),
          })
        );
      }
      return true;
    }
    if (msg.type === "mc_command_cancel") {
      await cancelCurrentTask("任务已取消", "cancelled");
      return true;
    }
    if (msg.type === "mc_command_pause") {
      if (!(await pauseCurrentTask())) {
        throw new Error("当前没有可暂停的任务");
      }
      return true;
    }
    if (msg.type === "mc_command_resume") {
      if(!currentTask){
        ensureBotReady();
        const saved=taskCheckpointStore.load(checkpointIdentity());
        if(saved){
          if(collectInvalidPlanStepSkills(saved.plan).length)throw Error('Saved task contains unavailable actions');
          currentTask={...saved,status:TaskState.PAUSED,error:'',errorCode:'',finishedAt:null,
            cancellationToken:createRuntimeToken(),movementLease:null,activeStageScript:null,currentRegistryAction:null,
            planningPaused:false,planningGeneration:0,lastProgressAt:Date.now(),lastHeartbeatAt:null,
            waitingForPhysicalSignalSince:null,turnPhase:'paused',actionState:'idle'};
          taskCounter=Math.max(taskCounter,Number(String(saved.taskId).replace(/^task-/,''))+1||taskCounter);
          runtimeToken=currentTask.cancellationToken;
          initializeTaskRuntimeMetadata(currentTask,'durable_checkpoint_restored');
          setForegroundTaskState(currentTask);
          addTaskLog('info','已从本世界的生产检查点恢复原任务；动作、物资和站位将重新读取真实世界确认。');
        }
      }
      if (!currentTask || currentTask.status !== TaskState.PAUSED) {
        throw new Error("当前没有可恢复的任务");
      }
      if(survivalInterruptRunning&&activeSurvivalInterrupt?.task===currentTask&&isMovementLeaseActive(activeSurvivalInterrupt.lease)){
        throw Object.assign(Error("当前自卫动作尚未收束，先完成自卫再恢复普通工作"),{code:"house_survival_recovery_in_progress"});
      }
      // A settled task may have acquired a newer recovery lease. Its stale
      // water frame cannot veto that owner's emergency shore rescue. Discard
      // only an identity-revoked frame; release() performs no foreign writes.
      if(discardForeignHouseWaterFrame())recordTaskDiagnostic(currentTask,"house_surface_obsolete_frame_discarded",{resume:true,movementOrArrivalCredit:false});
      if (activeHouseSurfaceWater?.task === currentTask) {
        if (!currentBot || !hasGroundedBodySupport(currentBot)) {
          throw Object.assign(new Error("尚未确认在干岸落稳，不能恢复普通工作"), { code: "house_surface_water_cleanup_pending" });
        }
        activeHouseSurfaceWater.session.release(); activeHouseSurfaceWater.closed = true; activeHouseSurfaceWater = null;
      }
      if (currentTask.planApproval?.required && currentTask.planApproval.confirmed !== true) {
        currentTask.planApproval.confirmed = true;
        currentTask.planApproval.confirmedAt = Date.now();
        addTaskLog("info", "用户已确认存在风险或资源提示的任务计划，准备执行。");
      }
      currentTask.cancellationToken?.resume?.();
      currentTask.error = "";
      runtimeToken = currentTask.cancellationToken || createRuntimeToken();
      if (currentTask.planningPaused) {
        const resumedPlanningTask = currentTask;
        currentTask.planningPaused = false;
        currentTask.status = TaskState.PLANNING;
        currentTask.planningGeneration = Number(currentTask.planningGeneration || 0) + 1;
        setAgentMode(TaskState.PLANNING);
        setTaskTurnPhase(currentTask, "planning", { progressText: "正在重新规划已暂停的任务" });
        broadcastTaskStatus(true);
        void finalizeSubmittedCommandPlanning(resumedPlanningTask, { source: resumedPlanningTask.source }, resumedPlanningTask.submittedContext || {});
        return true;
      }
      const resumedRunTaskId = currentTask.taskId;
      currentTask.status = TaskState.RUNNING;
      void safeAsyncTick("task_execution_fault", () => runTaskExecution(currentTask), {
        task: currentTask,
        broadcastError: false,
        onFailure: (error) => failRunTaskExecutionIfStillActive(resumedRunTaskId, error),
      });
      return true;
    }
    return false;
  }

  function __testPathfinderDynamicGoalHotPath() {
    const previousState = {
      currentBot,
      defaultMovements,
      appliedMovementsBot,
      appliedMovementsInstance,
      activeMovementLease,
      activeMovementSession,
      activeMovementMonitor,
      activePhysicalAction,
      lastPathfinderGoalSignature,
      lastPathfinderMotorWriteAt,
      lastDisconnectObservedAt,
      runtimeDiagnosticsState: runtimeDiagnostics.exportState(),
    };
    const stats = {
      setMovementsCalls: 0,
      setGoalCalls: 0,
      loadPluginCalls: 0,
    };
    const target = {
      id: 42,
      name: "test_target",
      position: new Vec3(8, 64, 8),
    };
    const fakeBot = {
      entity: {
        position: new Vec3(0, 64, 0),
      },
      _client: {
        state: "play",
        socket: {
          writable: true,
          destroyed: false,
        },
      },
      player: {
        ping: 1,
      },
      registry: {
        blocksByName: {
          stone: { id: 1 },
        },
      },
      loadPlugin: () => {
        stats.loadPluginCalls += 1;
      },
      pathfinder: {
        setMovements: () => {
          stats.setMovementsCalls += 1;
        },
        setGoal: () => {
          stats.setGoalCalls += 1;
        },
      },
    };
    try {
      currentBot = fakeBot;
      defaultMovements = {
        clearCollisionIndex() {},
      };
      appliedMovementsBot = null;
      appliedMovementsInstance = null;
      activeMovementLease = null;
      activeMovementSession = null;
      activeMovementMonitor = null;
      activePhysicalAction = null;
      lastPathfinderGoalSignature = "";
      lastPathfinderMotorWriteAt = 0;
      lastDisconnectObservedAt = 0;
      runtimeDiagnostics.resetBotWrite();
      const goal = new goals.GoalFollow(target, 2);
      setPathfinderGoal(goal, true, null);
      setPathfinderGoal(goal, true, null);
      ensureMovements(fakeBot);
      return {
        ...stats,
        movementSessionStable: activeMovementSession?.stable === true,
        movementSessionGoalSignature: String(activeMovementSession?.goalSignature || "").trim(),
      };
    } finally {
      clearMovementMonitor();
      if (activePhysicalAction) {
        activePhysicalAction.cancelled = true;
      }
      currentBot = previousState.currentBot;
      defaultMovements = previousState.defaultMovements;
      appliedMovementsBot = previousState.appliedMovementsBot;
      appliedMovementsInstance = previousState.appliedMovementsInstance;
      activeMovementLease = previousState.activeMovementLease;
      activeMovementSession = previousState.activeMovementSession;
      activeMovementMonitor = previousState.activeMovementMonitor;
      activePhysicalAction = previousState.activePhysicalAction;
      lastPathfinderGoalSignature = previousState.lastPathfinderGoalSignature;
      lastPathfinderMotorWriteAt = previousState.lastPathfinderMotorWriteAt;
      lastDisconnectObservedAt = previousState.lastDisconnectObservedAt;
      runtimeDiagnostics.importState(previousState.runtimeDiagnosticsState);
    }
  }

  return {
    attachBot,
    detachBot,
    dispose,
    startRuleReloadWatchers,
    sendSnapshot,
    handleMessage,
    getStatusFields,
    broadcastContextSnapshot,
    tickIdleBehavior,
    initializeBotRuntime,
    setRuntimeOptions,
    reportRuntimeFault,
    getRuntimeFaultSnapshot,
    getBotWriteSnapshot,
    getDisconnectEventTrail,
    rememberDisconnectEvent,
    rememberBotWrite,
    isBotConnectionWritable,
    quarantineBotRuntimeOnDisconnect,
    resumeAfterReconnect,
    failParkedTaskAfterReconnectGiveUp,
    hasParkedReconnectTask,
    hasBlockingForegroundTask,
    __testRejectPlannerScriptlet: rejectPlannerScriptlet,
    __testGetPlanApprovalReasons: getPlanApprovalReasons,
    __testGetLearningLibrarySummary: getLearningLibrarySummary,
    __testPlanCommand: planCommand,
    __testChooseLearnedTaskScript: chooseLearnedTaskScriptWithAi,
    getSkillCatalogSnapshot: skillCatalog.snapshot,
    validateSkillCandidate: skillCatalog.validate,
    enableSkillCandidate: skillCatalog.enable,
    revokeSkillCandidate: skillCatalog.revoke,
    __testPathfinderDynamicGoalHotPath,
    __testActivatePassiveEscort: activatePassiveEscort,
    __testHasPassiveEscort: () => Boolean(passiveEscort),
    __testFindNearestDroppedItemEntity: findNearestDroppedItemEntity,
    __testFindPlayerTarget: findPlayerTarget,
    __testGetBestKnownPlayerName: getBestKnownPlayerName,
    __testFindHostileEntity: findHostileEntity,
    __testSetPathfinderGoal: setPathfinderGoal,
    __testCreatePhysicalAction: createPhysicalAction,
    __testRecoverPhysicalAction: action=>executionContextStorage.run({},()=>recoverPhysicalAction(action)),
    __testClaimMovementLease: claimDevelopmentMovementLease,
    __testGetActiveMovementLease: () => activeMovementLease,
    __testHandleSurvivalCritical: settleSurvivalDefense,
    __testReturnHouseConstruction:position=>returnToHouseConstruction(toVec3(position)),
    __testWithHouseResourceWork: (operation, budget) => {
      const task = currentTask,ownerId=String(task?.movementLease?.ownerId||"");
      // Compatibility boundary for the private development runner retained in
      // memory while Java and the human observer remain live. Its old fixed
      // grave tour supplies no current item evidence and must not steer a new
      // house attempt. Reject without invoking it or claiming recovered loot.
      if(ownerId.endsWith(":development-drop-recovery"))throw Object.assign(Error("旧固定墓地恢复没有本轮可见掉落实体证据，停止该开发辅助动作，交回正常任务"),{code:"development_stale_drop_recovery_disabled"});
      // This retained runner's legacy90s preflight blocks foreground work
      // whenever a mob remains nearby. Production now owns defense and urgent
      // provisioning inside the actual house workflow, including low health.
      // Skipping the old callback grants no recovery or survival credit.
      if(ownerId.endsWith(":development-survival")){
        recordTaskDiagnostic(task,"development_legacy_survival_preflight_skipped",{health:currentBot.health,food:currentBot.food,recoveryCredit:false});
        return Promise.resolve({skipped:true,reason:"production_survival_workflow",health:currentBot.health,food:currentBot.food});
      }
      return executionContextStorage.run({ task, token: task?.cancellationToken || runtimeToken,
        movementLease: task?.movementLease, runGeneration: task?.executionGeneration, selfSupplyOnly: true },
        () => withSurfaceResourceMovements(() => operation({ equip: equipInventoryItem, safeFoot: safeSurfaceFoot, findSurfaceBlocks: findHouseSurfaceMaterialBlocks,
          resumeAfterSurvival: resumeHouseResourceAfterSurvival, bot: currentBot }), budget));
    },
    __testRunTaskExecution: runTaskExecution,
    __testGetHouseWaterFrame: () => activeHouseSurfaceWater,
    __testHouseSurfaceWater: (route, resource = "any_log") => {
      const task = currentTask;
      const context = { task, token: task?.cancellationToken || runtimeToken,
        movementLease: task?.movementLease, runGeneration: task?.executionGeneration };
      return executionContextStorage.run(context, () => traverseHouseSurfaceWater(task, resource, route, context, () => {
        checkTaskSignal(); ensureMovementLeaseActive(context.movementLease);
      }));
    },
    __testHouseSurfaceGraphNext: (anchor, options) => {
      const task = currentTask;
      if (task && !task.diagnostics) startTaskDiagnostics(task, "house_surface_test_started");
      return executionContextStorage.run({ task, token: task?.cancellationToken || runtimeToken,
        movementLease: task?.movementLease, runGeneration: task?.executionGeneration },
      () => exploreHouseSurfaceGraph(task, options?.resource || "any_log", anchor, () => {}, options));
    },
    __testRecoverHouseLocalRoute: (target,deadline) => {
      const task=currentTask;
      return executionContextStorage.run({...(getExecutionContext()||{}),task,token:task?.cancellationToken||runtimeToken,
        movementLease:task?.movementLease,runGeneration:task?.executionGeneration},()=>recoverHouseLocalRoute(task,target,deadline));
    },
    __testMiningPathfinderGoto: (goal) => {
      const task = currentTask;
      return executionContextStorage.run({ task, token: task?.cancellationToken || runtimeToken,
        movementLease: task?.movementLease, runGeneration: task?.executionGeneration },
      () => miningPathfinderGoto(goal));
    },
    __testHouseSurfacePathfinderGoto: (goal, timeoutMs, options) => {
      if(getExecutionContext()?.pausedSurvivalOwner)return houseSurfacePathfinderGoto(goal,timeoutMs,options);
      const task = currentTask;
      return executionContextStorage.run({ ...(getExecutionContext()||{}), task, token: task?.cancellationToken || runtimeToken,
        movementLease: task?.movementLease, runGeneration: task?.executionGeneration },
      () => houseSurfacePathfinderGoto(goal, timeoutMs, options));
    },
    __testAlignHouseResourceGraphOrigin: (deadline, bounds=[]) => {
      const task=currentTask;
      return executionContextStorage.run({...(getExecutionContext()||{}),task,token:task.cancellationToken,
        movementLease:task.movementLease,runGeneration:task.executionGeneration,selfSupplyOnly:true},
        ()=>alignHouseResourceGraphOrigin(task,deadline,bounds));
    },
    __testEnsurePlanks: ensurePlanks,
    __testBootstrapWoodLogs: bootstrapWoodLogs,
    __testEnsureFoodSupply: ensureFoodSupply,
    __testEnsureNutrition: ensureNutrition,
    __testHouseBootstrapFood: ensureHouseBootstrapFood,
    __testSettleHouseFoodThreats: settleHouseFoodThreats,
    __testDrainStartupOriginDefense:drainStartupOriginDefense,
    __testApproachOwnedCombatCover: (spec,deadline) => approachCleanupFreshGraph(currentTask,spec,checkTaskSignal,deadline),
    __testReturnCurrentHouseCamp: options => withCurrentHouseMaterialRuntime(source=>source.returnCamp(options)),
    __testLocalFoodFrontier: deadline => withCurrentHouseMaterialRuntime(async()=>{const previous=foodSupplyRunning;
      foodSupplyRunning=true;try{return await exploreHouseLocalFood(deadline);}finally{foodSupplyRunning=previous;}}),
    __testEmergencyFoodRecovery: () => withCurrentHouseMaterialRuntime(async()=>{const previous=foodSupplyRunning;foodSupplyRunning=true;try{return await ensureEmergencyFoodRecovery();}finally{foodSupplyRunning=previous;}}),
    __testExploreNextSurfacePosition: (positions, options) => {
      const task = currentTask;
      return executionContextStorage.run({ ...(getExecutionContext() || {}), task,
        token: task?.cancellationToken || runtimeToken, movementLease: task?.movementLease,
        runGeneration: task?.executionGeneration }, () => exploreNextSurfacePosition(positions, options));
    },
    __testEnsureSticks: ensureSticks,
    __testCraftItemByName: craftItemByName,
    __testPrepareForCraftItem: prepareForCraftItem,
    __testExecuteSmeltItem: executeSmeltItem,
    __testExecutePlaceBlock: executePlaceBlock,
    __testExecuteBuildFurnishedHousePhase: executeBuildFurnishedHousePhase,
    __testExecuteBuildEstate: executeBuildEstate,
    __testEstateFarm: (spec, options) => {
      const task = currentTask;
      return executionContextStorage.run({ task, token: task?.cancellationToken || runtimeToken,
        movementLease: task?.movementLease, runGeneration: task?.executionGeneration },
      () => withFurnishedHouseMovements(() => {
        const farm = createEstateNativeRuntime(task).farmFor(task);
        return options ? farm.validate(spec, options) : farm.build(spec);
      }));
    },
    __testPlaceFurnishedHouseBlock: (spec) => withFurnishedHouseMovements(() => placeFurnishedHouseBlock(spec)),
    __testFurnishedHouseStandingSafely: furnishedHouseStandingSafely,
    __testWithFurnishedHouseMovements: withFurnishedHouseMovements,
    __testBreakFurnishedHouseBlock: (position, options) => {
      const task = currentTask;
      return executionContextStorage.run({ task, token: task?.cancellationToken || runtimeToken,
        movementLease: task?.movementLease, runGeneration: task?.executionGeneration },
      () => withFurnishedHouseMovements(() => breakFurnishedHouseBlock(position, options)));
    },
    __testPrepareFurnishedHouseMaterials: prepareFurnishedHouseMaterials,
    __testWithHouseResourceBounds: (bounds, operation) => executionContextStorage.run({ ...(getExecutionContext() || {}),
      houseResourceExclusionBounds: bounds, selfSupplyOnly: true }, () => withSurfaceResourceMovements(operation)),
    __testHouseSelfSupply: (requirements, options = {}) => {
      const task = currentTask;
      if (task && !task.diagnostics) startTaskDiagnostics(task, "house_material_component_started");
      const blueprint = ["medieval_castle", "riverside_villa"].includes(options.profile)
        ? createEstateBlueprint(options.anchor, { profile: options.profile })
        : createFurnishedHouseBlueprint(options.anchor, { profile: options.profile || "cottage" });
      const bounds = houseConstructionMaterialBounds(blueprint);
      return executionContextStorage.run({ task, token: task?.cancellationToken || runtimeToken,
        movementLease: task?.movementLease, runGeneration: task?.executionGeneration },
      () => createHouseMaterialRuntime(task, blueprint, [bounds]).run(requirements));
    },
    __testHouseQuarryRaw: (name, amount, options = {}) => {
      const task = currentTask;
      if (task && !task.diagnostics) startTaskDiagnostics(task, "house_quarry_entry_component_started");
      const blueprint = createFurnishedHouseBlueprint(options.anchor, { profile: options.profile || "cottage" });
      const bounds = houseConstructionMaterialBounds(blueprint);
      return executionContextStorage.run({ task, token: task?.cancellationToken || runtimeToken,
        movementLease: task?.movementLease, runGeneration: task?.executionGeneration }, () => {
        const runtime = createHouseMaterialRuntime(task, blueprint, [bounds]);
        return runtime.withContext(() => runtime.ensure({ [name]: getItemCountByName(name) + amount }));
      });
    },
    __testPhysicalPlaceBlock: physicalPlaceBlock,
    __testExecuteMineResource: executeMineResource,
    __testExecuteDiamondExpedition: executeDiamondExpedition,
    __testExpandPlanWithPrerequisites: expandPlanWithPrerequisites,
    __testExecuteStepWithWatchdog: executeStepWithWatchdog,
    __testGetSmallHouseRemainingMaterials: getSmallHouseRemainingMaterials,
    __testExecuteBuildSmallHousePhase: executeBuildSmallHousePhase,
    __testExecuteBlueprintPhase: executeBlueprintPhase,
    __testVerifyTaskCompletion: verifyTaskCompletion,
    __testSetReconnectTask: (task) => {
      currentTask = task;
    },
    __testGetReconnectTask: () => currentTask,
  };
}

module.exports = {
  createMinecraftTaskAgent,
  configureFurnishedHouseDoorTraversal,
};
