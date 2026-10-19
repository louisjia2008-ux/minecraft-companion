import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';

import { messages } from '../../shared';
import type { DeskPetApi, MessageKey, MinecraftSnapshot, ProviderConfig, ResolvedLocale } from '../../shared';
import { MinecraftPage } from './MinecraftPage';

const idle = (): MinecraftSnapshot => ({
  runtimeState: 'stopped', connectionState: 'idle', config: null, status: null,
  task: null, history: [], inventory: [], logs: [], auth: null, lastError: null,
});

const connected = (): MinecraftSnapshot => ({
  ...idle(), runtimeState: 'ready', connectionState: 'connected',
  status: { connected: true, health: 0, food: 16, dimension: 'overworld', position: { x: 12, y: 64, z: -7 }, mode: 'survival' },
});

const installMinecraft = (state: MinecraftSnapshot = idle()) => {
  const listeners = new Set<(snapshot: MinecraftSnapshot) => void>();
  const unsubscribe = vi.fn();
  const api: DeskPetApi['minecraft'] = {
    getState: vi.fn(async () => state),
    connect: vi.fn(async () => state),
    disconnect: vi.fn(async () => ({ ...idle(), connectionState: 'disconnected' as const })),
    submit: vi.fn(async () => state), control: vi.fn(async () => state), sendChat: vi.fn(async () => state),
    onChanged: vi.fn((listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); unsubscribe(); };
    }),
  };
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { minecraft: api } });
  return { api, unsubscribe, emit: (snapshot: MinecraftSnapshot) => { listeners.forEach((listener) => listener(snapshot)); } };
};

const translator = (locale: ResolvedLocale = 'en') => (key: string): string => messages[locale][key as MessageKey] ?? key;
const renderPage = (providers: ProviderConfig[] = [], locale: ResolvedLocale = 'en') => render(<MinecraftPage providers={providers} t={translator(locale)} />);
const provider: ProviderConfig = {
  id: '6632bb90-3cc1-4a6d-a947-7461bb753f81', kind: 'ollama', name: 'Local Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3', enabled: true, supportsTools: false, secretState: 'missing',
};

afterEach(cleanup);

