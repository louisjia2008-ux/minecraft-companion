import type { MinecraftDeviceAuth, MinecraftInventoryItem, MinecraftStatus, MinecraftTask } from '../../shared';

export const boundedText = (value: unknown, limit = 2_000): string => {
  if (typeof value !== 'string') return '';
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization)\s*[=:]\s*)[^\s&,;]+/gi, '$1[REDACTED]')
    .split('').filter((character) => character.charCodeAt(0) >= 32 || character === '\n' || character === '\r' || character === '\t').join('')
    .slice(0, limit);
};

export const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

export const sanitizeStatus = (value: unknown): MinecraftStatus | null => {
  const status = record(value);
  if (status === null) return null;
  const position = record(status.position);
  const x = finite(position?.x), y = finite(position?.y), z = finite(position?.z);
  return {
    connected: status.connected === true,
    health: finite(status.health),
    food: finite(status.food),
    dimension: typeof status.dimension === 'string' ? boundedText(status.dimension, 120) : null,
    position: x !== null && y !== null && z !== null ? { x, y, z } : null,
    mode: typeof status.mode === 'string' ? boundedText(status.mode, 80) : null,
  };
};

export const sanitizeTask = (value: unknown): MinecraftTask | null => {
  const task = record(value);
  if (task === null || (typeof task.id !== 'string' && typeof task.taskId !== 'string')) return null;
  const goal = task.goal ?? task.goalText ?? task.userCommand ?? task.command ?? task.label ?? '';
  const phase = task.phase ?? task.turnPhaseLabel ?? task.turnPhase;
  const summary = task.summary || task.progressText || task.replyText || task.error;
  return {
    id: boundedText(task.id ?? task.taskId, 128),
    goal: boundedText(goal, 2_000),
    status: boundedText(task.status, 80) || 'unknown',
    ...(typeof phase === 'string' ? { phase: boundedText(phase, 120) } : {}),
    ...(typeof summary === 'string' ? { summary: boundedText(summary, 2_000) } : {}),
  };
};

export const sanitizeInventory = (value: unknown): MinecraftInventoryItem[] => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 128).flatMap((item) => {
    const entry = record(item);
    if (entry === null || typeof entry.name !== 'string') return [];
    const count = finite(entry.count);
    if (count === null || count <= 0) return [];
    return [{
      name: boundedText(entry.name, 160),
      count: Math.min(1_000_000, Math.floor(count)),
      ...(typeof entry.displayName === 'string' ? { displayName: boundedText(entry.displayName, 160) } : {}),
    }];
  });
};

export const sanitizeAuth = (value: unknown): MinecraftDeviceAuth | null => {
  const auth = record(value);
  if (auth === null || typeof auth.userCode !== 'string' || typeof auth.verificationURI !== 'string') return null;
  let verification: URL;
  try { verification = new URL(auth.verificationURI); } catch { return null; }
  if (verification.protocol !== 'https:' || verification.username || verification.password) return null;
  const host = verification.hostname.toLowerCase();
  if (!['microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com', 'login.live.com'].includes(host)) return null;
  return {
    userCode: boundedText(auth.userCode, 40),
    verificationURI: verification.href.slice(0, 512),
    message: boundedText(auth.message, 2_000),
    expiresIn: Math.max(0, Math.min(3_600, finite(auth.expiresIn) ?? 900)),
  };
};
