import { describe, expect, it } from 'vitest';

import {
  AGENT_CLI_ZIP_FILE,
  AGENT_DOWNLOADS,
  AGENT_DOWNLOAD_LINUX_DEBS,
  agentDownloadUrl,
  agentPairCommand,
  commandTypeLabel,
  detectClientArch,
  detectClientPlatform,
  devicePlatformLabel,
  formatLastSeen,
  pairingExpirySeconds,
  transportLabel,
} from '@/lib/devices';
describe('formatLastSeen', () => {
  const now = new Date('2026-07-25T12:00:00.000Z');
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

  it('reports never when the device was never seen', () => {
    expect(formatLastSeen(null, now)).toBe('never');
  });

  it('reports online when seen within the last minute', () => {
    expect(formatLastSeen(iso(5_000), now)).toBe('online');
    expect(formatLastSeen(iso(59_000), now)).toBe('online');
  });

  it('reports just now up to two minutes ago', () => {
    expect(formatLastSeen(iso(61_000), now)).toBe('just now');
    expect(formatLastSeen(iso(119_000), now)).toBe('just now');
  });

  it('reports minutes ago under an hour', () => {
    expect(formatLastSeen(iso(5 * 60_000), now)).toBe('5 min ago');
    expect(formatLastSeen(iso(59 * 60_000), now)).toBe('59 min ago');
  });

  it('reports hours ago under a day', () => {
    expect(formatLastSeen(iso(2 * 3_600_000), now)).toBe('2 h ago');
  });

  it('reports days ago beyond that', () => {
    expect(formatLastSeen(iso(3 * 86_400_000), now)).toBe('3 d ago');
  });
});

describe('devicePlatformLabel', () => {
  it('labels the known platforms', () => {
    expect(devicePlatformLabel('desktop')).toBe('Desktop');
    expect(devicePlatformLabel('android')).toBe('Android');
    expect(devicePlatformLabel('ios')).toBe('iOS');
    expect(devicePlatformLabel('web')).toBe('Web');
  });

  it('capitalizes unknown platforms', () => {
    expect(devicePlatformLabel('tv')).toBe('Tv');
  });
});

describe('transportLabel', () => {
  it('labels the adb transports', () => {
    expect(transportLabel('usb')).toBe('USB');
    expect(transportLabel('wifi')).toBe('Wi-Fi');
  });

  it('passes unknown transports through', () => {
    expect(transportLabel('carrier-pigeon')).toBe('carrier-pigeon');
  });
});

describe('pairingExpirySeconds', () => {
  it('returns whole seconds remaining, clamped at zero', () => {
    const now = new Date('2026-07-25T12:00:00.000Z');
    expect(pairingExpirySeconds('2026-07-25T12:05:30.000Z', now)).toBe(330);
    expect(pairingExpirySeconds('2026-07-25T11:59:00.000Z', now)).toBe(0);
  });
});

describe('agentPairCommand', () => {
  it('embeds the site origin and the pairing code', () => {
    expect(agentPairCommand('https://lemniscate.grig-teo.space', 'ABC123')).toBe(
      'cd agent && npm install && node index.js --server https://lemniscate.grig-teo.space --pair ABC123',
    );
  });
});

describe('commandTypeLabel', () => {
  it('labels known command types and passes through unknown ones', () => {
    expect(commandTypeLabel('run_web')).toBe('Run web app');
    expect(commandTypeLabel('install_apk')).toBe('Install APK');
    expect(commandTypeLabel('future_type')).toBe('future_type');
  });
});

describe('commandTypeLabel build_android', () => {
  it('labels build_android', () => {
    expect(commandTypeLabel('build_android')).toBe('Build Android APK');
  });
});

describe('commandTypeLabel run_desktop', () => {
  it('labels run_desktop', () => {
    expect(commandTypeLabel('run_desktop')).toBe('Run desktop app');
  });
});

