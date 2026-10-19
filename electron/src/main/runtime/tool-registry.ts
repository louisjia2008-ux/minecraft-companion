import { z } from 'zod';

import type { RiskLevel } from '../../shared';

export interface ToolContext {
  runId: string;
  taskId: string;
  signal: AbortSignal;
}

export interface ToolDefinition {
  id: string;
  title: string;
  capabilityId: string;
  risk: RiskLevel;
  sideEffect: boolean;
  inputSchema: z.ZodType<unknown>;
  execute(input: unknown, context: ToolContext): Promise<unknown>;
}

export interface ToolDescriptor extends Pick<ToolDefinition, 'id' | 'title' | 'capabilityId' | 'risk' | 'sideEffect'> {
  parameters: Record<string, unknown>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.#tools.has(tool.id)) {
      throw new Error(`Tool ${tool.id} is already registered.`);
    }
    this.#tools.set(tool.id, tool);
  }

  get(id: string): ToolDefinition {
    const tool = this.#tools.get(id);
    if (tool === undefined) {
      throw new Error(`Unknown tool ${id}.`);
    }
    return tool;
  }

  describe(): ToolDescriptor[] {
    return [...this.#tools.values()].map(({ id, title, capabilityId, risk, sideEffect, inputSchema }) => {
      const parameters = z.toJSONSchema(inputSchema, { target: 'draft-7' }) as Record<string, unknown>;
      delete parameters.$schema;
      return { id, title, capabilityId, risk, sideEffect, parameters };
    });
  }
}
