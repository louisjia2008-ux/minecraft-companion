import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CharacterService } from '../character-service';
import { DomainRepository } from '../domain';
import { SafeStorageVault } from '../security';
import type { MigrationHelperRunner } from './native-migration';
import { NativeMigrationService } from './native-migration';

const electronDialog = vi.hoisted(() => ({
  showOpenDialog: vi.fn(() => {
    throw new Error('Native migration unit fixtures must not open an Electron dialog.');
  }),
}));
vi.mock('electron', () => ({ dialog: electronDialog }));

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  expect(electronDialog.showOpenDialog).not.toHaveBeenCalled();
});

const adapter = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value, 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8'),
  getSelectedStorageBackend: () => 'keychain',
};

const helperPayload = {
  version: 1 as const,
  sourcePath: '',
  sourceDigest: createHash('sha256').update('native-source').digest('hex'),
  categories: [
    { id: 'conversations' as const, count: 1, containsSecrets: false },
    { id: 'memory' as const, count: 1, containsSecrets: false },
    { id: 'tasks' as const, count: 1, containsSecrets: false },
    { id: 'relationship' as const, count: 1, containsSecrets: false },
    { id: 'schedules' as const, count: 0, containsSecrets: false },
    { id: 'providers' as const, count: 1, containsSecrets: true },
    { id: 'appearance' as const, count: 1, containsSecrets: false },
    { id: 'live2d-model' as const, count: 0, containsSecrets: false },
  ],
  requiresKeychainConfirmation: true,
  warnings: [] as string[],
  values: {
    conversations: [{
      id: '11111111-1111-4111-8111-111111111111', kind: 'normal', title: 'Native chat',
      updatedAt: '2026-09-01T10:00:00Z', messages: [
        { id: '22222222-2222-4222-8222-222222222222', role: 'user', text: 'Hello', timestamp: '2026-09-01T09:59:00Z', status: 'completed' },
        { id: '33333333-3333-4333-8333-333333333333', role: 'pet', text: 'Hi', timestamp: '2026-09-01T10:00:00Z', status: 'completed' },
      ],
    }],
    memory: [{ id: '44444444-4444-4444-8444-444444444444', text: 'Likes tea', category: 'preference', scope: 'longTerm', createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-01T10:00:00Z' }],
    tasks: [{ id: '55555555-5555-4555-8555-555555555555', title: 'Review plan', done: false, createdAt: '2026-09-01T10:00:00Z' }],
    relationship: { state: { score: 23 } },
    providers: { providers: [{ id: 'native-provider', displayName: 'OpenAI', type: 'openAICompatible', baseURL: 'https://api.openai.com/v1', apiKeySecretID: 'native-secret', defaultModelID: 'gpt-test', enabled: true, capabilities: ['chat', 'toolCalling'] }] },
    appearance: { appearance: { characterHeight: 300, petSize: 'normal' } },
  },
};

class FixtureRunner implements MigrationHelperRunner {
  constructor(
    private readonly sourcePath: string,
    private readonly hangOnExport = false,
    private readonly onExport?: () => Promise<void>,
  ) {}

  async run(command: 'preview' | 'export', _sourcePath: string, includeSecrets: boolean, signal: AbortSignal) {
    if (command === 'export' && this.hangOnExport) {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      });
    }
    if (command === 'export') await this.onExport?.();
    return {
      result: { ...helperPayload, sourcePath: this.sourcePath, values: command === 'export' ? helperPayload.values : {} },
      secrets: includeSecrets
        ? { version: 1 as const, secrets: { 'native-secret': 'test-secret-never-log' }, warnings: [] }
        : { version: 1 as const, secrets: {}, warnings: [] },
    };
  }
}

