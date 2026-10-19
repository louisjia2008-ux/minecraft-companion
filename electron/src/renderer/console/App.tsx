import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, JSX, ReactNode } from 'react';

import type {
  AppState,
  CharacterState,
  ChatMessage,
  ChatSession,
  DeskTask,
  DiagnosticSnapshot,
  FocusSession,
  MemoryItem,
  MigrationPreview,
  MigrationResult,
  ImportProgress,
  PermissionDescriptor,
  PlatformCapability,
  ProviderConfig,
  RelationshipState,
  ScheduleDefinition,
  TaskRunEvent,
} from '../../shared';
import { messages, providerDefinitions } from '../../shared';
import type { MessageKey } from '../../shared';
import { MinecraftPage } from './MinecraftPage';

type View = 'today' | 'chat' | 'companion' | 'minecraft' | 'focus' | 'memory' | 'schedules' | 'activity' | 'settings';

interface Snapshot {
  app: AppState;
  character: CharacterState;
  sessions: ChatSession[];
  tasks: DeskTask[];
  focus: FocusSession | null;
  memories: MemoryItem[];
  relationship: RelationshipState;
  schedules: ScheduleDefinition[];
  providers: ProviderConfig[];
  permissions: PermissionDescriptor[];
  events: TaskRunEvent[];
}

const loadSnapshot = async (): Promise<Snapshot> => {
  const [appState, character, sessions, tasks, focus, memories, relationship, schedules, providers, permissions, events] =
    await Promise.all([
      window.deskpet.app.getState(),
      window.deskpet.character.getState(),
      window.deskpet.chat.listSessions(),
      window.deskpet.tasks.list(),
      window.deskpet.tasks.getFocus(),
      window.deskpet.memory.list(),
      window.deskpet.relationship.get(),
      window.deskpet.schedule.list(),
      window.deskpet.providers.list(),
      window.deskpet.permissions.list(),
      window.deskpet.tasks.listRunEvents(),
    ]);
  return { app: appState, character, sessions, tasks, focus, memories, relationship, schedules, providers, permissions, events };
};

export const ConsoleApp = (): JSX.Element => {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [view, setView] = useState<View>('today');
  const [error, setError] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setSnapshot(await loadSnapshot());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = [
      window.deskpet.app.onChanged(() => void refresh()),
      window.deskpet.character.onChanged(() => void refresh()),
      window.deskpet.tasks.onChanged(() => void refresh()),
      window.deskpet.memory.onChanged(() => void refresh()),
      window.deskpet.relationship.onChanged(() => void refresh()),
      window.deskpet.schedule.onChanged(() => void refresh()),
      window.deskpet.providers.onChanged(() => void refresh()),
      window.deskpet.permissions.onChanged(() => void refresh()),
    ];
    return () => unsubscribe.forEach((stop) => stop());
  }, [refresh]);

  const locale = snapshot?.app.resolvedLocale ?? 'en';
  const t = useCallback((key: string): string => messages[locale][key as MessageKey] ?? key, [locale]);

  if (snapshot === null) {
    return <main className="loading-state" aria-live="polite">{error ? t('common.error') : t('common.loading')}</main>;
  }

  const nav: Array<{ id: View; key: MessageKey; icon: string }> = [
    { id: 'today', key: 'nav.today', icon: '⌂' },
    { id: 'chat', key: 'nav.chat', icon: '✦' },
    { id: 'companion', key: 'nav.companion', icon: '◉' },
    { id: 'minecraft', key: 'nav.minecraft', icon: '▧' },
    { id: 'focus', key: 'nav.focus', icon: '◷' },
    { id: 'memory', key: 'nav.memory', icon: '◇' },
    { id: 'schedules', key: 'nav.schedules', icon: '◫' },
    { id: 'activity', key: 'nav.activity', icon: '≋' },
    { id: 'settings', key: 'nav.settings', icon: '⚙' },
  ];

  return (
    <div className="app-shell" data-theme={snapshot.app.theme}>
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand"><span className="brand-mark">D</span><div><strong>{t('app.name')}</strong><small>Electron</small></div></div>
        <nav>
          {nav.map((item) => (
            <button key={item.id} type="button" className={view === item.id ? 'nav-item active' : 'nav-item'} aria-current={view === item.id ? 'page' : undefined} onClick={() => setView(item.id)}>
              <span aria-hidden="true">{item.icon}</span>{t(item.key)}
            </button>
          ))}
        </nav>
        <div className="relationship-card"><span>{t('relationship.title')}</span><strong>Lv. {snapshot.relationship.level}</strong><div className="meter"><i style={{ width: `${snapshot.relationship.affinity}%` }} /></div></div>
      </aside>
      <main className="content" id="main-content">
        {error && <div className="error-banner" role="alert">{t('common.error')} <button type="button" onClick={() => void refresh()}>{t('common.retry')}</button></div>}
        {view === 'today' && <TodayPage snapshot={snapshot} t={t} setView={setView} />}
        {view === 'chat' && <ChatPage snapshot={snapshot} t={t} refresh={refresh} />}
        {view === 'companion' && <CompanionPage state={snapshot.character} t={t} refresh={refresh} />}
        {view === 'minecraft' && <MinecraftPage providers={snapshot.providers} t={t} />}
        {view === 'focus' && <FocusPage snapshot={snapshot} t={t} refresh={refresh} />}
        {view === 'memory' && <MemoryPage items={snapshot.memories} t={t} refresh={refresh} />}
        {view === 'schedules' && <SchedulePage items={snapshot.schedules} t={t} refresh={refresh} />}
        {view === 'activity' && <ActivityPage items={snapshot.events} t={t} />}
        {view === 'settings' && <SettingsPage snapshot={snapshot} t={t} refresh={refresh} />}
      </main>
    </div>
  );
};

