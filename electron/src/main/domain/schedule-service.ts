import type { ScheduleDefinition } from '../../shared';
import type { DomainRepository } from './repository';

const parseRule = (rrule: string): { frequency: 'MINUTELY' | 'HOURLY' | 'DAILY'; interval: number } => {
  const fields = Object.fromEntries(rrule.split(';').map((field) => field.split('=', 2)));
  const frequency = fields.FREQ;
  if (frequency !== 'MINUTELY' && frequency !== 'HOURLY' && frequency !== 'DAILY') {
    throw new Error('Only MINUTELY, HOURLY, and DAILY schedules are supported in Electron v1.');
  }
  const interval = fields.INTERVAL === undefined ? 1 : Number(fields.INTERVAL);
  if (!Number.isInteger(interval) || interval < 1 || interval > 10_000) {
    throw new Error('Schedule interval is invalid.');
  }
  return { frequency, interval };
};

export const nextOccurrence = (rrule: string, after: Date): Date => {
  const { frequency, interval } = parseRule(rrule);
  const unit = frequency === 'MINUTELY' ? 60_000 : frequency === 'HOURLY' ? 3_600_000 : 86_400_000;
  return new Date(after.getTime() + unit * interval);
};

export class ScheduleService {
  constructor(private readonly repository: DomainRepository) {}

  list(): ScheduleDefinition[] {
    return this.repository.snapshot().schedules;
  }

  async upsert(
    input: Omit<ScheduleDefinition, 'nextRunAt' | 'lastRunStatus'>,
    now = new Date(),
  ): Promise<ScheduleDefinition> {
    const nextRunAt = input.enabled ? nextOccurrence(input.rrule, now).toISOString() : null;
    return this.repository.transaction((state) => {
      const existing = state.schedules.find((item) => item.id === input.id);
      if (existing !== undefined) {
        Object.assign(existing, input, { nextRunAt });
        return structuredClone(existing);
      }
      const schedule: ScheduleDefinition = { ...input, nextRunAt, lastRunStatus: 'never' };
      state.schedules.push(schedule);
      return schedule;
    });
  }

  async remove(id: string): Promise<void> {
    await this.repository.transaction((state) => {
      state.schedules = state.schedules.filter((item) => item.id !== id);
    });
  }

  async updateRun(id: string, status: ScheduleDefinition['lastRunStatus'], after: Date): Promise<ScheduleDefinition> {
    return this.repository.transaction((state) => {
      const schedule = state.schedules.find((item) => item.id === id);
      if (schedule === undefined) {
        throw new Error('Schedule does not exist.');
      }
      schedule.lastRunStatus = status;
      schedule.nextRunAt = schedule.enabled ? nextOccurrence(schedule.rrule, after).toISOString() : null;
      return structuredClone(schedule);
    });
  }
}
