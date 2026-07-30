import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    task: { update: vi.fn(), findUnique: vi.fn() },
    skill: { findMany: vi.fn(), findUnique: vi.fn() },
    mcpServer: { findMany: vi.fn() },
  },
}));

vi.mock('../src/lib/agent-git.js', () => ({
  logEvent: vi.fn(async () => {}),
  hasDirtyWorkdir: vi.fn(async () => false),
}));

vi.mock('../src/lib/agent-prompts.js', () => ({
  buildSkillsSection: vi.fn(() => ''),
}));

vi.mock('../src/lib/task-skills.js', () => ({
  loadTaskSkills: vi.fn(async () => []),
}));

vi.mock('../src/lib/lemcore/graph-scan.js', () => ({
  scanRepositoryGraph: vi.fn(async (_taskId: string, workdir: string) => {
    const { storeGraphSession, summarizeGraph } = await import(
      '../src/lib/lemcore/graph/index.js'
    );
    const graph = {
      source: 'fallback' as const,
      ready: true,
      builtAt: new Date().toISOString(),
      repoRoot: workdir,
      nodes: [
        { id: 'file:src/a.ts', name: 'src/a.ts', kind: 'file' as const, filePath: 'src/a.ts' },
        { id: 'file:src/b.ts', name: 'src/b.ts', kind: 'file' as const, filePath: 'src/b.ts' },
      ],
      edges: [
        { from: 'file:src/a.ts', to: 'file:src/b.ts', kind: 'imports' as const },
      ],
      files: ['src/a.ts', 'src/b.ts'],
      stats: {
        fileCount: 2,
        nodeCount: 2,
        edgeCount: 1,
        summaryTokens: 40,
        rawDumpTokens: 4_000,
      },
    };
    storeGraphSession(workdir, graph, 2);
    return { graph, summaryText: summarizeGraph(graph), enabled: true };
  }),
}));

vi.mock('../src/lib/lemcore/loop.js', () => ({
  runLemcoreLoop: vi.fn(async () => 'done'),
  loadTranscript: vi.fn(() => null),
  scrubLegacyInCloneTranscript: vi.fn(),
}));

import {
  getGraphSession,
  resetGraphSessions,
  storeGraphSession,
  summarizeGraph,
  type LemcoreCodebaseGraph,
} from '../src/lib/lemcore/graph/index.js';
import { buildLemcoreImplContext } from '../src/lib/lemcore/graph-context.js';
import { appendGraphContext, runLemcoreTask } from '../src/lib/lemcore/run.js';

function sampleGraph(repoRoot: string): LemcoreCodebaseGraph {
  return {
    source: 'fallback',
    ready: true,
    builtAt: new Date().toISOString(),
    repoRoot,
    nodes: [
      { id: 'file:src/a.ts', name: 'src/a.ts', kind: 'file', filePath: 'src/a.ts' },
      { id: 'file:src/b.ts', name: 'src/b.ts', kind: 'file', filePath: 'src/b.ts' },
    ],
    edges: [{ from: 'file:src/a.ts', to: 'file:src/b.ts', kind: 'imports' }],
    files: ['src/a.ts', 'src/b.ts'],
    stats: {
      fileCount: 2,
      nodeCount: 2,
      edgeCount: 1,
      summaryTokens: 40,
      rawDumpTokens: 4_000,
    },
  };
}

describe('appendGraphContext', () => {
  afterEach(() => {
    resetGraphSessions();
  });

  it('does not double-inject the graph summary when a neighborhood is present', () => {
    const workdir = '/tmp/lemcore-run-graph-dedupe';
    const graph = sampleGraph(workdir);
    storeGraphSession(workdir, graph, 2);

    const scanSummary = summarizeGraph(graph);
    const impl = buildLemcoreImplContext(workdir, 'change src/a.ts helpers');
    expect(impl.text).toContain(scanSummary);
    expect(impl.text).toMatch(/neighborhood/i);

    const prompt = appendGraphContext('# Task\nfix', scanSummary, impl.text);
    // fallback summary heading appears once; neighborhood is a separate section.
    const summaryMarker = '## Codebase graph (fallback structural scan)';
    expect(prompt.split(summaryMarker).length - 1).toBe(1);
    expect(prompt).toMatch(/Graph neighborhood/);
    const first = prompt.indexOf(scanSummary.trim());
    const second = prompt.indexOf(scanSummary.trim(), first + 1);
    expect(first).toBeGreaterThan(-1);
    expect(second).toBe(-1);
  });

  it('falls back to scan summary when impl context is empty', () => {
    const prompt = appendGraphContext('# Task\nfix', '## Codebase graph\nok', '');
    expect(prompt).toContain('## Codebase graph\nok');
    expect(prompt).toMatch(/Prefer graph_\* tools/);
  });
});

describe('runLemcoreTask session teardown', () => {
  afterEach(() => {
    resetGraphSessions();
    vi.clearAllMocks();
  });

  it('clears the in-memory graph session when the run finishes', async () => {
    const workdir = '/tmp/lemcore-run-graph-teardown';
    const rt = {
      cfg: { systemPromptExtra: '' },
    } as unknown as import('../src/lib/agent-runtime.js').LlmRuntime;
    const task = {
      id: 't1',
      title: 'edit src/a.ts',
      prompt: 'touch src/a.ts',
    } as unknown as import('../src/lib/agent-runtime.js').TaskWithRepo;

    const result = await runLemcoreTask({
      taskId: 't1',
      task,
      workdir,
      rt,
      secrets: [],
      resume: false,
    });

    expect(result.changed).toBe(false);
    expect(getGraphSession(workdir)).toBeNull();
  });

  it('clears the session even when the loop throws', async () => {
    const { runLemcoreLoop } = await import('../src/lib/lemcore/loop.js');
    vi.mocked(runLemcoreLoop).mockRejectedValueOnce(new Error('boom'));

    const workdir = '/tmp/lemcore-run-graph-teardown-err';
    const rt = {
      cfg: { systemPromptExtra: '' },
    } as unknown as import('../src/lib/agent-runtime.js').LlmRuntime;
    const task = {
      id: 't2',
      title: 'edit src/a.ts',
      prompt: 'touch src/a.ts',
    } as unknown as import('../src/lib/agent-runtime.js').TaskWithRepo;

    await expect(
      runLemcoreTask({
        taskId: 't2',
        task,
        workdir,
        rt,
        secrets: [],
        resume: false,
      }),
    ).rejects.toThrow(/boom/);

    expect(getGraphSession(workdir)).toBeNull();
  });
});
