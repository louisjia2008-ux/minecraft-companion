const minecraftData = require("minecraft-data");
const minecraftDataCatalog = require("minecraft-data/data.js");

const EXPERIMENTAL_MAJOR_VERSION = "26.1";
const EXPERIMENTAL_VERSION_ALIASES = ["26.1", "26.1.1"];
const EXPERIMENTAL_DATA_SOURCE_VERSION = "1.21.11";
const EXPERIMENTAL_PLAY_TOSERVER_PACKET_REMAP = {
  "0x00": "teleport_confirm",
  "0x06": "message_acknowledgement",
  "0x07": "chat_command",
  "0x08": "chat_command_signed",
  "0x09": "chat_message",
  "0x0a": "chat_session_update",
  "0x0c": "tick_end",
  "0x0e": "settings",
  "0x0f": "tab_complete",
  "0x10": "configuration_acknowledged",
  "0x11": "enchant_item",
  "0x12": "window_click",
  "0x13": "close_window",
  "0x14": "set_slot_state",
  "0x15": "cookie_response",
  "0x16": "custom_payload",
  "0x17": "debug_subscription_request",
  "0x18": "edit_book",
  "0x19": "query_entity_nbt",
  "0x1a": "use_entity",
  "0x1b": "generate_structure",
  "0x1c": "keep_alive",
  "0x1d": "lock_difficulty",
  "0x1e": "position",
  "0x1f": "position_look",
  "0x20": "look",
  "0x21": "flying",
  "0x22": "vehicle_move",
  "0x23": "steer_boat",
  "0x24": "pick_item_from_block",
  "0x25": "pick_item_from_entity",
  "0x26": "ping_request",
  "0x27": "craft_recipe_request",
  "0x28": "abilities",
  "0x29": "block_dig",
  "0x2a": "entity_action",
  "0x2b": "player_input",
  "0x2c": "player_loaded",
  "0x2d": "pong",
  "0x2e": "recipe_book",
  "0x2f": "displayed_recipe",
  "0x30": "name_item",
  "0x31": "resource_pack_receive",
  "0x32": "advancement_tab",
  "0x33": "select_trade",
  "0x34": "set_beacon_effect",
  "0x35": "held_item_slot",
  "0x36": "update_command_block",
  "0x37": "update_command_block_minecart",
  "0x38": "set_creative_slot",
};
const EXPERIMENTAL_PLAY_CLIENTBOUND_PACKET_REMAP = {
  "0x2b": "initialize_world_border",
  "0x2c": "keep_alive",
  "0x2d": "map_chunk",
  "0x2e": "world_event",
  "0x2f": "world_particles",
  "0x30": "update_light",
  "0x40": "player_chat",
  "0x44": "player_remove",
  "0x45": "player_info",
  "0x46": "face_player",
  "0x47": "position",
  "0x48": "player_rotation",
  "0x4f": "remove_resource_pack",
  "0x50": "add_resource_pack",
  "0x55": "server_data",
  "0x56": "action_bar",
  "0x78": "system_chat",
};
const EXPERIMENTAL_PLAY_CLIENTBOUND_SHIFT_START = 0x2a;

let compatApplied = false;
let mineflayerCompatPatched = false;

function cloneVersionInfo(baseInfo, minecraftVersion) {
  return {
    ...baseInfo,
    minecraftVersion,
    majorVersion: EXPERIMENTAL_MAJOR_VERSION,
  };
}

function setVersionLookupAlias(aliasVersion) {
  const baseInfo = minecraftData.versionsByMinecraftVersion?.pc?.[EXPERIMENTAL_MAJOR_VERSION];
  if (!baseInfo) {
    return false;
  }

  if (!minecraftData.versionsByMinecraftVersion.pc[aliasVersion]) {
    minecraftData.versionsByMinecraftVersion.pc[aliasVersion] = cloneVersionInfo(
      baseInfo,
      aliasVersion
    );
  }

  return true;
}

function setDataAlias() {
  const pcCatalog = minecraftDataCatalog?.pc;
  const versionInfo = minecraftData.versionsByMinecraftVersion?.pc?.[EXPERIMENTAL_MAJOR_VERSION];
  if (!pcCatalog || !pcCatalog[EXPERIMENTAL_DATA_SOURCE_VERSION] || !versionInfo) {
    return false;
  }

  const sourceEntry = pcCatalog[EXPERIMENTAL_DATA_SOURCE_VERSION];
  const compatEntry = {
    ...sourceEntry,
    protocol: cloneProtocolEntry(sourceEntry.protocol),
  };
  Object.defineProperty(compatEntry, "version", {
    enumerable: true,
    configurable: true,
    get() {
      const sourceVersion = sourceEntry.version;
      return {
        ...sourceVersion,
        minecraftVersion: EXPERIMENTAL_MAJOR_VERSION,
        version: versionInfo.version,
        majorVersion: sourceVersion.majorVersion,
      };
    },
  });

  pcCatalog[EXPERIMENTAL_MAJOR_VERSION] = compatEntry;

  return true;
}

function cloneProtocolEntry(protocol) {
  if (!protocol || typeof protocol !== "object") {
    return protocol;
  }
  const cloned = JSON.parse(JSON.stringify(protocol));
  applyExperimentalPlayToServerRemap(cloned);
  applyExperimentalPlayClientboundRemap(cloned);
  applyExperimentalPacketShapeOverrides(cloned);
  return cloned;
}

function parsePacketId(packetId) {
  if (typeof packetId !== "string") {
    return null;
  }
  const parsed = Number.parseInt(packetId, 16);
  return Number.isInteger(parsed) ? parsed : null;
}

