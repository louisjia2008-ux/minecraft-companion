import type { ProviderConfig } from '../../shared';
import type { DomainRepository } from '../domain';
import type { SafeStorageVault } from '../security';
import { OpenAICompatibleAdapter } from './openai-compatible';
import type { ProviderUtilityClient } from './utility-client';
import type { ProviderAdapter } from './types';

export class ProviderService {
  constructor(
    private readonly repository: DomainRepository,
    private readonly vault: SafeStorageVault,
    private readonly utility?: ProviderUtilityClient,
  ) {}

  list(): ProviderConfig[] {
    return this.repository.snapshot().providers;
  }

  async upsert(input: Omit<ProviderConfig, 'secretState'>, apiKey?: string): Promise<ProviderConfig> {
    if (apiKey !== undefined) {
      await this.vault.setSecret(input.id, apiKey);
    }
    const secretState = this.vault.isAvailable()
      ? (await this.vault.hasSecret(input.id))
        ? 'configured'
        : 'missing'
      : 'unavailable';
    const config: ProviderConfig = { ...input, secretState };
    await this.repository.transaction((state) => {
      const index = state.providers.findIndex((item) => item.id === config.id);
      if (index === -1) state.providers.push(config);
      else state.providers[index] = config;
    });
    return config;
  }

  async adapter(id: string): Promise<ProviderAdapter> {
    const config = this.repository.snapshot().providers.find((item) => item.id === id);
    if (config === undefined) throw new Error('Provider does not exist.');
    const credentials = { config, apiKey: await this.vault.getSecret(id) };
    return this.utility?.adapter(credentials) ?? new OpenAICompatibleAdapter(credentials);
  }

  async remove(id: string): Promise<void> {
    await this.vault.deleteSecret(id);
    await this.repository.transaction((state) => {
      state.providers = state.providers.filter((item) => item.id !== id);
    });
  }

  async clearSecret(id: string): Promise<ProviderConfig> {
    await this.vault.deleteSecret(id);
    return this.repository.transaction((state) => {
      const config = state.providers.find((item) => item.id === id);
      if (config === undefined) throw new Error('Provider does not exist.');
      config.secretState = 'missing';
      return structuredClone(config);
    });
  }
}
