import { describe, expect, it } from 'vitest';

import {
  AGENT_DOWNLOADS,
  agentDownloadUrl,
  agentPairCommand,
  androidRepos,
  builderDevices,
  canInstallApk,
  canRunWeb,
  commandTypeLabel,
  defaultRunPort,
  desktopRepos,
  detectClientPlatform,
  devicePlatformLabel,
  formatLastSeen,
  pairingExpirySeconds,
  repoPlatformLabel,
  runWebBlocker,
} from '@/lib/devices';
import type { Device } from '@/lib/hooks';

function makeDevice(patch: Partial<Device>): Device {
  return {
    id: 'dev-1',
    name: 'My machine',
    platform: 'desktop',
    meta: null,
    online: true,
    lastSeenAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

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

describe('canRunWeb / runWebBlocker', () => {
  it('allows a desktop device with docker', () => {
    const device = makeDevice({ meta: { dockerAvailable: true } });
    expect(canRunWeb(device)).toBe(true);
    expect(runWebBlocker(device)).toBeNull();
  });

  it('blocks non-desktop platforms', () => {
    const device = makeDevice({ platform: 'android', meta: { dockerAvailable: true } });
    expect(canRunWeb(device)).toBe(false);
    expect(runWebBlocker(device)).toBe('Only desktop devices can run web apps');
  });

  it('blocks a desktop device without docker', () => {
    const device = makeDevice({ meta: { dockerAvailable: false } });
    expect(canRunWeb(device)).toBe(false);
    expect(runWebBlocker(device)).toBe('Docker not available on this device');
  });

  it('blocks when meta is missing entirely', () => {
    expect(canRunWeb(makeDevice({ meta: null }))).toBe(false);
  });
});

describe('defaultRunPort', () => {
  it('is 3000', () => {
    expect(defaultRunPort()).toBe(3000);
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

describe('canInstallApk', () => {
  it('allows android and desktop devices', () => {
    expect(canInstallApk(makeDevice({ platform: 'android' }))).toBe(true);
    expect(canInstallApk(makeDevice({ platform: 'desktop' }))).toBe(true);
  });

  it('blocks ios and web devices', () => {
    expect(canInstallApk(makeDevice({ platform: 'ios' }))).toBe(false);
    expect(canInstallApk(makeDevice({ platform: 'web' }))).toBe(false);
  });
});

describe('commandTypeLabel', () => {
  it('labels known command types and passes through unknown ones', () => {
    expect(commandTypeLabel('run_web')).toBe('Run web app');
    expect(commandTypeLabel('install_apk')).toBe('Install APK');
    expect(commandTypeLabel('future_type')).toBe('future_type');
  });
});

describe('repoPlatformLabel', () => {
  it('labels detected platforms', () => {
    expect(repoPlatformLabel('android')).toBe('Android');
    expect(repoPlatformLabel('ios')).toBe('iOS');
    expect(repoPlatformLabel('web')).toBe('Web');
    expect(repoPlatformLabel('desktop')).toBe('Desktop');
  });

  it('returns null when no badge should be shown', () => {
    expect(repoPlatformLabel('unknown')).toBeNull();
    expect(repoPlatformLabel(null)).toBeNull();
    expect(repoPlatformLabel(undefined)).toBeNull();
  });
});

describe('androidRepos', () => {
  it('keeps only android-platform repositories', () => {
    const repos = [
      { platform: 'android' },
      { platform: 'ios' },
      { platform: 'web' },
      { platform: null },
      { platform: 'unknown' },
    ];
    expect(androidRepos(repos)).toEqual([{ platform: 'android' }]);
  });
});

describe('builderDevices', () => {
  it('keeps only online desktop devices with docker', () => {
    const devices = [
      makeDevice({ id: 'ok', platform: 'desktop', meta: { dockerAvailable: true }, online: true }),
      makeDevice({ id: 'offline', platform: 'desktop', meta: { dockerAvailable: true }, online: false }),
      makeDevice({ id: 'no-docker', platform: 'desktop', meta: { dockerAvailable: false } }),
      makeDevice({ id: 'phone', platform: 'android', online: true }),
    ];
    expect(builderDevices(devices).map((d) => d.id)).toEqual(['ok']);
  });
});

describe('commandTypeLabel build_android', () => {
  it('labels build_android', () => {
    expect(commandTypeLabel('build_android')).toBe('Build Android APK');
  });
});

describe('desktopRepos', () => {
  it('keeps only desktop-platform repositories', () => {
    const repos = [
      { platform: 'desktop' },
      { platform: 'android' },
      { platform: 'web' },
      { platform: null },
      { platform: 'unknown' },
    ];
    expect(desktopRepos(repos)).toEqual([{ platform: 'desktop' }]);
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

describe('AGENT_DOWNLOADS / agentDownloadUrl', () => {
  it('offers macos, windows and linux downloads in order', () => {
    expect(AGENT_DOWNLOADS.map((d) => d.platform)).toEqual(['macos', 'windows', 'linux']);
  });

  it('gives each download a label and a stable file name', () => {
    for (const download of AGENT_DOWNLOADS) {
      expect(download.label.length).toBeGreaterThan(0);
      expect(download.fileName).toMatch(/^lemniscate-agent-/);
    }
  });

  it('builds a stable agent-latest release URL', () => {
    expect(agentDownloadUrl('lemniscate-agent-macos.dmg')).toBe(
      'https://github.com/grig-teo/lemniscate/releases/download/agent-latest/lemniscate-agent-macos.dmg',
    );
  });
});
