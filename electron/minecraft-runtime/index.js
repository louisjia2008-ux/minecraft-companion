/* global require, console, process, Buffer, setTimeout */
'use strict';

const path = require('node:path');
const { MAX_LINE_BYTES } = require('./protocol');
// Keep the stdout transport exclusively JSONL, including dependencies' console output.
for (const method of ['log', 'info', 'debug', 'warn', 'error']) {
  console[method] = (...args) => process.stderr.write(args.map((arg) => typeof arg === 'string' ? arg : String(arg)).join(' ') + '\n');
}
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\n');
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
try { runtime = require('./runtime').createRuntime({ dataDir, emit }); } catch (error) {
  emit({ version: 1, type: 'reply', ok: false, error: `Minecraft 运行时启动失败：${error.message}` });
  process.exit(1);
}
let input = Buffer.alloc(0);
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  runtime.close();
  process.stdin.pause();
  // Explicit process shutdown also closes Mineflayer's third-party timers and pending auth sockets.
  process.stdout.write('', () => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
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
    void runtime.handle(message).then(() => { if (message.type === 'shutdown') shutdown(); });
  }
  if (input.length > MAX_LINE_BYTES) { emit({ version: 1, type: 'reply', ok: false, error: 'Minecraft 消息超出大小限制' }); shutdown(); }
});
process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (error) => { console.error(error.message); shutdown(); });
process.on('unhandledRejection', (error) => { console.error(error?.message || error); shutdown(); });
