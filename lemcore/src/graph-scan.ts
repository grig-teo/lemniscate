// Platform-agnostic repository scan: build (or refresh) the codebase graph
// for a workdir and store it on the in-memory session used by the graph
// tools. Fail-soft — callers continue without a graph when the build fails.

import {
  buildLemcoreCodebaseGraph,
  defaultGraphDataDir,
  storeGraphSession,
  summarizeGraph,
  type LemcoreCodebaseGraph,
} from './graph/index.js';

export interface CoreGraphScanOptions {
  /** false disables the external scanner (fallback graph only). */
  enabled?: boolean;
  maxDepth?: number;
  timeoutMs?: number;
  cliPath?: string;
  dataDir?: string;
}

export interface CoreGraphScanResult {
  graph: LemcoreCodebaseGraph;
  summaryText: string;
  enabled: boolean;
}

export async function scanCoreGraph(
  workdir: string,
  opts: CoreGraphScanOptions = {},
): Promise<CoreGraphScanResult> {
  const enabled = opts.enabled !== false;
  const maxDepth = opts.maxDepth ?? 2;
  const graph = await buildLemcoreCodebaseGraph({
    repoRoot: workdir,
    enabled,
    dataDir: opts.dataDir?.trim() || defaultGraphDataDir(workdir),
    maxDepth,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.cliPath ? { cliPath: opts.cliPath } : {}),
  });
  storeGraphSession(workdir, graph, maxDepth);
  return { graph, summaryText: summarizeGraph(graph), enabled };
}
