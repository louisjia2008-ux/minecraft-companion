function createMinecraftAccessController(options = {}) {
  const broadcast =
    typeof options.broadcast === "function"
      ? options.broadcast
      : () => {};
  const getTaskStatus =
    typeof options.getTaskStatus === "function"
      ? options.getTaskStatus
      : () => ({});
  const describeExperimentalDiagnostics =
    typeof options.describeExperimentalDiagnostics === "function"
      ? options.describeExperimentalDiagnostics
      : () => "";

  const state = {
    connectionState: "idle",
    transportMode: null,
    activeConfigKey: "",
    lastDisconnectReason: "",
    lastDisconnectPath: "",
    lastDisconnectDetailSource: "",
    disconnectReasonText: "",
    lastRuntimeFault: "",
    lastRuntimeFaultAt: 0,
    lastError: "",
    lastBroadcastSignature: "",
    lastControlSignature: "",
    botHasSpawned: false,
    experimentalConnected: false,
    experimentalConnectedAt: 0,
    experimentalBootstrapSentAt: 0,
    experimentalLastPacket: null,
    lastExperienceSnapshot: null,
    lastExperienceEventAt: 0,
    connectedAt: 0,
  };

  function toNumber(value, fallback = 0) {
    return Number.isFinite(value) ? Number(value) : fallback;
  }

  function patch(next = {}) {
    Object.assign(state, next);
  }

  function getState() {
    return { ...state };
  }

  function getControlState() {
    return {
      connectionState: state.connectionState,
      transportMode: state.transportMode,
      activeConfigKey: state.activeConfigKey || "",
      lastDisconnectReason: state.lastDisconnectReason || "",
      lastDisconnectPath: state.lastDisconnectPath || "",
      lastDisconnectDetailSource: state.lastDisconnectDetailSource || "",
      disconnectReasonText: state.disconnectReasonText || "",
      lastRuntimeFault: state.lastRuntimeFault || "",
      lastRuntimeFaultAt: state.lastRuntimeFaultAt || 0,
      lastError: state.lastError || "",
      connectedAt: state.connectedAt || 0,
      experimentalConnected: state.experimentalConnected === true,
      experimentalConnectedAt: state.experimentalConnectedAt || 0,
      experimentalBootstrapSentAt: state.experimentalBootstrapSentAt || 0,
      experimentalLastPacket: state.experimentalLastPacket || null,
      diagnostics: describeExperimentalDiagnostics(),
      ...getTaskStatus(),
    };
  }

  function publishControlState(force = false) {
    const payload = getControlState();
    const signature = JSON.stringify(payload);
    if (!force && signature === state.lastControlSignature) {
      return;
    }
    state.lastControlSignature = signature;
    broadcast({
      type: "mc_control_state",
      control: payload,
    });
  }

  function createMinecraftStatus({ bot = null, experimentalClient = null } = {}) {
    if (!bot || !bot.entity) {
      if (experimentalClient && state.experimentalConnected) {
        return {
          connected: true,
          health: null,
          food: null,
          dimension: experimentalClient.__experimentalBootstrapSent
            ? "实验聊天桥"
            : "实验聊天桥（初始化中）",
          position: null,
          mode: "experimental-chat",
          ...getTaskStatus(),
        };
      }
      return {
        connected: false,
        health: null,
        food: null,
        dimension: null,
        position: null,
        mode: null,
        ...getTaskStatus(),
      };
    }

    return {
      connected: true,
      health: Number.isFinite(bot.health) ? Number(bot.health) : null,
      food: Number.isFinite(bot.food) ? Number(bot.food) : null,
      dimension: bot.game?.dimension || null,
      position: {
        x: Number(bot.entity.position.x.toFixed(1)),
        y: Number(bot.entity.position.y.toFixed(1)),
        z: Number(bot.entity.position.z.toFixed(1)),
      },
      mode: "mineflayer",
      ...getTaskStatus(),
    };
  }

  function broadcastStatus({ bot = null, experimentalClient = null, force = false } = {}) {
    const status = createMinecraftStatus({ bot, experimentalClient });
    const signature = JSON.stringify(status);
    if (!force && signature === state.lastBroadcastSignature) {
      return;
    }
    state.lastBroadcastSignature = signature;
    broadcast({
      type: "mc_status",
      status,
    });
    publishControlState(force);
  }

  function beginConnect({ mode = "mineflayer", configKey = "" } = {}) {
    patch({
      connectionState: "connecting",
      transportMode: mode,
      activeConfigKey: String(configKey || "").trim(),
      lastDisconnectReason: "",
      lastDisconnectPath: "",
      lastError: "",
    });
    publishControlState(true);
  }

  function markMineflayerAttached(configKey = "") {
    patch({
      connectionState: "connecting",
      transportMode: "mineflayer",
      activeConfigKey: String(configKey || state.activeConfigKey || "").trim(),
      botHasSpawned: false,
      connectedAt: 0,
      lastExperienceSnapshot: null,
      lastExperienceEventAt: 0,
      lastError: "",
    });
    publishControlState(true);
  }

  function markMineflayerLoggedIn() {
    patch({
      connectionState: "connected",
      transportMode: "mineflayer",
      connectedAt: Date.now(),
      lastError: "",
    });
    publishControlState(true);
  }

  function markMineflayerSpawned() {
    patch({
      connectionState: "connected",
      transportMode: "mineflayer",
      botHasSpawned: true,
      connectedAt: state.connectedAt || Date.now(),
      lastError: "",
    });
    publishControlState(true);
  }

  function markExperimentalAttached(configKey = "") {
    patch({
      connectionState: "connecting",
      transportMode: "experimental-chat",
      activeConfigKey: String(configKey || state.activeConfigKey || "").trim(),
      experimentalConnected: false,
      experimentalConnectedAt: 0,
      experimentalBootstrapSentAt: 0,
      experimentalLastPacket: null,
      lastError: "",
    });
    publishControlState(true);
  }

  function markExperimentalConnected() {
    patch({
      connectionState: "connected",
      transportMode: "experimental-chat",
      experimentalConnected: true,
      experimentalConnectedAt: Date.now(),
      connectedAt: Date.now(),
      lastError: "",
    });
    publishControlState(true);
  }

  function markExperimentalBootstrapSent() {
    patch({
      experimentalBootstrapSentAt: Date.now(),
      lastError: "",
    });
    publishControlState(true);
  }

  function markExperimentalPacket(metadata = {}) {
    patch({
      experimentalLastPacket: {
        name: String(metadata.name || "").trim(),
        id: metadata.id,
        state: metadata.state,
        at: Date.now(),
      },
    });
  }

  function markExperienceSnapshot(snapshot = null) {
    patch({
      lastExperienceSnapshot: snapshot,
    });
  }

  function markExperienceEventAt(timestamp = Date.now()) {
    patch({
      lastExperienceEventAt: toNumber(timestamp, Date.now()),
    });
  }

  function classifyDisconnectPath(reason = "") {
    const text = String(reason || "").toLowerCase();
    if (text === "server_disconnected") return "server_disconnected";
    if (text.includes("epipe") || text.includes("socket_write_epipe") || text.includes("socket_not_writable")) {
      return "socket_write_epipe";
    }
    if (/runtime_fault|idle_tick_fault|autonomy_plan_fault|movement_monitor_fault|combat_interrupt_fault|task_execution_fault/.test(text)) return "runtime_fault";
    if (text.includes("manual") || text.includes("用户") || text.includes("disconnect requested")) return "manual_disconnect";
    if (text.includes("config") || text.includes("switch transport")) return "transport_restart";
    if (text.includes("death") || text.includes("死亡")) return "bot_death";
    if (text.includes("kick") || text.includes("kicked") || text.includes("server")) return "server_kick";
    return "server_disconnected";
  }

  function buildDisconnectReasonText(path = "", detailSource = "", reason = "") {
    const values = [path, detailSource, reason]
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    const deduped = [];
    for (const value of values) {
      if (!deduped.includes(value)) {
        deduped.push(value);
      }
    }
    if (deduped.length >= 2) {
      const last = deduped[deduped.length - 1];
      const previous = deduped[deduped.length - 2];
      if (
        last === "server_disconnected" &&
        previous &&
        previous !== "server_disconnected"
      ) {
        deduped.pop();
      }
    }
    return deduped.join("：");
  }

  function markDisconnected(reason = "server_disconnected", path = "", detailSource = "") {
    const resolvedDetailSource = String(detailSource || classifyDisconnectPath(reason)).trim();
    const resolvedPath = String(path || classifyDisconnectPath(reason)).trim();
    const resolvedReason = String(reason || "server_disconnected");
    patch({
      connectionState: "idle",
      transportMode: null,
      activeConfigKey: "",
      lastDisconnectReason: resolvedReason,
      lastDisconnectPath: resolvedPath,
      lastDisconnectDetailSource: resolvedDetailSource,
      disconnectReasonText: buildDisconnectReasonText(
        resolvedPath,
        resolvedDetailSource,
        resolvedReason
      ),
      lastRuntimeFault:
        resolvedDetailSource === "runtime_fault" ? resolvedReason.trim() : state.lastRuntimeFault || "",
      lastRuntimeFaultAt:
        resolvedDetailSource === "runtime_fault" ? Date.now() : state.lastRuntimeFaultAt || 0,
      lastError: "",
      botHasSpawned: false,
      experimentalConnected: false,
      experimentalConnectedAt: 0,
      experimentalBootstrapSentAt: 0,
      connectedAt: 0,
      lastExperienceSnapshot: null,
      lastExperienceEventAt: 0,
    });
    state.lastBroadcastSignature = "";
    publishControlState(true);
  }

  function markError(message = "") {
    const nextConnectionState =
      state.connectionState === "connected" || state.connectionState === "disconnecting"
        ? state.connectionState
        : "error";
    const detail = String(message || "").trim();
    const isRuntimeFault =
      /runtime_fault|idle_tick_fault|autonomy_plan_fault|movement_monitor_fault|combat_interrupt_fault|task_execution_fault/i.test(
        detail
      );
    patch({
      connectionState: nextConnectionState,
      lastError: detail,
      lastRuntimeFault: isRuntimeFault ? detail : state.lastRuntimeFault || "",
      lastRuntimeFaultAt: isRuntimeFault ? Date.now() : state.lastRuntimeFaultAt || 0,
    });
    publishControlState(true);
  }

  function resetForStop(reason = "config updated") {
    patch({
      connectionState: "disconnecting",
      lastDisconnectReason: String(reason || "config updated"),
      lastDisconnectPath: String(classifyDisconnectPath(reason)).trim(),
      lastDisconnectDetailSource: String(classifyDisconnectPath(reason)).trim(),
      disconnectReasonText: buildDisconnectReasonText(
        classifyDisconnectPath(reason),
        classifyDisconnectPath(reason),
        String(reason || "config updated")
      ),
      lastError: "",
    });
    publishControlState(true);
    patch({
      connectionState: "idle",
      transportMode: null,
      activeConfigKey: "",
      botHasSpawned: false,
      experimentalConnected: false,
      experimentalConnectedAt: 0,
      experimentalBootstrapSentAt: 0,
      experimentalLastPacket: null,
      connectedAt: 0,
      lastExperienceSnapshot: null,
      lastExperienceEventAt: 0,
    });
    state.lastBroadcastSignature = "";
    publishControlState(true);
  }

  return {
    getState,
    getControlState,
    publishControlState,
    createMinecraftStatus,
    broadcastStatus,
    beginConnect,
    markMineflayerAttached,
    markMineflayerLoggedIn,
    markMineflayerSpawned,
    markExperimentalAttached,
    markExperimentalConnected,
    markExperimentalBootstrapSent,
    markExperimentalPacket,
    markExperienceSnapshot,
    markExperienceEventAt,
    markDisconnected,
    markError,
    resetForStop,
  };
}

module.exports = {
  createMinecraftAccessController,
};
