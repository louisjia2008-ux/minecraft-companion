function classifyDisconnectDetailSource(reason = "") {
  const text = String(reason || "").trim().toLowerCase();
  if (!text) {
    return "server_disconnected";
  }
  if (text.includes("epipe") || text.includes("socket_not_writable")) {
    return "socket_write_epipe";
  }
  if (
    /runtime_fault|idle_tick_fault|autonomy_plan_fault|movement_monitor_fault|combat_interrupt_fault|task_execution_fault/.test(
      text
    )
  ) {
    return "runtime_fault";
  }
  if (
    text.includes("manual") ||
    text.includes("用户") ||
    text.includes("disconnect requested")
  ) {
    return "manual_disconnect";
  }
  if (text.includes("config") || text.includes("switch")) {
    return "transport_restart";
  }
  if (text.includes("death") || text.includes("死亡")) {
    return "bot_death";
  }
  if (text.includes("kick") || text.includes("kicked")) {
    return "server_kick";
  }
  if (text === "server_disconnected") {
    return "server_disconnected";
  }
  if (text.includes("server")) {
    return "server_kick";
  }
  return "server_disconnected";
}

function getConnectionFailureTaskCode(detailSource = "", reason = "") {
  const normalizedSource = String(detailSource || "").trim().toLowerCase();
  const normalizedReason = String(reason || "").trim().toLowerCase();
  if (
    normalizedSource === "manual_disconnect" ||
    normalizedSource === "transport_restart" ||
    normalizedReason.includes("manual_disconnect") ||
    normalizedReason.includes("transport_restart")
  ) {
    return normalizedSource || "server_disconnected";
  }
  return "bot_connection_lost";
}

function getDisconnectPath(detailSource = "") {
  const normalizedSource = String(detailSource || "").trim();
  if (normalizedSource === "runtime_fault") return "runtime_fault";
  if (normalizedSource === "transport_restart") return "transport_restart";
  if (normalizedSource === "bot_death") return "bot_death";
  if (normalizedSource === "manual_disconnect") return "manual_disconnect";
  if (normalizedSource === "server_kick") return "server_kick";
  if (normalizedSource === "socket_write_epipe") return "socket_write_epipe";
  return "server_disconnected";
}

function createDisconnectRaceError(
  error = null,
  fallbackMessage = "Minecraft 底层连接在动作执行中断开"
) {
  const detail = String(error?.message || "").trim();
  const message = detail || fallbackMessage;
  const disconnectError = new Error(message);
  disconnectError.code =
    /(?:^|[\s:])EPIPE(?:$|[\s:])/i.test(message) || /write EPIPE/i.test(message)
      ? "socket_write_epipe"
      : "bot_connection_lost";
  return disconnectError;
}

module.exports = {
  classifyDisconnectDetailSource,
  createDisconnectRaceError,
  getConnectionFailureTaskCode,
  getDisconnectPath,
};
