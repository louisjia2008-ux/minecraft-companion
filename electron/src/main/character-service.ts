import { join } from 'node:path';
import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { z } from 'zod';

import type { CharacterState } from '../shared';
import { AtomicJsonStore } from './persistence';
import { CubismCoreImporter, ModelArchiveImporter } from './live2d';
import type { PendingModelImport } from './live2d';

const preferencesSchema = z
  .object({
    scale: z.number().min(0.2).max(3),
    position: z.object({ displayId: z.string(), x: z.number(), y: z.number() }).strict().nullable(),
  })
  .strict();

type Preferences = z.infer<typeof preferencesSchema>;

export class CharacterService {
  readonly #core: CubismCoreImporter;
  readonly #models: ModelArchiveImporter;
  readonly #preferences: AtomicJsonStore<Preferences>;
  #preferenceValue: Preferences = { scale: 1, position: null };
  #pending: PendingModelImport | null = null;
  #expression: string | null = null;
  #action: string | null = null;
  #bubble: string | null = null;

  constructor(managedRoot: string) {
    this.#core = new CubismCoreImporter(managedRoot);
    this.#models = new ModelArchiveImporter(managedRoot);
    this.#preferences = new AtomicJsonStore({
      path: join(managedRoot, 'character-preferences.json'),
      schemaVersion: 1,
      schema: preferencesSchema,
      defaultValue: () => ({ scale: 1, position: null }),
    });
  }

  async initialize(): Promise<void> {
    await this.#models.cleanupStaging();
    this.#preferenceValue = await this.#preferences.load();
  }

  async getState(): Promise<CharacterState> {
    const core = await this.#core.status().catch(() => null);
    const config = await this.#models.getConfig();
    const modelUrl = this.#pending === null
      ? config.active === null
        ? null
        : `deskpet://managed/models/${config.active.id}/${config.active.modelJsonRelativePath}`
      : `deskpet://managed/models/.staging/${this.#pending.importId}/${this.#pending.modelJsonRelativePath}`;
    return {
      coreState: core === null ? 'missing' : 'ready',
      modelState: this.#pending !== null ? 'loading' : config.active === null ? 'missing' : 'ready',
      coreUrl: core === null ? null : 'deskpet://managed/core/live2dcubismcore.min.js',
      modelUrl,
      pendingImportId: this.#pending?.importId ?? null,
      modelName: this.#pending?.name ?? config.active?.name ?? null,
      scale: this.#preferenceValue.scale,
      position: this.#preferenceValue.position,
      expression: this.#expression,
      action: this.#action,
      bubble: this.#bubble,
    };
  }

  async importCore(parent: BrowserWindow | null): Promise<CharacterState> {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose live2dcubismcore.min.js',
      properties: ['openFile'],
      filters: [{ name: 'Cubism Core JavaScript', extensions: ['js'] }],
    };
    const selection = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
    const path = selection.filePaths[0];
    if (!selection.canceled && path !== undefined) await this.#core.import(path);
    return this.getState();
  }

  async importModel(parent: BrowserWindow | null): Promise<CharacterState> {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose Live2D model ZIP',
      properties: ['openFile'],
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    };
    const selection = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
    const path = selection.filePaths[0];
    if (!selection.canceled && path !== undefined) {
      if (this.#pending !== null) await this.#models.cancel(this.#pending.importId);
      this.#pending = await this.#models.stage(path);
    }
    return this.getState();
  }

  async stageModelArchive(path: string): Promise<CharacterState> {
    if (this.#pending !== null) await this.#models.cancel(this.#pending.importId);
    this.#pending = await this.#models.stage(path);
    return this.getState();
  }

  async acknowledgeModelLoaded(importId: string): Promise<CharacterState> {
    if (this.#pending?.importId !== importId) throw new Error('Model acknowledgement does not match the pending import.');
    await this.#models.commit(importId);
    this.#pending = null;
    return this.getState();
  }

  async cancelImport(): Promise<void> {
    if (this.#pending !== null) await this.#models.cancel(this.#pending.importId);
    this.#pending = null;
  }

  async setScale(scale: number): Promise<CharacterState> {
    this.#preferenceValue.scale = scale;
    await this.#preferences.save(this.#preferenceValue);
    return this.getState();
  }

  async setPosition(position: CharacterState['position']): Promise<CharacterState> {
    this.#preferenceValue.position = position;
    await this.#preferences.save(this.#preferenceValue);
    return this.getState();
  }

  setExpression(expression: string | null): void { this.#expression = expression; }
  setAction(action: string | null): void { this.#action = action; }
  setBubble(bubble: string | null): void { this.#bubble = bubble; }
}