type Translator = (key: string) => string;

const Header = ({ eyebrow, title, detail }: { eyebrow: string; title: string; detail?: string }): JSX.Element => (
  <header className="page-header"><span>{eyebrow}</span><h1>{title}</h1>{detail === undefined ? null : <p>{detail}</p>}</header>
);

const TodayPage = ({ snapshot, t, setView }: { snapshot: Snapshot; t: Translator; setView: (view: View) => void }): JSX.Element => (
  <section>
    <Header eyebrow={t('nav.today')} title={t('today.greeting')} detail={t('today.summary')} />
    <div className="hero-grid">
      <article className="hero-card companion-card"><span className="orb" /><div><small>{t('nav.companion')}</small><h2>{snapshot.character.modelName ?? t('setup.missingModel')}</h2><p>{snapshot.character.modelState === 'ready' ? t('companion.ready') : t('setup.security')}</p><button type="button" onClick={() => setView('companion')}>{t('nav.companion')}</button></div></article>
      <article className="stat-card"><small>{t('tasks.title')}</small><strong>{snapshot.tasks.filter((task) => task.status !== 'done').length}</strong><span>{t('tasks.empty')}</span></article>
      <article className="stat-card"><small>{t('focus.title')}</small><strong>{Math.round((snapshot.focus?.elapsedSeconds ?? 0) / 60)}</strong><span>{t('form.duration')}</span></article>
    </div>
    <div className="panel"><div className="panel-heading"><h2>{t('tasks.title')}</h2><button type="button" onClick={() => setView('focus')}>{t('tasks.add')}</button></div>{snapshot.tasks.length === 0 ? <Empty text={t('tasks.empty')} /> : <ul className="simple-list">{snapshot.tasks.slice(0, 5).map((task) => <li key={task.id}><span className={`status-dot ${task.status}`} /><div><strong>{task.title}</strong><small>{task.notes}</small></div><span>{task.status}</span></li>)}</ul>}</div>
  </section>
);

