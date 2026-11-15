'use strict';
const { Vec3 } = require('vec3');
const registry = require('minecraft-data')('1.21.8');
const Block = require('prismarine-block')('1.21.8');
const WorldSync = require('prismarine-world/src/worldsync');
const path = require('node:path');
const runtime = process.env.QUARTZ04_RUNTIME || path.resolve(__dirname, '..');
const { createPortalTrip } = require(path.join(runtime, 'core/netherTrip'));
const key = (p) => `${p.x},${p.y},${p.z}`;
function model({ portal = true, count = 450 } = {}) {
  const cells = new Map(); const put = (p, name) => cells.set(key(p), name);
  if (portal) {
    // Saved02 original frame/platform only. Later02 bridge dirt/cobble omitted.
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 0; z++) put(new Vec3(x, 69, z), 'obsidian');
    for (const z of [-2, 1]) for (let y = 69; y <= 73; y++) put(new Vec3(0, y, z), 'obsidian');
    for (const z of [-1, 0]) { put(new Vec3(0, 73, z), 'obsidian'); for (let y = 70; y <= 72; y++) put(new Vec3(0, y, z), 'nether_portal'); }
  } else put(new Vec3(1, 69, 0), 'cobblestone');
  for (let x = 1; x <= 4; x++) for (let z = -6; z <= -5; z++) put(new Vec3(x, 69, z), 'basalt');
  const bag = { count }; const controls = {}; const attempts = []; const events = []; const steps = [];
  const bot = { game: { dimension: 'the_nether' }, registry,
    entity: { position: new Vec3(1.5, 70, 0.5), onGround: true, height: 1.8, width: 0.6 },
    findBlocks: () => [],
    inventory: { items: () => bag.count > 0 ? [{ name: 'cobblestone', count: bag.count }] : [] },
    getControlState: (n) => controls[n] || false, setControlState: (n, v) => { controls[n] = v; },
    blockAt(p) { const q = p.floored(); const name = cells.get(key(q)) || (q.y <= 31 ? 'lava' : 'air');
      const definition = registry.blocksByName[name]; const b = Block.fromStateId(definition.defaultState ?? definition.minStateId, 0); b.position = q;
      if (name === 'nether_portal') b.getProperties = () => ({ axis: 'z' }); return b; },
    equip: async () => {}, lookAt: async () => {},
  };
  bot.world = { getBlock: (p) => bot.blockAt(p) }; bot.world.raycast = WorldSync.prototype.raycast.bind(bot.world);
  bot._placeBlockWithOptions = async (reference, face, options = {}) => {
    const target = reference.position.plus(face); const local = options.delta || new Vec3(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
    const point = reference.position.plus(local); const eye = bot.entity.position.offset(0, 1.62, 0); const delta = point.minus(eye);
    const hit = bot.world.raycast(eye, delta.scaled(1 / delta.norm()), delta.norm() + 0.001);
    attempts.push({ target, reference: reference.position, face, options, nativeHit: hit && { position: hit.position, face: hit.face } });
    const before = bot.blockAt(target); if (before.name !== 'air') throw new Error(`MODELED_not_replaceable:${before.name}`);
    if (bot.failPlacement?.(target)) throw new Error('MODELED_transient_placement_failure');
    put(target, 'cobblestone'); bag.count--;
  };
  bot.placeBlock = async (reference, face) => { await bot.lookAt(reference.position.offset(0.5, 0.5, 0.5)); return bot._placeBlockWithOptions(reference, face); };
  const memory = { netherPortal: portal ? new Vec3(0, 70, 0) : new Vec3(-10, 70, 0) };
  const commands = { recentre: async () => {}, haltBody: () => { controls.forward = false; } };
  const trip = createPortalTrip({ bot, memory, actions: commands, walkOnly: true, protectedBridge: true });
  const ctx = { record: (type, data) => events.push({ type, ...data }) };
  async function acknowledgedStep(_bot, _ctx, target, options) {
    const feet = bot.entity.position.floored(); const dx = target.x - feet.x - 0.5; const dz = target.z - feet.z - 0.5;
    const dir = Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx) || 1, 0, 0) : new Vec3(0, 0, Math.sign(dz) || 1);
    const ahead = feet.plus(dir); const edge = { feet, ahead, dir, phase: 'before_clear' };
    let result = options.validateNext?.(edge); if (result && !result.ok) return result;
    const prepared = await options.prepareNext(edge); if (!prepared.ok) return prepared;
    for (const p of [ahead.offset(0, 1, 0), ahead]) {
      const b = bot.blockAt(p); if (b.boundingBox === 'block') { if (b.name === 'obsidian') return { ok: false, reason: 'bridge_wall' }; put(p, 'air'); }
    }
    result = options.validateNext?.({ ...edge, phase: 'after_clear' }); if (result && !result.ok) return result;
    if (prepared.afterClear) { result = await prepared.afterClear(); if (!result.ok) return result; }
    result = options.validateNext?.({ ...edge, phase: 'before_pulse' }); if (result && !result.ok) return result;
    steps.push({ from: feet, to: ahead, readyBeforeMoving: events.some((e) => e.type === 'bridge_guard_prepared' && e.next === key(ahead)) });
    bot.entity.position = ahead.offset(0.5, 0, 0.5); return { ok: true }; // acknowledged voxel model, not native physics
  }
  return { bot, memory, trip, ctx, put, cells, bag, controls, attempts, events, steps, acknowledgedStep };
}
module.exports = { model, key };
