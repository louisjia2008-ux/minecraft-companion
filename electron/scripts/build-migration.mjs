/* global process */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform === 'darwin') {
  const scratchPath = join(tmpdir(), 'deskpet-electron-migration-build');
  const result = spawnSync('swift', [
    'build', '--disable-sandbox', '--package-path', 'migration', '--scratch-path', scratchPath, '-c', 'release',
  ], {
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: join(scratchPath, 'clang-cache'),
      SWIFTPM_MODULECACHE_OVERRIDE: join(scratchPath, 'swift-cache'),
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const outputDirectory = resolve('migration/bin');
  const outputPath = join(outputDirectory, 'DeskPetMigrationHelper');
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  copyFileSync(join(scratchPath, 'release', 'DeskPetMigrationHelper'), outputPath);
  chmodSync(outputPath, 0o700);
}
