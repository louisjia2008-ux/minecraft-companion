import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProviderConfig } from '../../shared';
import { OpenAICompatibleAdapter, ProviderHttpError } from './openai-compatible';

const servers: Array<ReturnType<typeof createServer>> = [];
const listen = async (handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))),
  );
});

const config = (baseUrl: string): ProviderConfig => ({
  id: '0e5e71f9-5987-486d-bb03-f75c4c693783',
  kind: 'ollama',
  name: 'Fixture',
  baseUrl,
  model: 'fixture-model',
  enabled: true,
  supportsTools: true,
  secretState: 'missing',
});

describe('OpenAICompatibleAdapter', () => {
  it('parses streamed text, fragmented tool calls, usage, and completion', async () => {
    const baseUrl = await listen((request, response) => {
      if (request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}\n\n');
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_","function":{"name":"time.","arguments":"{\\""}}]},"finish_reason":null}]}\n\n');
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"current","arguments":"timezone\\":\\"UTC\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":5}}\n\n');
      response.end('data: [DONE]\n\n');
    });
    const adapter = new OpenAICompatibleAdapter({ config: config(baseUrl), apiKey: null });
    const events = [];
    for await (const event of adapter.streamChat({ model: 'fixture-model', messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event);
    }
    expect(events).toContainEqual({ type: 'text', text: 'Hello ' });
    expect(events).toContainEqual({ type: 'tool-call', id: 'call_1', name: 'time.current', argumentsJson: '{"timezone":"UTC"}' });
    expect(events).toContainEqual({ type: 'usage', inputTokens: 3, outputTokens: 5 });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('lists models and maps authentication errors without returning response secrets', async () => {
    let unauthorized = false;
    const baseUrl = await listen((_request, response) => {
      if (unauthorized) {
        response.writeHead(401, { 'content-type': 'application/json' }).end('{"apiKey":"must-not-leak"}');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"z-model"},{"id":"a-model"}]}');
      }
    });
    const adapter = new OpenAICompatibleAdapter({ config: config(baseUrl), apiKey: 'local-fixture-secret' });
    expect((await adapter.listModels()).map((model) => model.id)).toEqual(['a-model', 'z-model']);
    unauthorized = true;
    const error = await adapter.listModels().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 401, code: 'provider.authentication' });
    expect(String(error)).not.toContain('must-not-leak');
    expect(String(error)).not.toContain('local-fixture-secret');
  });

  it('serializes declared tools and assistant tool-call history using the OpenAI contract', async () => {
    let receivedBody: unknown = null;
    const baseUrl = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
    });
    const adapter = new OpenAICompatibleAdapter({ config: config(baseUrl), apiKey: null });
    const events = [];
    for await (const event of adapter.streamChat({
      model: 'fixture-model',
      messages: [
        { role: 'user', content: 'time?' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'time.current', argumentsJson: '{}' }] },
        { role: 'tool', content: '{"iso":"now"}', toolCallId: 'call_1' },
      ],
      tools: [{ name: 'time.current', description: 'Current time', parameters: { type: 'object' } }],
    })) events.push(event);

    expect(receivedBody).toMatchObject({
      tools: [{ type: 'function', function: { name: 'time.current', parameters: { type: 'object' } } }],
      messages: [
        { role: 'user', content: 'time?' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'time.current', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1' },
      ],
    });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('propagates caller cancellation during streaming', async () => {
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"first"},"finish_reason":null}]}\n\n');
    });
    const adapter = new OpenAICompatibleAdapter({ config: config(baseUrl), apiKey: null });
    const controller = new AbortController();
    const iterator = adapter.streamChat({ model: 'fixture-model', messages: [{ role: 'user', content: 'hi' }] }, controller.signal);
    expect(await iterator.next()).toMatchObject({ value: { type: 'text', text: 'first' } });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects insecure non-local provider endpoints before making a request', () => {
    const insecure = { ...config('http://example.com/v1'), kind: 'openai' as const };
    expect(() => new OpenAICompatibleAdapter({ config: insecure, apiKey: null })).toThrow('requires an HTTPS endpoint');
  });
});
