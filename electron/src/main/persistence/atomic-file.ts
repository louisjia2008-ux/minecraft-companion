import { mkdir, open, rename } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const atomicWriteFile = async (path: string, data: string | Uint8Array): Promise<void> => {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(temporaryPath, path);

  try {
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    // Directory fsync is unavailable on some supported filesystems and Windows.
  }
};
