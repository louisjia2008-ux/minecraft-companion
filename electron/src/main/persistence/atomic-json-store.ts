import { readFile, rename } from 'node:fs/promises';
import { z } from 'zod';

import { atomicWriteFile } from './atomic-file';
import { PersistenceCorruptionError, UnsupportedSchemaVersionError } from './errors';

const storedEnvelopeSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    data: z.unknown(),
  })
  .strict();

export type SchemaMigrations = Readonly<Record<number, (data: unknown) => unknown>>;

export interface AtomicJsonStoreOptions<T> {
  path: string;
  schemaVersion: number;
  schema: z.ZodType<T>;
  defaultValue: () => T;
  migrations?: SchemaMigrations;
}

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const quarantine = async (path: string): Promise<string> => {
  const quarantinedPath = `${path}.corrupt-${Date.now()}`;
  await rename(path, quarantinedPath);
  return quarantinedPath;
};

export class AtomicJsonStore<T> {
  readonly #options: AtomicJsonStoreOptions<T>;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(options: AtomicJsonStoreOptions<T>) {
    this.#options = options;
  }

  async load(): Promise<T> {
    let serialized: string;
    try {
      serialized = await readFile(this.#options.path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) {
        return this.#options.defaultValue();
      }
      throw error;
    }

    try {
      const parsed = storedEnvelopeSchema.parse(JSON.parse(serialized));
      if (parsed.schemaVersion > this.#options.schemaVersion) {
        throw new UnsupportedSchemaVersionError(parsed.schemaVersion, this.#options.schemaVersion);
      }

      let data = parsed.data;
      let version = parsed.schemaVersion;
      while (version < this.#options.schemaVersion) {
        const migration = this.#options.migrations?.[version];
        if (migration === undefined) {
          throw new Error(`Missing schema migration from version ${version}.`);
        }
        data = migration(data);
        version += 1;
      }

      return this.#options.schema.parse(data);
    } catch (error) {
      if (error instanceof UnsupportedSchemaVersionError) {
        throw error;
      }
      const quarantinedPath = await quarantine(this.#options.path);
      throw new PersistenceCorruptionError('Stored data failed validation and was quarantined.', quarantinedPath, {
        cause: error,
      });
    }
  }

  async save(value: T): Promise<void> {
    const validated = this.#options.schema.parse(value);
    const serialized = `${JSON.stringify({ schemaVersion: this.#options.schemaVersion, data: validated }, null, 2)}\n`;
    const write = async (): Promise<void> => atomicWriteFile(this.#options.path, serialized);
    this.#writeQueue = this.#writeQueue.then(write, write);
    await this.#writeQueue;
  }
}
