// @vitest-environment node
import type { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WindowManager } from './window-manager';

interface NativeContents extends EventEmitter {
  id: number;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

interface NativeWindow extends EventEmitter {
  contents: NativeContents;
  destroyed: boolean;
  deferClosed: boolean;
  destroy: () => void;
  show: () => void;
  showInactive: () => void;
}

interface NativeTray extends EventEmitter {
  destroyed: boolean;
  destroy: () => void;
}

const native = vi.hoisted(() => ({ windows: [] as NativeWindow[], trays: [] as NativeTray[], nextId: 1 }));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Contents extends EventEmitter {
    readonly id = native.nextId++;
    setWindowOpenHandler = vi.fn();
    getURL = vi.fn(() => 'deskpet://app/main_window/index.html');
    send = vi.fn();
  }
  class Window extends EventEmitter {
    readonly contents = new Contents();
    destroyed = false;
    deferClosed = false;
    constructor() { super(); native.windows.push(this); }
    // Electron has already invalidated this native getter when `closed` fires.
    get webContents(): Contents {
      if (this.destroyed) throw new TypeError('Object has been destroyed');
      return this.contents;
    }
    isDestroyed(): boolean { return this.destroyed; }
    destroy = vi.fn(() => {
      if (this.destroyed) throw new TypeError('Object has been destroyed');
      this.destroyed = true;
      if (!this.deferClosed) this.emit('closed');
    });
    show = vi.fn(() => { if (this.destroyed) throw new TypeError('Object has been destroyed'); });
    showInactive = vi.fn(() => { if (this.destroyed) throw new TypeError('Object has been destroyed'); });
    focus = vi.fn();
    hide = vi.fn();
    loadURL = vi.fn(async () => undefined);
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setIgnoreMouseEvents = vi.fn();
  }
  class Tray extends EventEmitter {
    destroyed = false;
    constructor() { super(); native.trays.push(this); }
    isDestroyed(): boolean { return this.destroyed; }
    destroy = vi.fn(() => {
      if (this.destroyed) throw new TypeError('Object has been destroyed');
      this.destroyed = true;
    });
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
  }
  return {
    BrowserWindow: Window, Tray,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
    nativeImage: { createFromDataURL: () => ({ setTemplateImage: vi.fn() }) },
    Menu: { buildFromTemplate: vi.fn((template: unknown) => template) },
  };
});

beforeEach(() => {
  native.windows.length = 0;
  native.trays.length = 0;
  native.nextId = 1;
  vi.stubGlobal('MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY', '/console-preload.js');
  vi.stubGlobal('MAIN_WINDOW_WEBPACK_ENTRY', 'deskpet://app/main_window/index.html');
  vi.stubGlobal('OVERLAY_WINDOW_PRELOAD_WEBPACK_ENTRY', '/overlay-preload.js');
  vi.stubGlobal('OVERLAY_WINDOW_WEBPACK_ENTRY', 'deskpet://app/overlay_window/index.html');
});

function fixture(): { manager: WindowManager; console: NativeWindow; overlay: NativeWindow } {
  const manager = new WindowManager();
  manager.createWindows();
  return { manager, console: native.windows[0]!, overlay: native.windows[1]! };
}

const role = (manager: WindowManager, id: number) => manager.roleFor({ id } as WebContents);

describe('WindowManager native lifetime', () => {
  it('forgets a closed window without accessing its destroyed native webContents', () => {
    const { manager, console, overlay } = fixture();
    const id = console.contents.id;
    expect(role(manager, id)).toBe('console');
    expect(() => console.destroy()).not.toThrow();
    expect(manager.consoleWindow()).toBeNull();
    expect(manager.overlayWindow()).toBe(overlay);
    expect(role(manager, id)).toBeNull();
    expect(role(manager, overlay.contents.id)).toBe('overlay');
  });

  it('disposes both native windows and the tray exactly once across repeated calls', () => {
    const { manager, console, overlay } = fixture();
    manager.createTray({ toggleOverlay: vi.fn(), showConsole: vi.fn(), quit: vi.fn() },
      { show: 'Open', toggle: 'Toggle', quit: 'Quit' });
    const tray = native.trays[0]!;
    expect(() => { manager.dispose(); manager.dispose(); }).not.toThrow();
    for (const item of [console, overlay, tray]) expect(item.destroy).toHaveBeenCalledTimes(1);
    expect(manager.consoleWindow()).toBeNull();
    expect(manager.overlayWindow()).toBeNull();
    expect(role(manager, console.contents.id)).toBeNull();
    expect(role(manager, overlay.contents.id)).toBeNull();
  });

  it('handles a synchronous closed callback reentering dispose while both windows are being destroyed', () => {
    const { manager, console, overlay } = fixture();
    console.on('closed', () => manager.dispose());
    expect(() => manager.dispose()).not.toThrow();
    expect(console.destroy).toHaveBeenCalledTimes(1);
    expect(overlay.destroy).toHaveBeenCalledTimes(1);
    expect(manager.consoleWindow()).toBeNull();
    expect(manager.overlayWindow()).toBeNull();
  });

  it('skips native objects already destroyed before their closed notification', () => {
    const { manager, console, overlay } = fixture();
    console.deferClosed = true;
    console.destroy();
    manager.createTray({ toggleOverlay: vi.fn(), showConsole: vi.fn(), quit: vi.fn() },
      { show: 'Open', toggle: 'Toggle', quit: 'Quit' });
    const tray = native.trays[0]!;
    tray.destroy();
    expect(() => manager.dispose()).not.toThrow();
    for (const item of [console, overlay, tray]) expect(item.destroy).toHaveBeenCalledTimes(1);
    expect(role(manager, console.contents.id)).toBeNull();
  });

  it('does not show windows when a queued ready-to-show arrives after disposal', () => {
    const { manager, console, overlay } = fixture();
    manager.dispose();
    expect(() => { console.emit('ready-to-show'); overlay.emit('ready-to-show'); }).not.toThrow();
    expect(console.show).not.toHaveBeenCalled();
    expect(overlay.showInactive).not.toHaveBeenCalled();
  });

  it('keeps replacement windows when an older closed callback arrives later', () => {
    const { manager, console, overlay } = fixture();
    console.deferClosed = true;
    overlay.deferClosed = true;
    manager.dispose();
    manager.createWindows();
    const newConsole = manager.consoleWindow();
    const newOverlay = manager.overlayWindow();
    expect(() => { console.emit('closed'); overlay.emit('closed'); }).not.toThrow();
    expect(manager.consoleWindow()).toBe(newConsole);
    expect(manager.overlayWindow()).toBe(newOverlay);
    expect(role(manager, native.windows[2]!.contents.id)).toBe('console');
    expect(role(manager, native.windows[3]!.contents.id)).toBe('overlay');
  });
});
