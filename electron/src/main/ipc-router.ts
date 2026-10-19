import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

import { invokePayloadSchemas } from '../shared';
import type { InvokeChannel, InvokePayload, WindowRole } from '../shared';
import type { WindowManager } from './window-manager';
import { authorizeIpcRequest } from './ipc-policy';

type Handler<C extends InvokeChannel> = (payload: InvokePayload<C>, event: IpcMainInvokeEvent) => Promise<unknown> | unknown;

export class IpcRouter {
  readonly #channels = new Set<InvokeChannel>();

  constructor(private readonly windows: WindowManager) {}

  register<C extends InvokeChannel>(channel: C, roles: readonly WindowRole[], handler: Handler<C>): void {
    if (this.#channels.has(channel)) throw new Error(`IPC channel ${channel} is already registered.`);
    this.#channels.add(channel);
    ipcMain.handle(channel, async (event, envelope: unknown) => {
      const role = this.windows.roleFor(event.sender);
      const senderUrl = event.senderFrame?.url ?? '';
      const payload = authorizeIpcRequest({
        channel,
        envelope,
        senderUrl,
        senderRole: role,
        allowedRoles: roles,
        development: process.env.NODE_ENV === 'development',
      });
      return handler(payload, event);
    });
  }

  dispose(): void {
    for (const channel of this.#channels) ipcMain.removeHandler(channel);
    this.#channels.clear();
  }

  static knownChannels(): InvokeChannel[] {
    return Object.keys(invokePayloadSchemas) as InvokeChannel[];
  }
}
