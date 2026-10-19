import type { DomainRepository, SideEffectRecord } from '../domain';

export class EffectLedger {
  constructor(private readonly repository: DomainRepository) {}

  find(key: string): SideEffectRecord | null {
    return this.repository.snapshot().sideEffects.find((item) => item.key === key) ?? null;
  }

  async record(record: SideEffectRecord): Promise<SideEffectRecord> {
    return this.repository.transaction((state) => {
      const existing = state.sideEffects.find((item) => item.key === record.key);
      if (existing !== undefined) {
        return structuredClone(existing);
      }
      state.sideEffects.push(record);
      return record;
    });
  }
}
