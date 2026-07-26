import { describe, expect, it } from 'vitest';

// Pure helpers for the device artifact store (MinIO 'device-artifacts'
// bucket): filename sanitizing and object-key building.

import {
  artifactDownloadPath,
  artifactKeyFor,
  artifactOwnerDeviceId,
  artifactQuotaAllowed,
  artifactQuotaKey,
  contentTypeForFilename,
  safeArtifactFilename,
} from '../src/lib/device-artifacts.js';

describe('safeArtifactFilename', () => {
  it('keeps a plain apk name as-is', () => {
    expect(safeArtifactFilename('app-debug.apk')).toBe('app-debug.apk');
  });

  it('strips path traversal and keeps only the basename', () => {
    expect(safeArtifactFilename('../../etc/passwd.apk')).toBe('passwd.apk');
    expect(safeArtifactFilename('C:\\builds\\app release.apk')).toBe('app-release.apk');
  });

  it('replaces unsafe characters with dashes', () => {
    expect(safeArtifactFilename('my app (v2) [debug].apk')).toBe('my-app-v2-debug-.apk');
  });

  it('falls back to artifact.bin when nothing safe remains', () => {
    expect(safeArtifactFilename('')).toBe('artifact.bin');
    expect(safeArtifactFilename('///')).toBe('artifact.bin');
  });
});

describe('artifactKeyFor', () => {
  it('scopes the key under the device id with a unique prefix', () => {
    expect(artifactKeyFor('dev-1', 'app.apk', 'abc123')).toBe('dev-1/abc123-app.apk');
  });

  it('sanitizes the filename part', () => {
    expect(artifactKeyFor('dev-1', '../my app.apk', 'abc123')).toBe('dev-1/abc123-my-app.apk');
  });
});

describe('artifactOwnerDeviceId', () => {
  it('returns the device id from the first key segment', () => {
    expect(artifactOwnerDeviceId('dev-1/abc123-app.apk')).toBe('dev-1');
  });

  it('round-trips keys built by artifactKeyFor', () => {
    expect(artifactOwnerDeviceId(artifactKeyFor('dev-1', 'my app.apk', 'abc123'))).toBe('dev-1');
  });

  it('returns null for keys without a device-id segment', () => {
    expect(artifactOwnerDeviceId('app.apk')).toBeNull();
    expect(artifactOwnerDeviceId('/abc123-app.apk')).toBeNull();
    expect(artifactOwnerDeviceId('')).toBeNull();
  });
});

describe('artifactDownloadPath', () => {
  it('builds the backend-relative download path', () => {
    expect(artifactDownloadPath('dev-1/abc-app.apk')).toBe('/api/devices/artifacts/dev-1/abc-app.apk');
  });
});

describe('artifactQuotaKey', () => {
  it('scopes the redis counter key by device id', () => {
    expect(artifactQuotaKey('dev-1')).toBe('artifact-quota:dev-1');
  });
});

describe('artifactQuotaAllowed', () => {
  it('allows counts up to and including the daily max', () => {
    expect(artifactQuotaAllowed(1, 20)).toBe(true);
    expect(artifactQuotaAllowed(20, 20)).toBe(true);
  });

  it('rejects the upload beyond the daily max', () => {
    expect(artifactQuotaAllowed(21, 20)).toBe(false);
  });
});

describe('contentTypeForFilename', () => {
  it('returns the APK mime for .apk files', () => {
    expect(contentTypeForFilename('app-debug.apk')).toBe('application/vnd.android.package-archive');
  });

  it('returns text/plain for .log files', () => {
    expect(contentTypeForFilename('cmd-123.log')).toBe('text/plain; charset=utf-8');
  });

  it('infers from the extension inside an artifact key', () => {
    expect(contentTypeForFilename('dev-1/uuid-cmd.log')).toBe('text/plain; charset=utf-8');
    expect(contentTypeForFilename('dev-1/uuid-app.apk')).toBe(
      'application/vnd.android.package-archive',
    );
  });

  it('falls back to octet-stream for unknown extensions', () => {
    expect(contentTypeForFilename('data.bin')).toBe('application/octet-stream');
    expect(contentTypeForFilename('archive.zip')).toBe('application/octet-stream');
  });
});
