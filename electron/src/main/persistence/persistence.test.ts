import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AtomicJsonStore } from './atomic-json-store';
import { EncryptedJsonStore } from './encrypted-json-store';
import { PersistenceCorruptionError } from './errors';

const roots: string[] = [];
const fixtureRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-persistence-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AtomicJsonStore', () => {
  it('round-trips validated data and migrates older versions', async () => {
    const root = await fixtureRoot();
    const path = join(root, 'state.json');
    const schema = z.object({ count: z.number().int(), label: z.string() }).strict();
    const store = new AtomicJsonStore({ path, schemaVersion: 2, schema, defaultValue: () => ({ count: 0, label: '' }), migrations: { 1: (data) => ({ ...(data as object), label: 'migrated' }) } });
    await writeFile(path, JSON.stringify({ schemaVersion: 1, data: { count: 4 } }), 'utf8');
    expect(await store.load()).toEqual({ count: 4, label: 'migrated' });
    await store.save({ count: 5, label: 'saved' });
    expect(await store.load()).toEqual({ count: 5, label: 'saved' });
  });

  it('quarantines invalid data instead of replacing it with an empty default', async () => {
    const root = await fixtureRoot();
    const path = join(root, 'state.json');
    await writeFile(path, '{broken', 'utf8');
    const store = new AtomicJsonStore({ path, schemaVersion: 1, schema: z.object({ ok: z.boolean() }).strict(), defaultValue: () => ({ ok: false }) });
    const error = await store.load().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PersistenceCorruptionError);
    expect(await readFile((error as PersistenceCorruptionError).quarantinedPath, 'utf8')).toBe('{broken');
  });
});

describe('EncryptedJsonStore', () => {
  it('detects AES-GCM tampering and quarantines the ciphertext', async () => {
    const root = await fixtureRoot();
    const path = join(root, 'private.json');
    const key = Buffer.alloc(32, 7);
    const vault = { getVaultKey: async () => key };
    const store = new EncryptedJsonStore({ path, schema: z.object({ private: z.string() }).strict(), defaultValue: () => ({ private: '' }), vault });
    await store.save({ private: 'local only' });
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    parsed.ciphertext = Buffer.from('tampered').toString('base64');
    await writeFile(path, JSON.stringify(parsed), 'utf8');
    await expect(store.load()).rejects.toBeInstanceOf(PersistenceCorruptionError);
  });
});
