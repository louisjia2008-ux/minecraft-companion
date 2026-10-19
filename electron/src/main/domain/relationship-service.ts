import type { RelationshipState } from '../../shared';
import type { DomainRepository } from './repository';

export class RelationshipService {
  constructor(private readonly repository: DomainRepository) {}

  get(): RelationshipState {
    return this.repository.snapshot().relationship;
  }

  async setNickname(nickname: string): Promise<RelationshipState> {
    return this.repository.transaction((state) => {
      state.relationship.nickname = nickname;
      return structuredClone(state.relationship);
    });
  }

  async recordInteraction(delta: number, now = new Date()): Promise<RelationshipState> {
    return this.repository.transaction((state) => {
      state.relationship.affinity = Math.min(100, Math.max(0, state.relationship.affinity + delta));
      state.relationship.level = Math.min(100, Math.max(1, Math.floor(state.relationship.affinity / 10) + 1));
      state.relationship.lastInteractionAt = now.toISOString();
      return structuredClone(state.relationship);
    });
  }
}
