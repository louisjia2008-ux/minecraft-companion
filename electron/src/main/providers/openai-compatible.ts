import { z } from 'zod';

import type { ProviderConfig, ProviderModel } from '../../shared';
import type {
  ProviderAdapter,
  ProviderChatRequest,
  ProviderCredentials,
  ProviderStreamEvent,
} from './types';

const modelListSchema = z
  .object({
    data: z.array(z.object({ id: z.string().min(1).max(240) }).passthrough()).max(10_000),
  })
  .passthrough();

const streamChunkSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            delta: z
              .object({
                content: z.string().max(256_000).nullish(),
                tool_calls: z
                  .array(
                    z
                      .object({
                        index: z.number().int().nonnegative(),
                        id: z.string().max(240).optional(),
                        function: z
                          .object({ name: z.string().max(128).optional(), arguments: z.string().max(256_000).optional() })
                          .optional(),
                      })
                      .passthrough(),
                  )
                  .max(128)
                  .optional(),
              })
              .passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(16),
    usage: z
      .object({ prompt_tokens: z.number().int().nonnegative().nullish(), completion_tokens: z.number().int().nonnegative().nullish() })
      .nullish(),
  })
  .passthrough();

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`Provider request failed with HTTP ${status} (${code}).`);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.code = code;
  }
}

const normalizedBaseUrl = (config: ProviderConfig): URL => {
  const url = new URL(config.baseUrl);
  const isLocal = config.kind === 'ollama' || config.kind === 'lm-studio';
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (isLocal) {
    if (!loopback || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new Error(`${config.kind} must use an HTTP(S) loopback endpoint.`);
    }
  } else if (url.protocol !== 'https:') {
    throw new Error(`${config.kind} requires an HTTPS endpoint.`);
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
};

const endpoint = (base: URL, path: string): string => {
  const url = new URL(base.toString());
  url.pathname = `${url.pathname}${path}`.replace(/\/{2,}/g, '/');
  return url.toString();
};

const errorCodeForStatus = (status: number): string => {
  if (status === 401 || status === 403) return 'provider.authentication';
  if (status === 408 || status === 504) return 'provider.timeout';
  if (status === 429) return 'provider.rateLimit';
  if (status >= 500) return 'provider.unavailable';
  return 'provider.request';
};

const combineSignals = (caller: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('Provider request timed out.', 'TimeoutError')), timeoutMs);
  const abort = () => controller.abort(caller?.reason);
  caller?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      caller?.removeEventListener('abort', abort);
    },
  };
};

const headers = (credentials: ProviderCredentials): Record<string, string> => {
  const result: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (credentials.apiKey !== null && credentials.apiKey.length > 0) {
    result.authorization = `Bearer ${credentials.apiKey}`;
  }
  return result;
};

const assertOk = async (response: Response): Promise<void> => {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderHttpError(response.status, errorCodeForStatus(response.status));
  }
};

interface ToolAccumulator {
  id: string;
  name: string;
  argumentsJson: string;
}

const MAX_SSE_LINE_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_MODEL_LIST_BYTES = 4 * 1024 * 1024;

const readBoundedText = async (response: Response, maximum: number): Promise<string> => {
  if (response.body === null) throw new Error('Provider returned an empty response body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new Error('Provider response exceeded its size limit.');
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
};

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly #credentials: ProviderCredentials;
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(credentials: ProviderCredentials, fetchImplementation: typeof fetch = fetch, timeoutMs = 60_000) {
    this.#credentials = credentials;
    this.#baseUrl = normalizedBaseUrl(credentials.config);
    this.#fetch = fetchImplementation;
    this.#timeoutMs = timeoutMs;
  }

  async *streamChat(request: ProviderChatRequest, callerSignal?: AbortSignal): AsyncGenerator<ProviderStreamEvent> {
    const { signal, dispose } = combineSignals(callerSignal, this.#timeoutMs);
    try {
      const response = await this.#fetch(endpoint(this.#baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: headers(this.#credentials),
        signal,
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
            ...(message.toolCalls === undefined
              ? {}
              : {
                  tool_calls: message.toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: call.argumentsJson },
                  })),
                }),
          })),
          stream: true,
          stream_options: { include_usage: true },
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.tools === undefined
            ? {}
            : {
                tools: request.tools.map((tool) => ({
                  type: 'function',
                  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
                })),
              }),
        }),
      });
      await assertOk(response);
      if (response.body === null) {
        throw new Error('Provider returned an empty streaming body.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const tools = new Map<number, ToolAccumulator>();
      let buffer = '';
      let receivedBytes = 0;
      let finishReason: string | null = null;
      while (true) {
        const { done, value } = await reader.read();
        receivedBytes += value?.byteLength ?? 0;
        if (receivedBytes > MAX_STREAM_BYTES) {
          await reader.cancel();
          throw new Error('Provider stream exceeded its size limit.');
        }
        buffer += decoder.decode(value, { stream: !done });
        if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_LINE_BYTES) {
          await reader.cancel();
          throw new Error('Provider stream line exceeded its size limit.');
        }
        const lines = buffer.split(/\r?\n/);
        buffer = done ? '' : (lines.pop() ?? '');
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data.length === 0 || data === '[DONE]') continue;
          const chunk = streamChunkSchema.parse(JSON.parse(data));
          const choice = chunk.choices[0];
          if (choice === undefined) continue;
          if (choice.delta.content !== undefined && choice.delta.content !== null && choice.delta.content.length > 0) {
            yield { type: 'text', text: choice.delta.content };
          }
          for (const delta of choice.delta.tool_calls ?? []) {
            const accumulator = tools.get(delta.index) ?? { id: '', name: '', argumentsJson: '' };
            accumulator.id += delta.id ?? '';
            accumulator.name += delta.function?.name ?? '';
            accumulator.argumentsJson += delta.function?.arguments ?? '';
            if (accumulator.argumentsJson.length > MAX_SSE_LINE_BYTES || accumulator.name.length > 128 || accumulator.id.length > 240) {
              throw new Error('Provider tool call exceeded its size limit.');
            }
            tools.set(delta.index, accumulator);
          }
          finishReason = choice.finish_reason ?? finishReason;
          if (chunk.usage !== undefined && chunk.usage !== null) {
            yield {
              type: 'usage',
              inputTokens: chunk.usage.prompt_tokens ?? null,
              outputTokens: chunk.usage.completion_tokens ?? null,
            };
          }
        }
        if (done) break;
      }
      for (const tool of [...tools.entries()].sort(([left], [right]) => left - right).map(([, value]) => value)) {
        yield { type: 'tool-call', ...tool };
      }
      yield { type: 'done', finishReason };
    } finally {
      dispose();
    }
  }

  async listModels(callerSignal?: AbortSignal): Promise<ProviderModel[]> {
    const { signal, dispose } = combineSignals(callerSignal, Math.min(this.#timeoutMs, 20_000));
    try {
      const response = await this.#fetch(endpoint(this.#baseUrl, '/models'), {
        method: 'GET',
        headers: headers(this.#credentials),
        signal,
      });
      await assertOk(response);
      const parsed = modelListSchema.parse(JSON.parse(await readBoundedText(response, MAX_MODEL_LIST_BYTES)));
      return parsed.data
        .map((model) => ({ id: model.id, displayName: model.id, contextWindow: null, supportsTools: this.#credentials.config.supportsTools }))
        .sort((left, right) => left.id.localeCompare(right.id));
    } finally {
      dispose();
    }
  }
}