describe('MinecraftPage', () => {
  it('connects using the Java server form and defaults to local built-in commands without AI', async () => {
    const { api } = installMinecraft();
    const { container } = renderPage();
    const button = await screen.findByRole('button', { name: 'Connect' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByText(/Java Edition servers only/u)).toBeInTheDocument();
    expect(screen.getByLabelText('Task execution')).toHaveValue('strict');
    expect(screen.getByText(/Try “follow me” or “collect 8 logs”/u)).toBeInTheDocument();
    expect(screen.getByText(/Follow and escort tasks require your actual in-game player name/u)).toHaveTextContent('Leaving this empty will not automatically choose a nearby player.');
    expect(screen.getByLabelText('Your Minecraft player name (optional)')).not.toBeRequired();
    expect(screen.queryByLabelText('AI provider')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Server address'), { target: { value: '192.168.1.18' } });
    fireEvent.change(screen.getByLabelText('Server port'), { target: { value: '51234' } });
    fireEvent.change(screen.getByLabelText('Your Minecraft player name (optional)'), { target: { value: 'PlayerOne' } });
    fireEvent.click(button);
    await waitFor(() => expect(api.connect).toHaveBeenCalledWith({
      host: '192.168.1.18', port: 51234, username: 'DeskPet', auth: 'offline',
      version: 'auto', ownerName: 'PlayerOne', executorMode: 'strict', providerId: null,
    }));
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('requires the user to explicitly choose an enabled provider for AI planning', async () => {
    const { api } = installMinecraft();
    renderPage([provider, { ...provider, id: '269da17a-a327-4ea2-8334-214da70a845f', name: 'Disabled provider', enabled: false }]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Task execution'), { target: { value: 'hybrid' } });
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(screen.queryByRole('option', { name: /Disabled provider/u })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('AI provider'), { target: { value: provider.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(api.connect).toHaveBeenCalledWith(expect.objectContaining({ executorMode: 'hybrid', providerId: provider.id })));
  });

  it('gates tasks on actual observed connection, supports task controls, and preserves observed zero health', async () => {
    const { api, emit } = installMinecraft({ ...connected(), status: null });
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled());
    expect(screen.getAllByText('Not observed')).toHaveLength(5);
    act(() => emit(connected()));
    const health = screen.getByText('Health').parentElement;
    expect(health).toHaveTextContent('0');
    expect(screen.getByText('12.0, 64.0, -7.0')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('What should your companion do?'), { target: { value: 'follow me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(api.submit).toHaveBeenCalledWith('follow me'));
    await waitFor(() => expect(screen.getByLabelText('What should your companion do?')).toHaveValue(''));
    act(() => emit({ ...connected(), task: { id: 'task-1', goal: 'follow me', status: 'running' } }));
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Resume task' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Pause task' }));
    await waitFor(() => expect(api.control).toHaveBeenCalledWith('pause'));
    act(() => emit({ ...connected(), task: { id: 'task-1', goal: 'follow me', status: 'paused' } }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume task' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Pause task' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Resume task' }));
    await waitFor(() => expect(api.control).toHaveBeenCalledWith('resume'));
  });

  it('shows connection errors and rejected action feedback without discarding the user’s task', async () => {
    const { api } = installMinecraft({ ...connected(), lastError: 'Server connection timed out' });
    vi.mocked(api.submit).mockRejectedValueOnce(new Error('The bot cannot reach that block'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Server connection timed out');
    fireEvent.change(screen.getByLabelText('What should your companion do?'), { target: { value: 'collect 8 oak logs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The bot cannot reach that block'));
    expect(screen.getByLabelText('What should your companion do?')).toHaveValue('collect 8 oak logs');
    expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled();
  });

  it('keeps Stop and Disconnect available while task planning is awaiting a reply', async () => {
    const { api, emit } = installMinecraft(connected());
    let resolveSubmit: ((snapshot: MinecraftSnapshot) => void) | undefined;
    vi.mocked(api.submit).mockImplementationOnce(() => new Promise((resolve) => { resolveSubmit = resolve; }));
    renderPage();
    await waitFor(() => expect(screen.getByLabelText('What should your companion do?')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('What should your companion do?'), { target: { value: 'collect 8 oak logs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
    expect(api.submit).toHaveBeenCalledWith('collect 8 oak logs');
    act(() => emit({ ...connected(), task: { id: 'planning-task', goal: 'collect 8 oak logs', status: 'planning' } }));
    expect(screen.getByRole('button', { name: 'Pause task' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel task' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop all movement' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop all movement' }));
    await waitFor(() => expect(api.control).toHaveBeenCalledWith('stop'));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(api.disconnect).toHaveBeenCalledOnce());
    await act(async () => resolveSubmit?.(connected()));
    expect(screen.getByRole('button', { name: 'Stop all movement' })).toBeDisabled();
  });

  it('displays the Microsoft device code and allows disconnecting while authentication is pending', async () => {
    const { api } = installMinecraft({
      ...idle(), runtimeState: 'ready', connectionState: 'connecting',
      auth: { userCode: 'ABCD1234', verificationURI: 'https://www.microsoft.com/link', message: 'Authenticate', expiresIn: 900 },
    });
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Sign in to Microsoft' })).toBeInTheDocument();
    expect(screen.getByText('ABCD1234')).toBeInTheDocument();
    expect(screen.getByText('https://www.microsoft.com/link')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(api.disconnect).toHaveBeenCalledOnce());
    expect(screen.queryByText('ABCD1234')).not.toBeInTheDocument();
  });

  it('sends plain server chat, rejects slash commands, and refreshes through the runtime', async () => {
    const { api } = installMinecraft(connected());
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh status' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Message to players'), { target: { value: '/op DeskPet' } });
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Message to players'), { target: { value: 'Hello everyone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(api.sendChat).toHaveBeenCalledWith('Hello everyone'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh status' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(api.control).toHaveBeenCalledWith('refresh'));
  });

  it('subscribes before its initial read, keeps newer pushed status, and only unsubscribes on unmount', async () => {
    const { api, emit, unsubscribe } = installMinecraft();
    let resolveInitial: ((snapshot: MinecraftSnapshot) => void) | undefined;
    vi.mocked(api.getState).mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }));
    const { unmount } = renderPage();
    expect(vi.mocked(api.onChanged).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.getState).mock.invocationCallOrder[0] ?? 0);
    act(() => emit(connected()));
    expect(screen.getByRole('button', { name: 'Refresh status' })).toBeEnabled();
    await act(async () => resolveInitial?.(idle()));
    expect(screen.getByRole('button', { name: 'Refresh status' })).toBeEnabled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(api.disconnect).not.toHaveBeenCalled();
  });

  it('renders the connection, task, and authentication controls in Simplified Chinese', async () => {
    installMinecraft();
    renderPage([], 'zh-CN');
    expect(await screen.findByRole('heading', { name: '一起玩 Minecraft' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '连接' })).toBeEnabled());
    expect(screen.getByLabelText('服务器地址')).toHaveValue('127.0.0.1');
    expect(screen.getByText(/可以试试“跟随我”或“收集 8 个木头”/u)).toBeInTheDocument();
    expect(screen.getByText(/跟随和护卫任务必须填写你的实际游戏玩家名/u)).toHaveTextContent('留空不会自动选择附近玩家。');
    expect(screen.getByLabelText('你的 Minecraft 玩家名（可选）')).not.toBeRequired();
    expect(screen.getByRole('button', { name: '开始任务' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Microsoft 账号' })).toBeInTheDocument();
  });
});