const ChatPage = ({ snapshot, t, refresh }: { snapshot: Snapshot; t: Translator; refresh: () => Promise<void> }): JSX.Element => {
  const [sessionId, setSessionId] = useState(snapshot.sessions[0]?.id ?? '');
  const [messagesState, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [running, setRunning] = useState<string | null>(null);
  const provider = snapshot.providers.find((item) => item.enabled);
  useEffect(() => { if (sessionId.length > 0) void window.deskpet.chat.listMessages(sessionId).then(setMessages); }, [sessionId]);
  useEffect(() => window.deskpet.chat.onEvent((event) => {
    if (event.type === 'delta') setMessages((items) => items.map((item) => item.id === event.messageId ? { ...item, content: item.content + event.text } : item));
    if (event.type === 'finished' || event.type === 'failed') { setRunning(null); void refresh(); if (sessionId.length > 0) void window.deskpet.chat.listMessages(sessionId).then(setMessages); }
  }), [refresh, sessionId]);
  const ensureSession = async (): Promise<string> => {
    if (sessionId.length > 0) return sessionId;
    const session = await window.deskpet.chat.createSession({ title: t('chat.new'), kind: 'normal' });
    setSessionId(session.id);
    return session.id;
  };
  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (draft.trim().length === 0 || provider === undefined) return;
    const activeSession = await ensureSession();
    const content = draft.trim(); setDraft('');
    setMessages((items) => [...items, { id: crypto.randomUUID(), sessionId: activeSession, role: 'user', content, createdAt: new Date().toISOString(), status: 'complete', errorCode: null }]);
    const result = await window.deskpet.chat.send({ sessionId: activeSession, content, providerId: provider.id }); setRunning(result.runId);
  };
  return <section className="chat-layout"><Header eyebrow={t('nav.chat')} title={t('nav.chat')} />
    <div className="chat-toolbar"><select aria-label={t('chat.new')} value={sessionId} onChange={(event) => setSessionId(event.target.value)}><option value="">{t('chat.new')}</option>{snapshot.sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}</select><span>{provider?.name ?? t('chat.noProvider')}</span></div>
    <div className="message-list" aria-live="polite">{messagesState.length === 0 ? <Empty text={t('chat.placeholder')} /> : messagesState.map((message) => <article key={message.id} className={`message ${message.role}`}><small>{message.role}</small><p>{message.content}</p></article>)}</div>
    <form className="composer" onSubmit={(event) => void send(event)}><textarea aria-label={t('chat.placeholder')} placeholder={t('chat.placeholder')} value={draft} onChange={(event) => setDraft(event.target.value)} /><button type={running === null ? 'submit' : 'button'} disabled={provider === undefined} onClick={running === null ? undefined : () => { void window.deskpet.chat.cancel(running); }}>{running === null ? t('chat.send') : t('chat.cancel')}</button></form>
  </section>;
};

const CompanionPage = ({ state, t, refresh }: { state: CharacterState; t: Translator; refresh: () => Promise<void> }): JSX.Element => {
  const missingCore = state.coreState !== 'ready';
  const missingModel = state.modelState === 'missing' || state.modelState === 'invalid';
  return <section><Header eyebrow={t('nav.companion')} title={missingCore || missingModel ? t('setup.title') : state.modelName ?? t('nav.companion')} detail={t('setup.security')} />
    {(missingCore || missingModel) ? <div className="setup-grid"><SetupStep number="1" title={t('setup.coreTitle')} detail={t('setup.coreDetail')} ready={!missingCore}><button type="button" onClick={() => void window.deskpet.character.importCore().then(refresh)}>{t('setup.chooseCore')}</button></SetupStep><SetupStep number="2" title={t('setup.modelTitle')} detail={t('setup.modelDetail')} ready={!missingModel}><button type="button" disabled={missingCore} onClick={() => void window.deskpet.character.importModel().then(refresh)}>{t('setup.chooseModel')}</button></SetupStep></div> : <div className="panel companion-controls"><div className="model-silhouette"><span>{state.modelName}</span></div><label>{t('companion.scale')}<input type="range" min="0.2" max="3" step="0.1" value={state.scale} onChange={(event) => void window.deskpet.character.setScale(Number(event.target.value)).then(refresh)} /></label><div className="button-row"><button type="button" onClick={() => void window.deskpet.character.playAction('greet')}>{t('companion.action')}</button><button type="button" className="secondary" onClick={() => void window.deskpet.character.importModel().then(refresh)}>{t('setup.changeModel')}</button></div></div>}
  </section>;
};

