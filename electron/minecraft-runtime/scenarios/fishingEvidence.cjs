'use strict';

const { setTimeout: delay } = require('node:timers/promises');

// The vanilla fishing table contains fish, junk and treasure. A catch of e.g.
// ten ink sacs is one catch, not ten; every native reel is credited at most once.
const LOOT = [...new Set(['cod', 'salmon', 'tropical_fish', 'pufferfish', 'bowl', 'fishing_rod',
  'leather', 'leather_boots', 'rotten_flesh', 'stick', 'string', 'potion', 'bone', 'ink_sac',
  'tripwire_hook', 'bamboo', 'lily_pad', 'bow', 'enchanted_book', 'name_tag', 'nautilus_shell', 'saddle'])];
const objectives = LOOT.map((item, i) => ({ item, objective: `mcFP${i}` }));
const catchId = 'minecraft_companion:fishing_catch';

// 81 is the data-pack format in the pinned 1.21.8 server's version.json. This
// observer changes only its own advancement/scoreboards, never game resources.
const fishingDataPacks = { 'minecraft-companion-observer': {
  'pack.mcmeta': JSON.stringify({ pack: { pack_format: 81, description: 'Minecraft companion acceptance observer' } }),
  'data/minecraft_companion/advancement/fishing_catch.json': JSON.stringify({
    criteria: { caught: { trigger: 'minecraft:fishing_rod_hooked',
      conditions: { item: { items: LOOT.map((item) => `minecraft:${item}`) } } } },
    rewards: { function: 'minecraft_companion:fishing_catch' },
  }),
  'data/minecraft_companion/function/fishing_catch.mcfunction':
    `scoreboard players add @s mcFishCatch 1\nadvancement revoke @s only ${catchId}\n`,
  'data/minecraft_companion/function/read_pickups.mcfunction':
    ['scoreboard players set @a mcFishLoot 0', ...objectives.map(({ objective }) =>
      `execute as @a run scoreboard players operation @s mcFishLoot += @s ${objective}`)].join('\n') + '\n',
} };

function fishingSetup(username) {
  return ['scoreboard objectives add mcFishCatch dummy', 'scoreboard objectives add mcFishLoot dummy',
    ...objectives.map(({ item, objective }) => `scoreboard objectives add ${objective} minecraft.picked_up:minecraft.${item}`),
    ...['mcFishCatch', 'mcFishLoot', ...objectives.map(({ objective }) => objective)]
      .map((objective) => `scoreboard players set ${username} ${objective} 0`),
    `advancement revoke ${username} only ${catchId}`];
}

async function fishingSnapshot(server, username) {
  const response = await server.execute('function minecraft_companion:read_pickups');
  if (!/(?:Executed .*function|Running function)/.test(response) || /Unknown function|Unknown or incomplete|not found/.test(response)) {
    throw new Error(`fishing_pickup_observer_unavailable: ${response.trim()}`);
  }
  const read = async (objective) => {
    const result = await server.query(`scoreboard players get ${username} ${objective}`,
      /has (-?\d+) \[|Can't get value|Unknown scoreboard objective/);
    if (result[1] === undefined) throw new Error(`fishing_score_missing: ${objective}`);
    return Number(result[1]);
  };
  return { at: Date.now(), catches: await read('mcFishCatch'), pickedUp: await read('mcFishLoot') };
}

function fishingVerdict(evidence, reported, required) {
  const confirmed = evidence?.confirmed || 0;
  return { pass: Boolean(evidence && !evidence.errors.length && confirmed >= required
    && reported >= required && reported <= confirmed), confirmed, reported, required,
  reason: confirmed >= required ? null : 'independent_catches_not_confirmed', evidence: evidence || null };
}

function installFishingEvidence({ bot, server, username, write = () => {}, pollMs = 100, pickupMs = 3000 }) {
  const native = bot.fish;
  if (typeof native !== 'function') throw new Error('Native fishing API missing');
  const evidence = { confirmed: 0, errors: [], casts: [] };
  const pending = new Set();
  let disposed = false;
  const fail = (error) => { const reason = String(error?.message || error); evidence.errors.push(reason);
    write('fishing_readback_error', { reason }); };
  const wrapper = function (...args) {
    const result = native.apply(this, args); // native starts now; preserve receiver and synchronous throws
    // The baseline is read after casting and before the bite (vanilla waits at
    // least five seconds). It does not delay, queue or repeat the native cast.
    const baseline = fishingSnapshot(server, username).then((value) => ({ value }), (error) => ({ error }));
    pending.add(baseline); baseline.then(() => pending.delete(baseline));
    const task = Promise.resolve(result).then((value) => {
      if (disposed) return value;
      const reading = (async () => {
      const before = await baseline;
      if (before.error) { fail(before.error); return value; }
      const event = { before: before.value, after: null, credited: 0 };
      try {
        const until = Date.now() + pickupMs;
        do {
          event.after = await fishingSnapshot(server, username);
          if (event.after.catches > event.before.catches && event.after.pickedUp > event.before.pickedUp) {
            event.credited = 1; break;
          }
          if (Date.now() < until) await delay(pollMs);
        } while (Date.now() < until);
        evidence.confirmed += event.credited;
        evidence.casts.push(event); write('fishing_server_catch', event);
      } catch (error) { fail(error); }
      return value;
      })();
      pending.add(reading);
      return reading.finally(() => pending.delete(reading));
    });
    // Observe rejection without replacing the native failure delivered to caller.
    task.catch(() => {});
    return task;
  };
  bot.fish = wrapper;
  return { evidence,
    async verify(reported, required) { await Promise.allSettled([...pending]); return fishingVerdict(evidence, reported, required); },
    async dispose() { disposed = true; if (bot.fish === wrapper) bot.fish = native; await Promise.allSettled([...pending]); },
  };
}

module.exports = { LOOT, fishingDataPacks, fishingSetup, fishingSnapshot, fishingVerdict, installFishingEvidence };
