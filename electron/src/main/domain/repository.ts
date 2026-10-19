import { EncryptedJsonStore } from '../persistence';
import type { VaultKeyProvider } from '../persistence';
import { createDefaultState, persistentStateSchema } from './schemas';
import type { PersistentState } from './schemas';

export class DomainRepository {
  readonly #store: EncryptedJsonStore<PersistentState>;
  #state: PersistentState | null = null;
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(path: string, vault: VaultKeyProvider) {
    this.#store = new EncryptedJsonStore({ path, schema: persistentStateSchema, defaultValue: createDefaultState, vault });
  }

  async initialize(): Promise<void> {
    if (this.#state === null) {
      this.#state = await this.#store.load();
    }
  }

  snapshot(): PersistentState {
    if (this.#state === null) {
      throw new Error('DomainRepository must be initialized before use.');
    }
    return structuredClone(this.#state);
  }

  async transaction<T>(mutation: (draft: PersistentState) => T | Promise<T>): Promise<T> {
    let resolveResult: ((value: T) => void) | undefined;
    let rejectResult: ((reason: unknown) => void) | undefined;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const execute = async (): Promise<void> => {
      try {
        const current = this.snapshot();
        const output = await mutation(current);
        const validated = persistentStateSchema.parse(current);
        await this.#store.save(validated);
        this.#state = validated;
        resolveResult?.(output);
      } catch (error) {
        rejectResult?.(error);
      }
    };
    this.#mutationQueue = this.#mutationQueue.then(execute, execute);
    await this.#mutationQueue;
    return result;
  }
}
