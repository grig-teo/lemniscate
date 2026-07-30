// Build a lemcore codebase graph for one repository scan.
// Prefers code-review-graph CLI; falls back to a local structural scan.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_BUILD_TIMEOUT_MS,
  DEFAULT_CLI,
  DEFAULT_QUERY_TIMEOUT_MS,
  defaultCliRunner,
  runGraphArchitecture,
  runGraphBuild,
  runGraphExportJson,
  runGraphStatus,
} from './cli.js';
import { buildFallbackGraph } from './fallback-scan.js';
import {
  architectureTextFromUnknown,
  graphPartsFromExport,
  statsFromStatus,
  tryParseJson,
} from './parse.js';
import { estimateContextTokens, summarizeGraph } from './summary.js';
import type {
  BuildGraphOptions,
  CliRunner,
  LemcoreCodebaseGraph,
} from './types.js';

const MAX_IMPORT_NODES = 4_000;
const MAX_IMPORT_EDGES = 8_000;

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

  if (!enabled) {
    return emptyGraph(repoRoot, dataDir, 'graph disabled by config', maxDepth);
  }

  const run: CliRunner = opts.runCli ?? defaultCliRunner(opts.cliPath ?? DEFAULT_CLI);
  try {
    const built = await runGraphBuild(run, repoRoot, dataDir, timeoutMs);
    if (!built.ok) {
      return withFallback(
        repoRoot,
        dataDir,
        built.error ?? (built.stderr || 'build failed'),
        maxDepth,
      );
    }

    const status = await runGraphStatus(run, repoRoot, dataDir, DEFAULT_QUERY_TIMEOUT_MS);
    const statusJson = status.ok ? tryParseJson(status.stdout) : null;

    // Full node/edge/file lists live in visualize --format json export,
    // not in status --json (which only has numeric counts).
    await runGraphExportJson(run, repoRoot, dataDir, DEFAULT_QUERY_TIMEOUT_MS);
    const exported = await readExportJson(dataDir);

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

    let { nodes, edges, files } = graphPartsFromExport(exported);
    nodes = nodes.slice(0, MAX_IMPORT_NODES);
    edges = edges.slice(0, MAX_IMPORT_EDGES);

    // If export was empty/missing, seed structure from local scan so
    // implementation context still has paths — CLI queries still use dataDir.
    if (files.length === 0 && nodes.length === 0) {
      const seed = await buildFallbackGraph(repoRoot);
      files = seed.files;
      nodes = seed.nodes;
      edges = seed.edges;
    } else if (files.length === 0) {
      files = unique(
        nodes
          .map((n) => n.filePath)
          .filter((f): f is string => typeof f === 'string' && f.length > 0),
      );
    }

    // Ensure every file path has a file node for neighborhood walks.
    const fileNodes = files.map((f) => ({
      id: `file:${f}`,
      name: f,
      kind: 'file' as const,
      filePath: f,
    }));
    const stats = statsFromStatus(statusJson, files);
    if (stats.fileCount === 0 && files.length > 0) stats.fileCount = files.length;
    if (stats.nodeCount === 0 && nodes.length > 0) {
      stats.nodeCount = nodes.length + fileNodes.length;
    }
    if (stats.edgeCount === 0 && edges.length > 0) stats.edgeCount = edges.length;

    const graph: LemcoreCodebaseGraph = {
      source: 'code-review-graph',
      ready: true,
      builtAt: new Date().toISOString(),
      repoRoot,
      dataDir,
      maxDepth,
      nodes: dedupeNodes([...nodes, ...fileNodes]),
      edges,
      files,
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
    return withFallback(repoRoot, dataDir, msg, maxDepth);
  }
}

async function readExportJson(dataDir: string): Promise<unknown | null> {
  const candidates = [
    path.join(dataDir, 'graph.json'),
    path.join(dataDir, 'export.json'),
  ];
  for (const p of candidates) {
    try {
      const text = await fs.readFile(p, 'utf8');
      const parsed = tryParseJson(text);
      if (parsed) return parsed;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function withFallback(
  repoRoot: string,
  dataDir: string,
  reason: string,
  maxDepth: number,
): Promise<LemcoreCodebaseGraph> {
  try {
    const graph = await buildFallbackGraph(repoRoot);
    graph.dataDir = dataDir;
    graph.maxDepth = maxDepth;
    graph.error = `code-review-graph unavailable (${reason}); using fallback scan`;
    return graph;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return emptyGraph(repoRoot, dataDir, `${reason}; fallback failed: ${msg}`, maxDepth);
  }
}

function emptyGraph(
  repoRoot: string,
  dataDir: string,
  error: string,
  maxDepth?: number,
): LemcoreCodebaseGraph {
  return {
    source: 'none',
    ready: false,
    builtAt: new Date().toISOString(),
    repoRoot,
    dataDir,
    maxDepth,
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
