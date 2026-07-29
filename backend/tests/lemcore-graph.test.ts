import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildFallbackGraph,
  buildLemcoreCodebaseGraph,
  clearGraphSession,
  getGraphSession,
  neighborsOf,
  queryGraph,
  resetGraphSessions,
  storeGraphSession,
  summarizeGraph,
  tokenSavings,
  type CliRunner,
  type LemcoreCodebaseGraph,
} from '../src/lib/lemcore/graph/index.js';
import { buildLemcoreImplContext, seedFilesFromHint } from '../src/lib/lemcore/graph-context.js';
import {
  toolGraphNeighbors,
  toolGraphQuery,
  toolGraphSearch,
} from '../src/lib/lemcore/graph-tools.js';

describe('buildFallbackGraph', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'lemcore-graph-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    resetGraphSessions();
  });

  it('builds nodes and import edges from a small fixture repo', async () => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(
      path.join(root, 'src', 'a.ts'),
      `import { b } from './b';\nexport const a = b;\n`,
    );
    await writeFile(path.join(root, 'src', 'b.ts'), `export const b = 1;\n`);
    await writeFile(path.join(root, 'README.md'), '# fixture\n');

    const graph = await buildFallbackGraph(root);
    expect(graph.ready).toBe(true);
    expect(graph.source).toBe('fallback');
    expect(graph.files).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
    expect(graph.files).not.toContain('README.md');
    expect(graph.edges.some((e) => e.from.includes('a.ts') && e.to.includes('b.ts'))).toBe(
      true,
    );
    expect(graph.stats.fileCount).toBeGreaterThanOrEqual(2);
  });

  it('answers local callers/imports queries', async () => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a.ts'), `import { b } from './b';\n`);
    await writeFile(path.join(root, 'src', 'b.ts'), `export const b = 1;\n`);
    const graph = await buildFallbackGraph(root);
    const session = storeGraphSession(root, graph, 2);
    const result = await queryGraph(session, 'imports_of', 'src/a.ts');
    expect(result.edges.length).toBeGreaterThan(0);
    expect(result.nodes.length).toBeGreaterThan(0);
  });
});

