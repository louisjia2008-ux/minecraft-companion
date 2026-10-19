import { realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';

const APP_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.map', '.png', '.svg', '.woff', '.woff2']);
const MODEL_EXTENSIONS = new Set(['.json', '.moc3', '.png', '.jpg', '.jpeg', '.webp', '.wav', '.mp3', '.ogg', '.m4a', '.bytes']);

export const registerDeskPetScheme = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'deskpet',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true },
    },
  ]);
};

const containedPath = async (root: string, pathname: string): Promise<string> => {
  const decoded = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (decoded.includes('\0') || decoded.includes('\\')) throw new Error('Invalid local protocol path.');
  const candidate = await realpath(join(root, decoded));
  const path = relative(root, candidate);
  if (path.startsWith('..') || isAbsolute(path)) throw new Error('Local protocol path escaped its root.');
  return candidate;
};

export const installLocalProtocol = async (managedRoot: string): Promise<void> => {
  const rendererRoot = await realpath(join(__dirname, '..', 'renderer'));
  protocol.handle('deskpet', async (request) => {
    const url = new URL(request.url);
    if (url.hostname === 'app') {
      const path = await containedPath(rendererRoot, url.pathname);
      if (!APP_EXTENSIONS.has(extname(path).toLowerCase())) return new Response(null, { status: 403 });
      return net.fetch(pathToFileURL(path).toString());
    }
    if (url.hostname === 'managed') {
      const path = await containedPath(managedRoot, url.pathname);
      const relativePath = relative(managedRoot, path).replaceAll('\\', '/');
      const isCore = relativePath === 'core/live2dcubismcore.min.js';
      const isModel = relativePath.startsWith('models/') && MODEL_EXTENSIONS.has(extname(path).toLowerCase());
      if (!isCore && !isModel) return new Response(null, { status: 403 });
      return net.fetch(pathToFileURL(path).toString());
    }
    return new Response(null, { status: 404 });
  });
};
