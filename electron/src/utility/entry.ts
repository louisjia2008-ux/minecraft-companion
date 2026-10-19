import { OpenAICompatibleAdapter, ProviderHttpError } from '../main/providers';
import { providerUtilityCommandSchema } from './provider-protocol';
import type { ProviderUtilityResponse } from './provider-protocol';

const port = process.parentPort;
if (port === null) throw new Error('DeskPet provider utility requires an Electron parent port.');

const controllers = new Map<string, AbortController>();
const post = (response: ProviderUtilityResponse): void => port.postMessage(response);

port.on('message', (messageEvent) => {
  void (async () => {
    const parsed = providerUtilityCommandSchema.safeParse(messageEvent.data);
    if (!parsed.success) return;
    const command = parsed.data;
    if (command.kind === 'provider:cancel') {
      controllers.get(command.requestId)?.abort();
      return;
    }
    const controller = new AbortController();
    controllers.set(command.requestId, controller);
    try {
      const adapter = new OpenAICompatibleAdapter(command.credentials);
      if (command.kind === 'provider:models') {
        post({ version: 1, kind: 'provider:models-result', requestId: command.requestId, models: await adapter.listModels(controller.signal) });
      } else {
        const providerRequest = {
          model: command.request.model,
          messages: command.request.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
            ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
          })),
          ...(command.request.tools === undefined ? {} : { tools: command.request.tools }),
          ...(command.request.temperature === undefined ? {} : { temperature: command.request.temperature }),
        };
        for await (const event of adapter.streamChat(providerRequest, controller.signal)) {
          post({ version: 1, kind: 'provider:event', requestId: command.requestId, event });
        }
        post({ version: 1, kind: 'provider:complete', requestId: command.requestId });
      }
    } catch (error) {
      const errorCode = error instanceof ProviderHttpError ? error.code : controller.signal.aborted ? 'provider.cancelled' : 'provider.failed';
      post({ version: 1, kind: 'provider:error', requestId: command.requestId, errorCode });
    } finally {
      controllers.delete(command.requestId);
    }
  })();
});