function formatPacketId(packetId) {
  return `0x${packetId.toString(16).padStart(2, "0")}`;
}

function applyExperimentalPlayToServerRemap(protocol) {
  const mappings = protocol?.play?.toServer?.types?.packet?.[1]?.[0]?.type?.[1]?.mappings;
  if (!mappings || typeof mappings !== "object") {
    return false;
  }

  for (const [packetId, logicalName] of Object.entries(EXPERIMENTAL_PLAY_TOSERVER_PACKET_REMAP)) {
    for (const [existingPacketId, existingLogicalName] of Object.entries(mappings)) {
      if (existingLogicalName === logicalName && existingPacketId !== packetId) {
        delete mappings[existingPacketId];
      }
    }
    mappings[packetId] = logicalName;
  }

  return true;
}

function applyExperimentalPlayClientboundRemap(protocol) {
  const mappings = protocol?.play?.toClient?.types?.packet?.[1]?.[0]?.type?.[1]?.mappings;
  if (!mappings || typeof mappings !== "object") {
    return false;
  }

  const shiftedEntries = Object.entries(mappings)
    .map(([packetId, logicalName]) => ({
      packetId,
      numericId: parsePacketId(packetId),
      logicalName,
    }))
    .filter(
      (entry) =>
        Number.isInteger(entry.numericId) &&
        entry.numericId >= EXPERIMENTAL_PLAY_CLIENTBOUND_SHIFT_START
    )
    .sort((left, right) => right.numericId - left.numericId);

  for (const entry of shiftedEntries) {
    delete mappings[entry.packetId];
    mappings[formatPacketId(entry.numericId + 1)] = entry.logicalName;
  }

  for (const [packetId, logicalName] of Object.entries(EXPERIMENTAL_PLAY_CLIENTBOUND_PACKET_REMAP)) {
    for (const [existingPacketId, existingLogicalName] of Object.entries(mappings)) {
      if (existingLogicalName === logicalName && existingPacketId !== packetId) {
        delete mappings[existingPacketId];
      }
    }
    mappings[packetId] = logicalName;
  }

  return true;
}

function applyExperimentalPacketShapeOverrides(protocol) {
  const toClientTypes = protocol?.play?.toClient?.types;
  if (!toClientTypes || typeof toClientTypes !== "object") {
    return false;
  }

  // For the experimental 26.1.x chat bridge we only need the session to stay online.
  // Minecart interpolation packets changed shape in 26.1.1 and are not needed for chat.
  // Consume the remaining payload safely so the bridge can keep receiving/sending chat.
  toClientTypes.packet_move_minecart = "restBuffer";

  return true;
}

function isCompatEnabled(config = {}) {
  return config.mcExperimentalVersionCompat === true;
}

function patchMineflayerVersionSupport() {
  const mineflayerVersion = require("mineflayer/lib/version");
  if (!mineflayerVersion.testedVersions.includes(EXPERIMENTAL_MAJOR_VERSION)) {
    mineflayerVersion.testedVersions.push(EXPERIMENTAL_MAJOR_VERSION);
  }
  mineflayerVersion.latestSupportedVersion = EXPERIMENTAL_MAJOR_VERSION;
  mineflayerCompatPatched = true;
  return true;
}

function getMinecraftExperimentalCompatSummary(config = {}) {
  return {
    enabled: isCompatEnabled(config),
    applied: compatApplied,
    aliasVersion: EXPERIMENTAL_MAJOR_VERSION,
    aliasVersions: [...EXPERIMENTAL_VERSION_ALIASES],
    dataSourceVersion: EXPERIMENTAL_DATA_SOURCE_VERSION,
    message: compatApplied
      ? `已启用实验兼容：${EXPERIMENTAL_MAJOR_VERSION}.x -> ${EXPERIMENTAL_DATA_SOURCE_VERSION} 数据集（含最小 play->server remap）`
      : "未启用实验兼容",
  };
}

function applyMinecraftExperimentalCompat(config = {}) {
  if (!isCompatEnabled(config)) {
    return getMinecraftExperimentalCompatSummary(config);
  }

  const dataAliasReady = setDataAlias();
  const versionAliasesReady = EXPERIMENTAL_VERSION_ALIASES.every((version) =>
    setVersionLookupAlias(version)
  );
  const mineflayerReady = patchMineflayerVersionSupport();
  compatApplied = dataAliasReady && versionAliasesReady && mineflayerReady;

  return {
    enabled: true,
    applied: compatApplied,
    aliasVersion: EXPERIMENTAL_MAJOR_VERSION,
    aliasVersions: [...EXPERIMENTAL_VERSION_ALIASES],
    dataSourceVersion: EXPERIMENTAL_DATA_SOURCE_VERSION,
    message: compatApplied
      ? `已启用实验兼容：${EXPERIMENTAL_MAJOR_VERSION}.x -> ${EXPERIMENTAL_DATA_SOURCE_VERSION} 数据集（含最小 play->server remap）`
      : `实验兼容初始化失败：缺少 ${EXPERIMENTAL_DATA_SOURCE_VERSION} 基础数据`,
    mineflayerCompatPatched,
  };
}

module.exports = {
  EXPERIMENTAL_MAJOR_VERSION,
  EXPERIMENTAL_VERSION_ALIASES,
  EXPERIMENTAL_DATA_SOURCE_VERSION,
  applyMinecraftExperimentalCompat,
  getMinecraftExperimentalCompatSummary,
};