describe('detectClientPlatform', () => {
  it('detects macOS from the user agent', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
    expect(detectClientPlatform(ua, 'MacIntel')).toBe('macos');
  });

  it('detects macOS from the platform alone', () => {
    expect(detectClientPlatform('', 'MacIntel')).toBe('macos');
    expect(detectClientPlatform('', 'MacPPC')).toBe('macos');
  });

  it('detects Windows from the user agent or platform', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    expect(detectClientPlatform(ua, 'Win32')).toBe('windows');
    expect(detectClientPlatform('', 'Win64')).toBe('windows');
  });

  it('detects Linux from the user agent', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36';
    expect(detectClientPlatform(ua, 'Linux x86_64')).toBe('linux');
  });

  it('treats Android as unknown (no android installer)', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36';
    expect(detectClientPlatform(ua, 'Linux armv81')).toBe('unknown');
  });

  it('treats ChromeOS as unknown (no chromeOS installer)', () => {
    const ua = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36';
    expect(detectClientPlatform(ua, 'Linux x86_64')).toBe('unknown');
  });

  it('returns unknown for empty input', () => {
    expect(detectClientPlatform('', '')).toBe('unknown');
  });
});

describe('detectClientArch', () => {
  const INTEL_MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

  it('trusts the Chromium high-entropy architecture over the UA', () => {
    // Apple-Silicon browsers report "Intel" in the UA; uaDataArch wins.
    expect(detectClientArch(INTEL_MAC_UA, 'arm')).toBe('arm64');
  });

  it('maps Chromium x86 high-entropy architecture to amd64', () => {
    expect(detectClientArch(INTEL_MAC_UA, 'x86')).toBe('amd64');
  });

  it('detects arm64 from an aarch64 Linux UA', () => {
    const ua = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36';
    expect(detectClientArch(ua)).toBe('arm64');
  });

  it('detects amd64 from an Intel macOS UA', () => {
    expect(detectClientArch(INTEL_MAC_UA)).toBe('amd64');
  });

  it('detects amd64 from a Windows Win64 UA', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    expect(detectClientArch(ua)).toBe('amd64');
  });

  it('returns unknown for empty input', () => {
    expect(detectClientArch('', '')).toBe('unknown');
  });
});

describe('AGENT_DOWNLOADS / agentDownloadUrl', () => {
  it('offers per-arch downloads for macos, windows and linux', () => {
    expect(
      AGENT_DOWNLOADS.map((d) => `${d.platform}-${d.arch}`),
    ).toEqual([
      'macos-arm64',
      'macos-amd64',
      'windows-amd64',
      'windows-arm64',
      'linux-amd64',
      'linux-arm64',
    ]);
  });

  it('matches the installer names published by the agent-latest release', () => {
    expect(AGENT_DOWNLOADS.map((d) => d.fileName)).toEqual([
      'lemniscate-agent-macos-arm64.dmg',
      'lemniscate-agent-macos-amd64.dmg',
      'lemniscate-agent-windows-amd64.msi',
      'lemniscate-agent-windows-arm64.msi',
      'lemniscate-agent-linux-amd64.AppImage',
      'lemniscate-agent-linux-arm64.AppImage',
    ]);
  });

  it('gives each download a label and a stable file name', () => {
    for (const download of AGENT_DOWNLOADS) {
      expect(download.label.length).toBeGreaterThan(0);
      expect(download.fileName).toMatch(/^lemniscate-agent-/);
    }
  });

  it('offers per-arch .deb packages for linux', () => {
    expect(AGENT_DOWNLOAD_LINUX_DEBS.map((d) => `${d.platform}-${d.arch}`)).toEqual([
      'linux-amd64',
      'linux-arm64',
    ]);
    expect(AGENT_DOWNLOAD_LINUX_DEBS.map((d) => d.fileName)).toEqual([
      'lemniscate-agent-linux-amd64.deb',
      'lemniscate-agent-linux-arm64.deb',
    ]);
  });

  it('builds a stable agent-latest release URL', () => {
    expect(agentDownloadUrl('lemniscate-agent-macos-arm64.dmg')).toBe(
      'https://github.com/grig-teo/lemniscate/releases/download/agent-latest/lemniscate-agent-macos-arm64.dmg',
    );
  });

  it('points the CLI agent zip at the same release', () => {
    expect(agentDownloadUrl(AGENT_CLI_ZIP_FILE)).toBe(
      'https://github.com/grig-teo/lemniscate/releases/download/agent-latest/lemniscate-agent-cli.zip',
    );
  });
});
