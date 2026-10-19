/** Renderer-facing Minecraft data. No credentials, arbitrary commands, or process handles. */
export interface MinecraftConnectionConfig {
  host: string;
  port: number;
  username: string;
  auth: 'offline' | 'microsoft';
  version: string;
  ownerName: string;
  executorMode: 'strict' | 'hybrid';
  providerId: string | null;
}

export interface MinecraftStatus {
  connected: boolean;
  health: number | null;
  food: number | null;
  dimension: string | null;
  position: { x: number; y: number; z: number } | null;
  mode: string | null;
}

export interface MinecraftTask {
  id: string;
  goal: string;
  status: string;
  phase?: string;
  summary?: string;
}

export interface MinecraftInventoryItem {
  name: string;
  count: number;
  displayName?: string;
}

export interface MinecraftLog {
  id: string;
  timestamp: string;
  kind: string;
  message: string;
}

export interface MinecraftDeviceAuth {
  userCode: string;
  verificationURI: string;
  message: string;
  expiresIn: number;
}

export type MinecraftControlAction = 'pause' | 'resume' | 'cancel' | 'stop' | 'refresh';

export interface MinecraftSnapshot {
  runtimeState: 'stopped' | 'starting' | 'ready' | 'error';
  connectionState: 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'disconnected' | 'error';
  config: MinecraftConnectionConfig | null;
  status: MinecraftStatus | null;
  task: MinecraftTask | null;
  history: MinecraftTask[];
  inventory: MinecraftInventoryItem[];
  logs: MinecraftLog[];
  auth: MinecraftDeviceAuth | null;
  lastError: string | null;
}