const fixture = async (hangOnExport = false) => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-migration-'));
  roots.push(root);
  const sourcePath = join(root, 'native');
  const dataRoot = join(root, 'DeskPet Electron');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(sourcePath, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  const sourceFile = join(sourcePath, 'source.bin');
  await writeFile(sourceFile, 'read-only fixture');
  const vault = new SafeStorageVault(join(dataRoot, 'vault'), adapter, 'darwin');
  const repository = new DomainRepository(join(dataRoot, 'profile.enc.json'), vault);
  await repository.initialize();
  const character = new CharacterService(join(dataRoot, 'managed'));
  await character.initialize();
  const service = new NativeMigrationService({
    platform: 'darwin', runner: new FixtureRunner(sourcePath, hangOnExport), sourcePath, dataRoot,
    repository, vault, character,
  });
  return { root, sourcePath, sourceFile, dataRoot, vault, repository, character, service };
};

describe('NativeMigrationService', () => {
  it('imports selected native data only into an empty profile, preserves the source, and refuses repetition', async () => {
    const item = await fixture();
    const before = createHash('sha256').update(await readFile(item.sourceFile)).digest('hex');
    const preview = await item.service.preview();
    expect(preview.available).toBe(true);
    const result = await item.service.start(['conversations', 'memory', 'tasks', 'relationship', 'providers', 'appearance'], true);
    const state = item.repository.snapshot();
    expect(state.chatSessions).toHaveLength(1);
    expect(state.chatMessages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(state.tasks[0]?.title).toBe('Review plan');
    expect(state.memories[0]?.source).toBe('migration');
    expect(state.relationship.affinity).toBe(23);
    expect(state.providers[0]?.kind).toBe('openai');
    expect(state.providers[0]?.secretState).toBe('configured');
    expect(await item.vault.getSecret(state.providers[0]?.id ?? '')).toBe('test-secret-never-log');
    expect((await item.character.getState()).scale).toBe(1.25);
    expect(result.sourceDigest).toBe(helperPayload.sourceDigest);
    expect(createHash('sha256').update(await readFile(item.sourceFile)).digest('hex')).toBe(before);
    expect((await readdir(item.root)).some((name) => name.startsWith('DeskPet Electron.migration-backup-'))).toBe(true);
    await expect(item.service.start(['tasks'], false)).rejects.toThrow(/already been imported/);
  });

  it('disables preview when the Electron profile is not empty', async () => {
    const item = await fixture();
    await item.repository.transaction((state) => { state.tasks.push({ id: crypto.randomUUID(), title: 'Existing', notes: '', status: 'todo', dueAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); });
    await expect(item.service.preview()).resolves.toMatchObject({ available: false, warnings: ['electron-profile-not-empty'] });
  });

  it('cancels an in-flight helper export without writing a marker', async () => {
    const item = await fixture(true);
    const pending = item.service.start(['tasks'], false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    item.service.cancel();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(await item.service.readMarker()).toBeNull();
    expect(item.repository.snapshot().tasks).toHaveLength(0);
  });

  it('rolls back imported data, appearance, and secrets if the completion marker cannot be committed', async () => {
    const item = await fixture();
    const { mkdir } = await import('node:fs/promises');
    const runner = new FixtureRunner(item.sourcePath, false, async () => {
      await mkdir(join(item.dataRoot, 'migration', 'native-import.json'), { recursive: true });
    });
    const service = new NativeMigrationService({
      platform: 'darwin', runner, sourcePath: item.sourcePath, dataRoot: item.dataRoot,
      repository: item.repository, vault: item.vault, character: item.character,
    });

    await expect(service.start(['tasks', 'providers', 'appearance'], true)).rejects.toThrow();
    expect(item.repository.snapshot().tasks).toHaveLength(0);
    expect(item.repository.snapshot().providers).toHaveLength(0);
    expect((await item.character.getState()).scale).toBe(1);
    expect(await readdir(join(item.dataRoot, 'vault', 'provider-secrets'))).toEqual([]);
  });

  it('reports native migration unavailable outside macOS', async () => {
    const item = await fixture();
    const service = new NativeMigrationService({
      platform: 'linux', runner: new FixtureRunner(item.sourcePath), sourcePath: item.sourcePath,
      dataRoot: item.dataRoot, repository: item.repository, vault: item.vault, character: item.character,
    });
    await expect(service.preview()).resolves.toEqual({
      available: false, sourcePath: null, sourceDigest: null, requiresKeychainConfirmation: false,
      categories: [], warnings: ['macos-only'],
    });
  });
});
