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

export type ClientPlatform = 'macos' | 'windows' | 'linux' | 'unknown';

/**
 * Best-effort client OS detection from navigator.userAgent / navigator.platform.
 * Android and ChromeOS map to 'unknown': we ship no installer for them, so the
 * dialog falls back to the CLI instructions.
 */
export function detectClientPlatform(userAgent: string, platform: string): ClientPlatform {
  if (/android/i.test(userAgent)) return 'unknown';
  if (/cros/i.test(userAgent)) return 'unknown';
  if (/mac os x|macintosh|macintel|macppc/i.test(userAgent) || platform.startsWith('Mac')) {
    return 'macos';
  }
  if (/windows|win32|win64/i.test(userAgent) || platform.startsWith('Win')) return 'windows';
  if (/linux/i.test(userAgent) || /linux/i.test(platform)) return 'linux';
  return 'unknown';
}

export type ClientArch = 'arm64' | 'amd64' | 'unknown';

/**
 * Best-effort client CPU-architecture detection. `uaDataArch` is the
 * `architecture` value from Chromium's `userAgentData.getHighEntropyValues`
 * ('arm' / 'x86') and wins when provided.
 *
 * Caveat: Apple-Silicon browsers still report "Intel Mac OS X" in the UA, so
 * UA-only detection cannot tell them apart — Chromium callers should pass
 * `uaDataArch`. Safari-on-ARM falls back to amd64 here, which is acceptable:
 * the user can pick the other button and Rosetta runs the amd64 build anyway.
 */
export function detectClientArch(userAgent: string, uaDataArch?: string): ClientArch {
  if (uaDataArch === 'arm') return 'arm64';
  if (uaDataArch === 'x86') return 'amd64';
  if (/arm64|aarch64/i.test(userAgent)) return 'arm64';
  if (/x86_64|amd64|win64|wow64/i.test(userAgent) || /intel mac os x/i.test(userAgent)) {
    return 'amd64';
  }
  return 'unknown';
}

export interface AgentDownload {
  platform: Exclude<ClientPlatform, 'unknown'>;
  arch: Exclude<ClientArch, 'unknown'>;
  label: string;
  fileName: string;
}

const AGENT_RELEASE_BASE =
  'https://github.com/grig-teo/lemniscate/releases/download/agent-latest';

/** Desktop-agent installers published by the agent-latest GitHub release. */
export const AGENT_DOWNLOADS: AgentDownload[] = [
  {
    platform: 'macos',
    arch: 'arm64',
    label: 'macOS Apple Silicon (.dmg)',
    fileName: 'lemniscate-agent-macos-arm64.dmg',
  },
  {
    platform: 'macos',
    arch: 'amd64',
    label: 'macOS Intel (.dmg)',
    fileName: 'lemniscate-agent-macos-amd64.dmg',
  },
  {
    platform: 'windows',
    arch: 'amd64',
    label: 'Windows x64 (.msi)',
    fileName: 'lemniscate-agent-windows-amd64.msi',
  },
  {
    platform: 'windows',
    arch: 'arm64',
    label: 'Windows ARM64 (.msi)',
    fileName: 'lemniscate-agent-windows-arm64.msi',
  },
  {
    platform: 'linux',
    arch: 'amd64',
    label: 'Linux x64 (.AppImage)',
    fileName: 'lemniscate-agent-linux-amd64.AppImage',
  },
  {
    platform: 'linux',
    arch: 'arm64',
    label: 'Linux ARM64 (.AppImage)',
    fileName: 'lemniscate-agent-linux-arm64.AppImage',
  },
];

/** Debian packages per arch, offered next to the AppImage for Linux users. */
export const AGENT_DOWNLOAD_LINUX_DEBS: AgentDownload[] = [
  {
    platform: 'linux',
    arch: 'amd64',
    label: 'Linux x64 (.deb)',
    fileName: 'lemniscate-agent-linux-amd64.deb',
  },
  {
    platform: 'linux',
    arch: 'arm64',
    label: 'Linux ARM64 (.deb)',
    fileName: 'lemniscate-agent-linux-arm64.deb',
  },
];

/** Zip of the Node CLI agent folder (agent/), for Termux/servers. */
export const AGENT_CLI_ZIP_FILE = 'lemniscate-agent-cli.zip';

/** Stable public download URL for a release asset (no auth needed). */
export function agentDownloadUrl(fileName: string): string {
  return `${AGENT_RELEASE_BASE}/${fileName}`;
}
