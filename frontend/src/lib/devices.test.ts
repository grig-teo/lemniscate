import { describe, expect, it } from 'vitest';

import {
  agentPairCommand,
  canRunWeb,
  defaultRunPort,
  devicePlatformLabel,
  formatLastSeen,
  pairingExpirySeconds,
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
