import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { redactSensitive } from './redaction';
import { SafeStorageVault } from './safe-storage-vault';

const roots: string[] = [];
const fixtureRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-vault-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const testSafeStorage = (backend = 'keychain') => ({
  isEncryptionAvailable: () => true,
  encryptString: (plaintext: string) => Buffer.from(`safe:${plaintext}`, 'utf8'),
  decryptString: (encrypted: Buffer) => encrypted.toString('utf8').slice(5),
  getSelectedStorageBackend: () => backend,
});

describe('SafeStorageVault', () => {
  it('protects a stable random vault key and provider secrets through safeStorage', async () => {
    const vault = new SafeStorageVault(await fixtureRoot(), testSafeStorage(), 'darwin');
    const firstKey = await vault.getVaultKey();
    const secondKey = await vault.getVaultKey();
    expect(firstKey).toHaveLength(32);
    expect(secondKey).toEqual(firstKey);
    await vault.setSecret('provider-id', 'not-for-logs');
    expect(await vault.getSecret('provider-id')).toBe('not-for-logs');
    expect(await vault.hasSecret('provider-id')).toBe(true);
  });

  it('fails closed when Linux selects basic_text', async () => {
    const vault = new SafeStorageVault(await fixtureRoot(), testSafeStorage('basic_text'), 'linux');
    expect(vault.isAvailable()).toBe(false);
    await expect(vault.setSecret('provider-id', 'secret')).rejects.toMatchObject({
      reasonCode: 'weak-linux-backend',
    });
  });
});

describe('redactSensitive', () => {
  it('redacts nested credential fields and bearer values without mutating safe metadata', () => {
    expect(
      redactSensitive({
        provider: 'openai',
        apiKey: 'sk-example',
        nested: { Authorization: 'Bearer top-secret', message: 'Bearer abc.def' },
      }),
    ).toEqual({
      provider: 'openai',
      apiKey: '[REDACTED]',
      nested: { Authorization: '[REDACTED]', message: 'Bearer [REDACTED]' },
    });
  });
});
