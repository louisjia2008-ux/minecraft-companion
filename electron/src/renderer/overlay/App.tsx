import { useEffect, useRef, useState } from 'react';
import type { JSX, PointerEvent } from 'react';

import type { CharacterState } from '../../shared';
import { messages } from '../../shared';
import { Live2DHost } from '../live2d';

export const OverlayApp = (): JSX.Element => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<Live2DHost | null>(null);
  const interactive = useRef(false);
  const [state, setState] = useState<CharacterState | null>(null);
  const [locale, setLocale] = useState<'en' | 'zh-CN'>('en');
  const [loadError, setLoadError] = useState(false);
  const coreUrl = state?.coreUrl ?? null;
  const modelUrl = state?.modelUrl ?? null;
  const pendingImportId = state?.pendingImportId ?? null;
  const scale = state?.scale ?? 1;

  useEffect(() => {
    void Promise.all([window.deskpet.character.getState(), window.deskpet.app.getState()]).then(([character, app]) => {
      setState(character);
      setLocale(app.resolvedLocale);
    });
    const stopCharacter = window.deskpet.character.onChanged(setState);
    const stopApp = window.deskpet.app.onChanged((app) => setLocale(app.resolvedLocale));
    return () => { stopCharacter(); stopApp(); };
  }, []);

  useEffect(() => {
    if (canvas.current === null || coreUrl === null || modelUrl === null) return;
    const live2d = new Live2DHost(canvas.current);
    host.current = live2d;
    setLoadError(false);
    void live2d.load(coreUrl, modelUrl).then(async () => {
      live2d.setScale(scale);
      if (pendingImportId !== null) await window.deskpet.character.acknowledgeModelLoaded(pendingImportId);
    }).catch(() => setLoadError(true));
    const resize = new ResizeObserver(() => live2d.fit());
    resize.observe(canvas.current);
    return () => { resize.disconnect(); void live2d.destroy(); host.current = null; };
  }, [coreUrl, modelUrl, pendingImportId, scale]);

  useEffect(() => {
    if (state?.action !== null && state?.action !== undefined) void host.current?.playSemanticAction(state.action);
  }, [state?.action]);
  useEffect(() => {
    if (state?.expression !== null && state?.expression !== undefined) void host.current?.setExpression(state.expression);
  }, [state?.expression]);

  const setInteractive = (next: boolean): void => {
    if (interactive.current === next) return;
    interactive.current = next;
    void window.deskpet.character.setInteractive(next);
  };
  const pointer = (event: PointerEvent<HTMLElement>): void => {
    if (event.type === 'pointerleave') {
      setInteractive(false);
      return;
    }
    const element = event.target instanceof Element ? event.target : null;
    const control = element?.closest('.drag-handle, .setup-card, .speech-bubble') !== null;
    setInteractive(control || (ready && (host.current?.containsPoint(event.clientX, event.clientY) ?? false)));
  };
  const t = (key: keyof typeof messages.en): string => messages[locale][key];
  const ready = state?.coreState === 'ready' && (state.modelState === 'ready' || state.modelState === 'loading');

  return (
    <main className="overlay-root" onPointerMove={pointer} onPointerLeave={pointer}>
      <div className="drag-handle" aria-hidden="true"><i /></div>
      {state?.bubble === null || state?.bubble === undefined ? null : <div className="speech-bubble" role="status">{state.bubble}</div>}
      <canvas ref={canvas} className={ready ? 'live2d-canvas visible' : 'live2d-canvas'} aria-label={state?.modelName ?? t('nav.companion')} />
      {!ready || loadError ? <button type="button" className="setup-card" onClick={() => void window.deskpet.app.showConsole()}><span>✦</span><strong>{loadError ? t('common.error') : state?.coreState !== 'ready' ? t('setup.missingCore') : t('setup.missingModel')}</strong><small>{t('setup.title')}</small></button> : null}
    </main>
  );
};
