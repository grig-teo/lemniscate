// Query helpers over a built lemcore graph session.
// Uses the external CLI when the graph came from code-review-graph; otherwise
// answers from the in-memory fallback edges.

import {
  DEFAULT_CLI,
  DEFAULT_QUERY_TIMEOUT_MS,
  defaultCliRunner,
  runGraphImpact,
  runGraphQuery,
  runGraphSearch,
} from './cli.js';
import {
  edgesFromUnknown,
  filesFromUnknown,
  nodesFromUnknown,
  queryResultFromUnknown,
  tryParseJson,
} from './parse.js';
import type {
  CliRunner,
  GraphEdge,
  GraphNeighborhood,
  GraphNode,
  GraphQueryResult,
  GraphSession,
  LemcoreCodebaseGraph,
} from './types.js';

/** Map aliases to upstream `query` CLI choices (v2.3.7). */
export function normalizeQueryPattern(pattern: string): string {
  const p = pattern.trim();
  if (p === 'references_to') return 'callers_of';
  return p;
}

export async function queryGraph(
  session: GraphSession,
  pattern: string,
  target: string,
  runCli?: CliRunner,
): Promise<GraphQueryResult> {
  const graph = session.graph;
  const cliPattern = normalizeQueryPattern(pattern);
  if (graph.source === 'code-review-graph' && graph.dataDir) {
    const run = runCli ?? defaultCliRunner(DEFAULT_CLI);
    const res = await runGraphQuery(
      run,
      graph.repoRoot,
      graph.dataDir,
      cliPattern,
      target,
      DEFAULT_QUERY_TIMEOUT_MS,
    );
    if (res.ok) {
      return queryResultFromUnknown(
        pattern,
        target,
        tryParseJson(res.stdout),
        res.stdout,
      );
    }
  }
  return localQuery(graph, pattern, target);
}

export async function impactGraph(
  session: GraphSession,
  files: string[],
  runCli?: CliRunner,
): Promise<GraphNeighborhood> {
  const graph = session.graph;
  const depth = session.maxDepth;
  if (graph.source === 'code-review-graph' && graph.dataDir && files.length > 0) {
    const run = runCli ?? defaultCliRunner(DEFAULT_CLI);
    const res = await runGraphImpact(
      run,
      graph.repoRoot,
      graph.dataDir,
      files,
      depth,
      DEFAULT_QUERY_TIMEOUT_MS,
    );
    if (res.ok) {
      const raw = tryParseJson(res.stdout);
      return {
        center: files.join(', '),
        nodes: nodesFromUnknown(raw),
        edges: edgesFromUnknown(raw),
        files: unique([...files, ...filesFromUnknown(raw)]),
      };
    }
  }
  return localNeighborhood(graph, files[0] ?? '', depth);
}

export async function searchGraph(
  session: GraphSession,
  query: string,
  runCli?: CliRunner,
): Promise<GraphQueryResult> {
  const graph = session.graph;
  if (graph.source === 'code-review-graph' && graph.dataDir) {
    const run = runCli ?? defaultCliRunner(DEFAULT_CLI);
    const res = await runGraphSearch(
      run,
      graph.repoRoot,
      graph.dataDir,
      query,
      DEFAULT_QUERY_TIMEOUT_MS,
    );
    if (res.ok) {
      return queryResultFromUnknown('search', query, tryParseJson(res.stdout), res.stdout);
    }
  }
  const q = query.toLowerCase();
  const nodes = graph.nodes.filter(
    (n) =>
      n.name.toLowerCase().includes(q) ||
      (n.filePath?.toLowerCase().includes(q) ?? false),
  );
  return {
    pattern: 'search',
    target: query,
    nodes,
    edges: [],
    detail: `local search: ${nodes.length} match(es)`,
  };
}

export function neighborsOf(
  graph: LemcoreCodebaseGraph,
  center: string,
  maxDepth = 2,
): GraphNeighborhood {
  return localNeighborhood(graph, center, maxDepth);
}

function localQuery(
  graph: LemcoreCodebaseGraph,
  pattern: string,
  target: string,
): GraphQueryResult {
  const targetIds = matchIds(graph, target);
  const edges = graph.edges.filter((e) => {
    if (pattern === 'callers_of' || pattern === 'importers_of' || pattern === 'references_to') {
      return targetIds.has(e.to) || e.to.includes(target);
    }
    if (pattern === 'callees_of' || pattern === 'imports_of' || pattern === 'children_of') {
      return targetIds.has(e.from) || e.from.includes(target);
    }
    return e.from.includes(target) || e.to.includes(target);
  });
  const nodeIds = new Set<string>();
  for (const e of edges) {
    nodeIds.add(e.from);
    nodeIds.add(e.to);
  }
  for (const id of targetIds) nodeIds.add(id);
  const nodes = graph.nodes.filter((n) => nodeIds.has(n.id) || n.name.includes(target));
  return {
    pattern,
    target,
    nodes,
    edges,
    detail: `local ${pattern}: ${nodes.length} node(s), ${edges.length} edge(s)`,
  };
}

function localNeighborhood(
  graph: LemcoreCodebaseGraph,
  center: string,
  maxDepth: number,
): GraphNeighborhood {
  const startIds = matchIds(graph, center);
  if (startIds.size === 0 && center) startIds.add(center);
  const seen = new Set<string>(startIds);
  let frontier = [...startIds];
  const edgeSet: GraphEdge[] = [];

  for (let depth = 0; depth < maxDepth; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of graph.edges) {
        if (e.from === id || e.from.includes(id) || id.includes(e.from)) {
          edgeSet.push(e);
          if (!seen.has(e.to)) {
            seen.add(e.to);
            next.push(e.to);
          }
        }
        if (e.to === id || e.to.includes(id) || id.includes(e.to)) {
          edgeSet.push(e);
          if (!seen.has(e.from)) {
            seen.add(e.from);
            next.push(e.from);
          }
        }
      }
    }
    frontier = next;
  }

  const nodes: GraphNode[] = graph.nodes.filter(
    (n) => seen.has(n.id) || [...seen].some((s) => n.id.includes(s) || n.name.includes(s)),
  );
  const files = unique([
    ...nodes.map((n) => n.filePath).filter((f): f is string => Boolean(f)),
    ...[...seen].filter((s) => s.includes('/') || s.startsWith('file:')).map((s) =>
      s.startsWith('file:') ? s.slice(5) : s,
    ),
  ]);
  return { center, nodes, edges: dedupeEdges(edgeSet), files };
}

function matchIds(graph: LemcoreCodebaseGraph, target: string): Set<string> {
  const ids = new Set<string>();
  if (!target) return ids;
  for (const n of graph.nodes) {
    if (n.id === target || n.name === target || n.filePath === target) ids.add(n.id);
    if (n.id.includes(target) || n.name.includes(target)) ids.add(n.id);
  }
  if (graph.files.includes(target)) ids.add(`file:${target}`);
  return ids;
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const out: GraphEdge[] = [];
  for (const e of edges) {
    const key = `${e.from}|${e.kind}|${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
