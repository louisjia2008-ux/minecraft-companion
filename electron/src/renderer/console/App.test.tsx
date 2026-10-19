import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';

import type { AppState, CharacterState, DeskPetApi, MinecraftSnapshot, ResolvedLocale } from '../../shared';
import { ConsoleApp } from './App';

const appState = (locale: ResolvedLocale): AppState => ({
  version: '0.1.0',
  platform: 'darwin',
  locale,
  resolvedLocale: locale,
  theme: 'dark',
  hotkey: 'Alt+Space',
  hotkeyRegistered: true,
  autoLaunch: false,
  dataDirectory: '/tmp/DeskPet Electron',
  capabilities: [{ id: 'tray', state: 'available', reasonCode: 'capability.reason.ready', requiredPermission: null, canRequestPermission: false }],
});

const character: CharacterState = {
  coreState: 'missing', modelState: 'missing', coreUrl: null, modelUrl: null, pendingImportId: null,
  modelName: null, scale: 1, position: null, expression: null, action: null, bubble: null,
};

const on = () => () => undefined;
const api = (locale: ResolvedLocale): DeskPetApi => ({
  minecraft: {
    getState: vi.fn(async (): Promise<MinecraftSnapshot> => ({ runtimeState: 'stopped', connectionState: 'idle', config: null, status: null, task: null, history: [], inventory: [], logs: [], auth: null, lastError: null })),
    connect: vi.fn(), disconnect: vi.fn(), submit: vi.fn(), control: vi.fn(), sendChat: vi.fn(), onChanged: on,
  },
  app: {
    getState: vi.fn(async () => appState(locale)), setLocale: vi.fn(), setTheme: vi.fn(), setHotkey: vi.fn(), setAutoLaunch: vi.fn(),
    showConsole: vi.fn(), setOverlayVisible: vi.fn(), getDiagnostics: vi.fn(), onChanged: on,
  },
  character: {
    getState: vi.fn(async () => character), importCore: vi.fn(), importModel: vi.fn(), cancelImport: vi.fn(), acknowledgeModelLoaded: vi.fn(),
    setScale: vi.fn(), setPosition: vi.fn(), playAction: vi.fn(), setExpression: vi.fn(), setBubble: vi.fn(), setInteractive: vi.fn(), onChanged: on, onImportProgress: on,
  },
  chat: { listSessions: vi.fn(async () => []), createSession: vi.fn(), listMessages: vi.fn(async () => []), send: vi.fn(), cancel: vi.fn(), retry: vi.fn(), onEvent: on },
  tasks: { list: vi.fn(async () => []), upsert: vi.fn(), remove: vi.fn(), getFocus: vi.fn(async () => null), startFocus: vi.fn(), pauseFocus: vi.fn(), resumeFocus: vi.fn(), stopFocus: vi.fn(), listRunEvents: vi.fn(async () => []), onChanged: on },
  memory: { list: vi.fn(async () => []), upsert: vi.fn(), remove: vi.fn(), onChanged: on },
  relationship: { get: vi.fn(async () => ({ affinity: 0, level: 1, streakDays: 0, lastInteractionAt: null, nickname: '' })), setNickname: vi.fn(), onChanged: on },
  schedule: { list: vi.fn(async () => []), upsert: vi.fn(), remove: vi.fn(), runNow: vi.fn(), onChanged: on },
  providers: { list: vi.fn(async () => []), upsert: vi.fn(), remove: vi.fn(), clearSecret: vi.fn(), test: vi.fn(), listModels: vi.fn(), onChanged: on },
  permissions: { list: vi.fn(async () => []), request: vi.fn(), revoke: vi.fn(), onChanged: on },
  migration: { preview: vi.fn(), start: vi.fn(), cancel: vi.fn(), onProgress: on },
});

const installApi = (locale: ResolvedLocale): void => {
  Object.defineProperty(window, 'deskpet', { value: api(locale), configurable: true });
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ConsoleApp', () => {
  it('renders English first-run setup and passes an automated accessibility scan', async () => {
    installApi('en');
    const { container } = render(<ConsoleApp />);
    expect(await screen.findByRole('heading', { name: 'Good to see you' })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Companion' }));
    expect(await screen.findByRole('heading', { name: 'Bring your companion to life' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose Cubism Core' })).toBeInTheDocument();
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('renders the same navigation and first-run flow in Simplified Chinese', async () => {
    installApi('zh-CN');
    render(<ConsoleApp />);
    expect(await screen.findByRole('heading', { name: '很高兴见到你' })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: '陪伴' }));
    expect(await screen.findByRole('heading', { name: '让你的伙伴苏醒' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择 Cubism Core' })).toBeInTheDocument();
  });

  it('opens the Minecraft companion from the localized navigation', async () => {
    installApi('zh-CN');
    render(<ConsoleApp />);
    expect(await screen.findByRole('heading', { name: '很高兴见到你' })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: '陪玩' }));
    expect(await screen.findByRole('heading', { name: '一起玩 Minecraft' })).toBeInTheDocument();
    expect(screen.getByLabelText('服务器地址')).toBeInTheDocument();
  });
});
