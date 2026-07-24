import { describe, expect, it } from 'vitest';
import { foldersWorkdirName } from '../src/routes/repositories.js';

// Locking tests for the GET /repositories/:id/folders workdir naming: the
// clone directory must be unique per request so concurrent requests for the
// same repository never share (and race on) one workdir.

describe('foldersWorkdirName', () => {
  it('embeds the repository id and the per-request id', () => {
    expect(foldersWorkdirName('repo-1', 'req-abc')).toBe('folders-repo-1-req-abc');
  });

  it('produces distinct names for distinct request ids', () => {
    expect(foldersWorkdirName('repo-1', 'req-a')).not.toBe(foldersWorkdirName('repo-1', 'req-b'));
  });
});
