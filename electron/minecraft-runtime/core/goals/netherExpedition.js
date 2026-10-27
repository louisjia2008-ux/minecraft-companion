'use strict';
// Goal: an expedition to the nether's structures, then home.
//
//   - find a fortress; kill blazes for blaze rods and wither skeletons until
//     one drops its skull (a looting sword makes that likelier)
//   - find a bastion; barter gold ingots with the piglins around it, wearing
//     a gold helmet so they stay calm
//   - come back through the arrival portal with everything
//
// Nothing about the structures is known up front: the bot scans the loaded
// chunks for their blocks and walks out in long legs until it sees them.
// Every run() decides from where the bot is and what it holds, like the
// quartz goal: a death in the nether sends it back through the portal.

const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const nether = require('../nether');
const end = require('../end');
const structures = require('../netherStructures');
const { createPortalTrip } = require('../netherTrip');
const { createBlacklist, posKey } = require('../blacklist');
const { waitUntil, runCancellable, sleep } = require('../confirm');

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const isAbort = (error) => error?.code === 'aborted';
const ARMOR = [['head', /_helmet$/], ['torso', /_chestplate$/], ['legs', /_leggings$/], ['feet', /_boots$/]];
const ARMOR_SLOT = { head: 5, torso: 6, legs: 7, feet: 8 };
const ARMOR_RANK = ['leather', 'golden', 'chainmail', 'iron', 'diamond', 'netherite'];
const SCAN_EVERY_MS = 10000;
// Below this the fortress is left to its mobs until health is back.
const HUNT_HEALTH = 15;
// How far above or below the bot a wither skeleton is still hunted.
const HUNT_DY_WITHER = 12;

