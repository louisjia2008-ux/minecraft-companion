import type { MemoryItem } from '../../shared';
import type { DomainRepository } from './repository';

export class MemoryService {
  constructor(private readonly repository: DomainRepository) {}

  list(): MemoryItem[] {
    return this.repository.snapshot().memories;
  }

  async upsert(
    input: Pick<MemoryItem, 'id' | 'text' | 'tags'>,
    source: MemoryItem['source'] = 'user',
    now = new Date(),
  ): Promise<MemoryItem> {
    return this.repository.transaction((state) => {
      const existing = state.memories.find((item) => item.id === input.id);
      if (existing !== undefined) {
        Object.assign(existing, input, { updatedAt: now.toISOString() });
        return structuredClone(existing);
      }
      const item: MemoryItem = { ...input, source, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      state.memories.push(item);
      return item;
    });
  }

  async remove(id: string): Promise<void> {
    await this.repository.transaction((state) => {
      state.memories = state.memories.filter((item) => item.id !== id);
    });
  }
}
