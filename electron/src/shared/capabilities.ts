import type { PlatformCapability } from './contracts';

export interface CapabilityEnvironment {
  platform: NodeJS.Platform;
  sessionType: string | null;
  secretStorageAvailable: boolean;
  globalShortcutsPortalEnabled: boolean;
}

const capability = (
  id: PlatformCapability['id'],
  state: PlatformCapability['state'],
  reasonCode: string,
  requiredPermission: string | null = null,
  canRequestPermission = false,
): PlatformCapability => ({ id, state, reasonCode, requiredPermission, canRequestPermission });

export const resolvePlatformCapabilities = (environment: CapabilityEnvironment): PlatformCapability[] => {
  const isLinux = environment.platform === 'linux';
  const isWayland = isLinux && environment.sessionType?.toLowerCase() === 'wayland';

  return [
    capability(
      'overlay-position',
      isWayland ? 'degraded' : 'available',
      isWayland ? 'capability.reason.waylandPosition' : 'capability.reason.ready',
    ),
    capability(
      'always-on-top',
      isWayland ? 'degraded' : 'available',
      isWayland ? 'capability.reason.waylandAlwaysOnTop' : 'capability.reason.ready',
    ),
    capability(
      'precise-click-through',
      isLinux ? 'degraded' : 'available',
      isWayland
        ? 'capability.reason.waylandClickThrough'
        : isLinux
          ? 'capability.reason.linuxClickThrough'
          : 'capability.reason.ready',
    ),
    capability(
      'global-shortcut',
      isWayland && !environment.globalShortcutsPortalEnabled ? 'degraded' : 'available',
      isWayland && !environment.globalShortcutsPortalEnabled
        ? 'capability.reason.portalRequired'
        : 'capability.reason.ready',
      isWayland ? 'GlobalShortcuts portal' : null,
      isWayland,
    ),
    capability('tray', isLinux ? 'degraded' : 'available', isLinux ? 'capability.reason.linuxDesktopDependent' : 'capability.reason.ready'),
    capability(
      'notifications',
      isLinux ? 'degraded' : 'available',
      isLinux ? 'capability.reason.linuxDesktopDependent' : 'capability.reason.permissionMayBeRequired',
      'notifications',
      true,
    ),
    capability('auto-launch', isLinux ? 'degraded' : 'available', isLinux ? 'capability.reason.linuxDesktopDependent' : 'capability.reason.ready'),
    capability(
      'secret-storage',
      environment.secretStorageAvailable ? 'available' : 'unavailable',
      environment.secretStorageAvailable ? 'capability.reason.ready' : 'capability.reason.keyringRequired',
    ),
    capability(
      'native-migration',
      environment.platform === 'darwin' ? 'available' : 'unavailable',
      environment.platform === 'darwin' ? 'capability.reason.ready' : 'capability.reason.macosOnly',
    ),
  ];
};

export const defaultHotkeyForPlatform = (platform: NodeJS.Platform): string =>
  platform === 'darwin' ? 'Alt+Space' : 'Control+Alt+P';
