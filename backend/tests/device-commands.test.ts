import { describe, expect, it } from 'vitest';

// Pure helpers for the build_android pipeline: server-side payload
// enrichment (defaults + upload base URL injected at dispatch time) and the
// build→install chaining decision.

import {
  BUILD_ANDROID_DEFAULTS,
  buildAndroidAgentPayload,
  nextCommandAfterBuild,
} from '../src/lib/device-commands.js';

describe('buildAndroidAgentPayload', () => {
  it('fills gradle defaults and injects the upload base URL', () => {
    expect(
      buildAndroidAgentPayload({ repoUrl: 'https://github.com/a/b', branch: 'main' }, 'https://api.x'),
    ).toEqual({
      repoUrl: 'https://github.com/a/b',
      branch: 'main',
      gradleTask: 'assembleDebug',
      gradleModule: 'app',
      image: BUILD_ANDROID_DEFAULTS.image,
      uploadBaseUrl: 'https://api.x',
    });
  });

  it('lets payload overrides win but never uploadBaseUrl', () => {
    expect(
      buildAndroidAgentPayload(
        { gradleTask: 'assembleRelease', uploadBaseUrl: 'https://evil' },
        'https://api.x',
      ),
    ).toEqual(
      expect.objectContaining({ gradleTask: 'assembleRelease', uploadBaseUrl: 'https://api.x' }),
    );
  });
});

describe('nextCommandAfterBuild', () => {
  const command = {
    type: 'build_android',
    payload: { repoUrl: 'https://github.com/a/b', installDeviceId: 'dev-android', appName: 'B' },
  };

  it('chains to install_apk when a build done-result carries an artifactKey', () => {
    expect(nextCommandAfterBuild(command, { artifactKey: 'dev-1/abc-app.apk' })).toEqual({
      installDeviceId: 'dev-android',
      artifactKey: 'dev-1/abc-app.apk',
      appName: 'B',
    });
  });

  it('does not chain for other command types', () => {
    expect(
      nextCommandAfterBuild({ type: 'run_web', payload: command.payload }, { artifactKey: 'k' }),
    ).toBeNull();
  });

  it('does not chain without an artifactKey or installDeviceId', () => {
    expect(nextCommandAfterBuild(command, { error: 'gradle failed' })).toBeNull();
    expect(nextCommandAfterBuild(command, null)).toBeNull();
    expect(
      nextCommandAfterBuild({ type: 'build_android', payload: {} }, { artifactKey: 'k' }),
    ).toBeNull();
  });
});
