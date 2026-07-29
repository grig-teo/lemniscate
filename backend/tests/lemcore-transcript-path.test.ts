import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TRANSCRIPT_FILE,
  transcriptPath,
} from '../src/lib/lemcore/loop-constants.js';
import {
  loadTranscript,
  scrubLegacyInCloneTranscript,
} from '../src/lib/lemcore/loop.js';

// Resume transcript must live beside the clone, never inside it — otherwise
// lemcore-transcript.json is committed into the user's PR.

describe('transcriptPath', () => {
  it('places the transcript as a sibling of the workdir, not inside it', () => {
    expect(transcriptPath('/tmp/repos/task-1')).toBe(
      `/tmp/repos/task-1.${TRANSCRIPT_FILE}`,
    );
    expect(transcriptPath('/tmp/repos/task-1/')).toBe(
      `/tmp/repos/task-1.${TRANSCRIPT_FILE}`,
    );
    expect(transcriptPath('/tmp/repos/task-1')).not.toContain(
      path.join('task-1', TRANSCRIPT_FILE),
    );
  });
});

describe('loadTranscript / scrubLegacyInCloneTranscript', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lemcore-tx-'));
  const workdir = path.join(root, 'task-abc');

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads the sibling transcript and ignores a legacy in-clone file for load', () => {
    fs.mkdirSync(workdir, { recursive: true });
    const messages = [{ role: 'user', content: 'hi' }];
    fs.writeFileSync(transcriptPath(workdir), JSON.stringify(messages));
    // Poison: old in-clone path should not be what loadTranscript returns once
    // scrubbed (and must not be preferred).
    fs.writeFileSync(
      path.join(workdir, TRANSCRIPT_FILE),
      JSON.stringify([{ role: 'user', content: 'legacy' }]),
    );

    expect(loadTranscript(workdir)).toEqual(messages);
  });

  it('deletes a leftover in-clone transcript so git never sees it', () => {
    fs.mkdirSync(workdir, { recursive: true });
    const legacy = path.join(workdir, TRANSCRIPT_FILE);
    fs.writeFileSync(legacy, '[]');
    scrubLegacyInCloneTranscript(workdir);
    expect(fs.existsSync(legacy)).toBe(false);
  });
});
