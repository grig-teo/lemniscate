// Lemcore-only codebase graph facade (code-review-graph integration).
// Other agents must not import this module.

export { buildLemcoreCodebaseGraph, defaultGraphDataDir } from './build.js';
export {
  DEFAULT_BUILD_TIMEOUT_MS,
  DEFAULT_CLI,
  DEFAULT_QUERY_TIMEOUT_MS,
  defaultCliRunner,
} from './cli.js';
export { buildFallbackGraph } from './fallback-scan.js';
export {
  impactGraph,
  neighborsOf,
  queryGraph,
  searchGraph,
} from './query.js';
export {
  clearGraphSession,
  getGraphSession,
  graphSessionKey,
  resetGraphSessions,
  storeGraphSession,
} from './session.js';
export {
  estimateContextTokens,
  summarizeGraph,
  summarizeNeighborhood,
  summarizeQuery,
  tokenSavings,
} from './summary.js';
export type {
  BuildGraphOptions,
  CliRunResult,
  CliRunner,
  GraphEdge,
  GraphEdgeKind,
  GraphNeighborhood,
  GraphNode,
  GraphNodeKind,
  GraphQueryResult,
  GraphSession,
  GraphSource,
  GraphStats,
  LemcoreCodebaseGraph,
} from './types.js';
