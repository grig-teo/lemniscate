/**
 * Pure helpers for the device-tunnel UI (DeviceBar / PairingDialog /
 * DeviceDetailsModal). Tested in devices.test.ts — keep them dependency-free.
 */

const MINUTE_MS = 60_000;const HOUR_MS = 3_600_000;
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

const TRANSPORT_LABELS: Record<string, string> = {
  usb: 'USB',
  wifi: 'Wi-Fi',
};

/** Display label for an adb device transport; unknown ones pass through. */
export function transportLabel(transport: string): string {
  return TRANSPORT_LABELS[transport] ?? transport;
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

const ALL_AGENT_DOWNLOADS: AgentDownload[] = [
  // .deb first so it wins for linux (distro-native); AppImage stays in "show all".
  ...AGENT_DOWNLOAD_LINUX_DEBS,
  ...AGENT_DOWNLOADS,
];

/**
 * The single download matching the visitor's platform+arch — the pairing
 * dialog shows only this one. Exact arch match wins; unknown arch falls back
 * to the platform's first entry; unknown platform → null (hide the section).
 */
export function matchingAgentDownload(
  platform: ClientPlatform,
  arch: ClientArch,
): AgentDownload | null {
  if (platform === 'unknown') return null;
  const forPlatform = ALL_AGENT_DOWNLOADS.filter((d) => d.platform === platform);
  return forPlatform.find((d) => d.arch === arch) ?? forPlatform[0] ?? null;
}

/** Stable public download URL for a release asset (no auth needed). */
export function agentDownloadUrl(fileName: string): string {
  return `${AGENT_RELEASE_BASE}/${fileName}`;
}
