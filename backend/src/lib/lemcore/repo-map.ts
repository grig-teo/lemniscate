// Compact PageRank-ranked repo map (Aider "repomap" pattern): a stable,
// always-available structural overview of the codebase injected per turn so
// the model knows what's defined where without bulk-reading files. Ranks
// files by import-graph centrality (PageRank) and lists their key symbols.
//
// Pure functions over the existing fallback graph — no tree-sitter dependency
// (symbol extraction is regex-based, matching the existing regex import scan
// in fallback-scan.ts). The map is deterministic for a given graph, so it
// doesn't invalidate the provider's prefix cache.

const MAX_MAP_FILES = 40;
const MAX_MAP_CHARS = 2_000;
const MAX_SYMBOLS_PER_FILE = 6;

// Patterns for top-level definition extraction by language. Intentionally
// regex (not AST): we need speed over perfect accuracy for a navigation map,
// and this mirrors the import-extraction approach in fallback-scan.ts.
const SYMBOL_PATTERNS: { exts: string[]; re: RegExp }[] = [
  // TS / JS: function NAME, class NAME, const NAME = (arrow/expr)
  {
    exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    re: /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)|\bclass\s+(\w+)|\b(?:export\s+)?const\s+(\w+)\s*=/g,
  },
  // Python: def NAME, class NAME (incl. methods — indented def)
  { exts: ['.py'], re: /^\s*(?:async\s+)?def\s+(\w+)|^\s*class\s+(\w+)/gm },
  // Go: func NAME and func (recv) NAME
  { exts: ['.go'], re: /\bfunc\s+(?:\([^)]*\)\s*)?(\w+)/g },
  // Rust: fn NAME, struct NAME, enum NAME, impl NAME
  { exts: ['.rs'], re: /\bfn\s+(\w+)|\bstruct\s+(\w+)|\benum\s+(\w+)/g },
  // Ruby: def NAME, class NAME
  { exts: ['.rb'], re: /^\s*def\s+(?:self\.)?(\w+)|^\s*class\s+(\w+)/gm },
];

/** Extract top-level symbol names (functions, classes) from a source file. */
export function extractSymbols(filePath: string, text: string): string[] {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const pattern = SYMBOL_PATTERNS.find((p) => p.exts.includes(ext));
  if (!pattern) return [];
  const names = new Set<string>();
  for (const match of text.matchAll(pattern.re)) {
    // The capture group index varies by pattern; take the first defined group.
    const name = match.slice(1).find((g) => g);
    if (name && /^[A-Za-z_]\w*$/.test(name)) names.add(name);
  }
  return [...names].sort().slice(0, 25);
}

/**
 * PageRank via power iteration over a directed graph. Returns a Map of
 * node-id → score (sums to ~1). Pure and deterministic. Used to rank files
 * by import-graph centrality so the most-referenced files appear first in
 * the map.
 */
export function pageRank(
  ids: string[],
  edges: { from: string; to: string }[],
  iterations = 20,
  damping = 0.85,
): Map<string, number> {
  if (ids.length === 0) return new Map();
  const n = ids.length;
  const outLinks = new Map<string, string[]>();
  for (const id of ids) outLinks.set(id, []);
  for (const e of edges) {
    if (outLinks.has(e.from) && ids.includes(e.to)) outLinks.get(e.from)!.push(e.to);
  }
  let scores = new Map<string, number>(ids.map((id) => [id, 1 / n]));
  for (let _ = 0; _ < iterations; _++) {
    const next = new Map<string, number>();
    for (const id of ids) next.set(id, (1 - damping) / n);
    for (const id of ids) {
      const links = outLinks.get(id) ?? [];
      const share = links.length > 0 ? (damping * (scores.get(id) ?? 0)) / links.length : 0;
      for (const target of links) next.set(target, (next.get(target) ?? 0) + share);
      // Distribute the rank of dangling nodes (no out-links) evenly.
      if (links.length === 0) {
        const dangle = (damping * (scores.get(id) ?? 0)) / n;
        for (const other of ids) next.set(other, (next.get(other) ?? 0) + dangle);
      }
    }
    scores = next;
  }
  return scores;
}

export interface RepoMapOptions {
  /** Pre-extracted symbols per file path (from extractSymbols). */
  fileSymbols?: Map<string, string[]>;
  /** Max files to include (default 40). */
  maxFiles?: number;
  /** Max total chars (default 2000). */
  maxChars?: number;
}

/** Build the compact repo-map string from a codebase graph. */
export function buildRepoMap(
  graph: { files: string[]; edges: { from: string; to: string; kind?: string }[] },
  opts: RepoMapOptions = {},
): string {
  if (graph.files.length === 0) return '';
  const maxFiles = opts.maxFiles ?? MAX_MAP_FILES;
  const maxChars = opts.maxChars ?? MAX_MAP_CHARS;
  const fileIds = graph.files.map((f) => `file:${f}`);
  const importEdges = graph.edges
    .filter((e) => e.kind === 'imports')
    .map((e) => ({ from: e.from, to: e.to }));
  const ranks = pageRank(fileIds, importEdges);
  // Strip the 'file:' prefix back to repo-relative paths for display.
  const rankedFiles = graph.files
    .map((f) => ({ file: f, score: ranks.get(`file:${f}`) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, maxFiles);

  const lines: string[] = ['Repo map (PageRank-ranked, top files + key symbols):'];
  let total = lines.join('\n').length;
  for (const { file } of rankedFiles) {
    const syms = (opts.fileSymbols?.get(file) ?? []).slice(0, MAX_SYMBOLS_PER_FILE);
    const line = syms.length > 0 ? `- ${file} → ${syms.join(', ')}` : `- ${file}`;
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join('\n');
}
