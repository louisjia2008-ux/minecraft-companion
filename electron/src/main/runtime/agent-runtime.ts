import { randomUUID } from 'node:crypto';

import type { EffectLedger } from './effect-ledger';
import type { PermissionGate } from './permissions';
import type { TaskEventStream } from './task-event-stream';
import type { ToolRegistry } from './tool-registry';

export interface ToolCall {
  id: string;
  toolId: string;
  input: unknown;
  effectKey?: string;
}

export type ModelDecision =
  | { type: 'final'; content: string }
  | { type: 'tools'; calls: readonly ToolCall[] };

export interface ModelTurnMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; argumentsJson: string }>;
}

export interface ModelDriver {
  next(input: {
    messages: ModelTurnMessage[];
    tools: ReturnType<ToolRegistry['describe']>;
    signal: AbortSignal;
  }): Promise<ModelDecision>;
}

export interface AgentRunResult {
  runId: string;
  status: 'succeeded' | 'cancelled' | 'failed';
  content: string;
  iterations: number;
}

export class AgentLimitError extends Error {
  constructor() {
    super('The agent reached its bounded tool-loop limit.');
    this.name = 'AgentLimitError';
  }
}

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new DOMException('The agent run was cancelled.', 'AbortError');
  }
};

export class AgentRuntime {
  readonly #controllers = new Map<string, AbortController>();

  constructor(
    private readonly tools: ToolRegistry,
    private readonly permissions: PermissionGate,
    private readonly effects: EffectLedger,
    private readonly events: TaskEventStream,
    private readonly maxIterations = 8,
  ) {}

  cancel(runId: string): boolean {
    const controller = this.#controllers.get(runId);
    controller?.abort();
    return controller !== undefined;
  }

  async run(userInput: string, driver: ModelDriver, requestedRunId: string = randomUUID()): Promise<AgentRunResult> {
    const controller = new AbortController();
    this.#controllers.set(requestedRunId, controller);
    const messages: ModelTurnMessage[] = [{ role: 'user', content: userInput }];
    await this.events.emit(requestedRunId, 'state', 'running', 'Agent run started.');

    try {
      for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
        throwIfAborted(controller.signal);
        const decision = await driver.next({ messages: structuredClone(messages), tools: this.tools.describe(), signal: controller.signal });
        throwIfAborted(controller.signal);
        if (decision.type === 'final') {
          await this.events.emit(requestedRunId, 'model', 'succeeded', 'Agent produced a final response.');
          return { runId: requestedRunId, status: 'succeeded', content: decision.content, iterations: iteration };
        }

        const preparedCalls = decision.calls.map((call) => {
          const tool = this.tools.get(call.toolId);
          return { call, tool, input: tool.inputSchema.parse(call.input) };
        });
        if (preparedCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: '',
            toolCalls: preparedCalls.map(({ call, input }) => ({
              id: call.id,
              name: call.toolId,
              argumentsJson: JSON.stringify(input),
            })),
          });
        }
        for (const { call, tool, input } of preparedCalls) {
          throwIfAborted(controller.signal);
          await this.permissions.consume(tool.capabilityId);
          let output: unknown;
          if (tool.sideEffect) {
            if (call.effectKey === undefined || call.effectKey.length === 0) {
              throw new Error(`Side-effect tool ${tool.id} requires an effectKey.`);
            }
            const existing = this.effects.find(call.effectKey);
            if (existing !== null) {
              output = existing.output;
            } else {
              output = await tool.execute(input, { runId: requestedRunId, taskId: call.id, signal: controller.signal });
              await this.effects.record({
                key: call.effectKey,
                runId: requestedRunId,
                toolId: tool.id,
                completedAt: new Date().toISOString(),
                output,
              });
            }
          } else {
            output = await tool.execute(input, { runId: requestedRunId, taskId: call.id, signal: controller.signal });
          }
          messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(output) });
          await this.events.emit(requestedRunId, tool.sideEffect ? 'effect' : 'tool', 'running', `Tool ${tool.id} completed.`, {
            toolId: tool.id,
            taskId: call.id,
          });
        }
      }
      throw new AgentLimitError();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        await this.events.emit(requestedRunId, 'state', 'cancelled', 'Agent run cancelled.');
        return { runId: requestedRunId, status: 'cancelled', content: '', iterations: 0 };
      }
      await this.events.emit(requestedRunId, 'error', 'failed', error instanceof Error ? error.message : 'Unknown agent error.');
      throw error;
    } finally {
      this.#controllers.delete(requestedRunId);
    }
  }
}
