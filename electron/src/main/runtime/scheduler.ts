import { randomUUID } from 'node:crypto';

import type { ScheduleDefinition } from '../../shared';
import type { ScheduleService } from '../domain';
import type { TaskEventStream } from './task-event-stream';

export class RuntimeScheduler {
  readonly #startedAt: Date;

  constructor(
    private readonly schedules: ScheduleService,
    private readonly events: TaskEventStream,
    private readonly execute: (schedule: ScheduleDefinition, runId: string) => Promise<void>,
    startedAt = new Date(),
  ) {
    this.#startedAt = startedAt;
  }

  async markStartupMisses(now = new Date()): Promise<number> {
    let missed = 0;
    for (const schedule of this.schedules.list()) {
      if (schedule.enabled && schedule.nextRunAt !== null && Date.parse(schedule.nextRunAt) < this.#startedAt.getTime()) {
        const runId = randomUUID();
        await this.schedules.updateRun(schedule.id, 'missed', now);
        await this.events.emit(runId, 'state', 'missed', `Schedule ${schedule.id} was missed while the app was offline.`, {
          scheduleId: schedule.id,
        });
        missed += 1;
      }
    }
    return missed;
  }

  async tick(now = new Date()): Promise<number> {
    let executed = 0;
    for (const schedule of this.schedules.list()) {
      const nextRun = schedule.nextRunAt === null ? null : Date.parse(schedule.nextRunAt);
      if (!schedule.enabled || nextRun === null || nextRun > now.getTime() || nextRun < this.#startedAt.getTime()) {
        continue;
      }
      await this.#executeOne(schedule, randomUUID(), now);
      executed += 1;
    }
    return executed;
  }

  async runNow(id: string, now = new Date()): Promise<{ runId: string }> {
    const schedule = this.schedules.list().find((item) => item.id === id);
    if (schedule === undefined) throw new Error('Schedule does not exist.');
    const runId = randomUUID();
    await this.events.emit(runId, 'state', 'queued', `Schedule ${id} queued manually.`, { scheduleId: id });
    await this.#executeOne(schedule, runId, now);
    return { runId };
  }

  async #executeOne(schedule: ScheduleDefinition, runId: string, now: Date): Promise<void> {
    await this.events.emit(runId, 'state', 'running', `Schedule ${schedule.id} started.`, { scheduleId: schedule.id });
    try {
      await this.execute(schedule, runId);
      await this.schedules.updateRun(schedule.id, 'succeeded', now);
      await this.events.emit(runId, 'state', 'succeeded', `Schedule ${schedule.id} completed.`, { scheduleId: schedule.id });
    } catch (error) {
      await this.schedules.updateRun(schedule.id, 'failed', now);
      await this.events.emit(runId, 'error', 'failed', error instanceof Error ? error.message : 'Schedule failed.', {
        scheduleId: schedule.id,
      });
    }
  }
}
