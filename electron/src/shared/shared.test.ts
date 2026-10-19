import { describe, expect, it } from 'vitest';

import { defaultHotkeyForPlatform, resolvePlatformCapabilities } from './capabilities';
import { API_VERSION } from './contracts';
import { en, resolveLocale, zhCN } from './i18n';
import { parseInvokeRequest } from './schemas';

describe('shared contracts', () => {
  it('rejects unknown and incorrectly versioned IPC fields', () => {
    expect(() =>
      parseInvokeRequest('app:set-theme', {
        version: API_VERSION,
        payload: { theme: 'dark', extra: true },
      }),
    ).toThrow();
    expect(() => parseInvokeRequest('app:set-theme', { version: 2, payload: { theme: 'dark' } })).toThrow();
  });

  it('parses an exact versioned payload', () => {
    expect(parseInvokeRequest('app:set-theme', { version: API_VERSION, payload: { theme: 'dark' } })).toEqual({
      theme: 'dark',
    });
  });

  it('keeps English and Simplified Chinese catalogs key-identical', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    expect(resolveLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(resolveLocale('fr-FR')).toBe('en');
  });

  it('reports Wayland limitations without hiding supported Linux features', () => {
    const capabilities = resolvePlatformCapabilities({
      platform: 'linux',
      sessionType: 'wayland',
      secretStorageAvailable: false,
      globalShortcutsPortalEnabled: false,
    });
    expect(capabilities.find((item) => item.id === 'overlay-position')?.state).toBe('degraded');
    expect(capabilities.find((item) => item.id === 'secret-storage')?.state).toBe('unavailable');
    expect(capabilities.find((item) => item.id === 'native-migration')?.state).toBe('unavailable');
    expect(defaultHotkeyForPlatform('linux')).toBe('Control+Alt+P');
    expect(defaultHotkeyForPlatform('darwin')).toBe('Alt+Space');
  });
});
