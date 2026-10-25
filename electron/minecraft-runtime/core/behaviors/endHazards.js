'use strict';
// End hazards no goal should have to watch for: the dragon's breath and its
// fireballs leave lingering clouds that hurt every half second, and its wings
// throw the bot high into the air. A fall from there is broken with a water
// bucket poured just before landing, and the water is scooped up again.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultActions = require('../actions');
const defaultSkills = require('../skills');
const { BAND } = require('../brain');
const { dimension } = require('../nether');
const { sleep } = require('../confirm');
const end = require('../end');

/**
 * Water-bucket landing. Runs on every physics tick (a behavior tick is far too
 * slow): when falling fast from more than five blocks, hold the bucket and
 * look straight down; pour once the ground is within reach of the look ray.
 */
function installFallGuard(bot, onEvent = () => {}) {
  let armed = null;
  const groundBelow = () => {
    const p = bot.entity.position;
    for (let d = 0; d <= 160; d += 1) {
      const b = bot.blockAt(new Vec3(p.x, Math.floor(p.y) - d - 1, p.z));
      if (!b) return null;
      if (b.boundingBox === 'block') return b;
      if (/water/.test(b.name)) return null; // landing in water already
    }
    return null;
  };
  const onTick = () => {
    const e = bot.entity;
    if (!e?.position || dimension(bot) !== 'the_end') return;
    if (e.onGround || e.isInWater) { armed = null; return; }
    const vy = e.velocity?.y ?? 0;
    const ground = groundBelow();
    if (!ground) return;
    const height = e.position.y - (ground.position.y + 1);
    if (!armed && vy < -0.5 && height > 5) {
      if (!bot.inventory.items().some((i) => i.name === 'water_bucket')) return;
      armed = { from: e.position.y, equipAt: 0 };
    }
    if (!armed) return;
    // A goal still running (bridging, digging) may swap the hand back to a
    // block mid-fall, so keep putting the bucket back until it is poured.
    if (bot.heldItem?.name !== 'water_bucket' && Date.now() - armed.equipAt > 150) {
      const bucket = bot.inventory.items().find((i) => i.name === 'water_bucket');
      if (!bucket) { armed = null; return; }
      armed.equipAt = Date.now();
      bot.equip(bucket, 'hand').catch(() => {});
    }
    bot.look(e.yaw, -Math.PI / 2, true).catch(() => {});
    // The server's look ray reaches 4.5 blocks from the eyes (1.62 up), so
    // pour inside 2.8 blocks; even a fast fall spends a tick in that window.
    if (height <= 2.8 && bot.heldItem?.name === 'water_bucket') {
      // After this tick's position packet: the server checks reach from there.
      queueMicrotask(() => bot.activateItem());
      onEvent({ type: 'water_landing', at: Date.now(), height: Math.round(armed.from - ground.position.y) });
      armed = null;
    }
  };
  bot.on('physicsTick', onTick);
  return () => bot.removeListener('physicsTick', onTick);
}

/**
 * Void brake. The pathfinder cuts corners and overshoots drops; out on a city
 * tower or a bridge that is a step into the void. While walking toward a
 * column with nothing under it, hold sneak: the physics never lets a sneaking
 * body leave an edge, and drops onto real blocks are left alone.
 */
function installVoidBrake(bot, onEvent = () => {}) {
  let braking = false;
  const release = () => {
    if (braking && !bot.companionSneaking) bot.setControlState('sneak', false);
    braking = false;
  };
  const onTick = () => {
    const e = bot.entity;
    if (!e?.position || dimension(bot) !== 'the_end' || !e.onGround || e.isInWater) { release(); return; }
    const v = e.velocity || { x: 0, z: 0 };
    const speed = Math.hypot(v.x, v.z);
    const moving = speed > 0.01 || bot.controlState.forward || bot.controlState.back || bot.controlState.left || bot.controlState.right;
    if (!moving) { release(); return; }
    let dx = v.x;
    let dz = v.z;
    if (speed <= 0.01) { const d = end.direction(e.yaw, 0); dx = d.x; dz = d.z; }
    const n = Math.hypot(dx, dz) || 1;
    const y = e.position.y;
    const ahead = [0.4, 0.8].some((r) => end.overVoid(bot, Math.floor(e.position.x + (dx / n) * r), y, Math.floor(e.position.z + (dz / n) * r)));
    if (ahead) {
      if (!braking) onEvent({ type: 'void_brake', at: Date.now(), x: Math.floor(e.position.x), y: Math.floor(y), z: Math.floor(e.position.z) });
      braking = true;
      bot.setControlState('sneak', true);
    } else release();
  };
  bot.on('physicsTick', onTick);
  return () => { bot.removeListener('physicsTick', onTick); release(); };
}

