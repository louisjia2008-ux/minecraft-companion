#!/usr/bin/env node
'use strict';
// Real external host -> JSONL child -> new core -> localhost vanilla server.
// No in-process adapter calls, provider, LLM, external server, or granted items.
// Requires a separately installed official server/JDK and explicit EULA consent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { startVanillaServer } = require('../scenarios/vanillaServer.cjs');
const { collectLogsFlat } = require('../scenarios/collectLogs.cjs');
const { runSetup } = require('./scenario-setup.cjs');

const argv = process.argv.slice(2);
const runtimeDir = path.resolve(__dirname, '..');
function usage(message) {
  if (message) console.error(message);
  console.error('Usage: node tools/test-core-host.cjs --accept-eula --installation DIR_OR_JSON [--output DIR]\n'
    + '  installation.json must contain java, minecraft.jar, and minecraft.version.\n'
    + '  Output must be a new or empty directory. All server connections use 127.0.0.1.\n'
    + '  Accept the Minecraft EULA at https://aka.ms/MinecraftEULA before running.');
  process.exit(message ? 2 : 0);
}
function parseOptions() {
  if (argv.includes('--help')) usage();
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--accept-eula') options.acceptEula = true;
    else if (['--installation', '--output'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) usage(`Missing value for ${arg}`);
      options[arg.slice(2)] = value;
    } else usage(`Unknown option: ${arg}`);
  }
  if (!options.acceptEula) usage('Pass --accept-eula after accepting the Minecraft EULA.');
  if (!options.installation) usage('--installation is required; this test does not download software.');
  if (Number(process.versions.node.split('.')[0]) < 22) usage('Node.js 22 or newer is required.');
  const candidate = path.resolve(options.installation);
  const installationFile = fs.statSync(candidate).isDirectory() ? path.join(candidate, 'installation.json') : candidate;
  const installation = JSON.parse(fs.readFileSync(installationFile, 'utf8'));
  const resolveInstalled = (file) => path.resolve(path.dirname(installationFile), file);
  if (!installation.java || !installation.minecraft?.jar || !installation.minecraft?.version) {
    usage('installation.json requires java, minecraft.jar, and minecraft.version.');
  }
  installation.java = resolveInstalled(installation.java);
  installation.minecraft.jar = resolveInstalled(installation.minecraft.jar);
  if (installation.minecraft.version !== '1.21.8') usage('This fixture is pinned to Minecraft Java 1.21.8.');
  for (const file of [installation.java, installation.minecraft.jar]) fs.accessSync(file, fs.constants.R_OK);
  const outputDir = path.resolve(options.output || path.join(path.dirname(installationFile), 'core-host-runs',
    new Date().toISOString().replace(/[:.]/g, '-')));
  if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length) usage('--output must be a new or empty directory.');
  fs.mkdirSync(outputDir, { recursive: true });
  return { installation, installationFile, outputDir };
}