describe('buildLemcoreCodebaseGraph', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'lemcore-graph-cli-'));
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'main.ts'), `export const x = 1;\n`);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    resetGraphSessions();
  });

  it('uses code-review-graph CLI export when the runner succeeds', async () => {
    const dataDir = path.join(root, '..', `graph-data-${path.basename(root)}`);
    await mkdir(dataDir, { recursive: true });

    const runCli: CliRunner = async (args) => {
      if (args[0] === 'build') {
        return { ok: true, stdout: 'built', stderr: '', code: 0 };
      }
      if (args[0] === 'status') {
        // Real v2.3.7 status --json: numeric counts only.
        return {
          ok: true,
          stdout: JSON.stringify({
            nodes: 3,
            edges: 1,
            files: 2,
            languages: ['typescript'],
            last_updated: '2026-01-01T00:00:00Z',
          }),
          stderr: '',
          code: 0,
        };
      }
      if (args[0] === 'visualize' && args.includes('json')) {
        await writeFile(
          path.join(dataDir, 'graph.json'),
          JSON.stringify({
            nodes: [
              {
                id: 1,
                kind: 'Function',
                name: 'main',
                qualified_name: 'src/main.ts::main',
                file_path: 'src/main.ts',
              },
              {
                id: 2,
                kind: 'Function',
                name: 'util',
                qualified_name: 'src/util.ts::util',
                file_path: 'src/util.ts',
              },
            ],
            edges: [
              {
                kind: 'CALLS',
                source: 'src/main.ts::main',
                target: 'src/util.ts::util',
              },
            ],
          }),
        );
        return {
          ok: true,
          stdout: `JSON exported: ${path.join(dataDir, 'graph.json')}`,
          stderr: '',
          code: 0,
        };
      }
      if (args[0] === 'architecture') {
        return {
          ok: true,
          stdout: JSON.stringify({
            summary: 'tiny app with main entry',
            communities: [{ id: 0, name: 'core', size: 2 }],
          }),
          stderr: '',
          code: 0,
        };
      }
      return { ok: false, stdout: '', stderr: 'unknown', code: 1, error: 'unknown' };
    };

    const graph = await buildLemcoreCodebaseGraph({
      repoRoot: root,
      runCli,
      dataDir,
    });
    expect(graph.source).toBe('code-review-graph');
    expect(graph.ready).toBe(true);
    expect(graph.files).toEqual(expect.arrayContaining(['src/main.ts', 'src/util.ts']));
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.nodes.some((n) => n.name === 'main')).toBe(true);
    expect(graph.stats.fileCount).toBe(2);
    expect(graph.stats.nodeCount).toBe(3);
    expect(graph.stats.edgeCount).toBe(1);
    expect(graph.architectureText).toMatch(/tiny app/);
    expect(graph.stats.summaryTokens).toBeGreaterThan(0);
  });

  it('falls back when the CLI is missing without throwing', async () => {
    const runCli: CliRunner = async () => ({
      ok: false,
      stdout: '',
      stderr: '',
      code: null,
      error: 'code-review-graph CLI not found (code-review-graph)',
    });
    const graph = await buildLemcoreCodebaseGraph({ repoRoot: root, runCli });
    expect(graph.ready).toBe(true);
    expect(graph.source).toBe('fallback');
    expect(graph.error).toMatch(/unavailable/i);
    expect(graph.files).toContain('src/main.ts');
  });

  it('returns a non-ready graph when disabled', async () => {
    const graph = await buildLemcoreCodebaseGraph({
      repoRoot: root,
      enabled: false,
    });
    expect(graph.ready).toBe(false);
    expect(graph.source).toBe('none');
  });
});

describe('implementation context + token savings', () => {
  afterEach(() => {
    resetGraphSessions();
  });

  it('prefers graph summary and reports lower tokens than a raw dump estimate', () => {
    const graph: LemcoreCodebaseGraph = {
      source: 'fallback',
      ready: true,
      builtAt: new Date().toISOString(),
      repoRoot: '/tmp/x',
      nodes: [
        { id: 'file:src/a.ts', name: 'src/a.ts', kind: 'file', filePath: 'src/a.ts' },
        { id: 'file:src/b.ts', name: 'src/b.ts', kind: 'file', filePath: 'src/b.ts' },
      ],
      edges: [
        { from: 'file:src/a.ts', to: 'file:src/b.ts', kind: 'imports' },
      ],
      files: ['src/a.ts', 'src/b.ts'],
      stats: {
        fileCount: 2,
        nodeCount: 2,
        edgeCount: 1,
        summaryTokens: 50,
        rawDumpTokens: 5_000,
      },
    };
    storeGraphSession('/tmp/x', graph, 2);
    const ctx = buildLemcoreImplContext('/tmp/x', 'change src/a.ts helpers');
    expect(ctx.usedGraph).toBe(true);
    expect(ctx.text).toMatch(/Codebase graph/);
    expect(ctx.text).toMatch(/src\/a\.ts/);
    expect(ctx.summaryTokens).toBeLessThan(ctx.rawDumpTokens);
    expect(ctx.savedRatio).toBeGreaterThan(0.5);

    const summary = summarizeGraph(graph);
    const savings = tokenSavings(graph, summary);
    expect(savings.summaryTokens).toBeLessThan(savings.rawDumpTokens);
  });

  it('seedFilesFromHint finds paths mentioned in the task', () => {
    const graph: LemcoreCodebaseGraph = {
      source: 'fallback',
      ready: true,
      builtAt: new Date().toISOString(),
      repoRoot: '/tmp/x',
      nodes: [],
      edges: [],
      files: ['src/lib/foo.ts', 'src/lib/bar.ts'],
      stats: {
        fileCount: 2,
        nodeCount: 0,
        edgeCount: 0,
        summaryTokens: 10,
        rawDumpTokens: 100,
      },
    };
    expect(seedFilesFromHint(graph, 'Please edit src/lib/foo.ts')).toEqual([
      'src/lib/foo.ts',
    ]);
  });

  it('neighbors expand along edges', () => {
    const graph: LemcoreCodebaseGraph = {
      source: 'fallback',
      ready: true,
      builtAt: new Date().toISOString(),
      repoRoot: '/tmp/x',
      nodes: [
        { id: 'file:a.ts', name: 'a.ts', kind: 'file', filePath: 'a.ts' },
        { id: 'file:b.ts', name: 'b.ts', kind: 'file', filePath: 'b.ts' },
      ],
      edges: [{ from: 'file:a.ts', to: 'file:b.ts', kind: 'imports' }],
      files: ['a.ts', 'b.ts'],
      stats: {
        fileCount: 2,
        nodeCount: 2,
        edgeCount: 1,
        summaryTokens: 10,
        rawDumpTokens: 100,
      },
    };
    const hood = neighborsOf(graph, 'a.ts', 1);
    expect(hood.files).toEqual(expect.arrayContaining(['a.ts', 'b.ts']));
  });
});

