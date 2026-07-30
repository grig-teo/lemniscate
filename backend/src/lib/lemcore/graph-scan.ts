// Hook: every lemcore repository scan builds (or refreshes) a codebase graph.
// Fail-soft — scan/implementation continues even when the graph tool is missing.

import { config } from '../../config.js';
import { logEvent } from '../agent-git.js';
import {
  buildLemcoreCodebaseGraph,
  defaultGraphDataDir,
  storeGraphSession,
  summarizeGraph,
  tokenSavings,
  type LemcoreCodebaseGraph,
} from './graph/index.js';

export interface LemcoreGraphScanResult {
  graph: LemcoreCodebaseGraph;
  summaryText: string;
  enabled: boolean;
}

export function isLemcoreGraphEnabled(): boolean {
  return config.LEMCORE_CODE_GRAPH !== false;
}

export function lemcoreGraphMaxDepth(): number {
  return config.LEMCORE_CODE_GRAPH_MAX_DEPTH;
}

export function lemcoreGraphDataDir(workdir: string): string {
  if (config.LEMCORE_CODE_GRAPH_DATA_DIR?.trim()) {
    return config.LEMCORE_CODE_GRAPH_DATA_DIR.trim();
  }
  return defaultGraphDataDir(workdir);
}

/**
 * Build the codebase graph for a lemcore workdir scan and store it on the
 * in-memory session used by implementation context + graph tools.
 */
export async function scanRepositoryGraph(
  taskId: string,
  workdir: string,
): Promise<LemcoreGraphScanResult> {
  const enabled = isLemcoreGraphEnabled();
  if (!enabled) {
    await logEvent(taskId, 'codebase graph: disabled (LEMCORE_CODE_GRAPH=false)').catch(() => {});
    const graph = await buildLemcoreCodebaseGraph({
      repoRoot: workdir,
      enabled: false,
      dataDir: lemcoreGraphDataDir(workdir),
      maxDepth: lemcoreGraphMaxDepth(),
    });
    storeGraphSession(workdir, graph, lemcoreGraphMaxDepth());
    return { graph, summaryText: summarizeGraph(graph), enabled: false };
  }

  await logEvent(taskId, 'scanning repository into codebase graph').catch(() => {});
  const graph = await buildLemcoreCodebaseGraph({
    repoRoot: workdir,
    dataDir: lemcoreGraphDataDir(workdir),
    enabled: true,
    maxDepth: lemcoreGraphMaxDepth(),
    timeoutMs: config.LEMCORE_CODE_GRAPH_TIMEOUT_MS,
    cliPath: config.LEMCORE_CODE_GRAPH_CLI,
  });
  storeGraphSession(workdir, graph, lemcoreGraphMaxDepth());
  const summaryText = summarizeGraph(graph);
  const savings = tokenSavings(graph, summaryText);

  if (graph.ready) {
    await logEvent(
      taskId,
      `codebase graph ready (${graph.source}): ${graph.stats.fileCount} files, ` +
        `${graph.stats.nodeCount} nodes, ${graph.stats.edgeCount} edges; ` +
        `~${savings.summaryTokens} summary tokens vs ~${savings.rawDumpTokens} raw ` +
        `(~${Math.round(savings.savedRatio * 100)}% fewer)`,
    ).catch(() => {});
  } else {
    await logEvent(
      taskId,
      `codebase graph unavailable: ${graph.error ?? 'unknown error'}; continuing without graph`,
    ).catch(() => {});
  }

  return { graph, summaryText, enabled: true };
}
