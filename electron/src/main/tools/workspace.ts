import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

import { atomicWriteFile } from '../persistence';

const MAX_FILE_BYTES = 1024 * 1024;
const WRITABLE_EXTENSIONS = new Set(['.csv', '.json', '.md', '.txt']);

const isContained = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

export class WorkspaceAccess {
  readonly #rootInput: string;
  #root: string | null = null;

  constructor(root: string) {
    this.#rootInput = resolve(root);
  }

  async #getRoot(): Promise<string> {
    this.#root ??= await realpath(this.#rootInput);
    return this.#root;
  }

  async #readPath(relativePath: string): Promise<string> {
    if (isAbsolute(relativePath) || relativePath.includes('\0')) throw new Error('Workspace path must be relative.');
    const root = await this.#getRoot();
    const candidate = await realpath(join(root, relativePath));
    if (!isContained(root, candidate)) throw new Error('Workspace path escapes the granted root.');
    return candidate;
  }

  async read(relativePath: string): Promise<string> {
    const path = await this.#readPath(relativePath);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Workspace file is not a supported regular file.');
    return readFile(path, 'utf8');
  }

  async write(relativePath: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('Workspace write exceeds the size limit.');
    if (!WRITABLE_EXTENSIONS.has(extname(relativePath).toLowerCase())) throw new Error('Workspace file extension is not writable.');
    if (isAbsolute(relativePath) || relativePath.includes('\0')) throw new Error('Workspace path must be relative.');
    const root = await this.#getRoot();
    const lexicalTarget = resolve(root, relativePath);
    if (!isContained(root, lexicalTarget)) throw new Error('Workspace path escapes the granted root.');
    await mkdir(dirname(lexicalTarget), { recursive: true, mode: 0o700 });
    const canonicalParent = await realpath(dirname(lexicalTarget));
    if (!isContained(root, canonicalParent)) throw new Error('Workspace parent escapes through a symbolic link.');
    await atomicWriteFile(join(canonicalParent, relative(canonicalParent, lexicalTarget)), content);
  }
}
