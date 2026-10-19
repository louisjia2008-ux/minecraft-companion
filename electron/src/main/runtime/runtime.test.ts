import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DomainRepository, ScheduleService } from '../domain';
import { AgentLimitError, AgentRuntime } from './agent-runtime';
import { EffectLedger } from './effect-ledger';
import { PermissionDeniedError, PermissionGate } from './permissions';
import { RuntimeScheduler } from './scheduler';
import { TaskEventStream } from './task-event-stream';
import { ToolRegistry } from './tool-registry';

const roots: string[] = [];
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-runtime-'));
  roots.push(root);
  const repository = new DomainRepository(join(root, 'domain.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 8) });
  await repository.initialize();
  const events = new TaskEventStream(join(root, 'events.jsonl'));
  await events.initialize();
  return { root, repository, events };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PermissionGate', () => {
  it('consumes one-shot grants and persists always grants', async () => {
    const { repository } = await fixture();
    const gate = new PermissionGate(repository);
    await gate.grant('notify', 'once');
    await gate.consume('notify');
    await expect(gate.consume('notify')).rejects.toBeInstanceOf(PermissionDeniedError);
    await gate.grant('workspace.read', 'always');
    await new PermissionGate(repository).consume('workspace.read');
  });
});

describe('AgentRuntime', () => {
  it('executes an approved side effect once across retries with the same effect key', async () => {
    const { repository, events } = await fixture();
    const permissions = new PermissionGate(repository);
    await permissions.grant('timer', 'always');
    let executions = 0;
    const tools = new ToolRegistry();
    tools.register({
      id: 'timer.create',
      title: 'Create timer',
      capabilityId: 'timer',
      risk: 'medium',
      sideEffect: true,
      inputSchema: z.object({ seconds: z.number().int().positive() }).strict(),
      execute: async () => ({ timerId: `timer-${++executions}` }),
    });
    const runtime = new AgentRuntime(tools, permissions, new EffectLedger(repository), events);
    const effectKey = randomUUID();
    const driver = () => {
      let turn = 0;
      return {
        next: async () =>
          ++turn === 1
            ? ({ type: 'tools', calls: [{ id: randomUUID(), toolId: 'timer.create', input: { seconds: 60 }, effectKey }] } as const)
            : ({ type: 'final', content: 'done' } as const),
      };
    };
    expect((await runtime.run('start timer', driver())).status).toBe('succeeded');
    expect((await runtime.run('retry timer', driver())).status).toBe('succeeded');
    expect(executions).toBe(1);
  });

  it('enforces a bounded model loop', async () => {
    const { repository, events } = await fixture();
    const runtime = new AgentRuntime(new ToolRegistry(), new PermissionGate(repository), new EffectLedger(repository), events, 2);
    await expect(runtime.run('loop', { next: async () => ({ type: 'tools', calls: [] }) })).rejects.toBeInstanceOf(AgentLimitError);
  });

  it('gives the model JSON schemas and preserves assistant tool calls for the next turn', async () => {
    const { repository, events } = await fixture();
    const permissions = new PermissionGate(repository);
    await permissions.grant('time.read', 'always');
    const tools = new ToolRegistry();
    tools.register({
      id: 'time.current', title: 'Current time', capabilityId: 'time.read', risk: 'low', sideEffect: false,
      inputSchema: z.object({ timezone: z.string().optional() }).strict(),
      execute: async () => ({ iso: '2026-09-27T00:00:00.000Z' }),
    });
    const runtime = new AgentRuntime(tools, permissions, new EffectLedger(repository), events);
    const turns: Array<Parameters<Parameters<AgentRuntime['run']>[1]['next']>[0]> = [];
    const callId = randomUUID();

    await runtime.run('What time is it?', {
      next: async (input) => {
        turns.push(input);
        return turns.length === 1
          ? { type: 'tools', calls: [{ id: callId, toolId: 'time.current', input: { timezone: 'UTC' } }] }
          : { type: 'final', content: 'It is midnight.' };
      },
    });

    expect(turns[0]?.tools[0]).toMatchObject({
      id: 'time.current', capabilityId: 'time.read', parameters: { type: 'object', additionalProperties: false },
    });
    expect(turns[1]?.messages).toContainEqual({
      role: 'assistant', content: '',
      toolCalls: [{ id: callId, name: 'time.current', argumentsJson: '{"timezone":"UTC"}' }],
    });
    expect(turns[1]?.messages).toContainEqual({
      role: 'tool', toolCallId: callId, content: '{"iso":"2026-09-27T00:00:00.000Z"}',
    });
  });

  it('cancels an in-flight model turn', async () => {
    const { repository, events } = await fixture();
    const runtime = new AgentRuntime(new ToolRegistry(), new PermissionGate(repository), new EffectLedger(repository), events);
    const runId = randomUUID();
    const run = runtime.run(
      'wait',
      {
        next: ({ signal }) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ type: 'final', content: 'late' }), { once: true });
          }),
      },
      runId,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.cancel(runId)).toBe(true);
    expect((await run).status).toBe('cancelled');
  });
});

