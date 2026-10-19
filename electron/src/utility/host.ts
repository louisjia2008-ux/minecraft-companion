import type { ToolRegistry } from '../main/runtime';
import { redactSensitive } from '../main/security';
import { utilityRequestSchema } from './protocol';
import type { UtilityResponse } from './protocol';

export const createUtilityHandler = (tools: ToolRegistry) => async (value: unknown, signal: AbortSignal): Promise<UtilityResponse> => {
  let requestId = '00000000-0000-0000-0000-000000000000';
  try {
    const request = utilityRequestSchema.parse(value);
    requestId = request.requestId;
    const tool = tools.get(request.toolId);
    if (tool.capabilityId !== request.capabilityId) throw new Error('Capability mismatch.');
    const input = tool.inputSchema.parse(request.input);
    const output = await tool.execute(input, { runId: request.runId, taskId: request.taskId, signal });
    return { version: 1, requestId, ok: true, output };
  } catch (error) {
    void redactSensitive(error instanceof Error ? error.message : error);
    return { version: 1, requestId, ok: false, errorCode: 'utility.requestRejected' };
  }
};
