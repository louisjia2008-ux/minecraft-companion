import type { ProviderKind } from './contracts';

export interface ProviderDefinition {
  kind: ProviderKind;
  label: string;
  defaultBaseUrl: string;
  local: boolean;
  apiKeyRequired: boolean;
  protocol: 'openai-compatible';
}

export const providerDefinitions: readonly ProviderDefinition[] = [
  { kind: 'openai', label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', local: false, apiKeyRequired: true, protocol: 'openai-compatible' },
  { kind: 'openai-compatible', label: 'OpenAI-compatible', defaultBaseUrl: 'https://example.invalid/v1', local: false, apiKeyRequired: true, protocol: 'openai-compatible' },
  { kind: 'minimax', label: 'MiniMax', defaultBaseUrl: 'https://api.minimax.chat/v1', local: false, apiKeyRequired: true, protocol: 'openai-compatible' },
  { kind: 'glm', label: 'GLM', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', local: false, apiKeyRequired: true, protocol: 'openai-compatible' },
  { kind: 'deepseek', label: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com/v1', local: false, apiKeyRequired: true, protocol: 'openai-compatible' },
  { kind: 'ollama', label: 'Ollama', defaultBaseUrl: 'http://127.0.0.1:11434/v1', local: true, apiKeyRequired: false, protocol: 'openai-compatible' },
  { kind: 'lm-studio', label: 'LM Studio', defaultBaseUrl: 'http://127.0.0.1:1234/v1', local: true, apiKeyRequired: false, protocol: 'openai-compatible' },
] as const;
