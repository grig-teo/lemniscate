import { describe, expect, it } from 'vitest';

import {
  AGENT_CLI_ZIP_FILE,
  AGENT_DOWNLOADS,
  AGENT_DOWNLOAD_LINUX_DEBS,
  agentDownloadUrl,
  detectClientArch,
  detectClientPlatform,
  matchingAgentDownload,
} from '@/lib/devices';

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

describe('matchingAgentDownload', () => {
  it('returns the exact platform+arch match', () => {
    expect(matchingAgentDownload('macos', 'arm64')?.fileName).toBe('lemniscate-agent-macos-arm64.dmg');
    expect(matchingAgentDownload('windows', 'amd64')?.fileName).toBe('lemniscate-agent-windows-amd64.msi');
    expect(matchingAgentDownload('linux', 'arm64')?.fileName).toBe('lemniscate-agent-linux-arm64.deb');
  });

  it('prefers the .deb over the AppImage for linux', () => {
    expect(matchingAgentDownload('linux', 'amd64')?.fileName).toBe('lemniscate-agent-linux-amd64.deb');
  });

  it('falls back to the platform default when arch is unknown', () => {
    expect(matchingAgentDownload('macos', 'unknown')?.platform).toBe('macos');
    expect(matchingAgentDownload('windows', 'unknown')?.platform).toBe('windows');
  });

  it('returns null for unknown platforms', () => {
    expect(matchingAgentDownload('unknown', 'unknown')).toBeNull();
    expect(matchingAgentDownload('unknown', 'arm64')).toBeNull();
  });
});
