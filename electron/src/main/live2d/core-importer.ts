import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { atomicWriteFile } from '../persistence';

export const SUPPORTED_CUBISM_CORE_HASHES = new Set([
  '944988f1523c9f888afe3611b630121ff503ea6246971d2eeee76f45cbfb8004',
]);

const CORE_FILENAME = 'live2dcubismcore.min.js';
const MAX_CORE_BYTES = 8 * 1024 * 1024;

export interface CoreImportResult {
  path: string;
  sha256: string;
  bytes: number;
}

export class CubismCoreImporter {
  constructor(
    private readonly managedRoot: string,
    private readonly allowedHashes: ReadonlySet<string> = SUPPORTED_CUBISM_CORE_HASHES,
  ) {}

  async validate(sourcePath: string): Promise<{ contents: Buffer; sha256: string }> {
    if (basename(sourcePath).toLowerCase() !== CORE_FILENAME) {
      throw new Error(`Cubism Core must be named ${CORE_FILENAME}.`);
    }
    const contents = await readFile(sourcePath);
    if (contents.byteLength === 0 || contents.byteLength > MAX_CORE_BYTES) {
      throw new Error('Cubism Core size is outside the supported range.');
    }
    const sha256 = createHash('sha256').update(contents).digest('hex');
    if (!this.allowedHashes.has(sha256)) {
      throw new Error('Cubism Core hash is not on the supported allowlist.');
    }
    return { contents, sha256 };
  }

  async import(sourcePath: string): Promise<CoreImportResult> {
    const { contents, sha256 } = await this.validate(sourcePath);
    const destination = join(this.managedRoot, 'core', CORE_FILENAME);
    await atomicWriteFile(destination, contents);
    return { path: destination, sha256, bytes: contents.byteLength };
  }

  async status(): Promise<CoreImportResult | null> {
    const destination = join(this.managedRoot, 'core', CORE_FILENAME);
    try {
      const { contents, sha256 } = await this.validate(destination);
      return { path: destination, sha256, bytes: contents.byteLength };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
}