function createNetherExpeditionGoal({ bot, blazeRods = 6, witherSkulls = 1, trades = 10, roam = 400, skullTries = 0,
  skills = defaultSkills, actions = defaultActions } = {}) {
  for (const [name, value] of Object.entries({ blazeRods, witherSkulls, trades, skullTries })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  }
  const blacklist = createBlacklist({ ttlMs: 120000 });
  const memory = {
    explore: {}, fortress: null, bastion: null, spawner: null, visited: { fortress: false, bastion: false },
    trades: 0, barter: {}, kills: {}, witherKills: 0, scannedAt: 0, scannedFrom: null, waitSince: 0, towerFails: {},
  };
  // A skull is luck (5.5% a kill with Looting III). With skullTries set, that
  // many wither skeletons killed without one ends the hunt for it.
  bot.on?.('entityDead', (e) => {
    if (e?.name === 'wither_skeleton' && e.position && bot.entity?.position && e.position.distanceTo(bot.entity.position) <= 6) {
      memory.witherKills += 1;
    }
  });
  // Where the bot has stood in the nether, every six blocks: the way home.
  // A straight walk to the portal bridged the lava sea it had walked round
  // on the way out, and ran out of blocks half way across.
  memory.crumbs = [];
  const dropCrumb = () => {
    const e = bot.entity;
    if (!e?.position || !e.onGround || e.isInLava || !nether.inNether(bot)) return;
    const last = memory.crumbs[memory.crumbs.length - 1];
    if (last && last.distanceTo(e.position) < 6) return;
    memory.crumbs.push(e.position.floored());
    if (memory.crumbs.length > 4000) memory.crumbs.shift();
  };
  bot.on?.('move', dropCrumb);
  const trip = createPortalTrip({ bot, memory, actions });

  const rods = (state) => state.inventory.blaze_rod || 0;
  const skulls = (state) => state.inventory.wither_skeleton_skull || 0;
  const gold = (state) => state.inventory.gold_ingot || 0;
  const skullsWanted = (state) => skulls(state) < witherSkulls && !(skullTries > 0 && memory.witherKills >= skullTries);
  const fortressWork = (state) => rods(state) < blazeRods || skullsWanted(state);
  const tradeWork = () => memory.trades < trades;
  const allDone = (state) => !fortressWork(state) && !tradeWork();

  // ---- equipment ------------------------------------------------------------

  /** Wears the best armour it carries, but always a gold helmet when it has one (piglins). */
  async function wearArmour(ctx) {
    for (const [slot, pattern] of ARMOR) {
      const worn = bot.inventory.slots[ARMOR_SLOT[slot]];
      const rank = (name) => (slot === 'head' && name.startsWith('golden_') ? 99 : ARMOR_RANK.indexOf(name.split('_')[0]));
      const best = bot.inventory.items().filter((i) => pattern.test(i.name)).sort((a, b) => rank(b.name) - rank(a.name))[0];
      if (!best || (worn && rank(worn.name) >= rank(best.name))) continue;
      try {
        await bot.equip(best, slot);
        ctx.record('equip', { item: best.name, slot });
      } catch (error) {
        if (isAbort(error)) throw error;
      }
    }
  }

  const onFire = () => (Number(bot.entity?.metadata?.[0]) & 1) === 1;

  /** Drinks fire resistance before a blaze fight or when burning, if it has none active. */
  async function fireProof(ctx, { danger }) {
    if (!danger && !onFire()) return { ok: true, skipped: true };
    if (structures.hasEffect(bot, 'FireResistance')) return { ok: true, skipped: true };
    const potion = bot.inventory.items().find(structures.isFireResistancePotion);
    if (!potion) {
      const other = bot.inventory.items().find((i) => i.name === 'potion');
      if (other && !memory.unknownPotion) {
        memory.unknownPotion = true;
        ctx.record('potion_unknown', { components: JSON.stringify(other.components || null).slice(0, 300) });
      }
      return { ok: true, skipped: true };
    }
    try {
      await bot.equip(potion, 'hand');
      await runCancellable(() => bot.consume(), { signal: ctx.signal, timeoutMs: 5000, timeoutCode: 'drink_timeout',
        cancel: () => bot.deactivateItem() });
    } catch (error) {
      if (isAbort(error)) throw error;
    }
    const active = await waitUntil(() => structures.hasEffect(bot, 'FireResistance'), { timeoutMs: 2000, signal: ctx.signal });
    ctx.record('drink', { potion: 'fire_resistance', active });
    return active ? { ok: true } : fail('drink_unconfirmed');
  }

  // ---- finding structures ---------------------------------------------------

  function scan(ctx, force = false) {
    const here = bot.entity.position;
    const moved = memory.scannedFrom ? here.distanceTo(memory.scannedFrom) : Infinity;
    if (!force && Date.now() - memory.scannedAt < SCAN_EVERY_MS && moved < 24) return;
    memory.scannedAt = Date.now();
    memory.scannedFrom = here.clone();
    for (const kind of ['fortress', 'bastion']) {
      if (memory[kind]) continue;
      const found = structures.findStructure(bot, kind);
      if (!found) continue;
      memory[kind] = found.position;
      ctx.record('structure_found', { kind, position: posKey(found.position), blocks: found.blocks,
        distance: Math.round(found.position.distanceTo(here)) });
    }
  }

  /**
   * Visits lookout points in rings around the arrival portal: 8 directions per
   * ring, rings 80 blocks apart, each ring turned half a step. With 128 blocks
   * of loaded chunks around the bot, the first ring alone sees ~200 blocks out.
   * A point it cannot get nearer to is skipped.
   */
  function lookout(index, home) {
    const ring = Math.floor(index / 8);
    const angle = (index % 8) * (Math.PI / 4) + ring * (Math.PI / 8);
    const r = Math.min(roam, 80 * (ring + 1));
    return { x: Math.round(home.x + Math.cos(angle) * r), z: Math.round(home.z + Math.sin(angle) * r) };
  }

  /**
   * Points on a circle around a structure the bot cannot reach from where it
   * stands: each next one about 135 degrees on, 32 or 48 blocks out, so that
   * it tries the far sides early.
   */
  function around(index, centre) {
    const angle = index * (Math.PI * 3 / 4);
    const r = 32 + 16 * (Math.floor(index / 8) % 2);
    return { x: Math.round(centre.x + Math.cos(angle) * r), z: Math.round(centre.z + Math.sin(angle) * r) };
  }

  /**
   * Walks out to look for structures. `centre`: a structure already seen but
   * not reached; the bot then circles it instead of going back to the lookouts
   * around the portal, which can be 200 blocks the wrong way.
   */
  async function explore(ctx, centre = null) {
    if (centre && memory.circle?.key !== posKey(centre)) memory.circle = { key: posKey(centre) };
    const m = centre ? memory.circle : memory.explore;
    const home = memory.netherPortal || bot.entity.position;
    m.index = m.index || 0;
    m.misses = m.misses || 0;
    // Done with the bastion: start with the lookouts away from its brutes.
    if (!centre && memory.bastion && !tradeWork() && !m.leftBastion) {
      m.leftBastion = true;
      const away = Math.atan2(home.z - memory.bastion.z, home.x - memory.bastion.x);
      m.index = Math.round(((away % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (Math.PI / 4)) % 8;
    }
    const target = centre ? around(m.index, centre) : lookout(m.index, home);
    ctx.record('explore', { lookout: m.index, x: target.x, z: target.z, ...(centre ? { around: posKey(centre) } : {}),
      want: [!memory.fortress && 'fortress', !memory.bastion && 'bastion'].filter(Boolean) });
    const walk = () => actions.goTo(bot, ctx, new goals.GoalNearXZ(target.x, target.z, 8), { timeoutMs: 60000, arrived: () => true });
    // A walk that went nowhere last time (an island in the lava sea, a ledge
    // under a fortress): bridge and tower this time.
    const bridge = centre || m.stuck > 0 || boxedIn();
    if (bridge) await stockScaffolding(ctx, 16);
    const start = bot.entity.position.clone();
    const result = await (bridge ? withScaffolding(walk) : walk());
    const moved = bot.entity.position.distanceTo(start);
    const left = Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z);
    scan(ctx, true);
    // Reached it, or stuck short of it twice: on to the next lookout.
    m.misses = moved < 10 ? m.misses + 1 : 0;
    m.stuck = moved < 10 ? (m.stuck || 0) + 1 : 0;
    if (left <= 16 || m.misses >= 2) {
      m.index += 1;
      m.misses = 0;
    }
    return moved >= 10 ? { ok: true, moved: Math.round(moved) } : fail(result.ok ? 'explore_blocked' : result.reason);
  }

  /** Walks to a reachable cell of the structure's floor near `around`; far ones in legs. */
  /**
   * Fortress bridges stand over lava, out of reach of any walk: while heading
   * for a structure the bot may pillar up and bridge with cobblestone or
   * netherrack. Placing is made costly so it still walks where it can.
   */
  // Where the bot stood after its last failed nether steps: eight failures
  // in a row, all within a few blocks of each other, mean nothing it tries
  // gets it anywhere. Any step that works (waiting by a spawner too) clears it.
  const trail = [];
  function noteStep(result) {
    if (result?.ok) {
      trail.length = 0;
      return;
    }
    trail.push(bot.entity.position.clone());
    if (trail.length > 8) trail.shift();
  }
  const boxedIn = () => trail.length >= 8 && trail.every((p) => p.distanceTo(trail[0]) <= 4);

  async function withScaffolding(run, { cobble: anyCobble = false } = {}) {
    const m = bot.pathfinder?.movements;
    if (!m) return run();
    const saved = { towers: m.allow1by1towers, blocks: m.scafoldingBlocks, placeCost: m.placeCost };
    m.allow1by1towers = true;
    m.scafoldingBlocks = nether.netherScaffolding(bot);
    // Boxed in (a pillar in a lava pit) with no netherrack left: build with
    // cobblestone too, all but the last stack-quarter kept for lava steps.
    const cobble = bot.registry.itemsByName?.cobblestone?.id;
    const spare = bot.inventory.items().filter((i) => i.name === 'cobblestone').reduce((n, i) => n + i.count, 0) > 16;
    if ((anyCobble || boxedIn()) && spare && Number.isInteger(cobble)) m.scafoldingBlocks = [...m.scafoldingBlocks, cobble];
    m.placeCost = 4;
    try {
      return await run();
    } finally {
      m.allow1by1towers = saved.towers;
      m.scafoldingBlocks = saved.blocks;
      m.placeCost = saved.placeCost;
    }
  }

  // Netherrack, or whatever rubble a basalt delta or a soul sand valley has;
  // never the fortress's own bricks, which may be the deck underfoot.
  // Fortress bricks too: inside a fortress there was no netherrack in reach,
  // stocking came back empty and a bot that fell in the lava had nothing to
  // step out with. Only walls at or above its feet, never the deck it is on.
  const DIGGABLE_RUBBLE = (n) => ['netherrack', 'blackstone', 'basalt', 'soul_soil', 'soul_sand', 'nether_bricks'].includes(n);
  // Nor anything touching lava, nor a block at its feet over a drop: a run
  // below a fortress dug the pillar bricks beside the lava sea one by one,
  // walked into the gap and fell in twice, and a quarter of its hour went on
  // climbing back up.
  const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const unsafeDig = (p) => {
    if (bot.blockAt(p)?.name === 'nether_bricks' && p.y < Math.floor(bot.entity.position.y)) return true;
    if (SIDES.some(([x, y, z]) => /^lava$/.test(bot.blockAt(p.offset(x, y, z))?.name || ''))) return true;
    const below = bot.blockAt(p.offset(0, -1, 0));
    return p.y <= Math.floor(bot.entity.position.y) && (!below || below.boundingBox === 'empty');
  };
  // A climb to a fortress deck or a spawner can take twenty blocks of tower.
  const SCAFFOLD_LOW = 8;
  const SCAFFOLD_STOCK = 24;
  // Three stacks: the most a walk home is stocked for.
  const HOME_STOCK = 192;

  /**
   * Too few blocks to tower `climb` blocks up: dig some netherrack nearby
   * first. A bridge deck can stand 35 blocks above the lava shore.
   */
  async function stockScaffolding(ctx, climb = 0, cap = 64) {
    const need = Math.min(cap, Math.max(SCAFFOLD_LOW, Math.ceil(climb) + 8));
    if (nether.scaffoldCount(bot) >= need || bot.entity?.isInLava) return;
    const stock = Math.max(need, SCAFFOLD_STOCK);
    ctx.record('stock_scaffolding', { have: nether.scaffoldCount(bot), want: stock });
    // Nothing safe to dig close by (a fortress at the lava sea's edge, all
    // bricks and a basalt crust on the lava): look further off.
    for (const radius of [16, 48]) {
      for (let misses = 0, i = 0; i < stock && misses < 3 && nether.scaffoldCount(bot) < stock; i += 1) {
        const got = await skills.gatherOne(bot, ctx, { blocks: DIGGABLE_RUBBLE, dropMatch: (n) => nether.SCAFFOLD.includes(n),
          blacklist, radius, exclude: unsafeDig });
        if (!got.ok) misses += 1;
      }
      if (nether.scaffoldCount(bot) >= need) return;
    }
  }

  /**
   * One leg back along the crumbs: to the earliest-dropped one within 20
   * blocks, which skips the loops the bot walked on the way. Null when there
   * is none to take, or the last three legs went nowhere.
   */
  async function retraceHome(ctx) {
    if ((memory.retraceOffUntil || 0) > Date.now()) return null;
    const here = bot.entity.position;
    const crumbs = memory.crumbs;
    const open = (p) => !blacklist.has(`crumb:${posKey(p)}`);
    // Only ever back along the trail: from a crumb whose earlier ones were
    // all out of reach, the nearest in reach was a later one, and a run that
    // had everything went back and forth between two crumbs until it failed.
    let reached = crumbs[memory.crumbAt]?.distanceTo(here) <= 12 ? memory.crumbAt : -1;
    if (reached < 0) {
      reached = crumbs.length;
      let best = Infinity;
      crumbs.forEach((p, i) => { if (p.distanceTo(here) < best) { best = p.distanceTo(here); reached = i; } });
    }
    // On about the same level only: back past a fortress, the earliest crumb
    // in reach was one from the first walk in, twenty blocks up on the hill
    // over the lava sea, and the climb to it ended in the lava.
    const level = (p) => Math.abs(p.y - here.y) <= 6;
    let index = crumbs.findIndex((p, i) => i < reached && p.distanceTo(here) <= 20 && p.distanceTo(here) >= 4 && level(p) && open(p));
    // The one before, further off (a drop the bot came down): try it anyway.
    if (index < 0 && reached > 0 && crumbs[reached - 1].distanceTo(here) <= 40 && open(crumbs[reached - 1])) index = reached - 1;
    if (index < 0) return null;
    const crumb = crumbs[index];
    ctx.record('retrace', { to: posKey(crumb), index, of: crumbs.length });
    const start = here.clone();
    const result = await withScaffolding(() => actions.goNear(bot, ctx, crumb, 2, { timeoutMs: 45000 }), { cobble: true });
    if (bot.entity.position.distanceTo(start) >= 3) {
      memory.retraceMisses = 0;
      memory.crumbAt = index;
      return result.ok ? result : { ok: true, moved: true };
    }
    blacklist.add(`crumb:${posKey(crumb)}`, result.reason || 'not_moved');
    memory.retraceMisses = (memory.retraceMisses || 0) + 1;
    if (memory.retraceMisses >= 3) {
      memory.retraceMisses = 0;
      memory.retraceOffUntil = Date.now() + 120000;
    }
    return result;
  }

  async function stockForTravel(ctx) {
    if (nether.scaffoldCount(bot) >= 64 || Date.now() - (memory.travelStockedAt || 0) < 60000) return;
    memory.travelStockedAt = Date.now();
    await stockScaffolding(ctx, 56);
  }

  async function approach(ctx, kind, cells) {
    const here = bot.entity.position;
    const target = cells.find((p) => !blacklist.has(`${kind}:${posKey(p)}`));
    if (!target) return fail(`${kind}_unreachable`);
    ctx.record('approach', { kind, target: posKey(target), distance: Math.round(target.distanceTo(here)) });
    const stand = target.offset(0, 1, 0);
    if (stand.y - here.y > 3) await stockScaffolding(ctx, stand.y - here.y);
    const result = await withScaffolding(() => actions.goNear(bot, ctx, stand, 2, { timeoutMs: 120000 }));
    if (!result.ok && bot.entity.position.distanceTo(here) < 6) blacklist.add(`${kind}:${posKey(target)}`, result.reason);
    return result;
  }

  // A deck this far above the bot is towered up to instead of left to the
  // pathfinder, which spent whole runs planning 30-block climbs and giving up.
  const CLIMB = 6;
  // Cobblestone last: it is what lava steps fall back on.
  const RUBBLE = /^(netherrack|nether_bricks|blackstone|basalt|polished_basalt|smooth_basalt|soul_soil|soul_sand)$/;
  const TOWER = /^(netherrack|nether_bricks|blackstone|basalt|polished_basalt|smooth_basalt|soul_soil|soul_sand|cobblestone)$/;
  const towerBlocks = (pattern = TOWER) => bot.inventory.items().filter((i) => pattern.test(i.name)).reduce((n, i) => n + i.count, 0);

  /**
   * Walks to open ground beside a deck edge, pillars straight up and steps
   * onto the deck. Any edge of the fortress will do: under the nearest deck
   * there is often only the lava sea. Walking uphill is what the pathfinder
   * gets wrong, so a spot costs its distance plus three per block it stands
   * above the bot, plus the climb.
   */
  async function climbTo(ctx, { minClimb = 0 } = {}) {
    const here = bot.entity.position;
    const feet = here.floored();
    const floor = deckFloor(memory.fortress, 96, 4096);
    const flat = (s) => Math.hypot(s.stand.x - here.x, s.stand.z - here.z);
    const cost = (s) => flat(s) + 3 * Math.max(0, s.stand.y - here.y) + (s.top - s.stand.y);
    const spots = structures.towerSpots(bot, floor, here)
      .filter((s) => !bySea(s.stand.offset(0, -1, 0)) && !blacklist.has(`tower:${posKey(s.stand)}`) && !((memory.towerFails[`tower:${posKey(s.stand)}`]?.until || 0) > Date.now()) && flat(s) <= 64 && s.top - s.stand.y <= 48
        && s.top - here.y >= minClimb)
      .sort((a, b) => cost(a) - cost(b));
    // Knocked off half way, or interrupted by a fight on the way up: the same column again.
    const inColumn = (s) => feet.x === s.stand.x && feet.z === s.stand.z && feet.y >= s.stand.y && feet.y <= s.top;
    const spot = spots.find(inColumn) || spots[0];
    if (!spot) {
      if (Date.now() - (memory.noTowerAt || 0) > 60000) {
        memory.noTowerAt = Date.now();
        ctx.record('no_tower_spot', { floor: floor.length });
      }
      return fail('no_tower_spot');
    }
    const key = `tower:${posKey(spot.stand)}`;
    // A spot that failed before fails the same way again: one run went back
    // to the same 27-block column eight times in forty minutes. Twice, and
    // it is left alone for ten minutes.
    const giveUp = (reason, result) => {
      const fails = (memory.towerFails[key]?.fails || 0) + 1;
      memory.towerFails[key] = { fails, until: fails >= 2 ? Date.now() + 600000 : 0 };
      blacklist.add(key, reason);
      ctx.record('tower_failed', { stand: posKey(spot.stand), reason, fails });
      return result;
    };
    const climb = spot.top - Math.max(spot.stand.y, inColumn(spot) ? feet.y : spot.stand.y);
    ctx.record('tower', { stand: posKey(spot.stand), deck: posKey(spot.deck), climb });
    if (!inColumn(spot)) {
      await stockScaffolding(ctx, climb);
      // A few left over at the top: what it steps out of lava with.
      if (towerBlocks() < climb + 4) return giveUp('few_blocks', fail('tower_blocks'));
      const walk = await withScaffolding(() => actions.goTo(bot, ctx, new goals.GoalBlock(spot.stand.x, spot.stand.y, spot.stand.z),
        { timeoutMs: 60000 }));
      const at = bot.entity.position.floored();
      if (at.x !== spot.stand.x || at.z !== spot.stand.z || Math.abs(at.y - spot.stand.y) > 1) {
        return giveUp(walk.reason || 'not_arrived', walk.ok ? fail('tower_not_reached') : walk);
      }
    }
    actions.haltBody(bot);
    await end.pillarUp(bot, ctx, spot.top, { maxSteps: climb + 6, blocks: towerBlocks(RUBBLE) >= climb ? RUBBLE : TOWER,
      stop: () => Boolean(bot.entity?.isInLava) || bot.health < 8 });
    if (bot.entity.position.y < spot.top - 0.5) return giveUp('pillar_short', fail('tower_short'));
    const step = await actions.goTo(bot, ctx, new goals.GoalBlock(spot.deck.x, spot.deck.y + 1, spot.deck.z), { timeoutMs: 10000 });
    const onDeck = inFortress();
    ctx.record('towered', { onDeck, y: Math.round(bot.entity.position.y) });
    if (onDeck) return { ok: true };
    return giveUp('off_deck', step.ok ? fail('tower_off_deck') : step);
  }

  // ---- fortress -------------------------------------------------------------

  // The pillar feet standing in the lava sea are fortress bricks with open
  // air over them too, but no deck: one run spent an hour and a half walking
  // between them and the decks, fell in fifty times and ran out of fire
  // resistance. Floor within reach of lava below is not walked to.
  const seaSide = new Map();
  const bySea = (p) => {
    const key = posKey(p);
    if (!seaSide.has(key)) {
      let lava = false;
      for (let dy = 0; dy >= -4 && !lava; dy -= 1) {
        for (let dx = -2; dx <= 2 && !lava; dx += 1) {
          for (let dz = -2; dz <= 2 && !lava; dz += 1) lava = /^lava$/.test(bot.blockAt(p.offset(dx, dy, dz))?.name || '');
        }
      }
      seaSide.set(key, lava);
    }
    return seaSide.get(key);
  };
  const deckFloor = (near, radius, count) => structures.fortressFloor(bot, near, radius, count, (p) => !bySea(p));
  const inFortress = () => deckFloor(bot.entity.position, 6, 1).length > 0;

  function fortressTarget(state) {
    const wanted = [];
    if (rods(state) < blazeRods) wanted.push('blaze');
    if (skullsWanted(state)) wanted.push('wither_skeleton');
    return wanted;
  }

  async function fortressStep(ctx, state) {
    const mobs = fortressTarget(state);
    const here = bot.entity.position;
    const blazeNear = Object.values(bot.entities).some((e) => e.name === 'blaze' && e.position?.distanceTo(here) <= 24);
    const drink = await fireProof(ctx, { danger: blazeNear });
    if (!drink.ok) return drink;
    // Hurt: no new fights. Back off from whatever is near and let health come
    // back (a full stomach regenerates), then hunt again.
    if (state.health < HUNT_HEALTH) {
      const near = state.hostiles.find((h) => h.distance <= 12 && h.name !== 'zombified_piglin');
      if (near) {
        ctx.record('fall_back', { health: Math.round(state.health), from: near.name });
        const moved = await actions.fleeFrom(bot, ctx, near.position, { distance: 16, timeoutMs: 10000 });
        return moved.ok || bot.entity.position.distanceTo(here) >= 4 ? { ok: true, waited: true } : moved;
      }
      actions.haltBody(bot);
      await sleep(2000, ctx.signal);
      return { ok: true, waited: true };
    }
    // Wither skeletons spawn anywhere in the fortress's bounds, on the
    // netherrack under and beside the decks too: one is worth a short climb
    // or drop. A fortress gave 25 kills in 85 minutes while patrols walked
    // past those below. Blazes float, so theirs stays level.
    const reach = (e) => (e.name === 'wither_skeleton' ? HUNT_DY_WITHER : 6);
    const target = Object.values(bot.entities).find((e) => mobs.includes(e.name) && e.position
      && e.position.distanceTo(here) <= 40 && Math.abs(e.position.y - here.y) <= reach(e) && !blacklist.has(`mob:${e.id}`));
    if (!target && mobs.includes('wither_skeleton')) {
      const seen = Object.values(bot.entities).filter((e) => e.name === 'wither_skeleton' && e.position && e.position.distanceTo(here) <= 64);
      if (seen.length && Date.now() - (memory.sightedAt || 0) > 30000) {
        memory.sightedAt = Date.now();
        ctx.record('sighted', { mob: 'wither_skeleton', at: seen.map((e) => `${Math.round(e.position.distanceTo(here))}/${Math.round(e.position.y - here.y)}`) });
      }
      // Nearly every one seen but not hunted was 20-30 blocks overhead, on
      // the decks, while the bot walked the ground under them: go up there.
      if (seen.some((e) => e.position.y - here.y > HUNT_DY_WITHER) && Date.now() - (memory.climbedForAt || 0) > 60000) {
        memory.climbedForAt = Date.now();
        const climbed = await climbTo(ctx, { minClimb: CLIMB });
        if (climbed.ok) return climbed;
      }
    }
    // Boxed in (a pillar under a blaze it cannot reach): get somewhere first.
    if (target && !boxedIn()) {
      const name = target.name;
      const result = await skills.huntOne(bot, ctx, {
        mobs, radius: 40, blacklist, dropMatch: (n) => n === 'blaze_rod' || n === 'wither_skeleton_skull',
        accept: (e) => Math.abs(e.position.y - bot.entity.position.y) <= reach(e),
      });
      if (result.ok) {
        memory.kills[name] = (memory.kills[name] || 0) + 1;
        ctx.record('kill', { mob: name, kills: memory.kills[name], gained: result.gained });
      }
      return result;
    }
    if (!inFortress()) {
      let floor = deckFloor(memory.fortress, 48, 32);
      // The first brick seen can be a buried pillar foot: look for floor anywhere in sight.
      if (!floor.length) floor = deckFloor(here, 96, 32);
      floor.sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
      if (floor.length && floor[0].y + 1 - here.y > CLIMB) {
        const climbed = await climbTo(ctx);
        if (climbed.ok) return climbed;
      }
      if (floor.length) return approach(ctx, 'fortress', floor);
      // Standing at that brick with no walkable floor in sight: look from elsewhere.
      if (here.distanceTo(memory.fortress) <= 8) return explore(ctx, memory.fortress);
      return approachStructure(ctx, 'fortress');
    }
    if (!memory.visited.fortress) {
      memory.visited.fortress = true;
      ctx.record('structure_entered', { kind: 'fortress', position: posKey(here.floored()) });
    }
    if (!memory.spawner) {
      memory.spawner = structures.findSpawners(bot, memory.fortress, 96)[0] || null;
      if (memory.spawner) ctx.record('spawner', { position: posKey(memory.spawner) });
    }
    // Blazes come from the spawner; wither skeletons spawn anywhere in the fortress.
    // Wait by the spawner a while, then walk the corridors for a bit.
    const now = Date.now();
    if (!memory.waitSince) memory.waitSince = now;
    const byspawner = memory.spawner && rods(state) < blazeRods;
    if (byspawner && now - memory.waitSince < 45000) {
      if (here.distanceTo(memory.spawner) > 7) {
        const floor = deckFloor(memory.spawner, 8, 32)
          .filter((p) => p.distanceTo(memory.spawner) >= 3)
          .sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
        if (floor.length) return approach(ctx, 'spawner', floor);
      }
      actions.haltBody(bot);
      await sleep(2000, ctx.signal);
      return { ok: true, waited: true };
    }
    memory.waitSince = 0;
    return patrol(ctx, memory.fortress, 'fortress', state);
  }

  // With the rods in, the spawner's blazes only fill the mob cap: wither
  // skeletons are found in the corridors away from it (3 of 58 kills by it).
  const SPAWNER_CLEAR = 24;

  /** A walk to a random floor cell 12-40 blocks away inside the structure. */
  async function patrol(ctx, centre, kind, state) {
    const here = bot.entity.position;
    const band = (lo, hi) => (p) => { const d = p.distanceTo(here); return d >= lo && d <= hi; };
    const avoid = kind === 'fortress' && memory.spawner && state && rods(state) >= blazeRods
      ? (p) => p.distanceTo(memory.spawner) >= SPAWNER_CLEAR : () => true;
    // A pillar foot by the lava sea counts as fortress floor too: from there
    // the decks are far overhead and walks to them fail one after another.
    // After two such misses, tower up to a deck instead.
    if (kind === 'fortress' && (memory.highMisses || 0) >= 2) {
      memory.highMisses = 0;
      const climbed = await climbTo(ctx, { minClimb: CLIMB });
      if (climbed.ok) return climbed;
    }
    // On the level it walks now first: a walk down to a lower ledge is a
    // walk along the drop, and the falls from it ended in the lava sea.
    const level = (p) => Math.abs(p.y + 1 - here.y) <= 6;
    let floor = deckFloor(here, 48, 512).filter((p) => band(12, 40)(p) && avoid(p) && level(p));
    if (!floor.length) floor = deckFloor(here, 48, 512).filter((p) => band(12, 40)(p) && avoid(p));
    if (!floor.length) floor = deckFloor(centre, 96, 512).filter((p) => band(12, 96)(p) && avoid(p));
    if (!floor.length) floor = deckFloor(here, 48, 512).filter(band(12, 40));
    if (!floor.length) floor = deckFloor(centre, 96, 512).filter(band(12, 96));
    // Nothing else to walk to here: go and stand by the spawner (or the first brick
    // seen); already there, look around from a lookout instead.
    const fallback = kind === 'fortress' && memory.spawner ? memory.spawner : centre;
    if (!floor.length) return here.distanceTo(fallback) <= 8 ? explore(ctx, fallback) : approachStructure(ctx, kind, fallback);
    const pick = floor[Math.floor(Math.random() * floor.length)];
    ctx.record('patrol', { kind, target: posKey(pick) });
    const result = await actions.goNear(bot, ctx, pick.offset(0, 1, 0), 2, { timeoutMs: 45000 });
    const high = pick.y + 1 - here.y > CLIMB;
    memory.highMisses = !result.ok && high ? (memory.highMisses || 0) + 1 : 0;
    return result.ok ? { ok: true, waited: true } : result;
  }

  /** No floor known yet (seen from afar): walk towards the first block seen. */
  async function approachStructure(ctx, kind, p = memory[kind]) {
    const here = bot.entity.position;
    ctx.record('approach', { kind, target: posKey(p), distance: Math.round(p.distanceTo(here)) });
    await stockScaffolding(ctx, p.y - here.y);
    const result = await withScaffolding(() => actions.goNear(bot, ctx, p, 4, { timeoutMs: 120000 }));
    if (!result.ok && bot.entity.position.distanceTo(here) < 6) return explore(ctx, p);
    return result;
  }

  // ---- bartering ------------------------------------------------------------

  const near = (e, p, r) => e.position && e.position.distanceTo(p) <= r;

  function pickPiglin(range) {
    const here = bot.entity.position;
    const brutes = Object.values(bot.entities).filter((e) => e.name === 'piglin_brute' && e.position);
    return Object.values(bot.entities)
      .filter((e) => structures.isAdultPiglin(bot, e) && near(e, here, range) && !blacklist.has(`piglin:${e.id}`)
        && Math.abs(e.position.y - here.y) <= 4 && !brutes.some((b) => near(b, e.position, 12) || near(b, here, 16)))
      .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0] || null;
  }

  function wearsGold() {
    return ARMOR.some(([slot]) => /^golden_/.test(bot.inventory.slots[ARMOR_SLOT[slot]]?.name || ''));
  }

  const goldOnGround = (origin, radius) => Object.values(bot.entities).filter((e) => e.name === 'item'
    && near(e, origin, radius) && (() => { try { return e.getDroppedItem?.()?.name === 'gold_ingot'; } catch { return false; } })());

  /** Tosses one gold ingot to a piglin and picks up what it throws back. */
  async function barter(ctx, piglin) {
    if (!wearsGold()) return fail('no_gold_armour');
    const ingot = bot.inventory.items().find((i) => i.name === 'gold_ingot');
    if (!ingot) return fail('no_gold');
    if (structures.piglinBusy(piglin)) {
      // Still looking at the last ingot: it would ignore another one.
      await waitUntil(() => !structures.piglinBusy(bot.entities[piglin.id]), { timeoutMs: 8000, signal: ctx.signal });
      if (!bot.entities[piglin.id]) return fail('piglin_gone');
    }
    // Thrown from right on top of it, the ingot flies past and lands at the bot's own feet.
    if (piglin.position.distanceTo(bot.entity.position) < 1.5) {
      await actions.fleeFrom(bot, ctx, piglin.position.clone(), { distance: 2.5, timeoutMs: 3000 });
    }
    if (piglin.position.distanceTo(bot.entity.position) > 3) {
      const moved = await actions.goNear(bot, ctx, piglin.position.clone(), 2, { timeoutMs: 20000 });
      if (!bot.entities[piglin.id]) return fail('piglin_gone');
      if (piglin.position.distanceTo(bot.entity.position) > 4.5) {
        blacklist.add(`piglin:${piglin.id}`, moved.reason || 'out_of_reach', 30000);
        return moved.ok ? fail('piglin_out_of_reach') : moved;
      }
    }
    actions.haltBody(bot);
    const totals = () => {
      const t = new Map();
      for (const i of bot.inventory.items()) t.set(i.name, (t.get(i.name) || 0) + i.count);
      return t;
    };
    const before = totals();
    const goldBefore = before.get('gold_ingot') || 0;
    const known = new Set(goldOnGround(bot.entity.position, 12).map((e) => e.id));
    try {
      await bot.lookAt(piglin.position.offset(0, 0.3, 0), true);
      await bot.toss(ingot.type, null, 1);
    } catch (error) {
      if (isAbort(error)) throw error;
      return fail('toss_failed');
    }
    ctx.record('barter_offer', { piglin: piglin.id, busy: structures.piglinBusy(piglin), distance: Math.round(piglin.position.distanceTo(bot.entity.position) * 10) / 10 });
    // The thrown ingot shows up as an item entity a tick or two later.
    let thrown = null;
    await waitUntil(() => { thrown = goldOnGround(bot.entity.position, 12).find((e) => !known.has(e.id)) || null; return Boolean(thrown); },
      { timeoutMs: 2000, signal: ctx.signal });
    const goldNow = () => totals().get('gold_ingot') || 0;
    if (!thrown) {
      // Never seen on the ground: count it only if it is not back in the bag after the pickup delay.
      await sleep(2500, ctx.signal);
      if (goldNow() >= goldBefore || goldOnGround(bot.entity.position, 12).some((e) => !known.has(e.id))) return fail('toss_unseen');
    }
    // Taken: the ingot leaves the ground and does not come back into the bag
    // (the bot itself may pick it up again after two seconds).
    const taken = await waitUntil(() => (!thrown || !bot.entities[thrown.id]) && goldNow() < goldBefore,
      { timeoutMs: 8000, signal: ctx.signal }) && goldNow() < goldBefore;
    if (!taken) {
      blacklist.add(`piglin:${piglin.id}`, 'ignored_gold', 20000);
      if (thrown && bot.entities[thrown.id]) {
        await actions.collectDrops(bot, ctx, bot.entities[thrown.id].position, (n) => n === 'gold_ingot', { radius: 3, timeoutMs: 6000 });
      }
      return fail('gold_not_taken');
    }
    // Whoever took it looks at the gold for six seconds, then throws the loot towards the player.
    const takenAt = Date.now();
    await waitUntil(() => Date.now() - takenAt > 6500 && !structures.piglinBusy(bot.entities[piglin.id]),
      { timeoutMs: 12000, signal: ctx.signal });
    await sleep(1000, ctx.signal);
    memory.trades += 1;
    const where = bot.entities[piglin.id]?.position?.clone() || bot.entity.position.clone();
    for (const origin of [where, bot.entity.position.clone()]) {
      await actions.collectDrops(bot, ctx, origin, (n) => structures.BARTER_LOOT.has(n), { radius: 8, timeoutMs: 6000 });
    }
    const after = totals();
    const gained = {};
    for (const [name, n] of after) {
      const d = n - (before.get(name) || 0);
      if (name !== 'gold_ingot' && structures.BARTER_LOOT.has(name) && d > 0) {
        gained[name] = d;
        memory.barter[name] = (memory.barter[name] || 0) + d;
      }
    }
    ctx.record('barter', { trades: memory.trades, gained });
    return { ok: true, trades: memory.trades };
  }

  // A bastion that gives no trade for a while is left for other work and tried again later.
  const BASTION_PATIENCE_MS = 180000;
  const BASTION_REST_MS = 300000;
  const bastionResting = () => Date.now() < (memory.bastionRestUntil || 0);

  async function bastionStep(ctx) {
    const here = bot.entity.position;
    const centre = memory.bastion;
    const now = Date.now();
    if (!memory.bastionSince || memory.bastionTrades !== memory.trades) {
      memory.bastionSince = now;
      memory.bastionTrades = memory.trades;
    }
    if (now - memory.bastionSince > BASTION_PATIENCE_MS) {
      memory.bastionRestUntil = now + BASTION_REST_MS;
      memory.bastionSince = 0;
      ctx.record('bastion_rest', { trades: memory.trades });
      return { ok: true };
    }
    if (here.distanceTo(centre) > 28) return approachStructure(ctx, 'bastion');
    if (!memory.visited.bastion) {
      memory.visited.bastion = true;
      ctx.record('structure_entered', { kind: 'bastion', position: posKey(here.floored()) });
    }
    // A brute in sight: no bartering here, step out of its way first.
    const brute = Object.values(bot.entities).find((e) => e.name === 'piglin_brute' && e.position && near(e, here, 16));
    if (brute) {
      ctx.record('avoid_brute', { distance: Math.round(brute.position.distanceTo(here)) });
      const moved = await actions.fleeFrom(bot, ctx, brute.position.clone(), { distance: 20, timeoutMs: 15000 });
      return moved.ok || bot.entity.position.distanceTo(here) >= 4 ? { ok: true, waited: true } : moved;
    }
    // Piglins further off or on another level: walk over to the nearest one
    // that no brute stands beside, then barter from up close.
    const far = Object.values(bot.entities)
      .filter((e) => structures.isAdultPiglin(bot, e) && near(e, here, 64) && !near(e, here, 3) && !blacklist.has(`goto-piglin:${e.id}`)
        && !blacklist.has(`piglin:${e.id}`)
        && !Object.values(bot.entities).some((b) => b.name === 'piglin_brute' && b.position && near(b, e.position, 10)))
      .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0];
    if (far) {
      ctx.record('approach', { kind: 'piglin', distance: Math.round(far.position.distanceTo(here)), dy: Math.round(far.position.y - here.y) });
      const moved = await actions.goNear(bot, ctx, far.position.clone(), 3, { timeoutMs: 45000 });
      if (!moved.ok && bot.entity.position.distanceTo(here) < 4) blacklist.add(`goto-piglin:${far.id}`, moved.reason, 60000);
      return moved.ok || bot.entity.position.distanceTo(here) >= 4 ? { ok: true, waited: true } : moved;
    }
    // No piglin in sight: walk around the bastion's edge to find one.
    const angle = Math.random() * Math.PI * 2;
    const x = Math.round(centre.x + Math.cos(angle) * 24);
    const z = Math.round(centre.z + Math.sin(angle) * 24);
    ctx.record('patrol', { kind: 'bastion', target: `${x},${z}` });
    const result = await actions.goTo(bot, ctx, new goals.GoalNearXZ(x, z, 4), { timeoutMs: 30000, arrived: () => true });
    return result.ok || bot.entity.position.distanceTo(here) > 8 ? { ok: true, waited: true } : result;
  }

  // ---- loot on the ground ---------------------------------------------------

  // A skull or rod left lying after a fight (the pickup after a kill gave up,
  // or another mob pulled the bot away) is worth more than the next kill:
  // one skull in eighteen kills was seen on the deck and walked away from.
  const LOOT_RANGE = 32;
  function lootOnGround(state) {
    const wanted = new Set();
    if (skullsWanted(state)) wanted.add('wither_skeleton_skull');
    if (rods(state) < blazeRods) wanted.add('blaze_rod');
    if (!wanted.size) return null;
    const here = bot.entity.position;
    return Object.values(bot.entities).filter((e) => e.name === 'item' && e.position && e.position.distanceTo(here) <= LOOT_RANGE
      && !blacklist.has(`loot:${e.id}`) && (() => { try { return wanted.has(e.getDroppedItem?.()?.name); } catch { return false; } })())
      .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0] || null;
  }

  async function pickUp(ctx, drop) {
    const name = drop.getDroppedItem?.()?.name;
    const count = () => bot.inventory.items().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);
    const before = count();
    ctx.record('loot', { item: name, distance: Math.round(drop.position.distanceTo(bot.entity.position)) });
    const moved = await withScaffolding(() => actions.goNear(bot, ctx, drop.position.clone(), 0.5, { timeoutMs: 30000 }));
    await waitUntil(() => count() > before || !bot.entities[drop.id], { timeoutMs: 1500, signal: ctx.signal });
    if (count() > before) return { ok: true, looted: name };
    blacklist.add(`loot:${drop.id}`, moved.reason || 'not_picked', 30000);
    return moved.ok ? fail('loot_not_picked') : moved;
  }

  // ---- the expedition -------------------------------------------------------

  // Lost the kit (died, drops gone): a bare-handed fortress run only dies
  // again, and there is no bartering without gold.
  function lostKit(state) {
    if (fortressWork(state) && !Object.keys(state.inventory).some((n) => n.endsWith('_sword') || n.endsWith('_axe'))) return 'no_weapon';
    if (tradeWork() && !gold(state)) return 'no_gold';
    return null;
  }

  async function netherStep(ctx, state) {
    trip.enterNetherMode();
    trip.netherPortal();
    // In lava no path can be planned: getting out is leave_lava's job, and
    // explore attempts from there would only burn the no-progress budget.
    if (bot.entity?.isInLava) {
      await sleep(1000, ctx.signal);
      return { ok: true, waited: true };
    }
    // Run out of blocks, a fall into the lava sea has no way out and the walk
    // home has nothing to bridge with (a run with every rod, skull and trade
    // in hand spent its last hour 135 blocks from the portal): keep some.
    if (nether.scaffoldCount(bot) < SCAFFOLD_LOW && Date.now() - (memory.restockedAt || 0) > 60000) {
      memory.restockedAt = Date.now();
      await stockScaffolding(ctx, 16);
    }
    if (allDone(state)) {
      // The walk home can cross a lava sea: a run with every rod, skull and
      // trade bridged its 100 netherrack away and spent the last 20 minutes on
      // its own bridge 40 blocks short; another bridged a stack and a half
      // across 110 blocks of sea under a portal 40 blocks up. Fill up once,
      // while there is something to dig, with enough to bridge and climb the
      // whole way, and build with the cobblestone too. Again after a fall:
      // one bot lost its footing digging the deck it stood on and landed in
      // the lava sea 40 blocks under the portal with nothing to climb with.
      const portal = memory.netherPortal;
      const here = bot.entity.position;
      const need = portal ? Math.hypot(portal.x - here.x, portal.z - here.z) + Math.max(0, portal.y - here.y) + 16 : 0;
      if (portal && here.distanceTo(portal) > 24 && nether.scaffoldCount(bot) < Math.min(need, HOME_STOCK)
        && Date.now() - (memory.homeStockedAt || 0) > 60000) {
        memory.homeStockedAt = Date.now();
        await stockScaffolding(ctx, need, HOME_STOCK);
      }
      if (portal && here.distanceTo(portal) > 24) {
        const leg = await retraceHome(ctx);
        if (leg) return leg;
      }
      return withScaffolding(() => trip.toOverworld(ctx), { cobble: true });
    }
    const lost = lostKit(state);
    if (lost) return fail(lost);
    scan(ctx);
    const drop = lootOnGround(state);
    if (drop) return pickUp(ctx, drop);
    if (tradeWork()) {
      const piglin = pickPiglin(memory.bastion && bot.entity.position.distanceTo(memory.bastion) <= 40 ? 24 : 12);
      if (piglin) return barter(ctx, piglin);
    }
    // The nearer structure with work left first.
    const options = [];
    if (fortressWork(state) && memory.fortress) options.push(['fortress', memory.fortress]);
    if (tradeWork() && memory.bastion && !bastionResting()) options.push(['bastion', memory.bastion]);
    const here = bot.entity.position;
    options.sort((a, b) => a[1].distanceTo(here) - b[1].distanceTo(here));
    // Stay with the fortress once inside: walking off to the bastion mid-fight wastes the trip.
    const pick = options.find(([kind]) => kind === 'fortress' && inFortress()) || options[0];
    if (pick?.[0] === 'fortress') return fortressStep(ctx, state);
    // Off across the lava sea (to the bastion, or to look for one): a stack
    // first. A bot that left the fortress with one block of basalt ended on
    // a pillar in the sea, every walk out of it blocked.
    if (here.distanceTo(pick?.[1] || here) > 24 || !pick) await stockForTravel(ctx);
    if (pick?.[0] === 'bastion') return bastionStep(ctx);
    // Nothing found yet that has work left: look further. A resting bastion is
    // only skipped while there is something else to look for.
    const lookFor = (fortressWork(state) && !memory.fortress) || (tradeWork() && !memory.bastion);
    if (!lookFor && tradeWork() && memory.bastion) {
      memory.bastionRestUntil = 0;
      return bastionStep(ctx);
    }
    return explore(ctx);
  }

  return {
    name: 'nether_expedition',
    target: { blazeRods, witherSkulls, trades, skullTries },
    noProgressLimit: 30,
    maxRecoveries: 4,
    memory,
    isDone: (state) => allDone(state) && !nether.inNether(bot),
    // Portal (0-15), in the nether (+5), each structure found (+20) and
    // entered (+10), then every rod, skull and trade.
    progress(state) {
      const found = ['fortress', 'bastion'].reduce((sum, k) => sum + (memory[k] ? 20 : 0) + (memory.visited[k] ? 10 : 0), 0);
      return trip.portalProgress() + (nether.inNether(bot) ? 5 : 0) + found
        + Math.min(rods(state), blazeRods) * 30 + Math.min(skulls(state), witherSkulls) * 60 + Math.min(memory.trades, trades) * 15
        + Math.min(memory.witherKills, skullTries) * 2;
    },
    recover() {
      blacklist.clear?.();
      memory.explore = { index: memory.explore.index, leftBastion: memory.explore.leftBastion };
      memory.waitSince = 0;
    },
    async run(ctx) {
      await wearArmour(ctx);
      const state = ctx.perceive();
      if (nether.inNether(bot)) {
        const result = await netherStep(ctx, state);
        noteStep(result);
        return result;
      }
      trip.leaveNetherMode();
      if (allDone(state)) return { ok: true };
      // Respawned without it: going back through to the fortress only dies again.
      const lost = lostKit(state);
      if (lost) return fail(lost);
      return trip.toNether(ctx, state);
    },
    dispose() {
      bot.removeListener?.('move', dropCrumb);
      trip.leaveNetherMode();
    },
  };
}

module.exports = { createNetherExpeditionGoal };
