import { BrowserWindow, nativeImage, screen, Tray, Menu } from 'electron';
import type { MenuItemConstructorOptions, WebContents } from 'electron';

import type { WindowRole } from '../shared';

export interface WindowManagerActions {
  toggleOverlay(): void;
  showConsole(): void;
  quit(): void;
}

export const secureWebPreferences = (preload: string): Electron.WebPreferences => ({
  preload,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  navigateOnDragDrop: false,
  spellcheck: false,
});

export class WindowManager {
  #console: BrowserWindow | null = null;
  #overlay: BrowserWindow | null = null;
  #tray: Tray | null = null;
  readonly #roles = new Map<number, WindowRole>();

  roleFor(webContents: WebContents): WindowRole | null {
    return this.#roles.get(webContents.id) ?? null;
  }

  consoleWindow(): BrowserWindow | null { return this.#console; }
  overlayWindow(): BrowserWindow | null { return this.#overlay; }

  createWindows(): void {
    this.#console ??= this.#createConsole();
    this.#overlay ??= this.#createOverlay();
  }

  #guard(window: BrowserWindow, role: WindowRole): void {
    // `closed` fires after Electron has invalidated the native window getters.
    const webContentsId = window.webContents.id;
    this.#roles.set(webContentsId, role);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      const current = window.webContents.getURL();
      if (url !== current) event.preventDefault();
    });
    window.on('closed', () => {
      this.#roles.delete(webContentsId);
      if (this.#console === window) this.#console = null;
      if (this.#overlay === window) this.#overlay = null;
    });
  }

  #createConsole(): BrowserWindow {
    const window = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 820,
      minHeight: 600,
      show: false,
      backgroundColor: '#10131a',
      title: 'DeskPet Electron',
      webPreferences: secureWebPreferences(MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY),
    });
    this.#guard(window, 'console');
    void window.loadURL(process.env.NODE_ENV === 'development' ? MAIN_WINDOW_WEBPACK_ENTRY : 'deskpet://app/main_window/index.html');
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
    return window;
  }

  #createOverlay(): BrowserWindow {
    const display = screen.getPrimaryDisplay().workArea;
    const width = 420;
    const height = 620;
    const window = new BrowserWindow({
      x: display.x + display.width - width - 28,
      y: display.y + display.height - height - 28,
      width,
      height,
      minWidth: 240,
      minHeight: 320,
      frame: false,
      transparent: true,
      resizable: true,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      fullscreenable: false,
      webPreferences: secureWebPreferences(OVERLAY_WINDOW_PRELOAD_WEBPACK_ENTRY),
    });
    window.setAlwaysOnTop(true, 'floating');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (process.platform !== 'linux') window.setIgnoreMouseEvents(true, { forward: true });
    this.#guard(window, 'overlay');
    void window.loadURL(process.env.NODE_ENV === 'development' ? OVERLAY_WINDOW_WEBPACK_ENTRY : 'deskpet://app/overlay_window/index.html');
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.showInactive(); });
    return window;
  }

  setOverlayInteractive(interactive: boolean): void {
    if (process.platform !== 'linux') this.#overlay?.setIgnoreMouseEvents(!interactive, { forward: !interactive });
  }

  setOverlayVisible(visible: boolean): void {
    if (visible) this.#overlay?.showInactive();
    else this.#overlay?.hide();
  }

  showConsole(): void {
    if (this.#console === null) this.#console = this.#createConsole();
    this.#console.show();
    this.#console.focus();
  }

  send(role: WindowRole, channel: string, value: unknown): void {
    const target = role === 'console' ? this.#console : this.#overlay;
    if (target !== null && !target.isDestroyed()) target.webContents.send(channel, value);
  }

  broadcast(channel: string, value: unknown): void {
    this.send('console', channel, value);
    this.send('overlay', channel, value);
  }

  createTray(actions: WindowManagerActions, labels: { show: string; toggle: string; quit: string }): void {
    if (this.#tray !== null) return;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><path fill="black" d="M11 2a7 7 0 0 0-7 7v3l-2 3h18l-2-3V9a7 7 0 0 0-7-7Zm0 19a3 3 0 0 0 2.8-2H8.2A3 3 0 0 0 11 21Z"/></svg>';
    const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
    image.setTemplateImage(true);
    this.#tray = new Tray(image);
    const template: MenuItemConstructorOptions[] = [
      { label: labels.show, click: actions.showConsole },
      { label: labels.toggle, click: actions.toggleOverlay },
      { type: 'separator' },
      { label: labels.quit, click: actions.quit },
    ];
    this.#tray.setToolTip('DeskPet Electron');
    this.#tray.setContextMenu(Menu.buildFromTemplate(template));
    this.#tray.on('click', actions.showConsole);
  }

  dispose(): void {
    const tray = this.#tray;
    const windows = [this.#console, this.#overlay];
    // Clear ownership before native destruction, whose events can reenter us.
    this.#tray = null;
    this.#console = null;
    this.#overlay = null;
    this.#roles.clear();
    if (tray !== null && !tray.isDestroyed()) tray.destroy();
    for (const window of windows) {
      if (window !== null && !window.isDestroyed()) window.destroy();
    }
  }
}
