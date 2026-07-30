// Lemcore tool handlers that query the scan-session codebase graph.

import {
  getGraphSession,
  impactGraph,
  neighborsOf,
  queryGraph,
  searchGraph,
  summarizeNeighborhood,
  summarizeQuery,
} from './graph/index.js';
import { truncate, type ToolResult } from './tools.js';

const NO_GRAPH =
  'No codebase graph in this scan session. Use grep/read_file instead.';

export async function toolGraphQuery(
  workdir: string,
  pattern: string,
  target: string,
): Promise<ToolResult> {
  const startMs = Date.now();
  const session = getGraphSession(workdir);
  if (!session?.graph.ready) {
    return {
      tool: 'graph_query',
      title: `${pattern} ${target}`,
      outputPreview: NO_GRAPH,
      durationMs: Date.now() - startMs,
      error: 'graph unavailable',
    };
  }
  const result = await queryGraph(session, pattern, target);
  return {
    tool: 'graph_query',
    title: `${pattern}(${target})`,
    outputPreview: truncate(summarizeQuery(result)),
    durationMs: Date.now() - startMs,
  };
}

export async function toolGraphImpact(
  workdir: string,
  files: string[],
): Promise<ToolResult> {
  const startMs = Date.now();
  const session = getGraphSession(workdir);
  if (!session?.graph.ready) {
    return {
      tool: 'graph_impact',
      title: 'impact',
      outputPreview: 'No codebase graph in this scan session.',
      durationMs: Date.now() - startMs,
      error: 'graph unavailable',
    };
  }
  const hood = await impactGraph(session, files);
  return {
    tool: 'graph_impact',
    title: `impact ${files.slice(0, 3).join(',')}${files.length > 3 ? '…' : ''}`,
    outputPreview: truncate(summarizeNeighborhood(hood)),
    durationMs: Date.now() - startMs,
  };
}

export async function toolGraphNeighbors(
  workdir: string,
  center: string,
  depth?: number,
): Promise<ToolResult> {
  const startMs = Date.now();
  const session = getGraphSession(workdir);
  if (!session?.graph.ready) {
    return {
      tool: 'graph_neighbors',
      title: center,
      outputPreview: 'No codebase graph in this scan session.',
      durationMs: Date.now() - startMs,
      error: 'graph unavailable',
    };
  }
  const hood = neighborsOf(session.graph, center, depth ?? session.maxDepth);
  return {
    tool: 'graph_neighbors',
    title: `neighbors(${center})`,
    outputPreview: truncate(summarizeNeighborhood(hood)),
    durationMs: Date.now() - startMs,
  };
}

export async function toolGraphSearch(
  workdir: string,
  query: string,
): Promise<ToolResult> {
  const startMs = Date.now();
  const session = getGraphSession(workdir);
  if (!session?.graph.ready) {
    return {
      tool: 'graph_search',
      title: query,
      outputPreview: 'No codebase graph in this scan session.',
      durationMs: Date.now() - startMs,
      error: 'graph unavailable',
    };
  }
  const result = await searchGraph(session, query);
  return {
    tool: 'graph_search',
    title: query,
    outputPreview: truncate(summarizeQuery(result)),
    durationMs: Date.now() - startMs,
  };
}
