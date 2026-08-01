import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scrubAgentScratchFiles } from '../src/lib/workdir-scrub.js';

// Locks the staging scrub: review/transcript scratch and crash core dumps
// must never reach git add -A (a 655 MB core dump once killed a task's push).

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'scrub-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function exists(rel: string): Promise<boolean> {
  return fs.access(path.join(workdir, rel)).then(() => true, () => false);
}

describe('scrubAgentScratchFiles', () => {
  it('removes review/transcript scratch from the workdir root', async () => {
    await fs.writeFile(path.join(workdir, '.lemniscate-review.json'), '{}');
    await fs.writeFile(path.join(workdir, 'lemcore-transcript.json'), '[]');

    await scrubAgentScratchFiles(workdir);

    expect(await exists('.lemniscate-review.json')).toBe(false);
    expect(await exists('lemcore-transcript.json')).toBe(false);
  });

  it('removes core dumps in nested dirs but keeps real files', async () => {
    await fs.mkdir(path.join(workdir, 'frontend/src'), { recursive: true });
    await fs.writeFile(path.join(workdir, 'frontend/core.12300'), 'dump');
    await fs.writeFile(path.join(workdir, 'core'), 'dump');
    await fs.writeFile(path.join(workdir, 'frontend/src/core-utils.ts'), 'export {}');
    await fs.writeFile(path.join(workdir, 'frontend/src/index.ts'), 'export {}');

    await scrubAgentScratchFiles(workdir);

    expect(await exists('frontend/core.12300')).toBe(false);
    expect(await exists('core')).toBe(false);
    expect(await exists('frontend/src/core-utils.ts')).toBe(true);
    expect(await exists('frontend/src/index.ts')).toBe(true);
  });

  it('does not descend into node_modules or .git', async () => {
    await fs.mkdir(path.join(workdir, 'node_modules/pkg'), { recursive: true });
    await fs.writeFile(path.join(workdir, 'node_modules/pkg/core.5'), 'dump');

    await scrubAgentScratchFiles(workdir);

    expect(await exists('node_modules/pkg/core.5')).toBe(true);
  });

  it('is a no-op on an empty workdir', async () => {
    await expect(scrubAgentScratchFiles(workdir)).resolves.toBeUndefined();
  });
});
