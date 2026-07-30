// Lightweight structural scan used when code-review-graph is unavailable.
// Produces a queryable file/import graph so lemcore still gets compact context.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GraphEdge, GraphNode, LemcoreCodebaseGraph } from './types.js';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  '.code-review-graph',
]);

const SOURCE_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
]);

const MAX_FILES = 800;
const MAX_FILE_BYTES = 200_000;
const IMPORT_RE =
  /(?:import\s+(?:type\s+)?(?:[\w*{}\s,]+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"])/g;

export async function buildFallbackGraph(repoRoot: string): Promise<LemcoreCodebaseGraph> {
  const files = await listSourceFiles(repoRoot);
  const nodes: GraphNode[] = files.map((f) => ({
    id: `file:${f}`,
    name: f,
    kind: 'file' as const,
    filePath: f,
  }));
  const edges: GraphEdge[] = [];
  const byPath = new Map(files.map((f) => [f, true] as const));

  for (const rel of files) {
    const imports = await readImports(path.join(repoRoot, rel));
    for (const spec of imports) {
      const resolved = resolveImport(rel, spec, byPath);
      if (!resolved) continue;
      edges.push({
        from: `file:${rel}`,
        to: `file:${resolved}`,
        kind: 'imports',
      });
    }
  }

  const summaryTokens = estimateTokens(compactFallbackSummary(files, edges));
  return {
    source: 'fallback',
    ready: true,
    builtAt: new Date().toISOString(),
    repoRoot,
    nodes,
    edges,
    files,
    stats: {
      fileCount: files.length,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      summaryTokens,
      rawDumpTokens: Math.max(summaryTokens * 8, files.length * 200),
    },
  };
}

export function compactFallbackSummary(files: string[], edges: GraphEdge[]): string {
  const top = files.slice(0, 80).join('\n');
  const edgeLines = edges
    .slice(0, 60)
    .map((e) => `${stripFile(e.from)} -> ${stripFile(e.to)}`)
    .join('\n');
  return [
    `## Codebase graph (fallback structural scan)`,
    `files: ${files.length}, import edges: ${edges.length}`,
    '',
    '### Files (sample)',
    top || '(none)',
    '',
    '### Import edges (sample)',
    edgeLines || '(none)',
  ].join('\n');
}

function stripFile(id: string): string {
  return id.startsWith('file:') ? id.slice(5) : id;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function listSourceFiles(repoRoot: string): Promise<string[]> {
  const out: string[] = [];
  await walk(repoRoot, '', out);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function walk(dir: string, rel: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let items: import('node:fs').Dirent[];
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  for (const item of items) {
    if (out.length >= MAX_FILES) return;
    if (item.name.startsWith('.') && item.name !== '.env.example') {
      if (item.isDirectory()) continue;
    }
    const childRel = rel ? `${rel}/${item.name}` : item.name;
    if (item.isDirectory()) {
      if (SKIP_DIRS.has(item.name)) continue;
      await walk(path.join(dir, item.name), childRel, out);
      continue;
    }
    if (!item.isFile()) continue;
    if (!SOURCE_EXT.has(path.extname(item.name).toLowerCase())) continue;
    out.push(childRel);
  }
}

async function readImports(absPath: string): Promise<string[]> {
  try {
    const stat = await fs.stat(absPath);
    if (stat.size > MAX_FILE_BYTES) return [];
    const text = await fs.readFile(absPath, 'utf8');
    const found: string[] = [];
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (spec) found.push(spec);
    }
    return found;
  } catch {
    return [];
  }
}

function resolveImport(
  fromFile: string,
  spec: string,
  byPath: Map<string, true>,
): string | null {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const fromDir = path.posix.dirname(fromFile);
  const joined = path.posix.normalize(
    spec.startsWith('/') ? spec.slice(1) : path.posix.join(fromDir, spec),
  );
  const candidates = [
    joined,
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}.js`,
    `${joined}.jsx`,
    `${joined}.mjs`,
    `${joined}.cjs`,
    `${joined}/index.ts`,
    `${joined}/index.js`,
    `${joined}.py`,
    `${joined}/__init__.py`,
  ];
  for (const c of candidates) {
    if (byPath.has(c)) return c;
  }
  return null;
}
