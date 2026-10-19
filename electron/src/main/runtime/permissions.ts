import type { PermissionDescriptor } from '../../shared';
import type { DomainRepository } from '../domain';
import type { PermissionGrant } from '../domain';

export class PermissionDeniedError extends Error {
  readonly capabilityId: string;

  constructor(capabilityId: string) {
    super(`Permission is required for capability ${capabilityId}.`);
    this.name = 'PermissionDeniedError';
    this.capabilityId = capabilityId;
  }
}

export interface PermissionAudit {
  capabilityId: string;
  action: 'granted' | 'consumed' | 'denied' | 'revoked';
  scope: PermissionGrant['scope'] | null;
  createdAt: string;
}

export class PermissionGate {
  readonly #repository: DomainRepository;
  readonly #sessionGrants = new Map<string, PermissionGrant>();
  readonly #audit: (entry: PermissionAudit) => void;

  constructor(repository: DomainRepository, audit: (entry: PermissionAudit) => void = () => undefined) {
    this.#repository = repository;
    this.#audit = audit;
  }

  async grant(
    capabilityId: string,
    scope: PermissionGrant['scope'],
    expiresAt: string | null = null,
    now = new Date(),
  ): Promise<PermissionGrant> {
    const grant: PermissionGrant = {
      capabilityId,
      scope,
      grantedAt: now.toISOString(),
      expiresAt,
      remainingUses: scope === 'once' ? 1 : null,
    };
    if (scope === 'always') {
      await this.#repository.transaction((state) => {
        state.persistentPermissionGrants = state.persistentPermissionGrants.filter(
          (item) => item.capabilityId !== capabilityId,
        );
        state.persistentPermissionGrants.push(grant);
      });
    } else {
      this.#sessionGrants.set(capabilityId, grant);
    }
    this.#audit({ capabilityId, action: 'granted', scope, createdAt: now.toISOString() });
    return grant;
  }

  async revoke(capabilityId: string, now = new Date()): Promise<void> {
    this.#sessionGrants.delete(capabilityId);
    await this.#repository.transaction((state) => {
      state.persistentPermissionGrants = state.persistentPermissionGrants.filter(
        (item) => item.capabilityId !== capabilityId,
      );
    });
    this.#audit({ capabilityId, action: 'revoked', scope: null, createdAt: now.toISOString() });
  }

  async consume(capabilityId: string, now = new Date()): Promise<void> {
    const sessionGrant = this.#sessionGrants.get(capabilityId);
    const persistentGrant = this.#repository
      .snapshot()
      .persistentPermissionGrants.find((item) => item.capabilityId === capabilityId);
    const grant = sessionGrant ?? persistentGrant;
    const expired = grant?.expiresAt !== null && grant?.expiresAt !== undefined && Date.parse(grant.expiresAt) <= now.getTime();
    if (grant === undefined || expired || grant.remainingUses === 0) {
      this.#audit({ capabilityId, action: 'denied', scope: grant?.scope ?? null, createdAt: now.toISOString() });
      throw new PermissionDeniedError(capabilityId);
    }
    if (grant.scope === 'once') {
      this.#sessionGrants.delete(capabilityId);
    }
    this.#audit({ capabilityId, action: 'consumed', scope: grant.scope, createdAt: now.toISOString() });
  }

  list(descriptors: ReadonlyArray<Omit<PermissionDescriptor, 'state' | 'expiresAt'>>): PermissionDescriptor[] {
    const persistent = this.#repository.snapshot().persistentPermissionGrants;
    return descriptors.map((descriptor) => {
      const session = this.#sessionGrants.get(descriptor.capabilityId);
      const always = persistent.find((item) => item.capabilityId === descriptor.capabilityId);
      const grant = session ?? always;
      return {
        ...descriptor,
        state: grant?.scope === 'always' ? 'always' : grant === undefined ? 'not-requested' : 'session',
        expiresAt: grant?.expiresAt ?? null,
      };
    });
  }
}
