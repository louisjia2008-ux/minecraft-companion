import { z } from 'zod';

import type { Locale, Theme } from '../shared';
import { AtomicJsonStore } from './persistence';
import { defaultHotkeyForPlatform } from '../shared';

const settingsSchema = z
  .object({
    locale: z.enum(['system', 'en', 'zh-CN']),
    theme: z.enum(['system', 'light', 'dark']),
    hotkey: z.string().min(1).max(128),
    autoLaunch: z.boolean(),
    overlayVisible: z.boolean(),
  })
  .strict();

export type AppSettings = z.infer<typeof settingsSchema>;

export class AppSettingsService {
  readonly #store: AtomicJsonStore<AppSettings>;
  #settings: AppSettings | null = null;

  constructor(path: string, platform: NodeJS.Platform = process.platform) {
    this.#store = new AtomicJsonStore({
      path,
      schemaVersion: 1,
      schema: settingsSchema,
      defaultValue: () => ({ locale: 'system', theme: 'system', hotkey: defaultHotkeyForPlatform(platform), autoLaunch: false, overlayVisible: true }),
    });
  }

  async initialize(): Promise<void> {
    this.#settings ??= await this.#store.load();
  }

  get(): AppSettings {
    if (this.#settings === null) throw new Error('Settings are not initialized.');
    return structuredClone(this.#settings);
  }

  async update(patch: Partial<{ locale: Locale; theme: Theme; hotkey: string; autoLaunch: boolean; overlayVisible: boolean }>): Promise<AppSettings> {
    const next = settingsSchema.parse({ ...this.get(), ...patch });
    await this.#store.save(next);
    this.#settings = next;
    return this.get();
  }
}
