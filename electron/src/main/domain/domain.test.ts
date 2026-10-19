import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatService } from './chat-service';
import { MemoryService } from './memory-service';
import { DomainRepository } from './repository';
import { RelationshipService } from './relationship-service';
import { ScheduleService, nextOccurrence } from './schedule-service';
import { TaskService } from './task-service';

const roots: string[] = [];
const createRepository = async (): Promise<{ root: string; repository: DomainRepository }> => {
  const root = await mkdtemp(join(tmpdir(), 'deskpet-domain-'));
  roots.push(root);
  const repository = new DomainRepository(join(root, 'domain.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 5) });
  await repository.initialize();
  return { root, repository };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('domain services', () => {
  it('persists chat, tasks, focus, memory, and relationship state', async () => {
    const { root, repository } = await createRepository();
    const chat = new ChatService(repository);
    const tasks = new TaskService(repository);
    const memory = new MemoryService(repository);
    const relationship = new RelationshipService(repository);
    const now = new Date('2026-09-27T10:00:00.000Z');

    const session = await chat.createSession('Project', 'project', now);
    await chat.addMessage({ sessionId: session.id, role: 'user', content: 'Hello', status: 'complete', errorCode: null }, now);
    await tasks.upsert({ id: randomUUID(), title: 'Ship', notes: '', status: 'todo', dueAt: null }, now);
    await tasks.startFocus(null, 1_500, now);
    await tasks.pauseFocus(new Date('2026-09-27T10:01:05.000Z'));
    await memory.upsert({ id: randomUUID(), text: 'Prefers concise reminders', tags: ['preference'] }, 'user', now);
    await relationship.recordInteraction(16, now);

    const reloaded = new DomainRepository(join(root, 'domain.enc.json'), { getVaultKey: async () => Buffer.alloc(32, 5) });
    await reloaded.initialize();
    expect(new ChatService(reloaded).listMessages(session.id)).toHaveLength(1);
    expect(new TaskService(reloaded).getFocus()?.elapsedSeconds).toBe(65);
    expect(new MemoryService(reloaded).list()).toHaveLength(1);
    expect(new RelationshipService(reloaded).get()).toMatchObject({ affinity: 16, level: 2 });
  });

  it('rejects overlapping focus sessions and computes bounded schedules', async () => {
    const { repository } = await createRepository();
    const tasks = new TaskService(repository);
    await tasks.startFocus(null, 600);
    await expect(tasks.startFocus(null, 600)).rejects.toThrow('already active');
    expect(nextOccurrence('FREQ=HOURLY;INTERVAL=2', new Date('2026-09-27T00:00:00.000Z')).toISOString()).toBe(
      '2026-09-27T02:00:00.000Z',
    );
    expect(() => nextOccurrence('FREQ=YEARLY', new Date())).toThrow('Only MINUTELY');
  });

  it('stores schedule state without executing it inside the data service', async () => {
    const { repository } = await createRepository();
    const schedules = new ScheduleService(repository);
    const schedule = await schedules.upsert(
      {
        id: randomUUID(),
        title: 'Reminder',
        enabled: true,
        kind: 'reminder',
        rrule: 'FREQ=DAILY;INTERVAL=1',
        timezone: 'Asia/Shanghai',
        payload: { text: 'stand up' },
      },
      new Date('2026-09-27T00:00:00.000Z'),
    );
    expect(schedule.lastRunStatus).toBe('never');
    expect(schedule.nextRunAt).toBe('2026-09-28T00:00:00.000Z');
  });
});
