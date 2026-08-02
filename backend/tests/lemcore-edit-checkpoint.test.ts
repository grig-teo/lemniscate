import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { lintAndMaybeRevert } from '../src/lib/lemcore/edit-checkpoint.js';

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'lemcore-checkpoint-'));
});

afterEach(async () => {
  await import('node:fs/promises').then((fs) => fs.rm(workdir, { recursive: true, force: true }));
});

describe('lintAndMaybeRevert — no-lint-config path writes the file', () => {
  it('writes new content for a .md file (no linter configured)', async () => {
    await writeFile(path.join(workdir, 'README.md'), '# Old\n');
    await lintAndMaybeRevert(
      workdir, 'README.md', '# Old\n', '# New\n', [], Date.now(), 'edit_file',
    );
    // BUG (before fix): the no-lint path returned "edited" without writing.
    expect(await readFile(path.join(workdir, 'README.md'), 'utf8')).toBe('# New\n');
  });

  it('writes new content for a .json file (no linter configured)', async () => {
    await writeFile(path.join(workdir, 'config.json'), '{"a":1}');
    await lintAndMaybeRevert(
      workdir, 'config.json', '{"a":1}', '{"a":2}', [], Date.now(), 'edit_file',
    );
    expect(await readFile(path.join(workdir, 'config.json'), 'utf8')).toBe('{"a":2}');
  });

  it('writes new content for a .sh file (no linter configured)', async () => {
    await writeFile(path.join(workdir, 'run.sh'), 'echo old\n');
    await lintAndMaybeRevert(
      workdir, 'run.sh', 'echo old\n', 'echo new\n', [], Date.now(), 'edit_file',
    );
    expect(await readFile(path.join(workdir, 'run.sh'), 'utf8')).toBe('echo new\n');
  });
});
