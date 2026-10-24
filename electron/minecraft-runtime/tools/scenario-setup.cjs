'use strict';
const { setTimeout: delay } = require('node:timers/promises');

function spatial(command) {
  const dimension = /^execute in (\S+) run /.exec(command)?.[1] || 'minecraft:overworld';
  const text = command.replace(/^execute in \S+ run /, '');
  const values = text.split(/\s+/);
  const kind = values.shift();
  if (!['fill', 'setblock', 'summon'].includes(kind)) return null;
  if (kind === 'summon') values.shift();
  const count = kind === 'fill' ? 6 : 3;
  const numbers = values.slice(0, count).map(Number);
  if (!numbers.every(Number.isFinite)) throw new Error(`Non-absolute fixture coordinate: ${command}`);
  const [x, y, z, xx = x, yy = y, zz = z] = numbers;
  return { dimension, kind, from: { x: Math.min(x, xx), y: Math.min(y, yy), z: Math.min(z, zz) },
    to: { x: Math.max(x, xx), y: Math.max(y, yy), z: Math.max(z, zz) },
    block: kind === 'summon' ? null : values[count].replace(/^minecraft:/, '').split('[')[0],
    mode: values[count + 1], replace: values[count + 2]?.replace(/^minecraft:/, '') };
}

function setupChunks(commands) {
  const chunks = new Map();
  for (const command of commands) {
    const box = spatial(command);
    if (!box) continue;
    for (let x = Math.floor(box.from.x / 16); x <= Math.floor(box.to.x / 16); x += 1) {
      for (let z = Math.floor(box.from.z / 16); z <= Math.floor(box.to.z / 16); z += 1) {
        chunks.set(`${box.dimension}:${x}:${z}`, { dimension: box.dimension, x, z });
      }
    }
  }
  return [...chunks.values()];
}

