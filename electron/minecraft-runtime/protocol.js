/* global module */
'use strict';

const MAX_LINE_BYTES = 1024 * 1024;
const COMMAND_TYPES = new Set([
  'mc_command_submit', 'mc_command_replace', 'mc_command_cancel',
  'mc_command_pause', 'mc_command_resume', 'mc_command_query',
  'mc_diagnostics_query', 'mc_learning_query', 'chat',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, name, max, { optional = false } = {}) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${name} 必须是 1–${max} 个字符`);
  }
  return value.trim();
}

function validateConfig(input) {
  if (!isObject(input)) throw new Error('缺少 Minecraft 连接配置');
  const host = boundedString(input.host, '服务器地址', 253);
  if (/[\s/@?#]/.test(host)) throw new Error('服务器地址只能填写主机名或 IP');
  const port = Number(input.port ?? 25565);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1–65535');
  const username = boundedString(input.username, '角色名或 Microsoft 账号', 254);
  const auth = input.auth ?? 'offline';
  if (!['offline', 'microsoft'].includes(auth)) throw new Error('不支持的 Minecraft 登录方式');
  if (auth === 'offline' && !/^[a-zA-Z0-9_]{1,16}$/.test(username)) {
    throw new Error('离线角色名需要 1–16 个英文字母、数字或下划线');
  }
  const version = input.version === undefined || input.version === 'auto' ? false
    : boundedString(input.version, '游戏版本', 32);
  if (version && !/^\d+(?:\.\d+){1,2}$/.test(version)) throw new Error('请输入 Java 版版本号或 auto');
  const ownerName = boundedString(input.ownerName, '玩家名', 16, { optional: true });
  if (ownerName && !/^[a-zA-Z0-9_]{1,16}$/.test(ownerName)) throw new Error('玩家名格式不正确');
  const executorMode = input.executorMode ?? 'strict';
  if (!['strict', 'hybrid'].includes(executorMode)) throw new Error('不支持的执行模式');
  return { host, port, username, auth, version, ownerName, executorMode };
}

function validateEnvelope(value) {
  if (!isObject(value) || value.version !== 1) throw new Error('不支持的 Minecraft 协议版本');
  boundedString(value.id, '请求 ID', 128);
  if (!['connect', 'disconnect', 'command', 'planner_result', 'shutdown'].includes(value.type)) {
    throw new Error('不支持的 Minecraft 消息类型');
  }
  if (value.type === 'connect') return { ...value, config: validateConfig(value.config) };
  if (value.type === 'planner_result') {
    boundedString(value.requestId, '规划请求 ID', 128);
    if (value.error !== undefined) boundedString(value.error, '规划错误', 2000);
    else boundedString(value.text, '规划结果', 512 * 1024);
  }
  if (value.type === 'command') {
    const command = value.command;
    if (!isObject(command) || !COMMAND_TYPES.has(command.type)) throw new Error('不支持的 Minecraft 指令');
    if (['mc_command_submit', 'mc_command_replace'].includes(command.type)) {
      boundedString(command.command, '任务', 4000);
    }
    if (command.type === 'chat') {
      const text = boundedString(command.message, '聊天消息', 256);
      if (text.startsWith('/') || /[\r\n]/.test(text)) throw new Error('Minecraft 聊天需要单行普通消息');
    }
    if (command.context !== undefined && !isObject(command.context)) throw new Error('任务上下文格式不正确');
    if (command.context?.playerName !== undefined) {
      const name = boundedString(command.context.playerName, '目标玩家', 16, { optional: true });
      if (name && !/^[a-zA-Z0-9_]+$/.test(name)) throw new Error('目标玩家名格式不正确');
    }
    // Only explicitly supported data crosses into the migrated engine.
    return { ...value, command: {
      type: command.type,
      ...(command.command !== undefined ? { command: command.command.trim() } : {}),
      ...(command.message !== undefined ? { message: command.message.trim() } : {}),
      replaceCurrent: command.replaceCurrent === true,
      context: { playerName: command.context?.playerName || '' },
      source: 'deskpet',
    } };
  }
  return value;
}

module.exports = { MAX_LINE_BYTES, COMMAND_TYPES, validateConfig, validateEnvelope };
