import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ToolRegistry } from '../runtime';
import { createUtilityHandler } from '../../utility/host';
import { SecureWebReader, assertSafeHttpsTarget } from './web-reader';
import { WorkspaceAccess } from './workspace';

const roots: string[] = [];
const fixtureRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-tools-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WorkspaceAccess', () => {
  it('reads and atomically writes only contained, bounded document types', async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, 'readme.md'), 'hello', 'utf8');
    const workspace = new WorkspaceAccess(root);
    expect(await workspace.read('readme.md')).toBe('hello');
    await workspace.write('notes/today.txt', 'focused');
    expect(await readFile(join(root, 'notes/today.txt'), 'utf8')).toBe('focused');
    await expect(workspace.write('../escape.txt', 'no')).rejects.toThrow('escapes');
    await expect(workspace.write('script.sh', 'no')).rejects.toThrow('extension');
  });

  it('rejects symbolic-link escapes', async () => {
    const root = await fixtureRoot();
    const outside = await fixtureRoot();
    await writeFile(join(outside, 'secret.txt'), 'private', 'utf8');
    await symlink(outside, join(root, 'linked'));
    const workspace = new WorkspaceAccess(root);
    await expect(workspace.read('linked/secret.txt')).rejects.toThrow('escapes');
    await expect(workspace.write('linked/new.txt', 'no')).rejects.toThrow('symbolic link');
  });
});

describe('SecureWebReader', () => {
  it('rejects private DNS answers, credentials, non-HTTPS, and nonstandard ports', async () => {
    const privateResolver = async () => [{ address: '127.0.0.1', family: 4 as const }];
    await expect(assertSafeHttpsTarget(new URL('https://example.com'), privateResolver)).rejects.toThrow('private');
    await expect(assertSafeHttpsTarget(new URL('http://example.com'), privateResolver)).rejects.toThrow('HTTPS');
    const credentialUrl = new URL(`https://${['fixture-user', 'fixture-pass'].join(':')}@example.invalid`);
    await expect(assertSafeHttpsTarget(credentialUrl, privateResolver)).rejects.toThrow('credentials');
    await expect(assertSafeHttpsTarget(new URL('https://example.com:8443'), privateResolver)).rejects.toThrow('port 443');
    for (const address of ['192.0.2.10', '198.51.100.4', '203.0.113.8', '::ffff:10.0.0.1', '2001:db8::1', 'ff02::1']) {
      const family = address.includes(':') ? 6 as const : 4 as const;
      await expect(assertSafeHttpsTarget(new URL('https://example.com'), async () => [{ address, family }])).rejects.toThrow('private');
    }
  });

  it('pins a public address and enforces response size', async () => {
    const resolver = async () => [{ address: '93.184.216.34', family: 4 as const }];
    const reader = new SecureWebReader({
      resolver,
      maxBytes: 4,
      requester: async () => ({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: (async function* () {
          yield Buffer.from('12345');
        })(),
      }),
    });
    await expect(reader.read('https://example.com')).rejects.toThrow('size limit');
  });
});

describe('utility request boundary', () => {
  it('requires matching task identity schema and declared capability', async () => {
    const tools = new ToolRegistry();
    tools.register({
      id: 'echo', title: 'Echo', capabilityId: 'echo.read', risk: 'low', sideEffect: false,
      inputSchema: z.object({ text: z.string() }).strict(),
      execute: async (input) => input,
    });
    const handler = createUtilityHandler(tools);
    const ids = { requestId: randomUUID(), runId: randomUUID(), taskId: randomUUID() };
    await expect(handler({ version: 1, ...ids, capabilityId: 'wrong', toolId: 'echo', input: { text: 'hi' } }, new AbortController().signal)).resolves.toMatchObject({ ok: false });
    await expect(handler({ version: 1, ...ids, capabilityId: 'echo.read', toolId: 'echo', input: { text: 'hi' } }, new AbortController().signal)).resolves.toMatchObject({ ok: true, output: { text: 'hi' } });
  });
});
