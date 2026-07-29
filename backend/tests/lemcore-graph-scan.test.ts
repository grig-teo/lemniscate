import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetGraphSessions, getGraphSession } from '../src/lib/lemcore/graph/index.js';
import { buildLemcoreImplContext } from '../src/lib/lemcore/graph-context.js';

vi.mock('../src/lib/agent-git.js', () => ({
  logEvent: vi.fn(async () => {}),
  hasDirtyWorkdir: vi.fn(async () => false),
}));

import { scanRepositoryGraph } from '../src/lib/lemcore/graph-scan.js';
import { logEvent } from '../src/lib/agent-git.js';

describe('scanRepositoryGraph', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'lemcore-scan-'));
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(
      path.join(root, 'src', 'index.ts'),
      `import { helper } from './helper';\nexport const main = helper;\n`,
    );
    await writeFile(path.join(root, 'src', 'helper.ts'), `export const helper = 42;\n`);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    resetGraphSessions();
  });

  it('builds a graph on each scan and stores a session for implementation context', async () => {
    const result = await scanRepositoryGraph('task-1', root);
    expect(result.graph.ready).toBe(true);
    // Without the real CLI in CI this is the fallback structural scan — still usable.
    expect(['fallback', 'code-review-graph']).toContain(result.graph.source);
    expect(result.summaryText).toMatch(/Codebase graph/);
    expect(getGraphSession(root)?.graph.files).toEqual(
      expect.arrayContaining(['src/index.ts', 'src/helper.ts']),
    );

    const ctx = buildLemcoreImplContext(root, 'update src/index.ts');
    expect(ctx.usedGraph).toBe(true);
    expect(ctx.summaryTokens).toBeLessThan(ctx.rawDumpTokens);
    expect(ctx.text).toMatch(/src\/index\.ts/);

    expect(logEvent).toHaveBeenCalled();
    const messages = vi.mocked(logEvent).mock.calls.map((c) => String(c[1]));
    expect(messages.some((m) => /codebase graph/i.test(m))).toBe(true);
  });
});
