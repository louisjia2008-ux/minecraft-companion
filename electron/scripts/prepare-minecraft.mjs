/* global process */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'minecraft-runtime');
const target = join(root, '.minecraft-package', 'minecraft-runtime');
const runtimeRequire = createRequire(join(source, 'package.json'));
for (const name of ['mineflayer', 'mineflayer-pathfinder', 'vec3']) {
  try {
    runtimeRequire.resolve(name);
  } catch {
    throw new Error('Minecraft dependencies are missing. Run npm ci --prefix minecraft-runtime --ignore-scripts.');
  }
}
await stat(join(source, 'bridge.js'));
await rm(target, { recursive: true, force: true });
await mkdir(dirname(target), { recursive: true });
await cp(source, target, {
  recursive: true,
  dereference: true,
  filter: (path) => {
    const parts = relative(source, path).split(sep);
    if (parts.some((part) => ['.git', '.cache', '.DS_Store', '.bin', 'archive', 'test', 'tests', 'test-support', '__tests__'].includes(part))) return false;
    const name = parts.at(-1) ?? '';
    return !/\.(?:test|spec)\.[cm]?js$/u.test(name)
      && !/\.(?:zip|moc3|model3\.json)$/iu.test(name)
      && !/^live2dcubismcore/iu.test(name);
  },
});
process.stdout.write('Minecraft runtime prepared with production dependencies outside ASAR.\n');
