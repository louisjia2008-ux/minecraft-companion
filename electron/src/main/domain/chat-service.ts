import { randomUUID } from 'node:crypto';

import type { ChatMessage, ChatSession } from '../../shared';
import type { DomainRepository } from './repository';

export class ChatService {
  constructor(private readonly repository: DomainRepository) {}

  listSessions(): ChatSession[] {
    return this.repository.snapshot().chatSessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listMessages(sessionId: string): ChatMessage[] {
    return this.repository.snapshot().chatMessages.filter((message) => message.sessionId === sessionId);
  }

  async createSession(title: string, kind: ChatSession['kind'], now = new Date()): Promise<ChatSession> {
    const session: ChatSession = { id: randomUUID(), title, kind, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    await this.repository.transaction((state) => state.chatSessions.push(session));
    return session;
  }

  async addMessage(
    input: Pick<ChatMessage, 'sessionId' | 'role' | 'content' | 'status' | 'errorCode'>,
    now = new Date(),
  ): Promise<ChatMessage> {
    const message: ChatMessage = { id: randomUUID(), createdAt: now.toISOString(), ...input };
    await this.repository.transaction((state) => {
      const session = state.chatSessions.find((item) => item.id === input.sessionId);
      if (session === undefined) {
        throw new Error('Chat session does not exist.');
      }
      session.updatedAt = now.toISOString();
      state.chatMessages.push(message);
    });
    return message;
  }

  async updateMessage(id: string, patch: Pick<ChatMessage, 'content' | 'status' | 'errorCode'>): Promise<ChatMessage> {
    return this.repository.transaction((state) => {
      const message = state.chatMessages.find((item) => item.id === id);
      if (message === undefined) {
        throw new Error('Chat message does not exist.');
      }
      Object.assign(message, patch);
      return structuredClone(message);
    });
  }
}
