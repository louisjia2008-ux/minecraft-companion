import { appendFile, mkdir, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { z } from 'zod';

import { PersistenceCorruptionError } from './errors';

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

export class JsonlEventStore<T> {
  readonly #path: string;
  readonly #schema: z.ZodType<T>;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string, schema: z.ZodType<T>) {
    this.#path = path;
    this.#schema = schema;
  }

  async append(event: T): Promise<void> {
    const validated = this.#schema.parse(event);
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      await appendFile(this.#path, `${JSON.stringify(validated)}\n`, { encoding: 'utf8', mode: 0o600 });
    };
    this.#writeQueue = this.#writeQueue.then(write, write);
    await this.#writeQueue;
  }

  async readAll(): Promise<T[]> {
    let contents: string;
    try {
      contents = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }

    try {
      return contents
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => this.#schema.parse(JSON.parse(line)));
    } catch (error) {
      const quarantinedPath = `${this.#path}.corrupt-${Date.now()}`;
      await rename(this.#path, quarantinedPath);
      throw new PersistenceCorruptionError('Event log failed validation and was quarantined.', quarantinedPath, {
        cause: error,
      });
    }
  }
}
