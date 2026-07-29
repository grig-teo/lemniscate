// Build a lemcore codebase graph for one repository scan.
// Prefers code-review-graph CLI; falls back to a local structural scan.

import path from 'node:path';
import {
  DEFAULT_BUILD_TIMEOUT_MS,
  DEFAULT_CLI,
  DEFAULT_QUERY_TIMEOUT_MS,
  defaultCliRunner,
  runGraphArchitecture,
  runGraphBuild,
  runGraphStatus,
} from './cli.js';
import { buildFallbackGraph } from './fallback-scan.js';
import {
  architectureTextFromUnknown,
  filesFromUnknown,
  nodesFromUnknown,
  statsFromStatus,
  tryParseJson,
} from './parse.js';
import { estimateContextTokens, summarizeGraph } from './summary.js';
import type {
  BuildGraphOptions,
  CliRunner,
  LemcoreCodebaseGraph,
} from './types.js';

export function defaultGraphDataDir(repoRoot: string): string {
  // Sibling of the clone so graph artifacts never enter git status / PRs.
  return `${repoRoot.replace(/[/\\]+$/, '')}.lemcore-graph-data`;
}

export async function buildLemcoreCodebaseGraph(
  opts: BuildGraphOptions,
): Promise<LemcoreCodebaseGraph> {
  const repoRoot = path.resolve(opts.repoRoot);
  const dataDir = opts.dataDir ?? defaultGraphDataDir(repoRoot);
  const enabled = opts.enabled !== false;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  const maxDepth = opts.maxDepth ?? 2;
  void maxDepth;

  if (!enabled) {
    return emptyGraph(repoRoot, dataDir, 'graph disabled by config');
  }

  const run: CliRunner = opts.runCli ?? defaultCliRunner(opts.cliPath ?? DEFAULT_CLI);
  try {
    const built = await runGraphBuild(run, repoRoot, dataDir, timeoutMs);
    if (!built.ok) {
      return withFallback(
        repoRoot,
        dataDir,
        built.error ?? (built.stderr || 'build failed'),
      );
    }

    const status = await runGraphStatus(run, repoRoot, dataDir, DEFAULT_QUERY_TIMEOUT_MS);
    const statusJson = status.ok ? tryParseJson(status.stdout) : null;
    const arch = await runGraphArchitecture(
      run,
      repoRoot,
      dataDir,
      DEFAULT_QUERY_TIMEOUT_MS,
    );
    const archJson = arch.ok ? tryParseJson(arch.stdout) : null;
    const architectureText = arch.ok
      ? architectureTextFromUnknown(archJson, arch.stdout)
      : undefined;

    const files = unique([
      ...filesFromUnknown(statusJson),
      ...filesFromUnknown(archJson),
    ]);
    const nodes = [
      ...nodesFromUnknown(statusJson),
      ...nodesFromUnknown(archJson),
      ...files.map((f) => ({
        id: `file:${f}`,
        name: f,
        kind: 'file' as const,
        filePath: f,
      })),
    ];
    const stats = statsFromStatus(statusJson, files);
    const graph: LemcoreCodebaseGraph = {
      source: 'code-review-graph',
      ready: true,
      builtAt: new Date().toISOString(),
      repoRoot,
      dataDir,
      nodes: dedupeNodes(nodes),
      edges: [],
      files: files.length > 0 ? files : nodes.map((n) => n.filePath).filter(Boolean) as string[],
      architectureText,
      stats,
    };
    const summary = summarizeGraph(graph);
    graph.stats.summaryTokens = estimateContextTokens(summary);
    if (graph.stats.rawDumpTokens < graph.stats.summaryTokens * 4) {
      graph.stats.rawDumpTokens = Math.max(
        graph.stats.summaryTokens * 10,
        graph.stats.fileCount * 400,
      );
    }
    return graph;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return withFallback(repoRoot, dataDir, msg);
  }
}

async function withFallback(
  repoRoot: string,
  dataDir: string,
  reason: string,
): Promise<LemcoreCodebaseGraph> {
  try {
    const graph = await buildFallbackGraph(repoRoot);
    graph.dataDir = dataDir;
    graph.error = `code-review-graph unavailable (${reason}); using fallback scan`;
    return graph;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return emptyGraph(repoRoot, dataDir, `${reason}; fallback failed: ${msg}`);
  }
}

function emptyGraph(
  repoRoot: string,
  dataDir: string,
  error: string,
): LemcoreCodebaseGraph {
  return {
    source: 'none',
    ready: false,
    builtAt: new Date().toISOString(),
    repoRoot,
    dataDir,
    nodes: [],
    edges: [],
    files: [],
    error,
    stats: {
      fileCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      summaryTokens: 0,
      rawDumpTokens: 0,
    },
  };
}

function dedupeNodes(
  nodes: LemcoreCodebaseGraph['nodes'],
): LemcoreCodebaseGraph['nodes'] {
  const seen = new Set<string>();
  const out: LemcoreCodebaseGraph['nodes'] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
