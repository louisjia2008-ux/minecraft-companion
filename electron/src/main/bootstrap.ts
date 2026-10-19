import { app, dialog } from 'electron';
import started from 'electron-squirrel-startup';
import { isAbsolute } from 'node:path';

import { AppController } from './app-controller';
import { installLocalProtocol, registerDeskPetScheme } from './local-protocol';
import { WindowManager } from './window-manager';

registerDeskPetScheme();
app.setName('DeskPet Electron');
const isolatedTestData = !app.isPackaged
  ? process.env.DESKPET_E2E_USER_DATA
  : undefined;
app.setPath(
  'userData',
  isolatedTestData !== undefined && isAbsolute(isolatedTestData)
    ? isolatedTestData
    : `${app.getPath('appData')}/DeskPet Electron`,
);
if (process.platform === 'win32') app.setAppUserModelId('com.deskpet.companion.electron');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (started || !hasSingleInstanceLock) {
  app.quit();
} else {
  const windows = new WindowManager();
  let controller: AppController | null = null;

  app.on('second-instance', () => windows.showConsole());
  app.on('activate', () => {
    windows.createWindows();
    windows.showConsole();
  });
  app.on('before-quit', () => {
    controller?.dispose();
    windows.dispose();
  });

  void app.whenReady().then(async () => {
    try {
      await installLocalProtocol(`${app.getPath('userData')}/managed`);
      controller = new AppController(windows);
      await controller.initialize();
      windows.createWindows();
      await controller.attachWindows();
      windows.createTray(
        {
          showConsole: () => windows.showConsole(),
          toggleOverlay: () => {
            const overlay = windows.overlayWindow();
            if (overlay?.isVisible()) overlay.hide();
            else overlay?.showInactive();
          },
          quit: () => app.quit(),
        },
        { show: 'Open DeskPet', toggle: 'Show or hide companion', quit: 'Quit' },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'DeskPet could not start.';
      dialog.showErrorBox('DeskPet Electron could not start securely', message);
      app.quit();
    }
  });
}
