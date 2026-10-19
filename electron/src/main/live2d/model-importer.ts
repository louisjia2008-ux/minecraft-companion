import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import JSZip from 'jszip';
import { z } from 'zod';

import { AtomicJsonStore, atomicWriteFile } from '../persistence';
import { parseZipCentralDirectory } from './zip-central-directory';

const activeModelSchema = z
  .object({
    version: z.literal(1),
    active: z
      .object({ id: z.string().uuid(), name: z.string().max(240), modelJsonRelativePath: z.string().max(2_048) })
      .strict()
      .nullable(),
  })
  .strict();

export type ActiveModelConfig = z.infer<typeof activeModelSchema>;

export interface ModelImportLimits {
  archiveBytes: number;
  expandedBytes: number;
  entryCount: number;
  singleFileBytes: number;
}

const DEFAULT_LIMITS: ModelImportLimits = {
  archiveBytes: 100 * 1024 * 1024,
  expandedBytes: 500 * 1024 * 1024,
  entryCount: 2_048,
  singleFileBytes: 64 * 1024 * 1024,
};

const ALLOWED_EXTENSIONS = new Set([
  '.json', '.moc3', '.png', '.jpg', '.jpeg', '.webp', '.wav', '.mp3', '.ogg', '.m4a', '.bytes',
]);

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;

const validateEntryName = (name: string): string => {
  if (name.length === 0 || name.length > 2_048 || name.includes('\0') || name.includes('\\')) {
    throw new Error('ZIP contains an invalid entry path.');
  }
  if (name.startsWith('/') || WINDOWS_ABSOLUTE.test(name) || isAbsolute(name)) {
    throw new Error('ZIP contains an absolute path.');
  }
  const comparableName = name.endsWith('/') ? name.slice(0, -1) : name;
  const normalized = posix.normalize(comparableName);
  if (normalized === '..' || normalized.startsWith('../') || normalized !== comparableName) {
    throw new Error('ZIP contains a path traversal or non-canonical path.');
  }
  return normalized;
};

const collectModelReferences = (model: unknown): string[] => {
  const root = model as { FileReferences?: Record<string, unknown> };
  const refs = root.FileReferences;
  if (refs === undefined || refs === null || typeof refs !== 'object') throw new Error('model3.json is missing FileReferences.');
  const paths: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string') paths.push(value);
  };
  push(refs.Moc);
  push(refs.Physics);
  push(refs.Pose);
  push(refs.UserData);
  if (Array.isArray(refs.Textures)) refs.Textures.forEach(push);
  if (Array.isArray(refs.Expressions)) {
    refs.Expressions.forEach((item) => push((item as { File?: unknown }).File));
  }
  if (refs.Motions !== null && typeof refs.Motions === 'object') {
    Object.values(refs.Motions as Record<string, unknown>).forEach((group) => {
      if (Array.isArray(group)) group.forEach((item) => {
        push((item as { File?: unknown }).File);
        push((item as { Sound?: unknown }).Sound);
      });
    });
  }
  return paths;
};

export interface PendingModelImport {
  importId: string;
  name: string;
  stagingDirectory: string;
  modelJsonRelativePath: string;
}

export class ModelArchiveImporter {
  readonly #modelsRoot: string;
  readonly #limits: ModelImportLimits;
  readonly #config: AtomicJsonStore<ActiveModelConfig>;
  readonly #pending = new Map<string, PendingModelImport>();