describe('graph tools', () => {
  afterEach(() => {
    resetGraphSessions();
  });

  it('returns a clear error when no session graph exists', async () => {
    const res = await toolGraphQuery('/tmp/missing-session', 'callers_of', 'x');
    expect(res.error).toMatch(/unavailable/i);
  });

  it('serves query/search/neighbors from a stored session', async () => {
    const workdir = '/tmp/lemcore-tools-session';
    const graph: LemcoreCodebaseGraph = {
      source: 'fallback',
      ready: true,
      builtAt: new Date().toISOString(),
      repoRoot: workdir,
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
        summaryTokens: 20,
        rawDumpTokens: 200,
      },
    };
    storeGraphSession(workdir, graph, 2);
    expect(getGraphSession(workdir)?.graph.files).toContain('src/a.ts');

    const q = await toolGraphQuery(workdir, 'imports_of', 'src/a.ts');
    expect(q.error).toBeUndefined();
    expect(q.outputPreview).toMatch(/Graph query/);

    const s = await toolGraphSearch(workdir, 'src/b');
    expect(s.outputPreview).toMatch(/search/i);

    const n = await toolGraphNeighbors(workdir, 'src/a.ts');
    expect(n.outputPreview).toMatch(/neighborhood/i);

    clearGraphSession(workdir);
    expect(getGraphSession(workdir)).toBeNull();
  });
});

describe('agent isolation guard', () => {
  it('does not import code-review-graph from non-lemcore agent modules', async () => {
    const { readFile } = await import('node:fs/promises');
    const { execFileSync } = await import('node:child_process');
    // Grep production sources outside lemcore for accidental coupling.
    let stdout = '';
    try {
      stdout = execFileSync(
        'rg',
        [
          '-l',
          'code-review-graph|lemcore/graph',
          'src',
          '--glob',
          '!**/lemcore/**',
        ],
        { cwd: path.join(process.cwd()), encoding: 'utf8' },
      );
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      // rg exits 1 when there are no matches — that is success for this guard.
      if (e.status === 1) {
        stdout = e.stdout ?? '';
      } else {
        throw err;
      }
    }
    const hits = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      // config may document the env vars; allow config.ts only for flag names.
      .filter((f) => !f.endsWith('config.ts'));
    expect(hits).toEqual([]);

    // Sanity: lemcore graph module itself mentions the tool.
    const idx = await readFile(
      path.join(process.cwd(), 'src/lib/lemcore/graph/cli.ts'),
      'utf8',
    );
    expect(idx).toContain('code-review-graph');
  });
});

// Silence unused vi import if tree-shaken differently across vitest versions.
void vi;