async function main() {
  const { installation, installationFile, outputDir } = parseOptions();
  const username = 'CoreHostTest';
  const checks = [];
  const frames = [];
  const malformed = [];
  const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
  let stage = 'startup';
  let server;
  let child;
  let childExit = null;
  let spawnError = null;
  let interrupted = null;
  let requestNumber = 0;
  let shutdownSent = false;
  let pendingStdout = '';
  const abort = new AbortController();
  const interrupt = (signal) => { interrupted = new Error(`Interrupted by ${signal}`); abort.abort(interrupted); };
  const onSigint = () => interrupt('SIGINT');
  const onSigterm = () => interrupt('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  function write(type, data = {}) {
    const row = { type, at: new Date().toISOString(), stage, ...data };
    fs.appendFileSync(path.join(outputDir, 'events.jsonl'), JSON.stringify(row) + '\n');
    if (['check', 'stage', 'harness_error', 'summary'].includes(type)) console.log(JSON.stringify(row));
    return row;
  }
  function check(name, pass, details = {}, { fatal = true } = {}) {
    checks.push({ name, pass: Boolean(pass), ...details });
    write('check', checks.at(-1));
    if (!pass && fatal) throw new Error(`Check failed: ${name}`);
  }
  function nextStage(name) { stage = name; write('stage'); }
  async function until(predicate, timeoutMs, label, { allowClosed = false, cleanup = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    do {
      const found = predicate();
      if (found) return found;
      if (!cleanup && interrupted) throw interrupted;
      if (!cleanup && malformed.length) throw new Error('Child stdout is not exclusively valid JSONL');
      if (spawnError) throw spawnError;
      if (childExit && !allowClosed) throw new Error(`Host exited before ${label}: ${JSON.stringify(childExit)}`);
      await delay(25);
    } while (Date.now() < deadline);
    throw new Error(`Timed out after ${timeoutMs} ms: ${label}`);
  }
  function parseLine(line) {
    if (!line.trim()) { malformed.push({ line, reason: 'empty_line' }); return; }
    let message;
    try { message = JSON.parse(line); } catch (error) { malformed.push({ line, reason: error.message }); return; }
    if (!message || message.version !== 1 || !['ready', 'event', 'reply'].includes(message.type)) {
      malformed.push({ line, reason: 'invalid_envelope' }); return;
    }
    const row = { seq: frames.length, receivedAt: Date.now(), message };
    frames.push(row);
    write('host_frame', row);
  }
  function startHost() {
    const dataDir = path.join(outputDir, 'host-data');
    const args = [path.join(runtimeDir, 'index.js'), '--engine', 'core', '--data-dir', dataDir];
    write('host_start', { executable: process.execPath, args });
    child = spawn(process.execPath, args, { cwd: runtimeDir, stdio: ['pipe', 'pipe', 'pipe'], env: {
      ...process.env, MC_AGENT_DATA_DIR: dataDir,
      MC_AGENT_LEARNING_PATH: path.join(dataDir, 'learning.json'),
      MC_AGENT_DIAGNOSTICS_DIR: path.join(dataDir, 'diagnostics'),
    } });
    child.stdout.on('data', (chunk) => {
      fs.appendFileSync(path.join(outputDir, 'host-stdout.jsonl'), chunk);
      pendingStdout += chunk.toString('utf8');
      const lines = pendingStdout.split('\n');
      pendingStdout = lines.pop();
      for (const line of lines) parseLine(line);
    });
    child.stdout.on('end', () => {
      if (pendingStdout) malformed.push({ line: pendingStdout, reason: 'unterminated_jsonl' });
    });
    child.stderr.on('data', (chunk) => fs.appendFileSync(path.join(outputDir, 'host-stderr.log'), chunk));
    child.stdin.on('error', (error) => write('host_stdin_error', { message: error.message }));
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => { childExit = { code, signal }; write('host_exit', childExit); });
  }
  async function request(input, { timeoutMs = 30000, cleanup = false } = {}) {
    const message = { version: 1, id: `request-${++requestNumber}`, ...input };
    const from = frames.length;
    const sentAt = Date.now();
    if (message.type === 'shutdown') shutdownSent = true;
    const serialized = JSON.stringify(message) + '\n';
    fs.appendFileSync(path.join(outputDir, 'host-requests.jsonl'), serialized);
    write('host_request', { message, sentAt });
    child.stdin.write(serialized);
    const reply = await until(() => frames.slice(from).find((row) => row.message.type === 'reply' && row.message.id === message.id),
      timeoutMs, `reply ${message.id}`, { cleanup });
    return { ...reply, sentAt, elapsedMs: reply.receivedAt - sentAt, request: message };
  }
  const tool = (name, args = {}, extra = {}) => request({ type: 'tool', name, arguments: args, ...extra });
  function success(receipt, name) {
    check(name, receipt.message.ok === true, { reply: receipt.message, elapsedMs: receipt.elapsedMs });
    return receipt.message.result;
  }
  function taskEvents(taskId) {
    return frames.filter((row) => row.message.type === 'event' && row.message.event?.type === 'task'
      && row.message.event.task?.taskId === taskId);
  }
  function taskFrom(receipt) {
    const task = receipt.message.result?.task;
    check(`task_receipt_${receipt.request.id}`, receipt.message.ok === true && typeof task?.taskId === 'string'
      && task.requestId === receipt.request.id && ['accepted', 'running'].includes(task.status), { reply: receipt.message });
    return task;
  }
  async function terminal(taskId, timeoutMs = 120000) {
    return until(() => taskEvents(taskId).find((row) => terminalStatuses.has(row.message.event.task.status)),
      timeoutMs, `terminal task ${taskId}`);
  }
  async function getTask(taskId) { return success(await tool('getTask', { taskId }), `query_${taskId}`).task; }
  async function getStatus() { return success(await tool('getStatus'), 'query_status'); }
  function errorCode(receipt) { return receipt.message.error?.code || receipt.message.code; }
  async function countLogs() {
    const match = await server.query(`clear ${username} #minecraft:logs 0`,
      new RegExp(`(?:Found (\\d+) matching item(?:\\(s\\)|s)? on player ${username}|No items were found on player ${username})`));
    return match[1] ? Number(match[1]) : 0;
  }
  async function connect(type = 'connect') {
    const from = frames.length;
    const receipt = await request({ type, ...(type === 'connect' ? { config: {
      host: '127.0.0.1', port: server.port, username, auth: 'offline', version: installation.minecraft.version,
    } } : {}) });
    success(receipt, `${type}_receipt`);
    const ready = await until(() => frames.slice(from).find((row) => row.message.event?.type === 'connection'
      && row.message.event.state === 'ready'), 60000, `${type} ready`);
    check(`${type}_ready`, Boolean(ready), { event: ready.message.event });
    return ready;
  }
  async function gather(id, count) {
    const before = await countLogs();
    const receipt = await tool('gatherLogs', { count }, { id });
    const task = taskFrom(receipt);
    const outcome = await terminal(task.taskId);
    await delay(250);
    const after = await countLogs();
    check(id, outcome.message.event.task.status === 'completed' && after >= before + count
      && receipt.seq < outcome.seq, { before, requestedAdditional: count, after,
      receiptAfterMs: receipt.elapsedMs, completionAfterMs: outcome.receivedAt - receipt.sentAt,
      receipt: receipt.message, completion: outcome.message.event });
    return { receipt, task, outcome };
  }
  try {
    let revision;
    try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: runtimeDir, encoding: 'utf8' }).trim(); } catch { revision = null; }
    write('metadata', { revision, node: process.version, installationFile, outputDir, realLLM: false,
      scope: 'Real index.js --engine core JSONL subprocess; isolated localhost official vanilla 1.21.8; no provider.' });
    const properties = { ...collectLogsFlat.serverProperties, 'server-ip': '127.0.0.1',
      'online-mode': false, 'enable-rcon': false, 'enable-query': false };
    server = await startVanillaServer({ java: installation.java, jar: installation.minecraft.jar,
      dir: path.join(outputDir, 'server'), properties, memory: '1G', log: write, signal: abort.signal });
    const serverProperties = fs.readFileSync(path.join(outputDir, 'server/server.properties'), 'utf8');
    check('server_is_loopback_only', /^server-ip=127\.0\.0\.1$/m.test(serverProperties), { port: server.port });
    startHost();
    const hostReady = await until(() => frames.find((row) => row.message.type === 'ready'), 15000, 'core host ready');
    check('explicit_new_core_entrypoint', hostReady.message.engine === 'core'
      && hostReady.message.capabilities?.taskLifecycle === true, { ready: hostReady.message });
    await connect();
    nextStage('controlled_fixture');
    let seed = 43;
    const rng = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const setup = collectLogsFlat.setup({ username, rng, difficulty: 'peaceful' });
    await runSetup({ server, setup, properties, write });
    await delay(1500);
    check('empty_starting_inventory', await countLogs() === 0, { fixture: setup.details,
      suppliedItems: [], note: 'Flat terrain and trees are fixture, not bot-built. No tools, logs, or food granted.' });

    nextStage('dispatch_duplicate_busy_and_completion');
    const before = await countLogs();
    const firstReceipt = await tool('gatherLogs', { count: 3 }, { id: 'first-gather' });
    const first = taskFrom(firstReceipt);
    const duplicate = await request(firstReceipt.request);
    let duplicateIdentical = false;
    try { assert.deepStrictEqual(duplicate.message, firstReceipt.message); duplicateIdentical = true; } catch { /* logged below */ }
    check('duplicate_replays_exact_receipt', duplicateIdentical, { original: firstReceipt.message, replay: duplicate.message });
    const conflict = await request({ ...firstReceipt.request, arguments: { count: 4 } });
    check('conflicting_duplicate_is_rejected', conflict.message.ok === false && errorCode(conflict) === 'id_conflict', { reply: conflict.message });
    const busy = await tool('gatherLogs', { count: 1 }, { id: 'busy-gather' });
    check('busy_task_is_rejected', busy.message.ok === false && ['busy', 'task_busy'].includes(errorCode(busy)), { reply: busy.message });
    const firstDone = await terminal(first.taskId);
    await delay(250);
    const after = await countLogs();
    check('three_real_logs_after_dispatch_receipt', firstDone.message.event.task.status === 'completed' && after >= before + 3
      && firstReceipt.seq < firstDone.seq, { before, after, receiptAfterMs: firstReceipt.elapsedMs,
      completionAfterMs: firstDone.receivedAt - firstReceipt.sentAt, completion: firstDone.message.event });
    check('duplicate_did_not_create_second_task', taskEvents(first.taskId).filter((row) => row.message.event.task.status === 'accepted').length === 1,
      { taskEvents: taskEvents(first.taskId).map((row) => row.message.event) });
    check('terminal_query_reports_completed', (await getTask(first.taskId)).status === 'completed');

    nextStage('explicit_replacement');
    const old = taskFrom(await tool('gatherLogs', { count: 4096 }, { id: 'replacement-old' }));
    const replacementBefore = await countLogs();
    const replacementReceipt = await tool('gatherLogs', { count: 1 }, { id: 'replacement-new', replaceCurrent: true });
    const replacement = taskFrom(replacementReceipt);
    const oldTerminal = await terminal(old.taskId, 15000);
    check('replacement_cancels_old_task', oldTerminal.message.event.task.status === 'cancelled' && old.taskId !== replacement.taskId,
      { old: oldTerminal.message.event, replacement });
    const replacementDone = await terminal(replacement.taskId);
    await delay(250);
    const replacementAfter = await countLogs();
    check('replacement_completes_with_real_collection', replacementDone.message.event.task.status === 'completed'
      && replacementAfter >= replacementBefore + 1 && replacementReceipt.seq < replacementDone.seq,
    { before: replacementBefore, after: replacementAfter, completion: replacementDone.message.event });

    nextStage('pause_resume_cancel_and_stale_controls');
    const paused = taskFrom(await tool('gatherLogs', { count: 4096 }, { id: 'pause-target' }));
    success(await tool('pause', { taskId: paused.taskId }), 'pause_receipt');
    const pausedTask = await getTask(paused.taskId);
    const pausedStatus = await getStatus();
    check('pause_preserves_nonterminal_task_and_safety', pausedTask.paused === true && !terminalStatuses.has(pausedTask.status)
      && pausedStatus.safetyActive === true, { task: pausedTask, status: pausedStatus });
    for (const name of ['pause', 'resume', 'cancel']) {
      const missingId = await tool(name);
      check(`${name}_requires_task_id`, missingId.message.ok === false, { reply: missingId.message });
    }
    const staleCancel = await tool('cancel', { taskId: old.taskId });
    const afterStale = await getTask(paused.taskId);
    check('stale_cancel_cannot_cancel_current_task', afterStale.paused === true && !terminalStatuses.has(afterStale.status),
      { staleReply: staleCancel.message, current: afterStale });
    await delay(500);
    check('pause_is_not_task_completion', !taskEvents(paused.taskId).some((row) => terminalStatuses.has(row.message.event.task.status)));
    success(await tool('resume', { taskId: paused.taskId }), 'resume_receipt');
    check('resume_clears_pause', (await getTask(paused.taskId)).paused === false);
    success(await tool('cancel', { taskId: paused.taskId }), 'cancel_receipt');
    const cancelled = await terminal(paused.taskId, 15000);
    check('cancel_is_terminal', cancelled.message.event.task.status === 'cancelled', { event: cancelled.message.event });

    nextStage('stop_all');
    const stopTarget = taskFrom(await tool('gatherLogs', { count: 4096 }, { id: 'stop-all-target' }));
    success(await tool('stopAll'), 'stop_all_receipt');
    check('stop_all_terminates_active_task', (await terminal(stopTarget.taskId, 15000)).message.event.task.status === 'cancelled');

    await connect('reconnect');

    nextStage('forced_kick_and_explicit_reconnect');
    const kicked = taskFrom(await tool('gatherLogs', { count: 4096 }, { id: 'kick-target' }));
    const kickFrom = frames.length;
    write('server_probe', { command: `kick ${username} core_host_disconnect_probe`,
      response: await server.execute(`kick ${username} core_host_disconnect_probe`) });
    const disconnected = await until(() => frames.slice(kickFrom).find((row) => row.message.event?.type === 'connection'
      && row.message.event.state === 'error'), 15000, 'forced disconnect event');
    const failed = (await terminal(kicked.taskId, 15000)).message.event.task;
    check('disconnect_fails_active_task_retryably', failed.status === 'failed'
      && (failed.retryable === true || failed.error?.retryable === true), { task: failed, event: disconnected.message.event });
    const disconnectedStatus = await getStatus();
    check('disconnect_status_is_observable', disconnectedStatus.connection?.state === 'error' && disconnectedStatus.connection.error?.retryable === true, { status: disconnectedStatus });
    const disconnectedTask = await tool('gatherLogs', { count: 1 }, { id: 'disconnected-task' });
    check('disconnected_task_is_rejected', disconnectedTask.message.ok === false, { reply: disconnectedTask.message });
    await connect('reconnect');
    await gather('fresh_task_after_reconnect', 1);
    check('failed_task_remains_terminal_after_reconnect', (await getTask(kicked.taskId)).status === 'failed');

    nextStage('explicit_disconnect_and_connect');
    const disconnectTarget = taskFrom(await tool('gatherLogs', { count: 4096 }, { id: 'disconnect-target' }));
    success(await request({ type: 'disconnect' }), 'disconnect_receipt');
    check('explicit_disconnect_terminates_active_task', (await terminal(disconnectTarget.taskId, 15000)).message.event.task.status === 'cancelled');
    await connect();
    await gather('fresh_task_after_explicit_connect', 1);

    nextStage('shutdown');
    const shutdownTarget = taskFrom(await tool('gatherLogs', { count: 4096 }, { id: 'shutdown-target' }));
    success(await request({ type: 'shutdown' }), 'shutdown_receipt');
    check('shutdown_terminates_active_task', (await terminal(shutdownTarget.taskId, 15000)).message.event.task.status === 'cancelled');
    await until(() => childExit, 15000, 'graceful host exit', { allowClosed: true });
    check('host_shutdown_is_clean', childExit.code === 0 && childExit.signal === null, { exit: childExit });
    const byTask = new Map();
    for (const row of frames) {
      const task = row.message.event?.type === 'task' && row.message.event.task;
      if (!task) continue;
      const seen = byTask.get(task.taskId) || [];
      seen.push(task); byTask.set(task.taskId, seen);
    }
    const completedTasks = [...byTask.values()].map((events) => events.at(-1)).filter((task) => task.status === 'completed');
    check('completion_is_backed_by_correlated_core_goal_done', completedTasks.length >= 4 && completedTasks.every((task) =>
      frames.some((row) => row.message.event?.type === 'core' && row.message.event.taskId === task.taskId
        && row.message.event.payload?.type === 'goal_done' && row.message.event.payload.taskId === task.taskId)),
    { completedTaskIds: completedTasks.map((task) => task.taskId) });
    check('rejected_busy_request_never_created_a_task', ![...byTask.values()].some((events) => events[0].requestId === 'busy-gather'));
    check('every_task_has_one_immutable_terminal_event', [...byTask.values()].every((events) => {
      const terminalIndex = events.findIndex((task) => terminalStatuses.has(task.status));
      return terminalIndex >= 0 && terminalIndex === events.length - 1;
    }), { tasks: Object.fromEntries([...byTask].map(([id, events]) => [id, events.map((task) => `${task.status}${task.paused ? ':paused' : ''}`)])) });
  } catch (error) {
    write('harness_error', { name: error.name, message: error.message, stack: error.stack });
    check('harness_completed', false, { error: error.message }, { fatal: false });
  } finally {
    nextStage('cleanup');
    if (child && !childExit && !spawnError) {
      try {
        if (!shutdownSent) await request({ type: 'shutdown' }, { cleanup: true, timeoutMs: 10000 });
        await until(() => childExit, 15000, 'cleanup host exit', { allowClosed: true, cleanup: true });
      } catch (error) {
        write('cleanup_error', { target: 'host', message: error.message });
        child.kill('SIGTERM');
        try { await until(() => childExit, 5000, 'host SIGTERM exit', { allowClosed: true, cleanup: true }); }
        catch { child.kill('SIGKILL'); }
        check('host_cleanup_graceful', false, { error: error.message }, { fatal: false });
      }
    }
    if (child) check('stdout_is_exclusively_jsonl', malformed.length === 0 && frames.length > 0,
      { frames: frames.length, malformed }, { fatal: false });
    if (server) {
      try {
        const receipt = await server.stop();
        check('clean_console_server_stop_and_save', receipt.saveObserved && receipt.closed && receipt.code === 0
          && !receipt.forced, { receipt }, { fatal: false });
      } catch (error) {
        check('clean_console_server_stop_and_save', false, { error: error.message, receipt: error.cleanup }, { fatal: false });
      }
    }
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    const summary = { pass: checks.length > 0 && checks.every((item) => item.pass), finishedAt: new Date().toISOString(),
      outputDir, checks, limitations: [
        'A deterministic external JSONL host, not a real LLM/provider, desktop application, or published SDK.',
        'Controlled peaceful flat fixture and gatherLogs tasks, not broad survival/world competence.',
        'Pause checks explicit safety-on status; synthetic late engine callbacks belong to unit tests.',
      ] };
    fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    write('summary', { pass: summary.pass, checks: checks.length, summaryFile: path.join(outputDir, 'summary.json') });
    if (!summary.pass) process.exitCode = 1;
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
