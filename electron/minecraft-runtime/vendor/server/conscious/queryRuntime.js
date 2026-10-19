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

function createMinecraftQueryRuntime(options = {}) {
  const worldQuery = options.worldQuery;
  const getWorldContext = typeof options.getWorldContext === "function" ? options.getWorldContext : () => ({});
  const getProtectedPlayerName =
    typeof options.getProtectedPlayerName === "function" ? options.getProtectedPlayerName : () => "";

  function selfStatus() {
    return cloneSerializable(worldQuery?.getSelfStatus?.(), null);
  }

  function nearbyHostiles(limit = 8) {
    return cloneSerializable(worldQuery?.listNearbyHostiles?.(limit), []) || [];
  }

  function nearbyPlayers(limit = 8) {
    return cloneSerializable(worldQuery?.listNearbyPlayers?.(limit), []) || [];
  }

  function protectedPlayer() {
    const targetName = String(getProtectedPlayerName() || "").trim().toLowerCase();
    if (!targetName) {
      return null;
    }
    return (
      nearbyPlayers(12).find((player) => String(player?.username || "").trim().toLowerCase() === targetName) ||
      null
    );
  }

  function availableInfrastructure() {
    const context = getWorldContext() || {};
    const workArea = context.workArea && typeof context.workArea === "object" ? context.workArea : {};
    return {
      hasCraftingTable: workArea.hasCraftingTable === true,
      hasFurnace: workArea.hasFurnace === true,
      hasContainer: workArea.hasContainer === true,
      hasBed: workArea.hasBed === true,
      hasNetherPortal: workArea.hasNetherPortal === true,
      torchCount: Number(workArea.torchCount || 0) || 0,
      center: cloneSerializable(workArea.center, null),
    };
  }

  function materialReadiness(material = "") {
    const inventory = cloneSerializable(worldQuery?.listInventory?.(), []) || [];
    const normalized = String(material || "").trim().toLowerCase();
    const directCount = inventory
      .filter((item) => String(item?.name || "").trim().toLowerCase() === normalized)
      .reduce((sum, item) => sum + Number(item?.count || 0), 0);
    return {
      material: normalized,
      directCount,
      availableItems: inventory.slice(0, 32),
    };
  }

  function executorHealth() {
    const context = getWorldContext() || {};
    return cloneSerializable(context.executor, null);
  }

  function createPlannerContext(extra = {}) {
    const context = getWorldContext() || {};
    const base = cloneSerializable(worldQuery?.createPlanningContext?.(extra), {}) || {};
    return {
      ...base,
      query: {
        selfStatus: selfStatus(),
        nearbyHostiles: nearbyHostiles(8),
        protectedPlayer: protectedPlayer(),
        availableInfrastructure: availableInfrastructure(),
        materialReadiness: materialReadiness(extra?.material || ""),
        executorHealth: executorHealth(),
      },
      rawWorldContext: cloneSerializable(context, {}) || {},
    };
  }

  return {
    selfStatus,
    nearbyHostiles,
    protectedPlayer,
    availableInfrastructure,
    materialReadiness,
    executorHealth,
    createPlannerContext,
  };
}

module.exports = {
  createMinecraftQueryRuntime,
};
