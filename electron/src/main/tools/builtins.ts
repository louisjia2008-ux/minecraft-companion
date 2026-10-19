import { cpus, freemem, platform, release, totalmem } from 'node:os';
import { z } from 'zod';

import type { ToolRegistry } from '../runtime';
import type { WorkspaceAccess } from './workspace';
import type { SecureWebReader } from './web-reader';

export interface BuiltinToolDependencies {
  workspace: WorkspaceAccess;
  web: SecureWebReader;
  notify(title: string, body: string): Promise<void>;
  createTimer(seconds: number, label: string): Promise<{ timerId: string }>;
  now?: () => Date;
}

export const registerBuiltinTools = (registry: ToolRegistry, dependencies: BuiltinToolDependencies): void => {
  registry.register({
    id: 'time.current', title: 'Current time', capabilityId: 'time.read', risk: 'low', sideEffect: false,
    inputSchema: z.object({ timezone: z.string().max(128).optional() }).strict(),
    execute: async (input) => {
      const parsed = input as { timezone?: string };
      const now = dependencies.now?.() ?? new Date();
      return { iso: now.toISOString(), formatted: new Intl.DateTimeFormat('en', { dateStyle: 'full', timeStyle: 'long', ...(parsed.timezone === undefined ? {} : { timeZone: parsed.timezone }) }).format(now) };
    },
  });
  registry.register({
    id: 'system.summary', title: 'System summary', capabilityId: 'system.read', risk: 'low', sideEffect: false,
    inputSchema: z.object({}).strict(),
    execute: async () => ({ platform: platform(), release: release(), cpuCount: cpus().length, totalMemory: totalmem(), freeMemory: freemem() }),
  });
  registry.register({
    id: 'timer.create', title: 'Create timer', capabilityId: 'timer.write', risk: 'medium', sideEffect: true,
    inputSchema: z.object({ seconds: z.number().int().min(1).max(86_400), label: z.string().max(240) }).strict(),
    execute: async (input) => {
      const parsed = input as { seconds: number; label: string };
      return dependencies.createTimer(parsed.seconds, parsed.label);
    },
  });
  registry.register({
    id: 'notification.send', title: 'Send notification', capabilityId: 'notification.write', risk: 'medium', sideEffect: true,
    inputSchema: z.object({ title: z.string().min(1).max(120), body: z.string().max(1_000) }).strict(),
    execute: async (input) => {
      const parsed = input as { title: string; body: string };
      await dependencies.notify(parsed.title, parsed.body);
      return { delivered: true };
    },
  });
  registry.register({
    id: 'workspace.read', title: 'Read workspace file', capabilityId: 'workspace.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({ path: z.string().min(1).max(1_024) }).strict(),
    execute: async (input) => ({ content: await dependencies.workspace.read((input as { path: string }).path) }),
  });
  registry.register({
    id: 'workspace.write', title: 'Write workspace file', capabilityId: 'workspace.write', risk: 'high', sideEffect: true,
    inputSchema: z.object({ path: z.string().min(1).max(1_024), content: z.string().max(1024 * 1024) }).strict(),
    execute: async (input) => {
      const parsed = input as { path: string; content: string };
      await dependencies.workspace.write(parsed.path, parsed.content);
      return { written: true };
    },
  });
  registry.register({
    id: 'web.read', title: 'Read HTTPS page', capabilityId: 'web.read', risk: 'medium', sideEffect: false,
    inputSchema: z.object({ url: z.url().max(2_048) }).strict(),
    execute: async (input, context) => dependencies.web.read((input as { url: string }).url, context.signal),
  });
};
