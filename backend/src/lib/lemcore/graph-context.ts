// Implementation context assembly for lemcore: prefer graph-derived slices
// over bulk raw codebase dumps to minimize LLM tokens.

import {
  getGraphSession,
  summarizeGraph,
  summarizeNeighborhood,
  tokenSavings,
  type LemcoreCodebaseGraph,
} from './graph/index.js';
import { neighborsOf } from './graph/query.js';

export interface LemcoreImplContext {
  text: string;
  usedGraph: boolean;
  summaryTokens: number;
  rawDumpTokens: number;
  savedRatio: number;
  source: LemcoreCodebaseGraph['source'] | 'none';
}

/**
 * Build the compact implementation context injected into the lemcore prompt.
 * When a scan-session graph exists, serialize its summary (+ optional task
 * neighborhood) instead of shipping large raw corpora.
 */
export function buildLemcoreImplContext(
  workdir: string,
  taskHint?: string,
): LemcoreImplContext {
  const session = getGraphSession(workdir);
  if (!session || !session.graph.ready) {
    return {
      text: [
        '## Codebase graph',
        'No graph is available for this scan session.',
        'Use selective read_file / grep / glob; do not dump the whole repository into context.',
      ].join('\n'),
      usedGraph: false,
      summaryTokens: 40,
      rawDumpTokens: 40,
      savedRatio: 0,
      source: session?.graph.source ?? 'none',
    };
  }

  const graph = session.graph;
  const parts = [summarizeGraph(graph)];

  if (taskHint?.trim()) {
    const seeds = seedFilesFromHint(graph, taskHint);
    if (seeds.length > 0) {
      const hood = neighborsOf(graph, seeds[0]!, session.maxDepth);
      // Merge extra seed files into the neighborhood file list for the prompt.
      const extra = seeds.slice(1).filter((f) => !hood.files.includes(f));
      hood.files = [...hood.files, ...extra].slice(0, 40);
      parts.push('', summarizeNeighborhood(hood));
    }
  }

  const text = parts.join('\n');
  const savings = tokenSavings(graph, text);
  return {
    text,
    usedGraph: true,
    summaryTokens: savings.summaryTokens,
    rawDumpTokens: savings.rawDumpTokens,
    savedRatio: savings.savedRatio,
    source: graph.source,
  };
}

/** Paths mentioned in the task that exist in the graph file list. */
export function seedFilesFromHint(
  graph: LemcoreCodebaseGraph,
  hint: string,
): string[] {
  const hits: string[] = [];
  for (const f of graph.files) {
    if (hint.includes(f)) hits.push(f);
  }
  // Also match bare basenames when unique enough.
  if (hits.length === 0) {
    const tokens = hint.match(/[\w./-]+\.\w{1,8}/g) ?? [];
    for (const tok of tokens) {
      const matches = graph.files.filter(
        (f) => f === tok || f.endsWith(`/${tok}`) || f.endsWith(tok),
      );
      hits.push(...matches);
    }
  }
  return [...new Set(hits)].slice(0, 12);
}
