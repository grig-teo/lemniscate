import { describe, expect, it } from 'vitest';

import { detectRepoPlatform } from '../src/lib/repo-platform.js';

// Pure path-list → platform classifier. Paths are repo-relative (root-level
// entry names from the provider listing, optionally deeper paths when a
// caller has a fuller tree). Priority: android > ios > desktop > web.

describe('detectRepoPlatform', () => {
  it('detects android from gradle + app module layout', () => {
    expect(detectRepoPlatform(['settings.gradle', 'build.gradle', 'app', 'gradle.properties'])).toBe(
      'android',
    );
  });

  it('detects android from gradle + a shallow AndroidManifest', () => {
    expect(
      detectRepoPlatform(['settings.gradle.kts', 'mobile/src/main/AndroidManifest.xml']),
    ).toBe('android');
  });

  it('does not call a plain gradle project android', () => {
    expect(detectRepoPlatform(['settings.gradle', 'src/main/kotlin/Main.kt'])).toBe('unknown');
  });

  it('detects ios from an xcodeproj bundle', () => {
    expect(detectRepoPlatform(['Lemniscate.xcodeproj', 'Lemniscate/App.swift'])).toBe('ios');
  });

  it('detects ios from root Podfile / Package.swift / Info.plist', () => {
    expect(detectRepoPlatform(['Podfile', 'Sources'])).toBe('ios');
    expect(detectRepoPlatform(['Package.swift'])).toBe('ios');
    expect(detectRepoPlatform(['Info.plist'])).toBe('ios');
  });

  it('detects desktop from tauri and electron markers', () => {
    expect(detectRepoPlatform(['src-tauri', 'package.json'])).toBe('desktop');
    expect(detectRepoPlatform(['electron-builder.yml', 'package.json'])).toBe('desktop');
    expect(detectRepoPlatform(['electron/main.js', 'package.json'])).toBe('desktop');
  });

  it('detects desktop from .NET solution/project files', () => {
    expect(detectRepoPlatform(['App.sln', 'App/App.csproj'])).toBe('desktop');
  });

  it('detects web from root package.json / index.html / framework configs', () => {
    expect(detectRepoPlatform(['package.json', 'src/index.ts'])).toBe('web');
    expect(detectRepoPlatform(['index.html'])).toBe('web');
    expect(detectRepoPlatform(['vite.config.ts', 'src'])).toBe('web');
    expect(detectRepoPlatform(['next.config.js', 'pages'])).toBe('web');
  });

  it('prefers android over web in a monorepo', () => {
    expect(detectRepoPlatform(['settings.gradle', 'app', 'package.json', 'index.html'])).toBe(
      'android',
    );
  });

  it('prefers ios and desktop over web', () => {
    expect(detectRepoPlatform(['Podfile', 'package.json'])).toBe('ios');
    expect(detectRepoPlatform(['tauri.conf.json', 'package.json'])).toBe('desktop');
  });

  it('returns unknown for empty or unrecognized listings', () => {
    expect(detectRepoPlatform([])).toBe('unknown');
    expect(detectRepoPlatform(['README.md', 'LICENSE'])).toBe('unknown');
  });
});
