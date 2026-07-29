/**
 * Contract tests against code-review-graph v2.3.7 CLI shapes.
 * These assert exact argv and status schema so mocks cannot hide drift.
 */
import { describe, expect, it } from 'vitest';

import {
  CRG_QUERY_PATTERNS,
  filesFromUnknown,
  graphPartsFromExport,
  normalizeQueryPattern,
  runGraphArchitecture,
  runGraphBuild,
  runGraphExportJson,
  runGraphImpact,
  runGraphQuery,
  runGraphSearch,
  runGraphStatus,
  statsFromStatus,
  tryParseJson,
  type CliRunner,
} from '../src/lib/lemcore/graph/index.js';
import { getAvailableTools } from '../src/lib/lemcore/tool-catalog.js';

/** Fixture matching real `status --json` from v2.3.7 cli.py. */
const REAL_STATUS_JSON = {
  nodes: 1284,
  edges: 3510,
  files: 214,
  languages: ['python', 'typescript'],
  last_updated: '2026-03-20T12:00:00',
  vcs: 'git',
  built_on_branch: 'main',
  built_at_commit: 'abc123def456',
  current_branch: 'main',
  current_sha: 'abc123def456',
  svn_branch: null,
  svn_revision: null,
};

function captureRunner(): {
  run: CliRunner;
  calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }>;
} {
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const run: CliRunner = async (args, opts) => {
    calls.push({ args: [...args], env: opts.env });
    return { ok: true, stdout: '{}', stderr: '', code: 0 };
  };
  return { run, calls };
}

describe('code-review-graph v2.3.7 CLI argv contract', () => {
  const repo = '/tmp/repo';
  const dataDir = '/tmp/repo.lemcore-graph-data';

  it('build/status/export pass --data-dir; query tools do not', async () => {
    const { run, calls } = captureRunner();

    await runGraphBuild(run, repo, dataDir, 1000);
    await runGraphStatus(run, repo, dataDir, 1000);
    await runGraphExportJson(run, repo, dataDir, 1000);
    await runGraphArchitecture(run, repo, dataDir, 1000);
    await runGraphQuery(run, repo, dataDir, 'callers_of', 'foo', 1000);
    await runGraphImpact(run, repo, dataDir, ['a.ts', 'b.ts'], 2, 1000);
    await runGraphSearch(run, repo, dataDir, 'Widget', 1000);

    expect(calls.map((c) => c.args[0])).toEqual([
      'build',
      'status',
      'visualize',
      'architecture',
      'query',
      'impact',
      'search',
    ]);

    // build
    expect(calls[0]!.args).toEqual([
      'build',
      '--repo',
      repo,
      '--data-dir',
      dataDir,
      '--quiet',
      '--skip-flows',
    ]);
    expect(calls[0]!.env?.CRG_DATA_DIR).toBe(dataDir);

    // status
    expect(calls[1]!.args).toEqual([
      'status',
      '--repo',
      repo,
      '--data-dir',
      dataDir,
      '--json',
    ]);

    // visualize export (has --data-dir)
    expect(calls[2]!.args).toEqual([
      'visualize',
      '--repo',
      repo,
      '--data-dir',
      dataDir,
      '--format',
      'json',
    ]);

    // architecture: NO --data-dir
    expect(calls[3]!.args).toEqual([
      'architecture',
      '--repo',
      repo,
      '--detail-level',
      'minimal',
    ]);
    expect(calls[3]!.args).not.toContain('--data-dir');
    expect(calls[3]!.env?.CRG_DATA_DIR).toBe(dataDir);

    // query: NO --data-dir
    expect(calls[4]!.args).toEqual([
      'query',
      'callers_of',
      'foo',
      '--repo',
      repo,
    ]);
    expect(calls[4]!.args).not.toContain('--data-dir');

    // impact: single --files with nargs='+' values
    expect(calls[5]!.args).toEqual([
      'impact',
      '--repo',
      repo,
      '--depth',
      '2',
      '--files',
      'a.ts',
      'b.ts',
    ]);
    expect(calls[5]!.args.filter((a) => a === '--files')).toHaveLength(1);
    expect(calls[5]!.args).not.toContain('--data-dir');

    // search: NO --data-dir
    expect(calls[6]!.args).toEqual([
      'search',
      'Widget',
      '--repo',
      repo,
      '--limit',
      '20',
    ]);
    expect(calls[6]!.args).not.toContain('--data-dir');
  });

  it('impact multi-file argv is one --files then all paths', async () => {
    const { run, calls } = captureRunner();
    await runGraphImpact(
      run,
      repo,
      dataDir,
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      3,
      1000,
    );
    const args = calls[0]!.args;
    const filesIdx = args.indexOf('--files');
    expect(filesIdx).toBeGreaterThan(0);
    expect(args.slice(filesIdx)).toEqual([
      '--files',
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
    // Must not repeat the flag per file.
    expect(args.filter((a) => a === '--files')).toEqual(['--files']);
  });
});

describe('status --json schema (v2.3.7)', () => {
  it('parses numeric counts and does not treat files as paths', () => {
    const raw = tryParseJson(JSON.stringify(REAL_STATUS_JSON));
    expect(raw).toEqual(REAL_STATUS_JSON);

    const stats = statsFromStatus(raw, []);
    expect(stats.fileCount).toBe(214);
    expect(stats.nodeCount).toBe(1284);
    expect(stats.edgeCount).toBe(3510);

    // files is a number — must not become a path list
    expect(filesFromUnknown(raw)).toEqual([]);
  });

  it('loads nodes/edges/files from visualize export payload', () => {
    const exportPayload = {
      nodes: [
        {
          kind: 'Function',
          name: 'login',
          qualified_name: 'auth.ts::login',
          file_path: 'src/auth.ts',
        },
        {
          kind: 'Function',
          name: 'logout',
          qualified_name: 'auth.ts::logout',
          file_path: 'src/auth.ts',
        },
      ],
      edges: [
        {
          kind: 'CALLS',
          source: 'auth.ts::login',
          target: 'auth.ts::logout',
        },
      ],
      stats: { total_nodes: 2, total_edges: 1, files_count: 1 },
    };
    const parts = graphPartsFromExport(exportPayload);
    expect(parts.files).toEqual(['src/auth.ts']);
    expect(parts.nodes).toHaveLength(2);
    expect(parts.edges).toEqual([
      {
        from: 'auth.ts::login',
        to: 'auth.ts::logout',
        kind: 'calls',
      },
    ]);
  });
});

describe('query pattern contract', () => {
  it('exposes only upstream CLI choices on graph_query tool', () => {
    const tools = getAvailableTools();
    const gq = tools.find((t) => t.function.name === 'graph_query');
    expect(gq).toBeDefined();
    const desc = String(
      (gq!.function.parameters as { properties: { pattern: { description: string } } })
        .properties.pattern.description,
    );
    for (const p of CRG_QUERY_PATTERNS) {
      expect(desc).toContain(p);
    }
    expect(desc).not.toContain('references_to');
  });

  it('maps references_to alias to callers_of for CLI', () => {
    expect(normalizeQueryPattern('references_to')).toBe('callers_of');
    expect(normalizeQueryPattern('imports_of')).toBe('imports_of');
  });
});