  constructor(managedRoot: string, limits: Partial<ModelImportLimits> = {}) {
    this.#modelsRoot = join(managedRoot, 'models');
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
    this.#config = new AtomicJsonStore({
      path: join(managedRoot, 'character.json'),
      schemaVersion: 1,
      schema: activeModelSchema,
      defaultValue: () => ({ version: 1, active: null }),
    });
  }

  getConfig(): Promise<ActiveModelConfig> {
    return this.#config.load();
  }

  async stage(archivePath: string): Promise<PendingModelImport> {
    const archive = await readFile(archivePath);
    if (archive.byteLength === 0 || archive.byteLength > this.#limits.archiveBytes) throw new Error('Model ZIP size is outside the supported range.');
    const centralEntries = parseZipCentralDirectory(archive);
    if (centralEntries.length === 0 || centralEntries.length > this.#limits.entryCount) throw new Error('Model ZIP entry count is outside the supported range.');
    const names = new Set<string>();
    let expanded = 0;
    for (const entry of centralEntries) {
      const name = validateEntryName(entry.name);
      const collisionKey = name.normalize('NFC').toLocaleLowerCase('en-US');
      if (names.has(collisionKey)) throw new Error('Model ZIP contains duplicate or conflicting paths.');
      names.add(collisionKey);
      if (entry.symlink) throw new Error('Model ZIP contains a symbolic link.');
      if (entry.uncompressedSize > this.#limits.singleFileBytes) throw new Error('Model ZIP contains an oversized file.');
      expanded += entry.uncompressedSize;
      if (expanded > this.#limits.expandedBytes) throw new Error('Model ZIP expanded size exceeds the limit.');
      if (!entry.directory && !ALLOWED_EXTENSIONS.has(extname(name).toLowerCase())) throw new Error('Model ZIP contains a disallowed file type.');
    }

    const modelEntries = centralEntries.filter((entry) => !entry.directory && entry.name.toLowerCase().endsWith('.model3.json'));
    if (modelEntries.length !== 1) throw new Error('Model ZIP must contain exactly one model3.json.');
    const modelJsonRelativePath = validateEntryName(modelEntries[0]?.name ?? '');
    const zip = await JSZip.loadAsync(archive, { checkCRC32: true, createFolders: true });
    const modelFile = zip.file(modelJsonRelativePath);
    if (modelFile === null) throw new Error('model3.json is unavailable after ZIP validation.');
    const modelText = await modelFile.async('string');
    if (Buffer.byteLength(modelText, 'utf8') > this.#limits.singleFileBytes) throw new Error('model3.json is oversized.');
    const model = JSON.parse(modelText) as unknown;
    const modelDirectory = posix.dirname(modelJsonRelativePath);
    for (const reference of collectModelReferences(model)) {
      const normalizedReference = validateEntryName(reference);
      const resolvedReference = posix.normalize(posix.join(modelDirectory, normalizedReference));
      if (resolvedReference.startsWith('../') || zip.file(resolvedReference) === null) {
        throw new Error(`Model references a missing or unsafe asset: ${reference}`);
      }
    }

    const importId = randomUUID();
    const stagingDirectory = join(this.#modelsRoot, '.staging', importId);
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    try {
      for (const entry of centralEntries) {
        if (entry.directory) continue;
        const safeName = validateEntryName(entry.name);
        const zipEntry = zip.file(safeName);
        if (zipEntry === null) throw new Error(`ZIP entry ${safeName} is missing during extraction.`);
        const contents = await zipEntry.async('uint8array');
        if (contents.byteLength !== entry.uncompressedSize || contents.byteLength > this.#limits.singleFileBytes) {
          throw new Error(`ZIP entry ${safeName} failed its size check.`);
        }
        const destination = resolve(stagingDirectory, safeName);
        if (relative(stagingDirectory, destination).startsWith('..')) throw new Error('Extraction target escaped staging.');
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await atomicWriteFile(destination, contents);
      }
      const pending: PendingModelImport = {
        importId,
        name: basename(modelJsonRelativePath, '.model3.json'),
        stagingDirectory,
        modelJsonRelativePath,
      };
      this.#pending.set(importId, pending);
      return pending;
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async commit(importId: string): Promise<ActiveModelConfig> {
    const pending = this.#pending.get(importId);
    if (pending === undefined) throw new Error('Model import is not pending or already expired.');
    const destination = join(this.#modelsRoot, importId);
    const previous = await this.#config.load();
    await rename(pending.stagingDirectory, destination);
    const next: ActiveModelConfig = {
      version: 1,
      active: { id: importId, name: pending.name, modelJsonRelativePath: pending.modelJsonRelativePath },
    };
    try {
      await this.#config.save(next);
      this.#pending.delete(importId);
      return next;
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      await this.#config.save(previous);
      throw error;
    }
  }

  async cancel(importId: string): Promise<void> {
    const pending = this.#pending.get(importId);
    if (pending === undefined) return;
    this.#pending.delete(importId);
    await rm(pending.stagingDirectory, { recursive: true, force: true });
  }

  async cleanupStaging(): Promise<void> {
    this.#pending.clear();
    await rm(join(this.#modelsRoot, '.staging'), { recursive: true, force: true });
  }
}