const SetupStep = ({ number, title, detail, ready, children }: { number: string; title: string; detail: string; ready: boolean; children: ReactNode }): JSX.Element => <article className={ready ? 'setup-step ready' : 'setup-step'}><span className="step-number">{ready ? '✓' : number}</span><div><h2>{title}</h2><p>{detail}</p>{children}</div></article>;

const FocusPage = ({ snapshot, t, refresh }: { snapshot: Snapshot; t: Translator; refresh: () => Promise<void> }): JSX.Element => {
  const [title, setTitle] = useState('');
  const [minutes, setMinutes] = useState(25);
  const addTask = async (event: FormEvent) => { event.preventDefault(); if (title.trim().length === 0) return; await window.deskpet.tasks.upsert({ id: crypto.randomUUID(), title: title.trim(), notes: '', status: 'todo', dueAt: null }); setTitle(''); await refresh(); };
  return <section><Header eyebrow={t('nav.focus')} title={t('focus.title')} /><div className="two-column"><div className="panel focus-panel"><div className="focus-time">{Math.floor((snapshot.focus?.elapsedSeconds ?? 0) / 60).toString().padStart(2, '0')}:00</div><label>{t('form.duration')}<input type="number" min="1" max="1440" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label><div className="button-row">{snapshot.focus === null || ['completed', 'cancelled'].includes(snapshot.focus.status) ? <button type="button" onClick={() => void window.deskpet.tasks.startFocus({ taskId: null, plannedSeconds: minutes * 60 }).then(refresh)}>{t('focus.start')}</button> : snapshot.focus.status === 'running' ? <button type="button" onClick={() => void window.deskpet.tasks.pauseFocus().then(refresh)}>{t('focus.pause')}</button> : <button type="button" onClick={() => void window.deskpet.tasks.resumeFocus().then(refresh)}>{t('focus.resume')}</button>}<button type="button" className="secondary" disabled={snapshot.focus === null} onClick={() => void window.deskpet.tasks.stopFocus('completed').then(refresh)}>{t('focus.complete')}</button></div></div><div className="panel"><h2>{t('tasks.title')}</h2><form className="inline-form" onSubmit={(event) => void addTask(event)}><input aria-label={t('form.title')} value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t('form.title')} /><button type="submit">{t('tasks.add')}</button></form><ul className="simple-list">{snapshot.tasks.map((task) => <li key={task.id}><input type="checkbox" aria-label={task.title} checked={task.status === 'done'} onChange={() => void window.deskpet.tasks.upsert({ ...task, status: task.status === 'done' ? 'todo' : 'done' }).then(refresh)} /><strong>{task.title}</strong></li>)}</ul></div></div></section>;
};

const MemoryPage = ({ items, t, refresh }: { items: MemoryItem[]; t: Translator; refresh: () => Promise<void> }): JSX.Element => {
  const [text, setText] = useState(''); const [tags, setTags] = useState('');
  const save = async (event: FormEvent) => { event.preventDefault(); if (text.trim().length === 0) return; await window.deskpet.memory.upsert({ id: crypto.randomUUID(), text: text.trim(), tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean) }); setText(''); setTags(''); await refresh(); };
  return <section><Header eyebrow={t('nav.memory')} title={t('memory.title')} /><div className="panel"><form className="stack-form" onSubmit={(event) => void save(event)}><textarea aria-label={t('form.text')} value={text} onChange={(event) => setText(event.target.value)} placeholder={t('form.text')} /><input aria-label={t('form.tags')} value={tags} onChange={(event) => setTags(event.target.value)} placeholder={t('form.tags')} /><button type="submit">{t('memory.add')}</button></form></div><div className="card-grid">{items.length === 0 ? <Empty text={t('memory.empty')} /> : items.map((item) => <article className="memory-card" key={item.id}><p>{item.text}</p><div>{item.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div><button type="button" className="text-button" onClick={() => void window.deskpet.memory.remove(item.id).then(refresh)}>{t('common.delete')}</button></article>)}</div></section>;
};