describe('RuntimeScheduler', () => {
  it('marks offline work missed without silently replaying it', async () => {
    const { repository, events } = await fixture();
    const schedules = new ScheduleService(repository);
    await schedules.upsert(
      {
        id: randomUUID(),
        title: 'Side effect',
        enabled: true,
        kind: 'agent',
        rrule: 'FREQ=MINUTELY;INTERVAL=1',
        timezone: 'UTC',
        payload: {},
      },
      new Date('2026-09-27T00:00:00.000Z'),
    );
    let executions = 0;
    const scheduler = new RuntimeScheduler(schedules, events, async () => {
      executions += 1;
    }, new Date('2026-09-27T01:00:00.000Z'));
    expect(await scheduler.markStartupMisses(new Date('2026-09-27T01:00:00.000Z'))).toBe(1);
    expect(executions).toBe(0);
    expect(schedules.list()[0]?.lastRunStatus).toBe('missed');
  });

  it('executes a manual run and records its terminal status', async () => {
    const { repository, events } = await fixture();
    const schedules = new ScheduleService(repository);
    const schedule = await schedules.upsert({
      id: randomUUID(), title: 'Manual reminder', enabled: false, kind: 'reminder',
      rrule: 'FREQ=DAILY;INTERVAL=1', timezone: 'UTC', payload: { prompt: 'Hello' },
    });
    const executed: string[] = [];
    const scheduler = new RuntimeScheduler(schedules, events, async (item) => { executed.push(item.id); });

    const { runId } = await scheduler.runNow(schedule.id, new Date('2026-09-27T02:00:00.000Z'));

    expect(executed).toEqual([schedule.id]);
    expect(schedules.list()[0]?.lastRunStatus).toBe('succeeded');
    expect((await events.readAll()).filter((event) => event.runId === runId).map((event) => event.status)).toEqual([
      'queued', 'running', 'succeeded',
    ]);
  });

  it('records a failed manual run without losing the next occurrence', async () => {
    const { repository, events } = await fixture();
    const schedules = new ScheduleService(repository);
    const schedule = await schedules.upsert({
      id: randomUUID(), title: 'Failing task', enabled: true, kind: 'agent',
      rrule: 'FREQ=HOURLY;INTERVAL=1', timezone: 'UTC', payload: { prompt: 'Work' },
    }, new Date('2026-09-27T01:00:00.000Z'));
    const scheduler = new RuntimeScheduler(schedules, events, async () => { throw new Error('fixture failure'); });

    await scheduler.runNow(schedule.id, new Date('2026-09-27T02:00:00.000Z'));

    expect(schedules.list()[0]).toMatchObject({
      lastRunStatus: 'failed', nextRunAt: '2026-09-27T03:00:00.000Z',
    });
  });
});
