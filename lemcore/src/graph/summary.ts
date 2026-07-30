// Compact LLM-facing serialization of a codebase graph.
// Prefer this over bulk raw-file dumps during lemcore implementation.

import { compactFallbackSummary } from './fallback-scan.js';
import type {
  GraphEdge,
  GraphNeighborhood,
  GraphQueryResult,
  LemcoreCodebaseGraph,
} from './types.js';

const MAX_SUMMARY_CHARS = 12_000;
const MAX_FILE_LINES = 100;
const MAX_EDGE_LINES = 80;

export function summarizeGraph(graph: LemcoreCodebaseGraph): string {
  if (!graph.ready) {
    return [
      '## Codebase graph',
      `status: unavailable (${graph.error ?? 'not built'})`,
      'Fall back to selective file reads; avoid dumping the whole repository.',
    ].join('\n');
  }

  if (graph.source === 'fallback') {
    return truncate(
      compactFallbackSummary(
        graph.files,
        graph.edges.filter((e) => e.kind === 'imports'),
      ),
    );
  }

  const parts: string[] = [
    '## Codebase graph (code-review-graph)',
    `source: ${graph.source}`,
    `files: ${graph.stats.fileCount}, nodes: ${graph.stats.nodeCount}, edges: ${graph.stats.edgeCount}`,
    `token estimate: summary ~${graph.stats.summaryTokens} vs raw dump ~${graph.stats.rawDumpTokens}`,
    '',
    'Prefer graph_query / graph_impact / graph_neighbors tools before bulk read_file.',
  ];

  if (graph.architectureText?.trim()) {
    parts.push('', '### Architecture', graph.architectureText.trim());
  }

  const fileSample = graph.files.slice(0, MAX_FILE_LINES);
  if (fileSample.length > 0) {
    parts.push('', '### Files (sample)', fileSample.join('\n'));
  }

  const edgeSample = formatEdges(graph.edges, MAX_EDGE_LINES);
  if (edgeSample) {
    parts.push('', '### Edges (sample)', edgeSample);
  }

  return truncate(parts.join('\n'));
}

export function summarizeNeighborhood(n: GraphNeighborhood): string {
  const lines = [
    `## Graph neighborhood: ${n.center}`,
    `files: ${n.files.length}, nodes: ${n.nodes.length}, edges: ${n.edges.length}`,
    '',
    '### Files',
    n.files.slice(0, 40).join('\n') || '(none)',
    '',
    '### Nodes',
    ...n.nodes.slice(0, 40).map((node) => `- [${node.kind}] ${node.name}${node.filePath ? ` @ ${node.filePath}` : ''}`),
    '',
    '### Edges',
    formatEdges(n.edges, 40) || '(none)',
  ];
  return truncate(lines.join('\n'), 6_000);
}

export function summarizeQuery(result: GraphQueryResult): string {
  const lines = [
    `## Graph query ${result.pattern}(${result.target})`,
    result.detail.slice(0, 3_000),
  ];
  if (result.nodes.length > 0) {
    lines.push(
      '',
      '### Nodes',
      ...result.nodes
        .slice(0, 30)
        .map((n) => `- [${n.kind}] ${n.name}${n.filePath ? ` @ ${n.filePath}` : ''}`),
    );
  }
  if (result.edges.length > 0) {
    lines.push('', '### Edges', formatEdges(result.edges, 30) || '(none)');
  }
  return truncate(lines.join('\n'), 6_000);
}

export function estimateContextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function tokenSavings(graph: LemcoreCodebaseGraph, summaryText: string): {
  summaryTokens: number;
  rawDumpTokens: number;
  savedTokens: number;
  savedRatio: number;
} {
  const summaryTokens = estimateContextTokens(summaryText);
  const rawDumpTokens = Math.max(graph.stats.rawDumpTokens, summaryTokens);
  const savedTokens = Math.max(0, rawDumpTokens - summaryTokens);
  const savedRatio = rawDumpTokens === 0 ? 0 : savedTokens / rawDumpTokens;
  return { summaryTokens, rawDumpTokens, savedTokens, savedRatio };
}

function formatEdges(edges: GraphEdge[], limit: number): string {
  return edges
    .slice(0, limit)
    .map((e) => `${e.from} -[${e.kind}]-> ${e.to}`)
    .join('\n');
}

function truncate(text: string, max = MAX_SUMMARY_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated graph summary at ${max} chars]`;
}