const SchedulePage = ({ items, t, refresh }: { items: ScheduleDefinition[]; t: Translator; refresh: () => Promise<void> }): JSX.Element => {
  const [title, setTitle] = useState(''); const [interval, setInterval] = useState(60);
  const save = async (event: FormEvent) => { event.preventDefault(); if (title.trim().length === 0) return; await window.deskpet.schedule.upsert({ id: crypto.randomUUID(), title: title.trim(), enabled: true, kind: 'reminder', rrule: `FREQ=MINUTELY;INTERVAL=${interval}`, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, payload: {} }); setTitle(''); await refresh(); };
  return <section><Header eyebrow={t('nav.schedules')} title={t('schedule.title')} /><div className="panel"><form className="inline-form" onSubmit={(event) => void save(event)}><input aria-label={t('form.title')} value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t('form.title')} /><input aria-label={t('form.interval')} type="number" min="1" value={interval} onChange={(event) => setInterval(Number(event.target.value))} /><button type="submit">{t('schedule.add')}</button></form><ul className="simple-list">{items.map((item) => <li key={item.id}><span className={`status-dot ${item.enabled ? 'doing' : 'cancelled'}`} /><div><strong>{item.title}</strong><small>{item.nextRunAt === null ? t('common.off') : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.nextRunAt))}</small></div><button type="button" className="secondary" onClick={() => void window.deskpet.schedule.runNow(item.id)}>{t('schedule.runNow')}</button></li>)}</ul></div></section>;
};

const ActivityPage = ({ items, t }: { items: TaskRunEvent[]; t: Translator }): JSX.Element => <section><Header eyebrow={t('nav.activity')} title={t('activity.title')} />{items.length === 0 ? <Empty text={t('activity.empty')} /> : <div className="panel table-wrap"><table><thead><tr><th>{t('activity.status')}</th><th>{t('activity.summary')}</th><th>{t('settings.status')}</th></tr></thead><tbody>{items.slice().reverse().map((item) => <tr key={item.id}><td><span className={`status-pill ${item.status}`}>{item.status}</span></td><td>{item.summary}</td><td>{new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(item.createdAt))}</td></tr>)}</tbody></table></div>}</section>;

const SettingsPage = ({ snapshot, t, refresh }: { snapshot: Snapshot; t: Translator; refresh: () => Promise<void> }): JSX.Element => {
  const [tab, setTab] = useState<'general' | 'providers' | 'permissions' | 'privacy' | 'migration' | 'advanced'>('general');
  const [diagnostics, setDiagnostics] = useState<DiagnosticSnapshot | null>(null);
  const tabs = useMemo(() => [
    ['general', 'settings.general'], ['providers', 'settings.providers'], ['permissions', 'settings.permissions'], ['privacy', 'settings.privacy'], ['migration', 'settings.migration'], ['advanced', 'settings.advanced'],
  ] as const, []);
  return <section><Header eyebrow={t('nav.settings')} title={t('nav.settings')} /><div className="settings-layout"><div className="settings-tabs" role="tablist">{tabs.map(([id, key]) => <button type="button" role="tab" aria-selected={tab === id} key={id} onClick={() => setTab(id)}>{t(key)}</button>)}</div><div className="settings-panel">
    {tab === 'general' && <GeneralSettings snapshot={snapshot} t={t} refresh={refresh} />}
    {tab === 'providers' && <ProviderSettings providers={snapshot.providers} t={t} refresh={refresh} />}
    {tab === 'permissions' && <PermissionSettings permissions={snapshot.permissions} t={t} refresh={refresh} />}
    {tab === 'privacy' && <div><h2>{t('settings.privacy')}</h2><p>{t('privacy.localOnly')}</p><code className="path-block">{snapshot.app.dataDirectory}</code></div>}
    {tab === 'migration' && <MigrationSettings t={t} refresh={refresh} />}
    {tab === 'advanced' && <div><h2>{t('diagnostics.title')}</h2><button type="button" onClick={() => void window.deskpet.app.getDiagnostics().then(setDiagnostics)}>{t('diagnostics.refresh')}</button>{diagnostics === null ? null : <pre>{JSON.stringify(diagnostics, null, 2)}</pre>}</div>}
  </div></div></section>;
};

