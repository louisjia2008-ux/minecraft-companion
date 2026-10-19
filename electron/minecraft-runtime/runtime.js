/* global require, module, process, clearTimeout, setTimeout */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateEnvelope } = require('./protocol');
const { withMinecraftProtocolCompatibility, installMinecraftBedWakeCompatibility } = require('./protocolCompatibility');
const { createRuntimeTickLoop } = require('./vendor/server/minecraft/runtimeTickLoop');

function parseJsonObjectFromText(text) {
  const value = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(value); } catch {
    const begin = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (begin >= 0 && end > begin) return JSON.parse(value.slice(begin, end + 1));
    throw new Error('AI 规划没有返回 JSON 对象');
  }
}

function flattenReason(value) {
  if (typeof value === 'string') {
    try { return flattenReason(JSON.parse(value)); } catch { return value.slice(0, 2000); }
  }
  if (Array.isArray(value)) return value.map(flattenReason).join('').slice(0, 2000);
  if (value && typeof value === 'object') {
    return [value.text || value.translate || '', ...(value.extra || []), ...(value.with || [])]
      .map(flattenReason).join(' ').trim().slice(0, 2000);
  }
  return '';
}

function supportsPlayerLoaded(bot) {
  // minecraft-data has no dedicated supportFeature for this acknowledgement.
  // Gate on the resolved version's actual PLAY packet map and empty payload,
  // so legacy clients never serialize an unknown packet or guess a version.
  const types = bot.registry?.protocol?.play?.toServer?.types;
  const payload = types?.packet_player_loaded;
  const packetFields = types?.packet?.[1];
  if (payload?.[0] !== 'container' || !Array.isArray(payload[1]) || payload[1].length !== 0
    || !Array.isArray(packetFields)) return false;
  const names = packetFields.find((field) => field.name === 'name')?.type?.[1]?.mappings;
  const parameters = packetFields.find((field) => field.name === 'params')?.type?.[1]?.fields;
  return Object.values(names || {}).includes('player_loaded') && parameters?.player_loaded === 'packet_player_loaded';
}

async function acknowledgePlayerLoaded(bot, isCurrent = () => true) {
  if (!supportsPlayerLoaded(bot)) return false;
  await bot.waitForChunksToLoad();
  if (!isCurrent()) return false;
  if (bot._client?.state !== 'play' || typeof bot._client.write !== 'function') {
    throw new Error('Minecraft 世界加载确认时连接已不可写');
  }
  bot._client.write('player_loaded', {});
  return true;
}

