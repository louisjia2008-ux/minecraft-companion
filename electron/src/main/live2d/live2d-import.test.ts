import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';

import { CubismCoreImporter } from './core-importer';
import { ModelArchiveImporter } from './model-importer';

const roots: string[] = [];
const fixtureRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-live2d-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const validModel = (moc = 'model.moc3') => ({
  Version: 3,
  FileReferences: { Moc: moc, Textures: ['texture.png'], Motions: {} },
});

const saveZip = async (root: string, build: (zip: JSZip) => void): Promise<string> => {
  const zip = new JSZip();
  build(zip);
  const path = join(root, 'model.zip');
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
  return path;
};

describe('CubismCoreImporter', () => {
  it('imports only an allowlisted exact Core and keeps the source outside managed storage', async () => {
    const root = await fixtureRoot();
    const sourceDirectory = join(root, 'source');
    await mkdir(sourceDirectory);
    const source = join(sourceDirectory, 'live2dcubismcore.min.js');
    const bytes = Buffer.from('licensed fixture core');
    await writeFile(source, bytes);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const importer = new CubismCoreImporter(join(root, 'managed'), new Set([hash]));
    const result = await importer.import(source);
    expect(result.sha256).toBe(hash);
    expect(await readFile(result.path, 'utf8')).toBe('licensed fixture core');
    expect(await readFile(source, 'utf8')).toBe('licensed fixture core');
  });

  it('rejects a modified or unknown Core hash', async () => {
    const root = await fixtureRoot();
    const source = join(root, 'live2dcubismcore.min.js');
    await writeFile(source, 'unknown core', 'utf8');
    await expect(new CubismCoreImporter(join(root, 'managed')).import(source)).rejects.toThrow('allowlist');
  });
});

describe('ModelArchiveImporter', () => {
  it('stages a valid model and persists it only after renderer acknowledgement', async () => {
    const root = await fixtureRoot();
    const archive = await saveZip(root, (zip) => {
      zip.file('avatar/avatar.model3.json', JSON.stringify(validModel()));
      zip.file('avatar/model.moc3', Buffer.from([1, 2, 3]));
      zip.file('avatar/texture.png', Buffer.from([4, 5, 6]));
    });
    const importer = new ModelArchiveImporter(join(root, 'managed'));
    const pending = await importer.stage(archive);
    expect((await importer.getConfig()).active).toBeNull();
    expect(await access(join(pending.stagingDirectory, pending.modelJsonRelativePath))).toBeUndefined();
    const committed = await importer.commit(pending.importId);
    expect(committed.active).toMatchObject({ id: pending.importId, name: 'avatar' });
    expect((await importer.getConfig()).active?.id).toBe(pending.importId);
  });

  it('rejects traversal, symbolic links, oversized expansion, multiple models, and missing references', async () => {
    const root = await fixtureRoot();
    const importer = new ModelArchiveImporter(join(root, 'managed'), { expandedBytes: 1_024, singleFileBytes: 512 });

    const traversal = await saveZip(root, (zip) => {
      zip.file('../avatar.model3.json', JSON.stringify(validModel()));
      zip.file('../model.moc3', 'moc');
      zip.file('../texture.png', 'png');
    });
    await expect(importer.stage(traversal)).rejects.toThrow('traversal');

    const symlink = await saveZip(root, (zip) => {
      zip.file('avatar.model3.json', JSON.stringify(validModel()));
      zip.file('model.moc3', 'moc');
      zip.file('texture.png', 'png');
      zip.file('linked.json', 'target', { unixPermissions: 0o120777 });
    });
    await expect(importer.stage(symlink)).rejects.toThrow('symbolic link');

    const oversized = await saveZip(root, (zip) => {
      zip.file('avatar.model3.json', JSON.stringify(validModel()));
      zip.file('model.moc3', 'x'.repeat(900));
      zip.file('texture.png', 'x'.repeat(900));
    });
    await expect(importer.stage(oversized)).rejects.toThrow(/oversized|expanded size/);

    const multiple = await saveZip(root, (zip) => {
      zip.file('a.model3.json', JSON.stringify(validModel('a.moc3')));
      zip.file('b.model3.json', JSON.stringify(validModel('b.moc3')));
      zip.file('a.moc3', 'a');
      zip.file('b.moc3', 'b');
      zip.file('texture.png', 'png');
    });
    await expect(importer.stage(multiple)).rejects.toThrow('exactly one');

    const missing = await saveZip(root, (zip) => {
      zip.file('avatar.model3.json', JSON.stringify(validModel('missing.moc3')));
      zip.file('texture.png', 'png');
    });
    await expect(importer.stage(missing)).rejects.toThrow('missing or unsafe asset');
  });

  it('removes a cancelled staged model without changing the prior active configuration', async () => {
    const root = await fixtureRoot();
    const archive = await saveZip(root, (zip) => {
      zip.file('avatar.model3.json', JSON.stringify(validModel()));
      zip.file('model.moc3', 'moc');
      zip.file('texture.png', 'png');
    });
    const importer = new ModelArchiveImporter(join(root, 'managed'));
    const pending = await importer.stage(archive);
    await importer.cancel(pending.importId);
    await expect(access(pending.stagingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await importer.getConfig()).active).toBeNull();
  });
});
