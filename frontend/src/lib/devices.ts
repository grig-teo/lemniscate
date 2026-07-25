/**
 * Pure helpers for the device-tunnel UI (DeviceBar / PairingDialog /
 * DeviceDetailsModal). Tested in devices.test.ts — keep them dependency-free.
 */
import type { Device, Repository } from '@/lib/hooks';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Human label for a device's last check-in ('online', 'just now', '5 min ago', …). */
export function formatLastSeen(iso: string | null, now: Date): string {
  if (!iso) return 'never';
  const diff = Math.max(0, now.getTime() - new Date(iso).getTime());
  if (diff < MINUTE_MS) return 'online';
  if (diff < 2 * MINUTE_MS) return 'just now';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} min ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} h ago`;
  return `${Math.floor(diff / DAY_MS)} d ago`;
}

const PLATFORM_LABELS: Record<string, string> = {
  desktop: 'Desktop',
  android: 'Android',
  ios: 'iOS',
  web: 'Web',
};

/** Display label for a device platform, capitalizing unknown ones. */
export function devicePlatformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform.charAt(0).toUpperCase() + platform.slice(1);
}

/** run_web commands need a desktop agent with docker. */
export function canRunWeb(device: Pick<Device, 'platform' | 'meta'>): boolean {
  return device.platform === 'desktop' && device.meta?.dockerAvailable === true;
}

/** install_apk works on android (install intent) and desktop (download only). */
export function canInstallApk(device: Pick<Device, 'platform'>): boolean {
  return device.platform === 'android' || device.platform === 'desktop';
}

/** Repositories an android APK can be built from (detected platform 'android'). */
export function androidRepos<T extends Pick<Repository, 'platform'>>(repos: T[]): T[] {
  return repos.filter((repo) => repo.platform === 'android');
}

/** Repositories runnable as desktop apps (detected platform 'desktop'). */
export function desktopRepos<T extends Pick<Repository, 'platform'>>(repos: T[]): T[] {
  return repos.filter((repo) => repo.platform === 'desktop');
}

/** Devices that can build APKs: online desktop agents with docker. */
export function builderDevices(devices: Device[]): Device[] {
  return devices.filter((device) => device.online && canRunWeb(device));
}

const COMMAND_TYPE_LABELS: Record<string, string> = {
  run_web: 'Run web app',
  install_apk: 'Install APK',
  build_android: 'Build Android APK',
  run_desktop: 'Run desktop app',
};

/** Display label for a device command type; unknown types pass through. */
export function commandTypeLabel(type: string): string {
  return COMMAND_TYPE_LABELS[type] ?? type;
}

/** Badge label for a repository's detected platform; null = show no badge. */
export function repoPlatformLabel(platform: string | null | undefined): string | null {
  if (!platform || platform === 'unknown') return null;
  return devicePlatformLabel(platform);
}

/** Why the run-on-device form is disabled, or null when it is usable. */
export function runWebBlocker(device: Pick<Device, 'platform' | 'meta'>): string | null {
  if (device.platform !== 'desktop') return 'Only desktop devices can run web apps';
  if (device.meta?.dockerAvailable !== true) return 'Docker not available on this device';
  return null;
}

/** Default host port offered by the run-on-device form. */
export function defaultRunPort(): number {
  return 3000;
}

/** Seconds until a pairing code expires, clamped at zero. */
export function pairingExpirySeconds(expiresAt: string, now: Date): number {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 1000));
}

/** Shell command the user runs on the device to pair the agent CLI. */
export function agentPairCommand(origin: string, code: string): string {
  return `cd agent && npm install && node index.js --server ${origin} --pair ${code}`;
}
