'use strict';
// Goal: a machine built next to home from nothing, for the director.
//
// A device goal (cobbleGenerator.js, autoSmelter.js) builds from what is in
// the bag and says through needs() what its unbuilt parts still take. This
// goal brings exactly that and then hands the body to the device. Every run()
// does one thing:
//   1. the bag lacks something the device still needs
//        -> gather it into the home chest (gatherMaterials.js), then take it out
//   2. no site yet, far from the next spot to try -> walk there
//   3. otherwise                                  -> the device's own run()
// A death that loses the materials just makes step 1 come back for what is
// missing; whatever is already built stays built and is not asked for again.

const { Vec3 } = require('vec3');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { createGatherMaterialsGoal } = require('./gatherMaterials');
const mining = require('../mining');
const { KNOWLEDGE, countKey } = require('../knowledge');

// Spots tried for a site, around the house centre: 8 headings, 14 blocks out.
const SITE_DISTANCE = 14;
const HEADINGS = 8;

function createDeviceProjectGoal({ bot, name, device, home, skills = defaultSkills, actions = defaultActions,
  kb = KNOWLEDGE, createGather = createGatherMaterialsGoal, carry } = {}) {
  if (!device || typeof device.needs !== 'function') throw new TypeError('device must be a goal with needs()');
  if (!home?.chest || !home.centre) throw new TypeError('home needs chest and centre');
  // The mine outlives each gather: the way back up is its own staircase.
  const memory = { gather: null, mine: null, mineDir: undefined, steps: 0, siteTry: 0, done: false, building: false,
    recovery: false, device: device.memory };

  // Killed down in the mine: monsters have the tunnel now. The next gather
  // starts a fresh one in another direction instead of walking back in.
  const onDeath = () => {
    const mine = memory.mine;
    if (!mine || bot.entity.position.y >= mine.surfaceY - 3) return;
    memory.mine = null;
    memory.mineDir = (mine.dir + 1) % 4;
    if (memory.gather?.memory) Object.assign(memory.gather.memory, { mine: null, mineDir: memory.mineDir });
  };
  bot.on?.('death', onDeath);

  const lacking = (state) => device.needs()
    .map((r) => ({ key: r.key, count: r.count - countKey(r.key, state.inventory, kb) }))
    .filter((r) => r.count > 0);

  function siteSpot() {
    const index = memory.siteTry % HEADINGS;
    const angle = (index * 2 * Math.PI) / HEADINGS + (home.headingOffset || 0);
    return new Vec3(Math.round(home.centre.x + Math.cos(angle) * SITE_DISTANCE), home.centre.y,
      Math.round(home.centre.z + Math.sin(angle) * SITE_DISTANCE));
  }

  // Out of the mine along its tunnel before anything up top.
  async function climbOut(ctx) {
    return memory.mine ? mining.leaveMine(bot, ctx, memory, actions) : null;
  }

  // Release the child before dropping ownership or handing the body to a device.
  async function releaseGather() {
    await memory.gather?.dispose?.();
    memory.gather = null;
  }

  async function bring(ctx, lack) {
    const state = ctx.perceive();
    if (!memory.gather) {
      ctx.record('device_materials', { device: device.name, lack: lack.map((r) => `${r.key}x${r.count}`) });
      memory.gather = createGather({ bot, chest: home.chest, stations: home.stations || {}, requirements: lack, kb, carry });
      if (memory.gather.memory) Object.assign(memory.gather.memory, { mine: memory.mine, mineDir: memory.mineDir });
    }
    if (!memory.gather.isDone(state)) {
      const result = await memory.gather.run(ctx);
      if (memory.gather?.memory) ({ mine: memory.mine, mineDir: memory.mineDir } = memory.gather.memory);
      return result;
    }
    const up = await climbOut(ctx);
    if (up) return up;
    // All of it is in the chest now: take it out to build with.
    const result = await skills.takeItems(bot, ctx, { position: home.chest,
      itemMatch: (n) => lack.some((r) => kb[r.key].match(n)) });
    ctx.record('device_take', { device: device.name, ok: result.ok, reason: result.reason, taken: result.taken });
    await releaseGather();
    return result;
  }

  return {
    name,
    memory,
    async dispose() {
      bot.removeListener?.('death', onDeath);
      try { await memory.gather?.dispose?.(); } finally { await device.dispose?.(); }
    },
    noProgressLimit: 40,
    maxRecoveries: 6,
    recover() {
      if (memory.gather) memory.gather.recover?.();
      else if (device.recover) device.recover();
      else memory.recovery = true;
    },
    // Once seen working it stays done: from far away its blocks are not loaded.
    isDone(state) {
      if (!memory.done && device.isDone(state)) memory.done = true;
      return memory.done;
    },
    // Gathering steps and the device's own progress both count, so the long
    // gathering phase does not run out of budget while nothing is built yet.
    progress: (state) => memory.steps + (memory.gather ? memory.gather.progress(state) : 0) + device.progress(state),
    async run(ctx) {
      if (memory.recovery) {
        memory.recovery = false;
        ctx.record('device_recovery', { device: device.name });
        return actions.unstick(bot, ctx);
      }
      const lack = lacking(ctx.perceive());
      if (lack.length) {
        memory.building = false;
        const gatherBefore = memory.gather;
        const before = gatherBefore ? gatherBefore.progress() : 0;
        const result = await bring(ctx, lack);
        // A finished gather is dropped: keep its steps.
        if (gatherBefore && memory.gather !== gatherBefore) memory.steps += before + (result.ok ? 1 : 0);
        return result;
      }
      // The last crafting step can put every needed part straight in the
      // bag. Keep that completed gathering work when handing the body to
      // construction; dropping its counter would put the device below the
      // brain's historical best for the whole following build.
      const gathered = memory.gather ? memory.gather.progress(ctx.perceive()) : 0;
      await releaseGather();
      memory.steps += gathered;
      if (!memory.building) {
        const up = await climbOut(ctx);
        if (up) return up;
        memory.building = true;
      }
      if (!device.memory.device) {
        const spot = siteSpot();
        if (bot.entity.position.distanceTo(spot) > 4) {
          ctx.record('device_site_walk', { device: device.name, spot: spot.toString(), attempt: memory.siteTry });
          const moved = await actions.goNear(bot, ctx, spot, 2, { timeoutMs: 60000 });
          if (!moved.ok) memory.siteTry += 1;
          return moved;
        }
      }
      const result = await device.run(ctx);
      if (!result.ok && result.reason === 'no_site') memory.siteTry += 1;
      return result;
    },
  };
}

module.exports = { createDeviceProjectGoal, SITE_DISTANCE };
