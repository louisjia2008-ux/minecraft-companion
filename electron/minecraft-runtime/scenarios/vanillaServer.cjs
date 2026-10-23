/* global require, module, setTimeout, clearTimeout */
'use strict';
// Starts an isolated vanilla Java server and drives it through its console.
// Console commands only set up scenarios and read back results; during a run
// only the bot changes the world.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { once } = require('node:events');
const { createOutputBuffer } = require('./serverOutput.cjs');

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function installDataPacks(dir, packs) {
  for (const [name, files] of Object.entries(packs || {})) {
    if (!/^[\w-]+$/.test(name)) throw new Error(`Invalid observer data-pack name: ${name}`);
    const root = path.resolve(dir, 'world/datapacks', name);
    for (const [file, contents] of Object.entries(files)) {
      const target = path.resolve(root, file);
      if (!target.startsWith(root + path.sep)) throw new Error(`Invalid observer data-pack path: ${file}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
  }
}

async function startVanillaServer({ java, jar, dir, properties = {}, dataPacks = {}, memory = '2G', log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  installDataPacks(dir, dataPacks);
  const port = await freePort();
  const merged = {
    'server-ip': '127.0.0.1', 'server-port': port, 'online-mode': false, 'enforce-secure-profile': false,
    'enable-rcon': false, 'enable-query': false, 'level-name': 'world', 'max-players': 2,
    'view-distance': 8, 'simulation-distance': 6, 'spawn-protection': 0, 'sync-chunk-writes': false,
    'pause-when-empty-seconds': 0, motd: 'DeskPet scenario', gamemode: 'survival',
    ...properties,
  };
  fs.writeFileSync(path.join(dir, 'server.properties'),
    Object.entries(merged).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');

  const child = spawn(java, [`-Xmx${memory}`, '-jar', jar, 'nogui'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const logStream = fs.createWriteStream(path.join(dir, 'server.log'));
  const output = createOutputBuffer();
  let queryQueue = Promise.resolve();
  const waiters = new Set();
  const onData = (chunk) => {
    const text = chunk.toString();
    logStream.write(chunk);
    output.append(text);
    for (const waiter of [...waiters]) waiter.check();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  let exited = false;
  child.on('exit', (code, signal) => {
    exited = true;
    log('server_exit', { code, signal });
    for (const waiter of [...waiters]) waiter.fail(new Error(`Server exited (${code ?? signal})`));
  });

  /** Waits for `pattern` in output appearing after character offset `from`. */
  function waitFor(pattern, { from = 0, timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      const waiter = {
        check() {
          const match = output.textFrom(from).match(pattern);
          if (match) { finish(); resolve(match); }
        },
        fail(error) { finish(); reject(error); },
      };
      const timer = setTimeout(() => waiter.fail(new Error(`Timed out waiting for ${pattern}`)), timeoutMs);
      function finish() { clearTimeout(timer); waiters.delete(waiter); }
      waiters.add(waiter);
      waiter.check();
    });
  }

  function command(text) {
    if (exited) throw new Error('Server is not running');
    child.stdin.write(`${text}\n`);
  }

  /** Sends a command and returns the first output line matching `pattern`. */
  async function queryNow(text, pattern, timeoutMs = 5000) {
    const from = output.offset();
    command(text);
    return waitFor(pattern, { from, timeoutMs });
  }

  function queued(action) {
    const result = queryQueue.then(action);
    queryQueue = result.catch(() => {});
    return result;
  }

  // Queries with the same reply pattern must never race (e.g. two block tests).
  function query(text, pattern, timeoutMs = 5000) {
    return queued(() => queryNow(text, pattern, timeoutMs));
  }

  function execute(text, timeoutMs = 15000) {
    return queued(async () => {
      const from = output.offset();
      command(text);
      // Console commands are processed in order. This barrier captures the
      // command's own response, including explicit failures, not just exit 0.
      await queryNow('list', /players online/, timeoutMs);
      return output.textFrom(from);
    });
  }

  async function stop() {
    if (exited) return;
    command('stop');
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    await once(child, 'exit').catch(() => {});
    clearTimeout(timer);
    logStream.end();
  }

  await waitFor(/Done \([^)]+\)! For help/, { timeoutMs: 240000 });
  return { port, command, query, execute, waitFor, stop, offset: () => output.offset() };
}

module.exports = { startVanillaServer, installDataPacks };
