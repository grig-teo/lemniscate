import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import {
  assertPublicHttpUrl,
  isPrivateIp,
  resolvesToPrivateIp,
} from '../src/lib/url-safety.js';

// Locking tests for the SSRF guard. DNS is mocked so the suite never touches
// the network; 'localhost' cases rely on the mock returning loopback.

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

const lookupMock = vi.mocked(lookup);

function stubDns(records: Array<{ address: string; family: number }>) {
  lookupMock.mockResolvedValue(records as never);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('isPrivateIp', () => {
  it.each([
    '127.0.0.1',
    '127.53.1.9',
    '10.0.0.5',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '0.0.0.0',
    '224.0.0.1',
    '240.0.0.1',
    '198.18.0.1',
  ])('flags IPv4 %s as private/reserved', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '140.82.121.4',
  ])('flags IPv4 %s as public', (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });

  it.each(['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3'])(
    'flags IPv6 %s as private/reserved',
    (ip) => {
      expect(isPrivateIp(ip)).toBe(true);
    },
  );

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'])(
    'flags IPv6 %s as public',
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );

  it('returns false for non-IP input', () => {
    expect(isPrivateIp('example.com')).toBe(false);
    expect(isPrivateIp('')).toBe(false);
  });
});

describe('resolvesToPrivateIp', () => {
  it('is true when any resolved address is private', async () => {
    stubDns([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ]);
    expect(await resolvesToPrivateIp('evil.example.com')).toBe(true);
  });

  it('is false when every resolved address is public', async () => {
    stubDns([{ address: '93.184.216.34', family: 4 }]);
    expect(await resolvesToPrivateIp('example.com')).toBe(false);
  });

  it('checks IP literals without DNS', async () => {
    expect(await resolvesToPrivateIp('127.0.0.1')).toBe(true);
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe('assertPublicHttpUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow(/scheme/i);
    await expect(assertPublicHttpUrl('ftp://example.com/x')).rejects.toThrow(/scheme/i);
  });

  it('rejects invalid URLs', async () => {
    await expect(assertPublicHttpUrl('not a url')).rejects.toThrow();
  });

  it('rejects loopback and link-local literals', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1:11434/api')).rejects.toThrow(/private/i);
    await expect(assertPublicHttpUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /private/i,
    );
  });

  it('rejects hostnames resolving to private addresses', async () => {
    stubDns([{ address: '192.168.0.10', family: 4 }]);
    await expect(assertPublicHttpUrl('https://internal.corp/api')).rejects.toThrow(/private/i);
  });

  it('accepts a public https URL and returns it parsed', async () => {
    stubDns([{ address: '140.82.121.4', family: 4 }]);
    const url = await assertPublicHttpUrl('https://api.github.com/repos');
    expect(url.hostname).toBe('api.github.com');
  });

  it('bypasses checks when allowPrivate is set (local dev escape hatch)', async () => {
    const url = await assertPublicHttpUrl('http://127.0.0.1:11434/api', { allowPrivate: true });
    expect(url.hostname).toBe('127.0.0.1');
  });

  it('bypasses checks when ALLOW_PRIVATE_URLS=true', async () => {
    vi.stubEnv('ALLOW_PRIVATE_URLS', 'true');
    const url = await assertPublicHttpUrl('http://10.0.0.5:8080/');
    expect(url.hostname).toBe('10.0.0.5');
  });
});
