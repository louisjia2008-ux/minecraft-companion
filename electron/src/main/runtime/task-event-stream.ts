import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { TaskRunEvent, TaskRunStatus } from '../../shared';
import { JsonlEventStore } from '../persistence';

const taskRunEventSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    sequence: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    type: z.enum(['state', 'model', 'tool', 'approval', 'effect', 'error']),
    status: z.enum(['queued', 'running', 'awaiting-approval', 'succeeded', 'failed', 'cancelled', 'missed']),
    summary: z.string().max(4_096),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();

export class TaskEventStream {
  readonly #store: JsonlEventStore<TaskRunEvent>;
  readonly #sequences = new Map<string, number>();

  constructor(path: string) {
    this.#store = new JsonlEventStore(path, taskRunEventSchema);
  }

  async initialize(): Promise<void> {
    for (const event of await this.#store.readAll()) {
      this.#sequences.set(event.runId, Math.max(this.#sequences.get(event.runId) ?? 0, event.sequence));
    }
  }

  async emit(
    runId: string,
    type: TaskRunEvent['type'],
    status: TaskRunStatus,
    summary: string,
    metadata: Record<string, unknown> = {},
    now = new Date(),
  ): Promise<TaskRunEvent> {
    const sequence = (this.#sequences.get(runId) ?? 0) + 1;
    const event: TaskRunEvent = {
      id: randomUUID(),
      runId,
      sequence,
      createdAt: now.toISOString(),
      type,
      status,
      summary,
      metadata,
    };
    await this.#store.append(event);
    this.#sequences.set(runId, sequence);
    return event;
  }

  readAll(): Promise<TaskRunEvent[]> {
    return this.#store.readAll();
  }
}
