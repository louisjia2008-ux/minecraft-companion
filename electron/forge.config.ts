import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'DeskPet Electron',
    executableName: 'deskpet-electron',
    appBundleId: 'com.deskpet.companion.electron',
    appCategoryType: 'public.app-category.productivity',
    asar: true,
    extraResource: [
      './.minecraft-package/minecraft-runtime',
      ...(process.platform === 'darwin' ? ['./migration/bin/DeskPetMigrationHelper'] : []),
    ],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: 'deskpet_electron',
      setupExe: 'DeskPet-Electron-Setup.exe',
    }),
    new MakerZIP({}, ['darwin']),
    new MakerDeb({
      options: {
        maintainer: 'DeskPet contributors',
        homepage: 'https://github.com/louisjia2008-ux/personal-ai-deskpet',
      },
    }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/renderer/console/index.html',
            js: './src/renderer/console/index.tsx',
            name: 'main_window',
            preload: {
              js: './src/preload/index.ts',
            },
          },
          {
            html: './src/renderer/overlay/index.html',
            js: './src/renderer/overlay/index.tsx',
            name: 'overlay_window',
            preload: {
              js: './src/preload/index.ts',
            },
          },
        ],
      },
    }),
  ],
};

export default config;
