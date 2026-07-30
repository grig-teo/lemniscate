/** Shared types for the lemcore codebase-graph adapter. */

export type GraphSource = 'code-review-graph' | 'fallback' | 'none';

export type GraphNodeKind =
  | 'file'
  | 'function'
  | 'class'
  | 'module'
  | 'type'
  | 'test'
  | 'unknown';

export type GraphEdgeKind =
  | 'imports'
  | 'calls'
  | 'contains'
  | 'inherits'
  | 'references'
  | 'depends_on'
  | 'unknown';

export interface GraphNode {
  id: string;
  name: string;
  kind: GraphNodeKind;
  filePath?: string;
  detail?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
}

export interface GraphStats {
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  /** Rough prompt-token estimate of the compact summary. */
  summaryTokens: number;
  /** Rough prompt-token estimate if raw key files were dumped instead. */
  rawDumpTokens: number;
}

export interface GraphNeighborhood {
  center: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  files: string[];
}

export interface GraphQueryResult {
  pattern: string;
  target: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  detail: string;
}

export interface LemcoreCodebaseGraph {
  source: GraphSource;
  ready: boolean;
  builtAt: string;
  repoRoot: string;
  /** Optional on-disk cache directory (outside the clone). */
  dataDir?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  files: string[];
  /** Compact architecture / status text from the tool, when available. */
  architectureText?: string;
  /** Max hop depth used when expanding neighborhoods (session default). */
  maxDepth?: number;
  error?: string;
  stats: GraphStats;
}

export interface BuildGraphOptions {
  repoRoot: string;
  /** Sibling cache dir; defaults to `<repoRoot>.lemcore-graph-data`. */
  dataDir?: string;
  enabled?: boolean;
  /** Max seconds for the external CLI build. */
  timeoutMs?: number;
  /** Override binary name/path (default: code-review-graph). */
  cliPath?: string;
  /** Max hop depth used when expanding neighborhoods. */
  maxDepth?: number;
  /** Injected runner for tests. */
  runCli?: CliRunner;
}

export interface CliRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
}

export type CliRunner = (
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<CliRunResult>;

export interface GraphSession {
  graph: LemcoreCodebaseGraph;
  maxDepth: number;
}
