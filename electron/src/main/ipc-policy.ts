import { MAX_IPC_BYTES, invokePayloadSchemas, parseInvokeRequest } from '../shared';
import type { InvokeChannel, InvokePayload, WindowRole } from '../shared';

export interface IpcAuthorizationInput<C extends InvokeChannel> {
  channel: C;
  envelope: unknown;
  senderUrl: string;
  senderRole: WindowRole | null;
  allowedRoles: readonly WindowRole[];
  development: boolean;
}

export const isKnownInvokeChannel = (channel: string): channel is InvokeChannel => channel in invokePayloadSchemas;

export const authorizeIpcRequest = <C extends InvokeChannel>(input: IpcAuthorizationInput<C>): InvokePayload<C> => {
  const serialized = JSON.stringify(input.envelope);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_IPC_BYTES) throw new Error('IPC payload exceeds the size limit.');
  if (input.senderRole === null || !input.allowedRoles.includes(input.senderRole)) {
    throw new Error('IPC sender window role is not authorized.');
  }
  const allowedDevelopment =
    input.development &&
    (input.senderUrl.startsWith('http://localhost:') || input.senderUrl.startsWith('http://127.0.0.1:'));
  if (!input.senderUrl.startsWith('deskpet://app/') && !allowedDevelopment) {
    throw new Error('IPC sender origin is not authorized.');
  }
  return parseInvokeRequest(input.channel, input.envelope);
};
