'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateConfig, MAX_LINE_BYTES } = require('./protocol');
const { withMinecraftProtocolCompatibility, installMinecraftBedWakeCompatibility } = require('./protocolCompatibility');
const { acknowledgePlayerLoaded, flattenReason } = require('./runtime');
const { GOAL_SCHEMAS, TOOLS, validateTool } = require('./core-tools');

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const problem = (code, message, retryable = false) => Object.assign(new Error(message), { code, retryable });
const errorData = (error) => ({ code: error.code || 'invalid_request', message: String(error.message || error).slice(0, 2000), retryable: error.retryable === true });
const clone = (value) => JSON.parse(JSON.stringify(value));
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** A single-bot, data-only tool host. Dispatch promises are NOT task completion. */
function createCoreHost({ dataDir, emit = () => {}, createBot = require('mineflayer').createBot,
  createCompanion = require('./core/companion').createCompanion, now = Date.now,
  historyLimit = 256, historyTtlMs = 10 * 60 * 1000, connectTimeoutMs = 60000, maxPending = 64 } = {}) {
  if (!dataDir || !path.isAbsolute(dataDir)) throw new TypeError('An absolute dataDir is required');
  if (!Number.isInteger(historyLimit) || historyLimit < 2 || !Number.isFinite(historyTtlMs) || historyTtlMs < 1
      || !Number.isInteger(maxPending) || maxPending < 1 || !Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 1) {
    throw new TypeError('Invalid host limits');
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let bot = null;
  let companion = null;
  let config = null;
  let generation = 0;
  let active = null;
  let closed = false;
  let closePromise = null;
  let connection = { state: 'disconnected', generation, automaticReconnect: false };
  let timer = null;
  let queue = Promise.resolve();
  let pending = 0;
  let cleanup = Promise.resolve();
  const tasks = new Map();
  const requests = new Map();
  // Observer failures must not leave a task half-transitioned.
  const send = (message) => { try { emit(clone(message)); } catch { /* transport owns delivery */ } };
  const event = (payload) => send({ version: 1, type: 'event', event: { at: now(), ...payload } });
  function setConnection(state, error) {
    connection = { state, generation, automaticReconnect: false, ...(error ? { error } : {}) };
    event({ type: 'connection', ...connection });
  }
  function prune() {
    for (const [id, task] of tasks) {
      if (TERMINAL.has(task.status) && now() - task.updatedAt >= historyTtlMs) tasks.delete(id);
    }
    for (const [id, request] of requests) {
      const task = tasks.get(request.taskId);
      if (request.done && (!task || TERMINAL.has(task.status)) && now() - request.at >= historyTtlMs) requests.delete(id);
    }
    while (tasks.size > historyLimit) {
      const oldest = [...tasks].find(([, task]) => TERMINAL.has(task.status));
      if (!oldest) break;
      tasks.delete(oldest[0]);
    }
  }
  function updateTask(task, status, details = {}) {
    if (!task || TERMINAL.has(task.status)) return;
    Object.assign(task, details, { status, updatedAt: now() });
    if (TERMINAL.has(status)) {
      task.paused = false;
      if (active === task) active = null;
    }
    event({ type: 'task', taskId: task.taskId, task });
    prune();
  }
  function coreEvent(payload, epoch) {
    if (closed || epoch !== generation) return;
    if (payload.type === 'goal_cleanup_error') {
      event({ type: 'core', taskId: payload.taskId || null, connectionGeneration: epoch, payload });
      void detach({ code: 'goal_cleanup_failed', message: 'Goal resource cleanup failed; connection closed', retryable: false },
        { failed: true }).catch(() => {});
      return;
    }
    // Never infer correlation from the current goal's name.
    const task = payload.taskId ? tasks.get(payload.taskId) : null;
    if (task && task.connectionGeneration === epoch && !TERMINAL.has(task.status)) {
      if (payload.type === 'goal_set') updateTask(task, 'running');
      else if (payload.type === 'goal_done') updateTask(task, 'completed', { progress: payload.progress });
      else if (payload.type === 'goal_failed') updateTask(task, 'failed', {
        error: { code: 'goal_failed', message: (payload.reasons || []).join('; ').slice(0, 2000), retryable: false },
      });
      else if (payload.type === 'goal_cleared') updateTask(task, 'cancelled', { reason: payload.reason || 'cleared' });
    }
    event({ type: 'core', taskId: payload.taskId || null, connectionGeneration: epoch, payload });
  }
  function detach(reason, { failed = false, dispose = false } = {}) {
    generation += 1; // invalidate old transport and core callbacks BEFORE cleanup
    clearTimeout(timer); timer = null;
    const oldBot = bot; const oldCompanion = companion;
    bot = null; companion = null;
    if (active) updateTask(active, failed ? 'failed' : 'cancelled', failed
      ? { error: reason } : { reason: reason.message });
    setConnection(dispose ? 'disposed' : failed ? 'error' : 'disconnected', failed ? reason : undefined);
    // Queue cleanup so reconnect cannot attach a new engine before the old one
    // has released its body/listeners. Tasks are never automatically replayed.
    cleanup = cleanup.then(async () => {
      try { await oldCompanion?.dispose(); } finally {
        try { oldBot?.clearControlStates?.(); } catch { /* disconnected */ }
        try { oldBot?.quit?.(reason.code); } catch { /* disconnected */ }
        try { oldBot?._client?.end?.(reason.code); } catch { /* disconnected */ }
        try { oldBot?._client?.socket?.destroy?.(); } catch { /* disconnected */ }
      }
    }).catch((error) => {
      // A teardown which did not complete cannot safely admit a new engine.
      // Remain fail-closed, but do not advertise a reconnect we cannot perform.
      const failure = error.code === 'cleanup_failed' ? error
        : problem('cleanup_failed', 'Companion cleanup failed; restart the host before reconnecting');
      setConnection(closed ? 'disposed' : 'error', errorData(failure));
      throw failure;
    });
    // Keep the rejection observable to the caller without an unhandled event.
    cleanup.catch((error) => event({ type: 'cleanup_error', error: errorData(error) }));
    return cleanup;
  }
  async function connect(nextConfig) {
    await cleanup;
    if (closed) throw problem('disposed', 'Host is permanently closed');
    config = nextConfig;
    const epoch = ++generation;
    setConnection('connecting');
    if (closed || epoch !== generation) throw problem('disposed', 'Connection was cancelled before creation');
    let next;
    try {
      next = createBot(withMinecraftProtocolCompatibility({
        host: config.host, port: config.port, username: config.username, auth: config.auth, version: config.version,
        profilesFolder: path.join(dataDir, 'microsoft-profiles'), hideErrors: true,
        onMsaCode: (code) => {
          if (epoch !== generation || closed) return;
          event({ type: 'auth_device_code', userCode: String(code.user_code || code.userCode || ''),
            verificationURI: String(code.verification_uri || code.verificationUri || ''), expiresIn: Number(code.expires_in || 0) });
        },
      }));
    } catch (error) {
      const detail = { ...errorData(error), code: 'connect_failed', retryable: true };
      setConnection('error', detail);
      throw problem(detail.code, detail.message, detail.retryable);
    }
    bot = next;
    const current = () => !closed && epoch === generation && bot === next;
    const lost = (code, message) => {
      if (!current()) return;
      void detach({ code, message, retryable: true }, { failed: true }).catch(() => {});
    };
    // These closures stay on their original bot and never affect a later one.
    next.on('error', (error) => lost('connection_error', String(error.message || error)));
    next.on('kicked', (reason) => lost('kicked', flattenReason(reason) || 'Server kicked the bot'));
    next.on('end', (reason) => lost('disconnected', String(reason || 'Connection ended')));
    let spawnEpoch = 0;
    next.on('spawn', async () => {
      if (!current()) return;
      const spawn = ++spawnEpoch;
      const valid = () => current() && spawn === spawnEpoch;
      try {
        await next.waitForChunksToLoad?.();
        await acknowledgePlayerLoaded(next, valid);
        if (!valid()) return;
        installMinecraftBedWakeCompatibility(next);
        if (!companion) companion = createCompanion({ bot: next, autonomy: false, onEvent: (payload) => coreEvent(payload, epoch) });
        clearTimeout(timer); timer = null;
        setConnection('ready');
      } catch (error) {
        if (valid()) lost('initialization_failed', String(error.message || error));
      }
    });
    timer = setTimeout(() => lost('connect_timeout', 'World readiness timed out; reconnect explicitly'), connectTimeoutMs);
    timer.unref?.();
    return { connection: clone(connection) };
  }
  function status() {
    prune();
    return { connection: clone(connection), task: active ? clone(active) : null,
      engine: companion ? companion.status() : null,
      safetyActive: connection.state === 'ready' && Boolean(companion),
      recovery: 'explicit_reconnect_then_new_request',
      idempotency: { limit: historyLimit, ttlMs: historyTtlMs, persistent: false } };
  }
  function currentTask(id) {
    const task = tasks.get(id);
    if (!task) throw problem('task_not_found', 'Task is unknown or its bounded history expired');
    if (TERMINAL.has(task.status)) return task;
    if (task !== active) throw problem('task_not_active', 'Task is not the active task');
    return task;
  }
  async function tool(message, request) {
    const { name, arguments: args = {} } = message;
    validateTool(name, args);
    if (name === 'listTools') return { tools: TOOLS };
    if (name === 'getStatus') return status();
    if (name === 'getTask') return { task: clone(currentTask(args.taskId)) };
    if (name === 'stopAll') {
      await detach({ code: 'stopped_all', message: 'Host stopped all activity and disconnected' });
      return status();
    }
    if (Object.hasOwn(GOAL_SCHEMAS, name)) {
      if (connection.state !== 'ready' || !companion) throw problem('not_ready', 'Connect and wait for connection.ready before submitting a task', true);
      if (active && !message.replaceCurrent) throw problem('busy', 'A task already owns the body; cancel it or explicitly replaceCurrent', true);
      if (active) {
        const previous = active;
        await companion.cancelTask('replaced');
        updateTask(previous, 'cancelled', { reason: 'replaced' });
      }
      // Cancellation may await I/O. A kick or external close during that wait
      // must not admit work into the disconnected/replaced generation.
      if (closed || connection.state !== 'ready' || !companion) throw problem('not_ready', 'Connection ended during task replacement', true);
      const task = { taskId: randomUUID(), requestId: message.id, name, status: 'accepted', paused: false,
        createdAt: now(), updatedAt: now(), connectionGeneration: generation };
      request.taskId = task.taskId;
      tasks.set(task.taskId, task); active = task;
      event({ type: 'task', taskId: task.taskId, task });
      try {
        await companion.submitTask(name, args, { taskId: task.taskId });
      } catch (error) {
        updateTask(task, 'failed', { error: errorData(error) });
        throw Object.assign(error, { task });
      }
      return { task: clone(task), dispatchOnly: true };
    }
    const task = currentTask(args.taskId);
    if (TERMINAL.has(task.status)) return { task: clone(task) };
    if (!companion) throw problem('not_ready', 'No live companion is attached', true);
    if (name === 'cancel') {
      await companion.cancelTask('host_cancel');
      updateTask(task, 'cancelled', { reason: 'host_cancel' });
    } else if (name === 'pause') {
      await companion.pauseTask('host_pause');
      updateTask(task, task.status, { paused: true });
    } else if (name === 'resume') {
      await companion.resumeTask();
      updateTask(task, task.status, { paused: false });
    }
    return { task: clone(task) };
  }
  async function execute(message, request) {
    if (closed) throw problem('disposed', 'Host is permanently closed');
    if (message.type === 'tool') return tool(message, request);
    if (message.type === 'connect' || message.type === 'reconnect') {
      const nextConfig = message.config === undefined && message.type === 'reconnect' && config ? config : validateConfig(message.config);
      if (bot && message.type === 'connect') throw problem('already_connected', 'Use reconnect explicitly to replace a connection');
      if (message.type === 'reconnect') await detach({ code: 'reconnect', message: 'Host explicitly reconnected' });
      return connect(nextConfig);
    }
    if (message.type === 'disconnect') {
      await detach({ code: 'host_disconnect', message: 'Host disconnected' });
      return status();
    }
    if (message.type === 'shutdown') { await close(); return status(); }
    throw problem('unsupported_type', 'Use connect, reconnect, disconnect, tool or shutdown with the core engine');
  }
  function validateMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.version !== 1) throw problem('invalid_request', 'Expected a version 1 object');
    if (typeof message.id !== 'string' || !message.id.trim() || message.id.length > 128) throw problem('invalid_request', 'id must be 1..128 characters');
    if (!['connect', 'reconnect', 'disconnect', 'tool', 'shutdown'].includes(message.type)) throw problem('unsupported_type', 'Unsupported core message type');
    const fields = ['version', 'id', 'type', ...(message.type === 'tool' ? ['name', 'arguments', 'replaceCurrent'] : ['config'])];
    if (Object.keys(message).some((key) => !fields.includes(key))) throw problem('invalid_request', 'Unexpected envelope field');
    if (message.replaceCurrent !== undefined && typeof message.replaceCurrent !== 'boolean') throw problem('invalid_request', 'replaceCurrent must be boolean');
    if (message.type === 'tool') validateTool(message.name, message.arguments);
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_LINE_BYTES) throw problem('invalid_request', 'Request exceeds size limit');
  }
  async function handle(input) {
    let message;
    const id = typeof input?.id === 'string' ? input.id.slice(0, 128) : undefined;
    const reply = (result) => { const response = clone({ version: 1, type: 'reply', id, ...result }); send(response); return response; };
    try {
      // Normalize direct calls to the same data-only semantics as JSONL input.
      message = clone(input);
      validateMessage(message);
      prune();
      const fingerprint = canonical(message);
      const previous = requests.get(message.id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw problem('id_conflict', 'This request id was already used for different content');
        return reply(await previous.promise);
      }
      if (pending >= maxPending) throw problem('overloaded', 'Too many pending requests', true);
      while (requests.size >= historyLimit) {
        const oldest = [...requests].find(([, record]) => record.done && (!active || record.taskId !== active.taskId));
        if (!oldest) throw problem('overloaded', 'Idempotency history is occupied by pending requests', true);
        requests.delete(oldest[0]);
      }
      const record = { fingerprint, at: now(), done: false };
      pending += 1;
      record.promise = queue.then(() => execute(message, record))
        .then((result) => ({ ok: true, result }), (error) => ({ ok: false, error: errorData(error), ...(error.task ? { task: clone(error.task) } : {}) }))
        .then((result) => { record.done = true; record.at = now(); pending -= 1; return result; });
      requests.set(message.id, record);
      queue = record.promise.then(() => {});
      return reply(await record.promise);
    } catch (error) { return reply({ ok: false, error: errorData(error) }); }
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = detach({ code: 'disposed', message: 'Host disposed' }, { dispose: true });
    return closePromise;
  }
  send({ version: 1, type: 'ready', engine: 'core', capabilities: {
    tools: TOOLS, taskLifecycle: true, pauseKeepsSafety: true, automaticReconnect: false,
    idempotency: { limit: historyLimit, ttlMs: historyTtlMs, persistent: false },
  } });
  return { handle, close, status };
}

module.exports = { createCoreHost };
