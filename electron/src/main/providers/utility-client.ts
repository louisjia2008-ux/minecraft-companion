import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';

import { providerUtilityResponseSchema } from '../../utility/provider-protocol';
import type { ProviderUtilityCommand } from '../../utility/provider-protocol';
import type { ProviderAdapter, ProviderChatRequest, ProviderCredentials, ProviderStreamEvent } from './types';
import type { ProviderModel } from '../../shared';

interface StreamPending {
  kind: 'stream';
  queue: ProviderStreamEvent[];
  done: boolean;
  error: Error | null;
  wake: (() => void) | null;
}

interface ModelsPending {
  kind: 'models';
  resolve(models: ProviderModel[]): void;
  reject(error: Error): void;
}

type Pending = StreamPending | ModelsPending;

export class ProviderUtilityClient {
  readonly #process: UtilityProcess;
  readonly #pending = new Map<string, Pending>();

  constructor(modulePath = join(__dirname, 'utility.js')) {
    this.#process = utilityProcess.fork(modulePath, [], { serviceName: 'DeskPet Provider Runtime' });
    this.#process.on('message', (message) => this.#receive(message));
    this.#process.on('exit', () => {
      for (const pending of this.#pending.values()) {
        if (pending.kind === 'models') pending.reject(new Error('Provider utility exited.'));
        else {
          pending.error = new Error('Provider utility exited.');
          pending.done = true;
          pending.wake?.();
        }
      }
      this.#pending.clear();
    });
  }

  #receive(value: unknown): void {
    const parsed = providerUtilityResponseSchema.safeParse(value);
    if (!parsed.success) return;
    const response = parsed.data;
    const pending = this.#pending.get(response.requestId);
    if (pending === undefined) return;
    if (pending.kind === 'models') {
      if (response.kind === 'provider:models-result') pending.resolve(response.models);
      else if (response.kind === 'provider:error') pending.reject(new Error(response.errorCode));
      if (response.kind === 'provider:models-result' || response.kind === 'provider:error') this.#pending.delete(response.requestId);
      return;
    }
    if (response.kind === 'provider:event') pending.queue.push(response.event);
    else if (response.kind === 'provider:error') {
      pending.error = new Error(response.errorCode);
      pending.done = true;
    } else if (response.kind === 'provider:complete') pending.done = true;
    pending.wake?.();
    pending.wake = null;
  }

  adapter(credentials: ProviderCredentials): ProviderAdapter {
    return new UtilityProviderAdapter(this, credentials);
  }

  async *stream(credentials: ProviderCredentials, request: ProviderChatRequest, signal?: AbortSignal): AsyncGenerator<ProviderStreamEvent> {
    const requestId = randomUUID();
    const pending: StreamPending = { kind: 'stream', queue: [], done: false, error: null, wake: null };
    this.#pending.set(requestId, pending);
    const cancel = () => {
      this.#post({ version: 1, kind: 'provider:cancel', requestId });
      pending.error = new DOMException('Provider request cancelled.', 'AbortError');
      pending.done = true;
      pending.wake?.();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    this.#post({ version: 1, kind: 'provider:chat', requestId, credentials, request });
    try {
      while (!pending.done || pending.queue.length > 0) {
        if (pending.queue.length === 0) await new Promise<void>((resolve) => { pending.wake = resolve; });
        while (pending.queue.length > 0) {
          const event = pending.queue.shift();
          if (event !== undefined) yield event;
        }
        if (pending.error !== null) throw pending.error;
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.#pending.delete(requestId);
    }
  }

  models(credentials: ProviderCredentials, signal?: AbortSignal): Promise<ProviderModel[]> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.#post({ version: 1, kind: 'provider:cancel', requestId });
        this.#pending.delete(requestId);
        reject(new DOMException('Provider request cancelled.', 'AbortError'));
      };
      signal?.addEventListener('abort', cancel, { once: true });
      this.#pending.set(requestId, {
        kind: 'models',
        resolve: (models) => {
          signal?.removeEventListener('abort', cancel);
          resolve(models);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', cancel);
          reject(error);
        },
      });
      this.#post({ version: 1, kind: 'provider:models', requestId, credentials });
    });
  }

  #post(command: ProviderUtilityCommand): void {
    this.#process.postMessage(command);
  }

  dispose(): void {
    this.#process.kill();
  }
}

class UtilityProviderAdapter implements ProviderAdapter {
  constructor(
    private readonly client: ProviderUtilityClient,
    private readonly credentials: ProviderCredentials,
  ) {}

  streamChat(request: ProviderChatRequest, signal?: AbortSignal): AsyncGenerator<ProviderStreamEvent> {
    return this.client.stream(this.credentials, request, signal);
  }

  listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    return this.client.models(this.credentials, signal);
  }
}
