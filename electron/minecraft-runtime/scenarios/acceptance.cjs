'use strict';

// Evidence queried from the isolated server, never from a goal's success flags.
const OBJECTIVES = { table: 'mcUseTable', furnace: 'mcUseFurn', sleep: 'mcNightSleep' };
const STATS = { table: 'interact_with_crafting_table', furnace: 'interact_with_furnace', sleep: 'sleep_in_bed' };

function interactionSetup(username) {
  return Object.entries(OBJECTIVES).flatMap(([key, objective]) => [
    `scoreboard objectives add ${objective} minecraft.custom:minecraft.${STATS[key]}`,
    `scoreboard players set ${username} ${objective} 0`,
  ]);
}

async function score(server, username, key) {
  const objective = OBJECTIVES[key];
  const result = await server.query(`scoreboard players get ${username} ${objective}`,
    /has (-?\d+) \[|Can't get value|Unknown scoreboard objective/);
  if (!result[1]) throw new Error(`Missing server statistic ${objective}`);
  return Number(result[1]);
}

async function worldTime(server) {
  const day = await server.query('time query day', /The time is (\d+)/);
  const daytime = await server.query('time query daytime', /The time is (\d+)/);
  return { day: Number(day[1]), daytime: Number(daytime[1]) };
}

async function playerState(server, username) {
  const health = await server.query(`data get entity ${username} Health`, /has the following entity data: ([\d.eE+-]+)f?/);
  const position = await server.query(`data get entity ${username} Pos`, /has the following entity data: \[([^\]]+)\]/);
  const xyz = position[1].split(',').map((value) => Number(value.trim().replace(/[dDfF]$/, '')));
  if (xyz.length !== 3 || !xyz.every(Number.isFinite)) throw new Error('Invalid server player position');
  return { health: Number(health[1]), position: { x: xyz[0], y: xyz[1], z: xyz[2] } };
}

module.exports = { interactionSetup, score, worldTime, playerState };
