import { describe, expect, it } from 'vitest';

import { detectRunTargets } from '../src/lib/run-targets.js';

// Pure changed-paths → run-targets classifier. Paths are repo-relative
// (recorded by the worker via `git diff --name-only`). Output order is
// stable: android, ios, web, desktop.

describe('detectRunTargets', () => {
  it('detects an android-only change in a monorepo', () => {
    expect(
      detectRunTargets(['android/app/src/main/AndroidManifest.xml', 'android/build.gradle'], 'web'),
    ).toEqual(['android']);
  });

  it('detects android from gradle/manifest signals without an android/ folder', () => {
    expect(detectRunTargets(['app/src/main/AndroidManifest.xml'], null)).toEqual(['android']);
    expect(detectRunTargets(['settings.gradle.kts'], null)).toEqual(['android']);
  });

  it('maps frontend + backend changes to the web target', () => {
    expect(
      detectRunTargets(['frontend/src/App.tsx', 'backend/src/routes/tasks.ts'], 'android'),
    ).toEqual(['web']);
  });

  it('detects ios changes from folder, xcodeproj and Podfile', () => {
    expect(detectRunTargets(['ios/App/SceneDelegate.swift'], null)).toEqual(['ios']);
    expect(detectRunTargets(['Lemniscate.xcodeproj/project.pbxproj'], null)).toEqual(['ios']);
    expect(detectRunTargets(['Podfile.lock'], null)).toEqual(['ios']);
  });

  it('detects desktop changes from tauri and electron markers', () => {
    expect(detectRunTargets(['src-tauri/tauri.conf.json'], null)).toEqual(['desktop']);
    expect(detectRunTargets(['electron/main.js'], null)).toEqual(['desktop']);
  });

  it('falls back to the repository platform for root-level ambiguous changes', () => {
    expect(detectRunTargets(['README.md', 'package.json'], 'android')).toEqual(['android']);
    expect(detectRunTargets(['README.md'], 'web')).toEqual(['web']);
  });

  it('combines concrete targets with the platform fallback', () => {
    expect(detectRunTargets(['ios/App/App.swift', 'README.md'], 'ios')).toEqual(['ios']);
    expect(detectRunTargets(['android/app/build.gradle', 'docs/usage.md'], 'ios')).toEqual([
      'android',
      'ios',
    ]);
  });

  it('returns multiple targets in stable order', () => {
    expect(detectRunTargets(['frontend/src/App.tsx', 'ios/App/App.swift'], null)).toEqual([
      'ios',
      'web',
    ]);
  });

  it('falls back to repoPlatform alone when changedPaths is null', () => {
    expect(detectRunTargets(null, 'android')).toEqual(['android']);
    expect(detectRunTargets(null, 'desktop')).toEqual(['desktop']);
  });

  it('returns [] for null changedPaths with unknown or missing platform', () => {
    expect(detectRunTargets(null, 'unknown')).toEqual([]);
    expect(detectRunTargets(null, null)).toEqual([]);
  });

  it('returns [] for an empty change list', () => {
    expect(detectRunTargets([], 'android')).toEqual([]);
  });

  it('returns [] when nothing classifies and the platform is unknown', () => {
    expect(detectRunTargets(['README.md'], 'unknown')).toEqual([]);
    expect(detectRunTargets(['README.md'], null)).toEqual([]);
  });
});
