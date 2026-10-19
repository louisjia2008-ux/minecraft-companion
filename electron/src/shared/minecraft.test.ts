import { describe, expect, it } from 'vitest';

import { minecraftConnectionSchema, parseInvokeRequest } from './schemas';

const config = {
  host: '127.0.0.1', port: 25565, username: 'DeskPet', auth: 'offline',
  version: 'auto', ownerName: 'Player_1', executorMode: 'strict', providerId: null,
};

describe('Minecraft IPC boundary', () => {
  it('accepts explicit Java server configuration and bounds names, ports and fields', () => {
    expect(minecraftConnectionSchema.parse(config)).toEqual(config);
    for (const patch of [
      { port: 0 }, { port: 65536 }, { host: 'https://server.example' },
      { host: 'server.example/path' }, { username: '../../token' },
      { ownerName: 'player\ncommand' }, { version: 'bedrock' }, { apiKey: 'not-accepted' },
    ]) expect(minecraftConnectionSchema.safeParse({ ...config, ...patch }).success).toBe(false);
  });

  it('requires an explicit provider selection for model-assisted play', () => {
    expect(minecraftConnectionSchema.safeParse({ ...config, executorMode: 'hybrid' }).success).toBe(false);
    expect(minecraftConnectionSchema.safeParse({ ...config, executorMode: 'hybrid', providerId: '16bdf5fa-68e6-4290-acb3-fb472473b387' }).success).toBe(true);
    expect(minecraftConnectionSchema.safeParse({ ...config, auth: 'microsoft', username: 'player@example.test' }).success).toBe(true);
  });

  it('keeps game chat separate from slash commands and accepts only declared controls', () => {
    expect(parseInvokeRequest('minecraft:chat', { version: 1, payload: { message: 'hello!' } })).toEqual({ message: 'hello!' });
    for (const message of ['/op somebody', ' /stop', 'hello\n/stop', 'x'.repeat(241)]) {
      expect(() => parseInvokeRequest('minecraft:chat', { version: 1, payload: { message } })).toThrow();
    }
    expect(() => parseInvokeRequest('minecraft:control', { version: 1, payload: { action: 'exec' } })).toThrow();
    expect(() => parseInvokeRequest('minecraft:submit', { version: 1, payload: { command: 'follow', script: 'evil' } })).toThrow();
  });
});