const FAILURE = /not loaded|Unknown or incomplete command|Incorrect argument|Unknown (?:block|item|entity|scoreboard)|Too many blocks|Could not summon|No player was found|No entity was found for|not a valid|Cannot /i;
const SUCCESS = /Successfully filled|No blocks were filled|Changed the block|Could not set the block|Gave \d+|Removed \d+|No items were found|No entit(?:y|ies) (?:was|were) found|Killed |Summoned new|Teleported |Spread \d+|Set (?:the |world |game |.*'s)|difficulty.*(?:set|already)|difficulty has not changed|Gamerule .* (?:set|is)|weather|already (?:in|set|marked)|Marked|force loaded|forceloaded|objective already exists|Created new objective|set .* to|nothing changed|has no effects|doesn't have any effects|Applied effect|Revoked |No advancements were found/i;

function validateResponse(command, response) {
  const kind = command.replace(/^execute in \S+ run /, '').split(' ')[0];
  if (/No entit(?:y|ies) (?:was|were) found/.test(response) && kind !== 'kill') throw new Error(`setup_missing_target: ${command}`);
  if (kind === 'advancement' && /^advancement revoke /.test(command)
    && /Couldn't revoke advancement .* as they don't have it/.test(response)) return response;
  // Vanilla may emit no feedback when the player already has this game mode.
  // runSetup independently reads playerGameType for this one idempotent case.
  if (kind === 'gamemode' && !FAILURE.test(response)) return response;
  if (FAILURE.test(response) || !SUCCESS.test(response)) throw new Error(`setup_command_failed: ${command}: ${response.trim()}`);
  return response;
}

function flatBlock(properties, y) {
  const settings = JSON.parse(properties['generator-settings'] || '{}');
  let base = -64;
  for (const layer of settings.layers || []) {
    if (y >= base && y < base + layer.height) return layer.block.replace(/^minecraft:/, '');
    base += layer.height;
  }
  return y >= base ? 'air' : null;
}

// Compute final expected ore cells, including overlap and replace/keep rules.
// Fresh flat scenarios have a known base; an old contaminated world fails
// readback rather than silently treating a partial fixture as complete.
function expectedOreCells(commands, properties = {}) {
  const boxes = commands.map(spatial).filter(Boolean);
  const candidates = new Map();
  for (const box of boxes.filter((b) => /_ore$/.test(b.block || ''))) {
    for (let x = box.from.x; x <= box.to.x; x += 1) for (let y = box.from.y; y <= box.to.y; y += 1) {
      for (let z = box.from.z; z <= box.to.z; z += 1) candidates.set(`${box.dimension}:${x},${y},${z}`, { dimension: box.dimension, x, y, z });
    }
  }
  const expected = [];
  for (const p of candidates.values()) {
    let block = flatBlock(properties, p.y);
    for (const box of boxes) {
      if (!box.block || box.dimension !== p.dimension || p.x < box.from.x || p.x > box.to.x
        || p.y < box.from.y || p.y > box.to.y || p.z < box.from.z || p.z > box.to.z) continue;
      if (box.mode === 'keep' && block !== 'air') continue;
      if (box.mode === 'replace' && box.replace && block !== box.replace) continue;
      block = box.block;
    }
    if (/_ore$/.test(block || '')) expected.push({ ...p, block });
  }
  return expected;
}

async function runSetup({ server, setup, properties, write = () => {}, wait = delay }) {
  if (typeof server.execute !== 'function') throw new Error('Setup requires checked server execution');
  const chunks = setupChunks(setup.commands);
  const rows = new Map();
  for (const chunk of chunks) {
    const key = `${chunk.dimension}:${chunk.z}`;
    const row = rows.get(key) || { dimension: chunk.dimension, z: chunk.z, xs: [] };
    row.xs.push(chunk.x); rows.set(key, row);
  }
  for (const row of rows.values()) {
    const command = `execute in ${row.dimension} run forceload add ${Math.min(...row.xs) * 16} ${row.z * 16} ${Math.max(...row.xs) * 16} ${row.z * 16}`;
    validateResponse(command, await server.execute(command));
  }
  for (const chunk of chunks) {
    let loaded = false;
    for (let attempt = 0; attempt < 30 && !loaded; attempt += 1) {
      const result = await server.query(`execute in ${chunk.dimension} if loaded ${chunk.x * 16} 64 ${chunk.z * 16}`, /Test (passed|failed)/);
      loaded = result[1] === 'passed';
      if (!loaded) await wait(500);
    }
    if (!loaded) throw new Error(`setup_chunk_not_loaded: ${JSON.stringify(chunk)}`);
  }
  for (const command of setup.prepare || []) {
    const response = validateResponse(command, await server.execute(command));
    write('setup_command', { phase: 'prepare', command, response });
  }
  for (const [index, command] of setup.commands.entries()) {
    const response = validateResponse(command, await server.execute(command));
    if (command.startsWith('gamemode ')) {
      const [, mode, username] = command.split(' ');
      const expected = { survival: 0, creative: 1, adventure: 2, spectator: 3 }[mode];
      const result = await server.query(`data get entity ${username} playerGameType`, /has the following entity data: (\d+)/);
      if (Number(result[1]) !== expected) throw new Error(`setup_gamemode_not_confirmed: ${command}`);
    }
    write('setup_command', { index, command, response });
  }
  const cells = expectedOreCells(setup.commands, properties);
  const distribution = {};
  for (let i = 0; i < cells.length; i += 32) {
    const group = cells.slice(i, i + 32);
    const dimensions = new Set(group.map((p) => p.dimension));
    if (dimensions.size !== 1) throw new Error('Mixed fixture dimensions');
    const command = `execute in ${group[0].dimension} ` + group.map((p) => `if block ${p.x} ${p.y} ${p.z} minecraft:${p.block}`).join(' ');
    const result = await server.query(command, /Test (passed|failed)|(not loaded)/, 15000);
    if (result[1] !== 'passed') throw new Error(`setup_ore_readback_failed: ${JSON.stringify(group)}`);
    for (const p of group) distribution[p.block] = (distribution[p.block] || 0) + 1;
  }
  write('setup_verified', { chunks: chunks.length, oreCells: cells, distribution });
  return { chunks: chunks.length, distribution };
}

module.exports = { spatial, setupChunks, expectedOreCells, validateResponse, runSetup };
