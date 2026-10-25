/* global require, console, process, Buffer, setTimeout */
'use strict';

const path = require('node:path');
const { MAX_LINE_BYTES } = require('./protocol');
// Keep the stdout transport exclusively JSONL, including dependencies' console output.
for (const method of ['log', 'info', 'debug', 'warn', 'error']) {
  console[method] = (...args) => process.stderr.write(args.map((arg) => typeof arg === 'string' ? arg : String(arg)).join(' ') + '\n');
}
let shutdownDeadline = null;
function armShutdownDeadline() {
  // Keep this referenced: unresolved cleanup alone does not keep Node alive.
  shutdownDeadline ??= setTimeout(() => process.exit(1), 5000);
}
const emit = (message) => {
  // This event is published only after an authorized core close begins. Arm
  // before its receipt: teardown may never resolve (or may reject).
  if (message.type === 'event' && message.event?.type === 'connection'
      && message.event.state === 'disposed') armShutdownDeadline();
  process.stdout.write(JSON.stringify(message) + '\n');
};
const index = process.argv.indexOf('--data-dir');
const dataDir = index >= 0 ? process.argv[index + 1] : '';
if (!dataDir || !path.isAbsolute(dataDir)) {
  emit({ version: 1, type: 'reply', ok: false, error: 'Minecraft 运行时需要独立的绝对 --data-dir 路径' });
  process.exit(1);
}
if (Number(process.versions.node.split('.')[0]) < 22) {
  emit({ version: 1, type: 'reply', ok: false, error: 'Minecraft 陪玩需要 Node.js 22 或更新版本' });
  process.exit(1);
}
let runtime;
try {
  const engineIndex = process.argv.indexOf('--engine');
  const engine = engineIndex < 0 ? 'legacy' : process.argv[engineIndex + 1];
  if (!['legacy', 'core'].includes(engine)) throw new Error('--engine must be legacy or core');
  runtime = engine === 'core'
    ? require('./core-host').createCoreHost({ dataDir, emit })
    : require('./runtime').createRuntime({ dataDir, emit });
} catch (error) {
  emit({ version: 1, type: 'reply', ok: false, error: `Minecraft 运行时启动失败：${error.message}` });
  process.exit(1);
}
let input = Buffer.alloc(0);
let closing = false;
async function shutdown(exitCode = 0) {
  if (closing) return;
  closing = true;
  process.stdin.pause();
  // Join core cancellation/disposal before closing the transport. A stuck
  // third-party teardown is a failed shutdown, never a claimed clean exit.
  armShutdownDeadline();
  let code = exitCode;
  try { await runtime.close(); } catch (error) { console.error(error.message); code = 1; }
  process.stdout.write('', () => process.exit(code));
}
process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  let end;
  while ((end = input.indexOf(10)) !== -1) {
    const line = input.subarray(0, end);
    input = input.subarray(end + 1);
    if (line.length > MAX_LINE_BYTES) { emit({ version: 1, type: 'reply', ok: false, error: 'Minecraft 消息超出大小限制' }); shutdown(); return; }
    if (!line.length) continue;
    let message;
    try { message = JSON.parse(line.toString('utf8')); } catch {
      emit({ version: 1, type: 'reply', ok: false, error: 'Minecraft 消息不是有效 JSON' });
      continue;
    }
    void runtime.handle(message).then((result) => {
      // Legacy returns a boolean; core returns the structured receipt. A
      // rejected shutdown (including an idempotency conflict) does no work.
      if (message?.type === 'shutdown') {
        if (result === true || result?.ok === true) void shutdown();
        else if (runtime.status?.().connection?.state === 'disposed') void shutdown(1);
      }
    });
  }
  if (input.length > MAX_LINE_BYTES) { emit({ version: 1, type: 'reply', ok: false, error: 'Minecraft 消息超出大小限制' }); shutdown(); }
});
process.stdin.on('end', shutdown);
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.on('uncaughtException', (error) => { console.error(error.message); void shutdown(1); });
process.on('unhandledRejection', (error) => { console.error(error?.message || error); void shutdown(1); });