function createRuntime(options) {
  const emit = options.emit;
  const dataDir = path.resolve(options.dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // Explicit paths disable the source project's implicit private-memory migration.
  process.env.MC_AGENT_DATA_DIR = dataDir;
  process.env.MC_AGENT_LEARNING_PATH = path.join(dataDir, 'minecraft-agent-learning.json');
  process.env.MC_AGENT_DIAGNOSTICS_DIR = path.join(dataDir, 'diagnostics');
  process.env.MC_AGENT_DISCONNECT_TRACE_PATH = path.join(dataDir, 'diagnostics', 'disconnect-trace.jsonl');

  let bot = null;
  let worldReady = false;
  let config = null;
  let generation = 0;
  let stopped = false;
  let connectTimer = null;
  const plannerRequests = new Map();
  let agent;
  const event = (payload) => emit({ version: 1, type: 'event', event: payload });
  const errorEvent = (message) => event({ type: 'mc_error', message: String(message).slice(0, 2000) });
  const engineConfig = () => ({
    mcExecutorMode: config?.executorMode === 'hybrid' ? 'experimental-autonomy' : 'strict-executor',
    mcTaskMaxRecoveryAttempts: 5,
    mcAiMidTaskRevision: config?.executorMode === 'hybrid',
    mcAiMidTaskRevisionMaxPerTask: 2,
    mcAgentAutoReconnect: false,
    mcAgentReconnectMaxAttempts: 0,
    mcAgentAutoJsScripts: false,
    aiProvider: 'deskpet-host',
    aiModel: 'host-configured',
  });

  function rejectPlanners(reason) {
    for (const request of plannerRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    plannerRequests.clear();
  }

  function requestPlannerCompletion({ promptMessages, temperature = 0.2 }) {
    if (stopped || !bot) return Promise.reject(new Error('Minecraft 已断开，规划请求已取消'));
    if (config.executorMode !== 'hybrid') return Promise.reject(new Error('本地指令模式未启用 AI 规划，请使用支持的快捷任务或切换 AI 模式'));
    if (!worldReady || !bot.entity) return Promise.reject(new Error('Minecraft 角色尚未进入可操作世界，规划请求已取消'));
    if (plannerRequests.size >= 8) return Promise.reject(new Error('Minecraft 规划请求过多，请稍后重试'));
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        plannerRequests.delete(requestId);
        reject(new Error('DeskPet AI 任务规划超时'));
      }, options.plannerTimeoutMs || 90000);
      timer.unref?.();
      plannerRequests.set(requestId, { resolve, reject, timer, generation });
      emit({ version: 1, type: 'planner_request', requestId, messages: promptMessages, temperature });
    });
  }

  const createAgent = options.createAgent || require('./vendor/server/minecraftTaskAgent').createMinecraftTaskAgent;
  agent = createAgent({
    appPaths: { appDataDir: dataDir },
    readConfig: engineConfig,
    parseJsonObjectFromText,
    requestPlannerCompletion,
    broadcast: event,
    broadcastMinecraftError: errorEvent,
    // Trusted host function only. No command envelope can install a verifier
    // or promote candidates. The engine defaults to its fixed host approval file.
    validateSkillEvidence: options.validateSkillEvidence,
    // Hybrid enables command planning only; spontaneous maintenance stays disarmed.
    allowAutonomousMaintenance: () => false,
    getPreferredPlayerName: () => config?.ownerName || '',
  });
  const access = require('./vendor/server/minecraftAccessController').createMinecraftAccessController({
    broadcast: event,
    getTaskStatus: () => agent.getStatusFields(),
  });
  const snapshotSocket = { send: (data) => event(JSON.parse(data)) };

  function broadcastStatus(force = false) {
    access.broadcastStatus({ bot: worldReady ? bot : null, force });
  }

  function clearConnectTimer() {
    clearTimeout(connectTimer);
    connectTimer = null;
  }

  function detach(reason, source = 'manual_disconnect') {
    generation += 1;
    clearConnectTimer();
    rejectPlanners('Minecraft 连接已结束，旧规划请求已取消');
    const previous = bot;
    bot = null;
    worldReady = false;
    agent.detachBot(source === 'manual_disconnect' ? 'manual_disconnect' : reason);
    if (previous) {
      // Listener closures also check identity; lingering old transport events cannot replace current state.
      try { previous.clearControlStates?.(); } catch { /* Already disconnected or unavailable. */ }
      try { previous.quit?.(reason); } catch { /* Already disconnected or unavailable. */ }
      const socket = previous._client?.socket;
      try { previous._client?.end?.(reason); } catch { /* Already disconnected or unavailable. */ }
      try { socket?.destroy?.(); } catch { /* Already disconnected or unavailable. */ }
    }
    access.markDisconnected(reason, source, source);
    broadcastStatus(true);
  }

  function connect(nextConfig) {
    if (bot) detach('用户更新了 Minecraft 连接', 'manual_disconnect');
    config = nextConfig;
    const currentGeneration = ++generation;
    access.beginConnect({ mode: 'mineflayer', configKey: JSON.stringify({ host: config.host, port: config.port, username: config.username }) });
    const createBot = options.createBot || require('mineflayer').createBot;
    let nextBot;
    try {
      nextBot = createBot(withMinecraftProtocolCompatibility({
        host: config.host,
        port: config.port,
        username: config.username,
        auth: config.auth,
        version: config.version,
        profilesFolder: path.join(dataDir, 'microsoft-profiles'),
        hideErrors: true,
        onMsaCode: (code) => {
          if (stopped || currentGeneration !== generation) return;
          const verificationURI = String(code.verification_uri || code.verificationUri || '');
          const userCode = String(code.user_code || code.userCode || '');
          event({ type: 'mc_auth_device_code', userCode, verificationURI,
            message: String(code.message || ''), expiresIn: Number(code.expires_in || 0) });
        },
      }));
    } catch (error) {
      access.markError(error.message);
      broadcastStatus(true);
      throw error;
    }
    bot = nextBot;
    let spawnEpoch = 0;
    const isCurrent = () => !stopped && bot === nextBot && currentGeneration === generation;
    agent.attachBot(nextBot);
    agent.setRuntimeOptions?.({ mcExecutorMode: engineConfig().mcExecutorMode });
    access.markMineflayerAttached('');
    nextBot.on('login', () => {
      if (!isCurrent()) return;
      // A login packet is not proof that the bot entered a playable world.
      broadcastStatus(true);
    });
    nextBot.on('spawn', () => {
      if (!isCurrent()) return;
      const thisSpawnEpoch = ++spawnEpoch;
      const stillSpawning = () => isCurrent() && thisSpawnEpoch === spawnEpoch;
      const failedSpawn = (error) => {
        if (!stillSpawning()) return;
        errorEvent(`Minecraft 运行时初始化失败：${error.message}`);
        detach(error.message, 'runtime_fault');
      };
      const finishSpawn = () => {
        if (!stillSpawning()) return;
        try {
          installMinecraftBedWakeCompatibility(nextBot);
          // Death and dimension changes detach actions but preserve transport.
          agent.attachBot(nextBot);
          agent.initializeBotRuntime();
          clearConnectTimer();
          worldReady = true;
          access.markMineflayerSpawned();
          broadcastStatus(true);
          agent.sendSnapshot(snapshotSocket);
        } catch (error) { failedSpawn(error); }
      };
      if (supportsPlayerLoaded(nextBot)) {
        // Do not expose command readiness while terrain is still loading, and
        // do not acknowledge a disconnected or superseded world's chunks.
        worldReady = false;
        // Mineflayer 4.37.1 omits this acknowledgement; Vanilla otherwise
        // suppresses early interactions until its loading timeout expires.
        acknowledgePlayerLoaded(nextBot, stillSpawning).then(finishSpawn, failedSpawn);
      } else finishSpawn();
    });
    nextBot.on('health', () => { if (isCurrent()) broadcastStatus(); });
    nextBot.on('chat', (playerName, message) => {
      if (!isCurrent()) return;
      event({ type: 'mc_event', event: { eventType: 'chat', playerName, message, timestamp: Date.now() } });
    });
    for (const [name, eventType] of [['playerJoined', 'player_join'], ['playerLeft', 'player_leave']]) {
      nextBot.on(name, (player) => { if (isCurrent()) event({ type: 'mc_event', event: {
        eventType, playerName: player?.username || '', timestamp: Date.now(),
      } }); });
    }
    for (const name of ['death', 'respawn']) {
      nextBot.on(name, () => {
        if (!isCurrent()) return;
        spawnEpoch += 1;
        worldReady = false;
        // Cancel engine actions before rejecting AI planning, so late completions cannot run in a new world.
        agent.detachBot(name === 'death' ? 'bot_death' : 'world_transition');
        rejectPlanners('Minecraft 角色已离开当前世界，旧规划已取消');
        access.beginConnect({ mode: 'mineflayer', configKey: JSON.stringify({ host: config.host, port: config.port, username: config.username }) });
        access.markMineflayerAttached('');
        broadcastStatus(true);
        agent.sendSnapshot(snapshotSocket);
        event({ type: 'mc_event', event: { eventType: name, timestamp: Date.now() } });
      });
    }
    nextBot.on('kicked', (reason) => {
      if (!isCurrent()) return;
      const detail = flattenReason(reason) || 'Minecraft 服务器拒绝或断开了连接';
      errorEvent(detail);
      detach(detail, 'server_kick');
    });
    nextBot.on('end', (reason) => {
      if (isCurrent()) detach(flattenReason(reason) || 'Minecraft 连接已结束', 'server_disconnected');
    });
    nextBot.on('error', (error) => {
      if (!isCurrent()) return;
      const detail = error?.message || 'Minecraft 连接错误';
      errorEvent(detail);
      detach(detail, 'runtime_fault');
    });
    connectTimer = setTimeout(() => {
      if (!isCurrent()) return;
      const detail = config.auth === 'microsoft' ? 'Microsoft 登录或 Minecraft 连接等待超时，请重新连接'
        : 'Minecraft 连接等待超时，请检查服务器地址、版本和登录方式';
      errorEvent(detail);
      detach(detail, 'connect_timeout');
    }, config.auth === 'microsoft' ? 300000 : 30000);
    connectTimer.unref?.();
    broadcastStatus(true);
  }

  const tickLoop = createRuntimeTickLoop({
    isReady: () => !stopped && worldReady && Boolean(bot?.entity),
    tick: async () => {
      broadcastStatus();
      agent.broadcastContextSnapshot();
      await agent.tickIdleBehavior();
    },
    onFault: error => {
      agent.reportRuntimeFault?.('idle_tick_fault', error, { broadcastError: false });
      errorEvent(error?.message || 'Minecraft 陪玩循环异常');
    },
  });

  async function handle(input) {
    let message;
    try {
      message = validateEnvelope(input);
      if (stopped) throw new Error('Minecraft 运行时已经关闭');
      if (message.type === 'connect') connect(message.config);
      else if (message.type === 'disconnect') detach('用户断开 Minecraft', 'manual_disconnect');
      else if (message.type === 'planner_result') {
        const pending = plannerRequests.get(message.requestId);
        if (!pending || pending.generation !== generation) throw new Error('规划请求已过期或不存在');
        clearTimeout(pending.timer);
        plannerRequests.delete(message.requestId);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.text);
      } else if (message.type === 'command') {
        const command = message.command;
        if (command.type === 'chat') {
          if (!worldReady || !bot?.entity || !agent.isBotConnectionWritable?.()) throw new Error('Minecraft 尚未进入世界');
          bot.chat(command.message);
        } else {
          if (['mc_command_submit', 'mc_command_replace'].includes(command.type) && (!worldReady || !bot?.entity)) {
            throw new Error('请先连接 Minecraft 并等待角色进入世界');
          }
          if (!command.context.playerName && config?.ownerName) command.context.playerName = config.ownerName;
          const handling = agent.handleMessage(command, snapshotSocket);
          if (['mc_command_cancel', 'mc_command_pause'].includes(command.type)) {
            // Engine marks the task first, so rejecting planning cannot turn a pause into a failure.
            rejectPlanners(command.type === 'mc_command_pause' ? '任务已暂停，旧规划已取消' : '任务已取消，旧规划已取消');
          }
          await handling;
        }
      } else if (message.type === 'shutdown') close();
      emit({ version: 1, type: 'reply', id: message.id, ok: true });
      return true;
    } catch (error) {
      emit({ version: 1, type: 'reply', id: typeof input?.id === 'string' ? input.id.slice(0, 128) : undefined,
        ok: false, error: String(error?.message || error).slice(0, 2000) });
      return false;
    }
  }

  function close() {
    if (stopped) return;
    detach('DeskPet 关闭 Minecraft 陪玩', 'manual_disconnect');
    stopped = true;
    void tickLoop.stop();
    agent.dispose();
  }

  emit({ version: 1, type: 'ready', capabilities: {
    java: true, bedrock: false, offline: true, microsoft: true,
    tasks: true, hostPlanner: true, autonomousMaintenance: false,
  } });
  broadcastStatus(true);
  agent.sendSnapshot(snapshotSocket);
  return { handle, close };
}

module.exports = { createRuntime, parseJsonObjectFromText, flattenReason, acknowledgePlayerLoaded,
  withMinecraftProtocolCompatibility, installMinecraftBedWakeCompatibility };