const MigrationSettings = ({ t, refresh }: { t: Translator; refresh: () => Promise<void> }): JSX.Element => {
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<MigrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => window.deskpet.migration.onProgress(setProgress), []);
  const review = async (): Promise<void> => {
    setError(null);
    try {
      const value = await window.deskpet.migration.preview();
      setPreview(value);
      setSelected(value.categories.filter((item) => item.count > 0).map((item) => item.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('common.error'));
    }
  };
  const start = async (): Promise<void> => {
    if (selected.length === 0 || preview?.available !== true) return;
    if (includeSecrets && !window.confirm(t('migration.secretsPrompt'))) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const value = await window.deskpet.migration.start({ categories: selected, confirmProviderSecrets: includeSecrets });
      setResult(value);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  return <div><h2>{t('migration.title')}</h2><p>{t('migration.sourceReadOnly')}</p><p>{t('migration.emptyProfile')}</p>
    <button type="button" disabled={busy} onClick={() => void review()}>{t('migration.preview')}</button>
    {preview === null ? null : <div className="migration-preview"><code className="path-block">{preview.sourcePath ?? t('migration.notFound')}</code>
      {!preview.available && <p className="notice">{preview.warnings.map((warning) => t(`migration.warning.${warning}`)).join(' · ')}</p>}
      <div className="migration-categories">{preview.categories.map((category) => <label className="check-row" key={category.id}><input type="checkbox" checked={selected.includes(category.id)} disabled={busy || category.count === 0 || !preview.available} onChange={(event) => setSelected((items) => event.target.checked ? [...items, category.id] : items.filter((item) => item !== category.id))} /><span>{t(`migration.category.${category.id}`)}</span><strong>{category.count}</strong></label>)}</div>
      {preview.requiresKeychainConfirmation && selected.includes('providers') && <label className="check-row warning-check"><input type="checkbox" checked={includeSecrets} disabled={busy} onChange={(event) => setIncludeSecrets(event.target.checked)} />{t('migration.secretsConfirm')}</label>}
      <div className="button-row"><button type="button" disabled={busy || !preview.available || selected.length === 0} onClick={() => void start()}>{t('migration.start')}</button>{busy && <button type="button" className="secondary" onClick={() => void window.deskpet.migration.cancel()}>{t('migration.cancel')}</button>}</div>
    </div>}
    {progress === null ? null : <div className="migration-progress" aria-live="polite"><progress max={progress.total} value={progress.completed} /><span>{t(progress.messageCode)} · {progress.completed}/{progress.total}</span></div>}
    {result === null ? null : <div className="success-card" role="status"><strong>{t('migration.complete')}</strong><p>{Object.entries(result.imported).map(([key, count]) => `${t(`migration.category.${key}`)}: ${count}`).join(' · ')}</p></div>}
    {error === null ? null : <p className="error-banner" role="alert">{error}</p>}
  </div>;
};

const GeneralSettings = ({ snapshot, t, refresh }: { snapshot: Snapshot; t: Translator; refresh: () => Promise<void> }): JSX.Element => <div><h2>{t('settings.general')}</h2><div className="setting-row"><label htmlFor="language">{t('settings.language')}</label><select id="language" value={snapshot.app.locale} onChange={(event) => void window.deskpet.app.setLocale(event.target.value as AppState['locale']).then(refresh)}><option value="system">{t('settings.system')}</option><option value="en">{t('settings.english')}</option><option value="zh-CN">{t('settings.chinese')}</option></select></div><div className="setting-row"><label htmlFor="theme">{t('settings.theme')}</label><select id="theme" value={snapshot.app.theme} onChange={(event) => void window.deskpet.app.setTheme(event.target.value as AppState['theme']).then(refresh)}><option value="system">{t('settings.system')}</option><option value="light">{t('settings.light')}</option><option value="dark">{t('settings.dark')}</option></select></div><div className="setting-row"><label htmlFor="hotkey">{t('settings.hotkey')}</label><input id="hotkey" value={snapshot.app.hotkey} onChange={(event) => void window.deskpet.app.setHotkey(event.target.value).then(refresh)} /><span className={`status-pill ${snapshot.app.hotkeyRegistered ? 'succeeded' : 'failed'}`}>{snapshot.app.hotkeyRegistered ? t('capability.state.available') : t('capability.state.unavailable')}</span></div><label className="check-row"><input type="checkbox" checked={snapshot.app.autoLaunch} onChange={(event) => void window.deskpet.app.setAutoLaunch(event.target.checked).then(refresh)} />{t('settings.autoLaunch')}</label><h2>{t('settings.capabilities')}</h2><div className="capability-list">{snapshot.app.capabilities.map((item) => <CapabilityRow key={item.id} item={item} t={t} />)}</div></div>;

const CapabilityRow = ({ item, t }: { item: PlatformCapability; t: Translator }): JSX.Element => <div className="capability-row"><div><strong>{item.id}</strong><small>{t(item.reasonCode)}</small></div><span className={`status-pill ${item.state}`}>{t(`capability.state.${item.state}`)}</span></div>;

const ProviderCard = ({ provider, feedback, models, t, onTest, onModels, onSelectModel, refresh }: {
  provider: ProviderConfig;
  feedback: string | undefined;
  models: string[] | undefined;
  t: Translator;
  onTest(id: string): Promise<void>;
  onModels(id: string): Promise<void>;
  onSelectModel(provider: ProviderConfig, model: string): Promise<void>;
  refresh(): Promise<void>;
}): JSX.Element => <article>
  <div><strong>{provider.name}</strong><small>{provider.kind} · {provider.model}</small></div>
  <span className={`status-pill ${provider.secretState === 'configured' ? 'succeeded' : 'degraded'}`}>
    {provider.secretState === 'configured' ? t('provider.apiKeyStored') : t('provider.apiKeyMissing')}
  </span>
  <div className="button-row">
    <button type="button" className="secondary" onClick={() => void onTest(provider.id)}>{t('provider.test')}</button>
    <button type="button" className="secondary" onClick={() => void onModels(provider.id)}>{t('provider.models')}</button>
    <button type="button" className="text-button" disabled={provider.secretState !== 'configured'} onClick={() => void window.deskpet.providers.clearSecret(provider.id).then(refresh)}>{t('provider.clearKey')}</button>
    <button type="button" className="text-button" onClick={() => void window.deskpet.providers.remove(provider.id).then(refresh)}>{t('common.delete')}</button>
  </div>
  {feedback === undefined ? null : <small role="status">{feedback}</small>}
  {models === undefined
    ? null
    : models.length === 0
      ? <small>{t('provider.models.empty')}</small>
      : <div className="model-list">{models.map((item) => <button type="button" className={item === provider.model ? 'tag active' : 'tag'} key={item} onClick={() => void onSelectModel(provider, item)}>{item}</button>)}</div>}
</article>;

const ProviderSettings = ({ providers, t, refresh }: { providers: ProviderConfig[]; t: Translator; refresh: () => Promise<void> }): JSX.Element => {
  const [kind, setKind] = useState(providerDefinitions[0]?.kind ?? 'openai'); const definition = providerDefinitions.find((item) => item.kind === kind) ?? providerDefinitions[0];
  const [name, setName] = useState(''); const [baseUrl, setBaseUrl] = useState(definition?.defaultBaseUrl ?? ''); const [model, setModel] = useState(''); const [apiKey, setApiKey] = useState('');
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Record<string, string[]>>({});
  useEffect(() => { setBaseUrl(definition?.defaultBaseUrl ?? ''); }, [definition]);
  const save = async (event: FormEvent) => { event.preventDefault(); await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind, name: name || definition?.label || kind, baseUrl, model, enabled: true, supportsTools: true, ...(apiKey.length === 0 ? {} : { apiKey }) }); setApiKey(''); await refresh(); };
  const testProvider = async (id: string): Promise<void> => {
    const result = await window.deskpet.providers.test(id);
    setFeedback((items) => ({ ...items, [id]: t(result.messageCode) }));
  };
  const refreshModels = async (id: string): Promise<void> => {
    try {
      const items = await window.deskpet.providers.listModels(id);
      setModels((current) => ({ ...current, [id]: items.map((item) => item.id) }));
    } catch {
      setFeedback((items) => ({ ...items, [id]: t('provider.test.failed') }));
    }
  };
  const selectModel = async (provider: ProviderConfig, selectedModel: string): Promise<void> => {
    await window.deskpet.providers.upsert({
      id: provider.id, kind: provider.kind, name: provider.name, baseUrl: provider.baseUrl,
      model: selectedModel, enabled: provider.enabled, supportsTools: provider.supportsTools,
    });
    await refresh();
  };
  return <div><h2>{t('provider.title')}</h2><div className="provider-list">{providers.length === 0 ? <Empty text={t('provider.empty')} /> : providers.map((provider) => <ProviderCard key={provider.id} provider={provider} feedback={feedback[provider.id]} models={models[provider.id]} t={t} onTest={testProvider} onModels={refreshModels} onSelectModel={selectModel} refresh={refresh} />)}</div><form className="stack-form provider-form" onSubmit={(event) => void save(event)}><label>{t('provider.type')}<select value={kind} onChange={(event) => setKind(event.target.value as ProviderConfig['kind'])}>{providerDefinitions.map((item) => <option key={item.kind} value={item.kind}>{item.label}</option>)}</select></label><label>{t('provider.name')}<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>{t('provider.baseUrl')}<input type="url" required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label><label>{t('provider.model')}<input required value={model} onChange={(event) => setModel(event.target.value)} /></label><label>{t('provider.apiKey')}<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label><button type="submit">{t('provider.save')}</button></form><p className="notice">{t('provider.unsupported')}</p></div>;
};

const PermissionSettings = ({ permissions, t, refresh }: { permissions: PermissionDescriptor[]; t: Translator; refresh: () => Promise<void> }): JSX.Element => <div><h2>{t('permission.title')}</h2><div className="permission-list">{permissions.map((permission) => <article key={permission.capabilityId}><div><strong>{permission.capabilityId}</strong><small>{permission.risk}</small></div><span className={`status-pill ${permission.state === 'denied' ? 'failed' : permission.state === 'not-requested' ? 'degraded' : 'succeeded'}`}>{permission.state}</span>{permission.state === 'not-requested' || permission.state === 'denied' ? <button type="button" onClick={() => void window.deskpet.permissions.request({ capabilityId: permission.capabilityId, duration: 'session' }).then(refresh)}>{t('permission.allowSession')}</button> : <button type="button" className="secondary" onClick={() => void window.deskpet.permissions.revoke(permission.capabilityId).then(refresh)}>{t('permission.revoke')}</button>}</article>)}</div></div>;

const Empty = ({ text }: { text: string }): JSX.Element => <div className="empty-state"><span aria-hidden="true">✦</span><p>{text}</p></div>;
