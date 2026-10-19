import { randomUUID } from 'node:crypto';

import type { DeskTask, FocusSession } from '../../shared';
import type { DomainRepository } from './repository';
import type { PersistentFocus } from './schemas';

const publicFocus = (focus: PersistentFocus): FocusSession => ({
  id: focus.id,
  taskId: focus.taskId,
  startedAt: focus.startedAt,
  plannedSeconds: focus.plannedSeconds,
  elapsedSeconds: focus.elapsedSeconds,
  status: focus.status,
});

const addRunningElapsed = (focus: PersistentFocus, now: Date): void => {
  if (focus.status === 'running' && focus.lastResumedAt !== null) {
    const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(focus.lastResumedAt)) / 1_000));
    focus.elapsedSeconds += seconds;
  }
};

export class TaskService {
  constructor(private readonly repository: DomainRepository) {}

  list(): DeskTask[] {
    return this.repository.snapshot().tasks;
  }

  async upsert(
    input: Pick<DeskTask, 'id' | 'title' | 'notes' | 'status' | 'dueAt'>,
    now = new Date(),
  ): Promise<DeskTask> {
    return this.repository.transaction((state) => {
      const existing = state.tasks.find((item) => item.id === input.id);
      if (existing !== undefined) {
        Object.assign(existing, input, { updatedAt: now.toISOString() });
        return structuredClone(existing);
      }
      const task: DeskTask = { ...input, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      state.tasks.push(task);
      return task;
    });
  }

  async remove(id: string): Promise<void> {
    await this.repository.transaction((state) => {
      state.tasks = state.tasks.filter((item) => item.id !== id);
    });
  }

  getFocus(): FocusSession | null {
    const focus = this.repository.snapshot().focus;
    return focus === null ? null : publicFocus(focus);
  }

  async startFocus(taskId: string | null, plannedSeconds: number, now = new Date()): Promise<FocusSession> {
    return this.repository.transaction((state) => {
      if (state.focus?.status === 'running' || state.focus?.status === 'paused') {
        throw new Error('A focus session is already active.');
      }
      const focus: PersistentFocus = {
        id: randomUUID(),
        taskId,
        startedAt: now.toISOString(),
        lastResumedAt: now.toISOString(),
        plannedSeconds,
        elapsedSeconds: 0,
        status: 'running',
      };
      state.focus = focus;
      return publicFocus(focus);
    });
  }

  async pauseFocus(now = new Date()): Promise<FocusSession> {
    return this.repository.transaction((state) => {
      if (state.focus?.status !== 'running') {
        throw new Error('No running focus session.');
      }
      addRunningElapsed(state.focus, now);
      state.focus.status = 'paused';
      state.focus.lastResumedAt = null;
      return publicFocus(state.focus);
    });
  }

  async resumeFocus(now = new Date()): Promise<FocusSession> {
    return this.repository.transaction((state) => {
      if (state.focus?.status !== 'paused') {
        throw new Error('No paused focus session.');
      }
      state.focus.status = 'running';
      state.focus.lastResumedAt = now.toISOString();
      return publicFocus(state.focus);
    });
  }

  async stopFocus(status: 'completed' | 'cancelled', now = new Date()): Promise<FocusSession> {
    return this.repository.transaction((state) => {
      if (state.focus === null || (state.focus.status !== 'running' && state.focus.status !== 'paused')) {
        throw new Error('No active focus session.');
      }
      addRunningElapsed(state.focus, now);
      state.focus.status = status;
      state.focus.lastResumedAt = null;
      return publicFocus(state.focus);
    });
  }
}
