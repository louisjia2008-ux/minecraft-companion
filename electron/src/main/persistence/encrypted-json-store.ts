import { access, readFile, rename } from 'node:fs/promises';
import type { z } from 'zod';

import { atomicWriteFile } from './atomic-file';
import { decryptJson, encryptJson } from './encryption';
import { PersistenceCorruptionError } from './errors';

export interface VaultKeyProvider {
  getVaultKey(): Promise<Buffer>;
}

export interface EncryptedJsonStoreOptions<T> {
  path: string;
  schema: z.ZodType<T>;
  defaultValue: () => T;
  vault: VaultKeyProvider;
}

export class EncryptedJsonStore<T> {
  readonly #options: EncryptedJsonStoreOptions<T>;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(options: EncryptedJsonStoreOptions<T>) {
    this.#options = options;
  }

  async load(): Promise<T> {
    try {
      await access(this.#options.path);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return this.#options.defaultValue();
      }
      throw error;
    }

    try {
      const [serialized, key] = await Promise.all([
        readFile(this.#options.path, 'utf8'),
        this.#options.vault.getVaultKey(),
      ]);
      return decryptJson(JSON.parse(serialized), key, this.#options.schema);
    } catch (error) {
      const quarantinedPath = `${this.#options.path}.corrupt-${Date.now()}`;
      await rename(this.#options.path, quarantinedPath);
      throw new PersistenceCorruptionError('Encrypted data failed authentication or validation.', quarantinedPath, {
        cause: error,
      });
    }
  }

  async save(value: T): Promise<void> {
    const validated = this.#options.schema.parse(value);
    const key = await this.#options.vault.getVaultKey();
    const serialized = `${JSON.stringify(encryptJson(validated, key))}\n`;
    const write = async (): Promise<void> => atomicWriteFile(this.#options.path, serialized);
    this.#writeQueue = this.#writeQueue.then(write, write);
    await this.#writeQueue;
  }
}
