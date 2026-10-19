import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { authorizeIpcRequest, isKnownInvokeChannel } from '../../src/main/ipc-policy';

const valid = {
  channel: 'app:set-theme' as const,
  envelope: { version: 1, payload: { theme: 'dark' } },
  senderUrl: 'deskpet://app/main_window/index.html',
  senderRole: 'console' as const,
  allowedRoles: ['console'] as const,
  development: false,
};

describe('IPC security policy', () => {
  it('accepts only known channels and exact versioned payloads', () => {
    expect(isKnownInvokeChannel('app:get-state')).toBe(true);
    expect(isKnownInvokeChannel('electron:execute-anything')).toBe(false);
    expect(authorizeIpcRequest(valid)).toEqual({ theme: 'dark' });
    expect(() => authorizeIpcRequest({ ...valid, envelope: { version: 1, payload: { theme: 'dark', extra: true } } })).toThrow();
  });

  it('rejects the wrong origin and window role', () => {
    expect(() => authorizeIpcRequest({ ...valid, senderUrl: 'https://attacker.example/' })).toThrow('origin');
    expect(() => authorizeIpcRequest({ ...valid, senderRole: 'overlay' })).toThrow('role');
  });

  it('restricts Minecraft controls to the console with strict schemas', () => {
    const request = { ...valid, channel: 'minecraft:control' as const, envelope: { version: 1, payload: { action: 'stop' } } };
    expect(authorizeIpcRequest(request)).toEqual({ action: 'stop' });
    expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...request, senderUrl: 'https://server.example/' })).toThrow('origin');
    expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { action: 'stop', shell: true } } })).toThrow();
  });

  it('rejects an oversized payload before schema dispatch', () => {
    expect(() => authorizeIpcRequest({ ...valid, envelope: { version: 1, payload: { theme: 'dark', padding: 'x'.repeat(300_000) } } })).toThrow('size');
  });

  it('keeps the preload bridge narrow and excludes generic Electron send/invoke exposure', async () => {
    const preload = await readFile(join(process.cwd(), 'src/preload/index.ts'), 'utf8');
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer/s);
    expect(preload).not.toContain('ipcRenderer.send(');
    expect(preload).not.toContain('shell.openExternal');
  });

  it('ships a restrictive CSP in both renderer documents', async () => {
    for (const role of ['console', 'overlay']) {
      const html = await readFile(join(process.cwd(), `src/renderer/${role}/index.html`), 'utf8');
      expect(html).toContain("default-src 'self'");
      expect(html).toContain("object-src 'none'");
      expect(html).toContain("form-action 'none'");
      expect(html).not.toContain("script-src 'unsafe-inline'");
    }
  });
});
