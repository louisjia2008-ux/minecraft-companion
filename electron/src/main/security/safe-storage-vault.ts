import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWriteFile } from '../persistence/atomic-file';

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export class SecureStorageUnavailableError extends Error {
  readonly reasonCode: 'encryption-unavailable' | 'weak-linux-backend';

  constructor(reasonCode: SecureStorageUnavailableError['reasonCode']) {
    super(
      reasonCode === 'weak-linux-backend'
        ? 'Secure secret storage requires GNOME Keyring or KWallet; Electron selected the basic_text backend.'
        : 'Electron safeStorage encryption is unavailable.',
    );
    this.name = 'SecureStorageUnavailableError';
    this.reasonCode = reasonCode;
  }
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

export class SafeStorageVault {
  readonly #root: string;
  readonly #safeStorage: SafeStorageAdapter;
  readonly #platform: NodeJS.Platform;
  #cachedKey: Buffer | null = null;

  constructor(root: string, safeStorage: SafeStorageAdapter, platform: NodeJS.Platform = process.platform) {
    this.#root = root;
    this.#safeStorage = safeStorage;
    this.#platform = platform;
  }

  getBackend(): string {
    return this.#safeStorage.getSelectedStorageBackend?.() ?? 'platform-default';
  }

  isAvailable(): boolean {
    if (!this.#safeStorage.isEncryptionAvailable()) {
      return false;
    }
    return !(this.#platform === 'linux' && this.getBackend() === 'basic_text');
  }

  #assertAvailable(): void {
    if (!this.#safeStorage.isEncryptionAvailable()) {
      throw new SecureStorageUnavailableError('encryption-unavailable');
    }
    if (this.#platform === 'linux' && this.getBackend() === 'basic_text') {
      throw new SecureStorageUnavailableError('weak-linux-backend');
    }
  }

  async getVaultKey(): Promise<Buffer> {
    this.#assertAvailable();
    if (this.#cachedKey !== null) {
      return Buffer.from(this.#cachedKey);
    }

    const keyPath = join(this.#root, 'vault-key.safe');
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    let key: Buffer;
    if (await exists(keyPath)) {
      const encrypted = await readFile(keyPath);
      key = Buffer.from(this.#safeStorage.decryptString(encrypted), 'base64');
    } else {
      key = randomBytes(32);
      const encrypted = this.#safeStorage.encryptString(key.toString('base64'));
      await atomicWriteFile(keyPath, encrypted);
    }

    if (key.byteLength !== 32) {
      throw new Error('Stored vault key is invalid.');
    }
    this.#cachedKey = Buffer.from(key);
    return Buffer.from(key);
  }

  #secretPath(id: string): string {
    const digest = createHash('sha256').update(id).digest('hex');
    return join(this.#root, 'provider-secrets', `${digest}.safe`);
  }

  async setSecret(id: string, secret: string): Promise<void> {
    this.#assertAvailable();
    if (secret.length === 0 || secret.length > 16_384) {
      throw new Error('Secret length is outside the supported range.');
    }
    const encrypted = this.#safeStorage.encryptString(secret);
    await atomicWriteFile(this.#secretPath(id), encrypted);
  }

  async getSecret(id: string): Promise<string | null> {
    this.#assertAvailable();
    const path = this.#secretPath(id);
    if (!(await exists(path))) {
      return null;
    }
    return this.#safeStorage.decryptString(await readFile(path));
  }

  async hasSecret(id: string): Promise<boolean> {
    this.#assertAvailable();
    return exists(this.#secretPath(id));
  }

  async deleteSecret(id: string): Promise<void> {
    this.#assertAvailable();
    try {
      await unlink(this.#secretPath(id));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
}
