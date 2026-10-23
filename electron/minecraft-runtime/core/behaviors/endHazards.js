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
      const bucket = bot.inventory.items().find((i) => i.name === 'water_bucket');
      if (!bucket) return;
      armed = { from: e.position.y };
      bot.equip(bucket, 'hand').catch(() => {});
    }
    if (!armed) return;
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

function createEndHazards({ bot, actions = defaultActions, skills = defaultSkills, onEvent } = {}) {
  const removeFallGuard = installFallGuard(bot, onEvent);
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
      return actions.goTo(bot, ctx, goal, { timeoutMs: 6000, arrived: () => !cloudAt() });
    },
  };
  // After a water landing: take the water back, the next fall needs it too.
  const pouredWater = () => {
    if (dimension(bot) !== 'the_end' || !bot.inventory.items().some((i) => i.name === 'bucket')
      || bot.inventory.items().some((i) => i.name === 'water_bucket')) return null;
    const id = bot.registry.blocksByName.water?.id;
    return bot.findBlocks({ matching: id, maxDistance: 4, count: 8 })
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
  return [leaveBreath, retrieveWater];
}

module.exports = { createEndHazards };