/**
 * An enderman turns hostile when looked in the eyes. A carved pumpkin on the
 * head stops that; without one (lost on a death, on the way back for it) keep
 * the eyes on the ground while any enderman is about. Walking only needs yaw.
 */
function installGazeGuard(bot) {
  const onTick = () => {
    const e = bot.entity;
    if (!e?.position || dimension(bot) !== 'the_end') return;
    if (bot.inventory.slots[5]?.name === 'carved_pumpkin') return;
    if (e.pitch <= -0.6) return;
    const here = e.position;
    const near = Object.values(bot.entities).some((m) => m.name === 'enderman' && m.position && m.position.distanceTo(here) <= 64);
    if (near) bot.look(e.yaw, -0.6, true).catch(() => {});
  };
  bot.on('physicsTick', onTick);
  return () => bot.removeListener('physicsTick', onTick);
}

function createEndHazards({ bot, actions = defaultActions, skills = defaultSkills, onEvent } = {}) {
  const removeGuards = [installFallGuard(bot, onEvent), installVoidBrake(bot, onEvent), installGazeGuard(bot)];
  const removeFallGuard = () => removeGuards.forEach((f) => f());
  const radiusIndex = bot.registry?.entitiesByName?.area_effect_cloud?.metadataKeys?.indexOf('radius') ?? -1;
  const cloudAt = () => {
    if (dimension(bot) !== 'the_end' || !bot.entity?.position) return null;
    const here = bot.entity.position;
    return Object.values(bot.entities).find((e) => {
      if (e.name !== 'area_effect_cloud' || !e.position) return false;
      const r = Number(e.metadata?.[radiusIndex]) || 3;
      return Math.hypot(e.position.x - here.x, e.position.z - here.z) <= r + 0.4 && Math.abs(e.position.y - here.y) <= 2.5;
    }) || null;
  };
  const leaveBreath = {
    name: 'leave_breath',
    band: BAND.ESCAPE,
    want: () => (cloudAt() ? 1 : 0),
    async run(ctx) {
      const cloud = cloudAt();
      if (!cloud) return { ok: true };
      const r = Number(cloud.metadata?.[radiusIndex]) || 3;
      ctx.record('leave_breath', { radius: Math.round(r * 10) / 10 });
      const goal = new goals.GoalInvert(new goals.GoalNearXZ(cloud.position.x, cloud.position.z, r + 3));
      const walked = await actions.goTo(bot, ctx, goal, { timeoutMs: 6000, arrived: () => !cloudAt() });
      if (walked.ok || !cloudAt()) return { ok: true };
      // No path out (the portal's bedrock rim, a pit): straight away from
      // its middle, jumping whatever is in the way. Every half second in it hurts.
      const here = bot.entity.position;
      const dx = here.x - cloud.position.x;
      const dz = here.z - cloud.position.z;
      const yaw = Math.hypot(dx, dz) > 0.2 ? Math.atan2(-dx, -dz) : bot.entity.yaw;
      ctx.record('leave_breath_direct', { reason: walked.reason || null });
      try {
        await bot.look(yaw, 0, true);
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        await end.waitUntil(() => !cloudAt(), { timeoutMs: 3000, signal: ctx.signal });
      } finally {
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
      }
      return cloudAt() ? walked : { ok: true };
    },
  };
  // After a water landing: take the water back, the next fall needs it too.
  const pouredWater = () => {
    if (dimension(bot) !== 'the_end' || !bot.inventory.items().some((i) => i.name === 'bucket')
      || bot.inventory.items().some((i) => i.name === 'water_bucket')) return null;
    const id = bot.registry.blocksByName.water?.id;
    return bot.findBlocks({ matching: id, maxDistance: 12, count: 8 })
      .map((p) => bot.blockAt(p)).find((b) => skills.isFluidSource(b, 'water')) || null;
  };
  const retrieveWater = {
    name: 'retrieve_water',
    band: BAND.MAINTENANCE,
    want: () => (pouredWater() ? 0.9 : 0),
    dispose: removeFallGuard,
    async run(ctx) {
      const water = pouredWater();
      if (!water) return { ok: true };
      return skills.scoopLiquid(bot, ctx, water.position, 'water');
    },
  };
  // Shulkers on city walls fire homing bullets. A bullet is swatted with the
  // sword when it gets close; the shulker itself takes arrows only while its
  // shell is open, which it is whenever it is firing.
  const peekIndex = bot.registry?.entitiesByName?.shulker?.metadataKeys?.indexOf('peek') ?? -1;
  const giveUp = new Map(); // shulker id -> until
  const hasBow = () => bot.inventory.items().some((i) => i.name === 'bow')
    && bot.inventory.items().some((i) => i.name === 'arrow' || i.name === 'spectral_arrow');
  const near = (name, range) => {
    const here = bot.entity?.position;
    if (!here) return [];
    return Object.values(bot.entities).filter((e) => e.name === name && e.position && e.position.distanceTo(here) <= range)
      .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here));
  };
  const isOpen = (e) => Number(bot.entities[e.id]?.metadata?.[peekIndex]) > 0;
  const shulkerTarget = ({ airborne = false } = {}) => {
    if (!hasBow() || (!airborne && !bot.entity?.onGround)) return null;
    const from = bot.entity.position.offset(0, 1.52, 0);
    return near('shulker', 20).find((e) => {
      if ((giveUp.get(e.id) || 0) > Date.now()) return false;
      const at = e.position.offset(0, 0.5, 0);
      const shot = end.aim(from, at, end.ARROW);
      return shot && end.clearFlight(bot, from, shot, at, end.ARROW, { radius: 0.3 });
    }) || null;
  };
  const fightShulker = {
    name: 'fight_shulker',
    band: BAND.DEFENSE,
    want: () => {
      if (dimension(bot) !== 'the_end') return 0;
      if (near('shulker_bullet', 4).length) return 1;
      return shulkerTarget() ? 0.9 : 0;
    },
    async run(ctx) {
      const bullet = near('shulker_bullet', 4)[0];
      if (bullet) {
        const sword = bot.inventory.items().find((i) => /_sword$/.test(i.name));
        if (sword && bot.heldItem?.name !== sword.name) await bot.equip(sword, 'hand').catch(() => {});
        await bot.lookAt(bullet.position, true).catch(() => {});
        bot.attack(bullet);
        ctx.record('bullet_swatted');
        await sleep(250, ctx.signal);
        return { ok: true };
      }
      const shulker = shulkerTarget();
      if (!shulker) return { ok: true };
      ctx.record('shulker_target', { at: `${Math.floor(shulker.position.x)},${Math.floor(shulker.position.y)},${Math.floor(shulker.position.z)}` });
      const open = () => isOpen(shulker);
      for (let i = 0; i < 6 && bot.entities[shulker.id]; i += 1) {
        if (near('shulker_bullet', 4).length) return { ok: true }; // swat first
        if (!open()) await end.waitUntil(open, { timeoutMs: 3000, signal: ctx.signal });
        const shot = await end.shootArrow(bot, ctx, shulker.position.offset(0, 0.5, 0), { drawMs: 1000 });
        if (!shot.ok) break;
        await sleep(300, ctx.signal);
      }
      if (!bot.entities[shulker.id]) {
        ctx.record('shulker_killed');
        return { ok: true };
      }
      giveUp.set(shulker.id, Date.now() + 60000);
      return { ok: false, reason: 'shulker_survived' };
    },
  };
  // A shulker bullet lifts the bot for seconds. A goal that keeps bridging or
  // walking meanwhile only swaps the bucket out of hand, so hold still until
  // the effect wears off and the fall guard has the landing.
  const levitationId = bot.registry?.effectsByName?.Levitation?.id;
  const levitating = () => levitationId != null && Boolean(bot.entity?.effects?.[levitationId]);
  const rideLevitation = {
    name: 'ride_levitation',
    band: BAND.ESCAPE,
    want: () => (dimension(bot) === 'the_end' && levitating() ? 1 : 0),
    async run(ctx) {
      ctx.record('levitation', { y: Math.round(bot.entity.position.y) });
      bot.pathfinder?.setGoal?.(null);
      bot.clearControlStates();
      const bucket = bot.inventory.items().find((i) => i.name === 'water_bucket');
      if (bucket) await bot.equip(bucket, 'hand').catch(() => {});
      // Up there the bullets keep coming: swat them, and shoot the shulker
      // while it is open. The bucket goes back in hand once it is falling.
      while (levitating() && !ctx.signal?.aborted) {
        const bullet = near('shulker_bullet', 4)[0];
        if (bullet) {
          await bot.lookAt(bullet.position, true).catch(() => {});
          bot.attack(bullet);
          ctx.record('bullet_swatted', { airborne: true });
          await sleep(150, ctx.signal);
          continue;
        }
        const shulker = shulkerTarget({ airborne: true });
        if (shulker && isOpen(shulker)) {
          await end.shootArrow(bot, ctx, shulker.position.offset(0, 0.5, 0), { drawMs: 1000 });
          continue;
        }
        await sleep(150, ctx.signal);
      }
      // Ride the fall down too: the guard pours on the way.
      const until = Date.now() + 8000;
      while (!bot.entity.onGround && !bot.entity.isInWater && Date.now() < until && !ctx.signal?.aborted) {
        await sleep(100, ctx.signal).catch(() => {});
      }
      return { ok: true };
    },
  };
  return [leaveBreath, retrieveWater, rideLevitation, fightShulker];
}

module.exports = { createEndHazards };
