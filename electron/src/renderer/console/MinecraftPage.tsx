import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';

import type {
  MinecraftConnectionConfig,
  MinecraftControlAction,
  MinecraftSnapshot,
  ProviderConfig,
} from '../../shared';

interface MinecraftPageProps {
  providers: ProviderConfig[];
  t: (key: string) => string;
}

const defaultConfig: MinecraftConnectionConfig = {
  host: '127.0.0.1', port: 25565, username: 'DeskPet', auth: 'offline',
  version: 'auto', ownerName: '', executorMode: 'strict', providerId: null,
};
const activeTaskStates = new Set(['pending', 'planning', 'running', 'paused']);
const isPlainChat = (message: string): boolean => message.trim().length > 0
  && !message.trimStart().startsWith('/') && ![...message].some((character) => character.charCodeAt(0) < 32);

export const MinecraftPage = ({ providers, t }: MinecraftPageProps): JSX.Element => {
  const [snapshot, setSnapshot] = useState<MinecraftSnapshot | null>(null);
  const [config, setConfig] = useState<MinecraftConnectionConfig>(defaultConfig);
  const [goal, setGoal] = useState('');
  const [chat, setChat] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const changes = useRef(0);
  const operations = useRef(0);
  const formEdited = useRef(false);

  const acceptSnapshot = useCallback((state: MinecraftSnapshot) => {
    if (!mounted.current) return;
    setSnapshot(state);
    if (!formEdited.current && state.config !== null) setConfig(state.config);
  }, []);

  const refreshState = useCallback(async (): Promise<void> => {
    const revision = changes.current;
    try {
      const state = await window.deskpet.minecraft.getState();
      if (revision === changes.current) acceptSnapshot(state);
      if (mounted.current) setError(null);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'minecraft.error');
    }
  }, [acceptSnapshot]);

  useEffect(() => {
    mounted.current = true;
    // Listen first: a newer push must win over an in-flight initial read.
    const unsubscribe = window.deskpet.minecraft.onChanged((state) => {
      changes.current += 1;
      acceptSnapshot(state);
    });
    void refreshState();
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [acceptSnapshot, refreshState]);

  const updateConfig = <K extends keyof MinecraftConnectionConfig>(key: K, value: MinecraftConnectionConfig[K]): void => {
    formEdited.current = true;
    setConfig((current) => ({ ...current, [key]: value }));
  };

  const run = async (name: string, operation: () => Promise<MinecraftSnapshot>, onSuccess?: () => void): Promise<void> => {
    const operationId = ++operations.current;
    const revision = changes.current;
    setBusy(name);
    setError(null);
    try {
      const state = await operation();
      if (operationId === operations.current && revision === changes.current) acceptSnapshot(state);
      if (mounted.current && operationId === operations.current) onSuccess?.();
    } catch (cause) {
      if (mounted.current && operationId === operations.current) {
        setError(cause instanceof Error ? cause.message : 'minecraft.error');
      }
    } finally {
      if (mounted.current && operationId === operations.current) setBusy(null);
    }
  };

  const connected = snapshot?.connectionState === 'connected' && snapshot.status?.connected === true;
  const connecting = snapshot?.connectionState === 'connecting' || snapshot?.runtimeState === 'starting';
  const disconnecting = snapshot?.connectionState === 'disconnecting';
  const activeTask = snapshot?.task !== null && snapshot?.task !== undefined && activeTaskStates.has(snapshot.task.status);
  const paused = snapshot?.task?.status === 'paused';
  const enabledProviders = providers.filter((provider) => provider.enabled);
  const validProvider = config.executorMode === 'strict' || enabledProviders.some((provider) => provider.id === config.providerId);
  const controlsDisabled = !connected || busy !== null;
  const canControl = (action: MinecraftControlAction): boolean => connected && busy !== 'disconnect' && busy !== action;
  const canDisconnect = (connected || connecting || snapshot?.runtimeState === 'ready') && !disconnecting && busy !== 'disconnect';
  const shownError = error ?? snapshot?.lastError;
  const unknown = t('minecraft.unknown');
  const status = connected ? snapshot.status : null;
  const taskLabel = (value: string): string => {
    const translated = t(`minecraft.task.${value}`);
    return translated === `minecraft.task.${value}` ? value : translated;
  };

  const connect = (event: FormEvent): void => {
    event.preventDefault();
    if (snapshot === null || busy !== null || connected || connecting || disconnecting || !validProvider) return;
    const request = {
      ...config, host: config.host.trim(), username: config.username.trim(), ownerName: config.ownerName.trim(),
      version: config.version.trim(), providerId: config.executorMode === 'strict' ? null : config.providerId,
    };
    void run('connect', () => window.deskpet.minecraft.connect(request));
  };

  const control = (action: MinecraftControlAction): void => {
    if (!canControl(action)) return;
    void run(action, () => window.deskpet.minecraft.control(action));
  };

  const submitTask = (event: FormEvent): void => {
    event.preventDefault();
    if (controlsDisabled || activeTask || goal.trim().length === 0) return;
    void run('submit', () => window.deskpet.minecraft.submit(goal.trim()), () => setGoal(''));
  };

  const sendChat = (event: FormEvent): void => {
    event.preventDefault();
    if (controlsDisabled || !isPlainChat(chat)) return;
    void run('chat', () => window.deskpet.minecraft.sendChat(chat.trim()), () => setChat(''));
  };

  return <section className="minecraft-page">
    <header className="page-header"><span>{t('nav.minecraft')}</span><h1>{t('minecraft.title')}</h1><p>{t('minecraft.description')}</p></header>
    {shownError && <div className="error-banner" role="alert">{shownError === 'minecraft.error' ? t(shownError) : shownError} <button type="button" className="secondary" disabled={busy !== null} onClick={() => void refreshState()}>{t('common.retry')}</button></div>}
    {snapshot === null && <p role="status">{t('minecraft.loading')}</p>}
    <div className="minecraft-connection-summary" role="status" aria-live="polite">
      <span>{t('minecraft.connection')} <strong className={`status-pill ${connected ? 'available' : snapshot?.connectionState === 'error' ? 'failed' : ''}`}>{t(`minecraft.connection.${snapshot?.connectionState ?? 'idle'}`)}</strong></span>
      <span>{t('minecraft.runtime')} <strong>{t(`minecraft.runtime.${snapshot?.runtimeState ?? 'stopped'}`)}</strong></span>
    </div>
    {snapshot?.auth && <article className="panel minecraft-auth" aria-labelledby="minecraft-auth-title">
      <h2 id="minecraft-auth-title">{t('minecraft.auth.title')}</h2>
      <p>{t('minecraft.auth.instructions')}</p>
      <dl><div><dt>{t('minecraft.auth.address')}</dt><dd><code>{snapshot.auth.verificationURI}</code></dd></div><div><dt>{t('minecraft.auth.code')}</dt><dd><code className="minecraft-device-code">{snapshot.auth.userCode}</code></dd></div><div><dt>{t('minecraft.auth.expires')}</dt><dd>{snapshot.auth.expiresIn}</dd></div></dl>
    </article>}
    <article className="panel" aria-labelledby="minecraft-server-title">
      <h2 id="minecraft-server-title">{t('minecraft.server')}</h2>
      <p className="minecraft-help">{t('minecraft.javaOnly')}</p>
      <form className="stack-form" onSubmit={connect}>
        <fieldset className="minecraft-form-grid" disabled={snapshot === null || busy !== null || connected || connecting || disconnecting}>
          <label>{t('minecraft.host')}<input required maxLength={253} value={config.host} onChange={(event) => updateConfig('host', event.target.value)} autoComplete="off" /></label>
          <label>{t('minecraft.port')}<input required type="number" min="1" max="65535" step="1" value={config.port} onChange={(event) => updateConfig('port', Number(event.target.value))} /></label>
          <label>{t('minecraft.auth')}<select value={config.auth} onChange={(event) => updateConfig('auth', event.target.value as MinecraftConnectionConfig['auth'])}><option value="offline">{t('minecraft.auth.offline')}</option><option value="microsoft">{t('minecraft.auth.microsoft')}</option></select></label>
          <label>{t('minecraft.username')}<input required maxLength={config.auth === 'offline' ? 16 : 254} pattern={config.auth === 'offline' ? '[A-Za-z0-9_]+' : undefined} value={config.username} onChange={(event) => updateConfig('username', event.target.value)} autoComplete="off" /></label>
          <p className="minecraft-help minecraft-full-width">{t(`minecraft.auth.${config.auth}Detail`)}</p>
          <label>{t('minecraft.version')}<input required maxLength={32} pattern="auto|1\.[0-9]+(\.[0-9]+)?" value={config.version} onChange={(event) => updateConfig('version', event.target.value)} /></label>
          <label>{t('minecraft.owner')}<input maxLength={16} pattern="[A-Za-z0-9_]*" value={config.ownerName} onChange={(event) => updateConfig('ownerName', event.target.value)} autoComplete="off" /></label>
          <p className="minecraft-help">{t('minecraft.versionDetail')}</p>
          <p className="minecraft-help">{t('minecraft.ownerDetail')}</p>
          <label className="minecraft-full-width">{t('minecraft.executor')}<select value={config.executorMode} onChange={(event) => updateConfig('executorMode', event.target.value as MinecraftConnectionConfig['executorMode'])}><option value="strict">{t('minecraft.executor.strict')}</option><option value="hybrid">{t('minecraft.executor.hybrid')}</option></select></label>
          {config.executorMode === 'hybrid' && <label className="minecraft-full-width">{t('minecraft.provider')}<select required value={config.providerId ?? ''} onChange={(event) => updateConfig('providerId', event.target.value || null)}><option value="">{t('minecraft.chooseProvider')}</option>{enabledProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}</select></label>}
        </fieldset>
        <p className="minecraft-help">{t(config.executorMode === 'strict' ? 'minecraft.strictDetail' : 'minecraft.hybridDetail')}</p>
        {config.executorMode === 'hybrid' && enabledProviders.length === 0 && <p className="notice">{t('minecraft.noProvider')}</p>}
        <div className="button-row"><button type="submit" disabled={snapshot === null || busy !== null || connected || connecting || disconnecting || !validProvider}>{t('minecraft.connect')}</button><button type="button" className="secondary" disabled={!canDisconnect} onClick={() => void run('disconnect', () => window.deskpet.minecraft.disconnect())}>{t('minecraft.disconnect')}</button></div>
      </form>
    </article>
    <article className="panel" aria-labelledby="minecraft-status-title">
      <div className="panel-heading"><h2 id="minecraft-status-title">{t('minecraft.observations')}</h2><button type="button" className="secondary" disabled={!canControl('refresh')} onClick={() => control('refresh')}>{t('minecraft.refresh')}</button></div>
      {!connected && <p className="minecraft-help">{t('minecraft.disconnectedStatus')}</p>}
      <dl className="minecraft-observations"><div><dt>{t('minecraft.health')}</dt><dd>{status?.health ?? unknown}</dd></div><div><dt>{t('minecraft.food')}</dt><dd>{status?.food ?? unknown}</dd></div><div><dt>{t('minecraft.position')}</dt><dd>{status?.position ? [status.position.x, status.position.y, status.position.z].map((number) => number.toFixed(1)).join(', ') : unknown}</dd></div><div><dt>{t('minecraft.dimension')}</dt><dd>{status?.dimension ?? unknown}</dd></div><div><dt>{t('minecraft.mode')}</dt><dd>{status?.mode ?? unknown}</dd></div></dl>
    </article>
    <div className="two-column">
      <article className="panel" aria-labelledby="minecraft-task-title">
        <h2 id="minecraft-task-title">{t('minecraft.task')}</h2>
        <form className="stack-form" onSubmit={submitTask}><label>{t('minecraft.goal')}<textarea maxLength={2000} placeholder={t('minecraft.goalPlaceholder')} value={goal} onChange={(event) => setGoal(event.target.value)} disabled={controlsDisabled || activeTask} /></label><button type="submit" disabled={controlsDisabled || activeTask || goal.trim().length === 0}>{t('minecraft.submit')}</button></form>
        <p className="minecraft-help">{t('minecraft.taskScope')}</p>
        {activeTask && <p className="minecraft-help">{t('minecraft.taskBusy')}</p>}
        <div className="minecraft-current-task" aria-live="polite">{snapshot?.task ? <><strong>{snapshot.task.goal}</strong><span>{t('minecraft.task.status')}: {taskLabel(snapshot.task.status)}</span>{snapshot.task.phase && <small>{snapshot.task.phase}</small>}{snapshot.task.summary && <p>{snapshot.task.summary}</p>}</> : <p className="minecraft-help">{t('minecraft.noTask')}</p>}</div>
        <div className="button-row minecraft-task-controls"><button type="button" className="secondary" disabled={!canControl('pause') || !activeTask || paused} onClick={() => control('pause')}>{t('minecraft.pause')}</button><button type="button" className="secondary" disabled={!canControl('resume') || !paused} onClick={() => control('resume')}>{t('minecraft.resume')}</button><button type="button" className="secondary" disabled={!canControl('cancel') || !activeTask} onClick={() => control('cancel')}>{t('minecraft.cancel')}</button><button type="button" className="minecraft-stop" disabled={!canControl('stop')} onClick={() => control('stop')}>{t('minecraft.stop')}</button></div>
      </article>
      <article className="panel" aria-labelledby="minecraft-chat-title">
        <h2 id="minecraft-chat-title">{t('minecraft.chat')}</h2>
        <form className="stack-form" onSubmit={sendChat}><label>{t('minecraft.chatMessage')}<input maxLength={240} placeholder={t('minecraft.chatPlaceholder')} value={chat} onChange={(event) => setChat(event.target.value)} disabled={controlsDisabled} /></label><p className="minecraft-help">{t('minecraft.chatDetail')}</p><button type="submit" disabled={controlsDisabled || !isPlainChat(chat)}>{t('minecraft.send')}</button></form>
        <h3>{t('minecraft.inventory')}</h3>
        {snapshot?.inventory.length ? <ul className="simple-list minecraft-inventory">{snapshot.inventory.map((item, index) => <li key={`${item.name}-${index}`}><strong>{item.displayName ?? item.name}</strong><span>× {item.count}</span></li>)}</ul> : <p className="minecraft-help">{t('minecraft.inventoryEmpty')}</p>}
      </article>
    </div>
    {Boolean(snapshot?.history.length) && <article className="panel" aria-labelledby="minecraft-history-title"><h2 id="minecraft-history-title">{t('minecraft.history')}</h2><ul className="simple-list">{snapshot?.history.slice(-8).reverse().map((task) => <li key={task.id}><div><strong>{task.goal}</strong>{task.summary && <small>{task.summary}</small>}</div><span>{taskLabel(task.status)}</span></li>)}</ul></article>}
    <article className="panel" aria-labelledby="minecraft-logs-title"><h2 id="minecraft-logs-title">{t('minecraft.logs')}</h2>{snapshot?.logs.length ? <ol className="minecraft-log-list">{snapshot.logs.slice(-50).reverse().map((log) => <li key={log.id}><time dateTime={log.timestamp}>{Number.isNaN(Date.parse(log.timestamp)) ? log.timestamp : new Date(log.timestamp).toLocaleTimeString()}</time><span className="tag">{log.kind}</span><p>{log.message}</p></li>)}</ol> : <p className="minecraft-help">{t('minecraft.logsEmpty')}</p>}</article>
  </section>;
};
