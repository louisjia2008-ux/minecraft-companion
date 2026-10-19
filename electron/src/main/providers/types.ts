import type { ProviderConfig, ProviderModel } from '../../shared';

export interface ProviderChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; argumentsJson: string }>;
}

export interface ProviderToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderChatRequest {
  model: string;
  messages: ProviderChatMessage[];
  tools?: ProviderToolDefinition[];
  temperature?: number;
}

export type ProviderStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; name: string; argumentsJson: string }
  | { type: 'usage'; inputTokens: number | null; outputTokens: number | null }
  | { type: 'done'; finishReason: string | null };

export interface ProviderAdapter {
  streamChat(request: ProviderChatRequest, signal?: AbortSignal): AsyncGenerator<ProviderStreamEvent>;
  listModels(signal?: AbortSignal): Promise<ProviderModel[]>;
}

export interface ProviderCredentials {
  config: ProviderConfig;
  apiKey: string | null;
}
