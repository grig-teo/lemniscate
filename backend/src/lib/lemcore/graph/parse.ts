// Parse code-review-graph CLI JSON into our graph model.
// Status --json (v2.3.7) is counts-only; path lists come from export/tools.

import type {
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphNodeKind,
  GraphQueryResult,
  GraphStats,
} from './types.js';

/** Real `status --json` payload shape from code-review-graph v2.3.7. */
export interface CrgStatusJson {
  nodes: number;
  edges: number;
  files: number;
  languages?: string[];
  last_updated?: string | null;
  vcs?: string | null;
  built_on_branch?: string | null;
  built_at_commit?: string | null;
  current_branch?: string | null;
  current_sha?: string | null;
}

export function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    const aStart = trimmed.indexOf('[');
    const aEnd = trimmed.lastIndexOf(']');
    if (aStart >= 0 && aEnd > aStart) {
      try {
        return JSON.parse(trimmed.slice(aStart, aEnd + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Parse status --json. `files`/`nodes`/`edges` are numeric counts upstream.
 * Path lists must come from export or tool payloads, not status.
 */
export function statsFromStatus(raw: unknown, files: string[]): GraphStats {
  const obj = asRecord(raw) ?? {};
  const fileCount =
    num(obj.files) ??
    num(obj.file_count) ??
    num(obj.fileCount) ??
    num(obj.files_count) ??
    files.length;
  const nodeCount =
    num(obj.nodes) ?? num(obj.node_count) ?? num(obj.nodeCount) ?? files.length;
  const edgeCount =
    num(obj.edges) ?? num(obj.edge_count) ?? num(obj.edgeCount) ?? 0;
  return {
    fileCount,
    nodeCount,
    edgeCount,
    summaryTokens: 0,
    rawDumpTokens: Math.max(fileCount * 400, 4_000),
  };
}

/** Load nodes/edges/files from `visualize --format json` export payload. */
export function graphPartsFromExport(raw: unknown): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  files: string[];
} {
  const obj = asRecord(raw);
  if (!obj) return { nodes: [], edges: [], files: [] };
  const nodes = nodesFromUnknown(obj.nodes ?? obj);
  const edges = edgesFromUnknown(obj.edges ?? obj);
  const files = unique([
    ...filesFromUnknown(obj),
    ...nodes
      .map((n) => n.filePath)
      .filter((v): v is string => typeof v === 'string' && v.length > 0),
  ]);
  return { nodes, edges, files };
}

export function nodesFromUnknown(raw: unknown): GraphNode[] {
  if (Array.isArray(raw)) return raw.flatMap((item) => nodeFromUnknown(item) ?? []);
  const obj = asRecord(raw);
  if (!obj) return [];
  for (const key of [
    'nodes',
    'results',
    'items',
    'matches',
    'entities',
    'changed_nodes',
    'impacted_nodes',
  ]) {
    if (Array.isArray(obj[key])) return nodesFromUnknown(obj[key]);
  }
  const single = nodeFromUnknown(obj);
  return single ? [single] : [];
}

export function edgesFromUnknown(raw: unknown): GraphEdge[] {
  if (Array.isArray(raw)) return raw.flatMap((item) => edgeFromUnknown(item) ?? []);
  const obj = asRecord(raw);
  if (!obj) return [];
  for (const key of ['edges', 'relations', 'links']) {
    if (Array.isArray(obj[key])) return edgesFromUnknown(obj[key]);
  }
  return [];
}

/**
 * Extract path lists from tool/export payloads.
 * Ignores numeric `files` counts from status --json.
 */
export function filesFromUnknown(raw: unknown): string[] {
  const obj = asRecord(raw);
  if (!obj) return [];
  const out: string[] = [];
  for (const key of [
    'files',
    'file_paths',
    'paths',
    'changed_files',
    'impacted_files',
  ]) {
    const val = obj[key];
    if (typeof val === 'number') continue; // status --json count
    if (!Array.isArray(val)) continue;
    for (const v of val) {
      if (typeof v === 'string' && v.length > 0) out.push(v);
      else {
        const p = asRecord(v)?.path ?? asRecord(v)?.file_path;
        if (typeof p === 'string' && p.length > 0) out.push(p);
      }
    }
  }
  const nodes = nodesFromUnknown(raw);
  for (const n of nodes) {
    if (n.filePath) out.push(n.filePath);
  }
  return unique(out);
}

export function queryResultFromUnknown(
  pattern: string,
  target: string,
  raw: unknown,
  stdout: string,
): GraphQueryResult {
  const nodes = nodesFromUnknown(raw);
  const edges = edgesFromUnknown(raw);
  const detail =
    typeof asRecord(raw)?.summary === 'string'
      ? String(asRecord(raw)!.summary)
      : compactJson(raw) || stdout.trim().slice(0, 4_000);
  return { pattern, target, nodes, edges, detail };
}

export function architectureTextFromUnknown(raw: unknown, stdout: string): string {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  const obj = asRecord(raw);
  if (obj) {
    for (const key of ['overview', 'summary', 'text', 'architecture']) {
      if (typeof obj[key] === 'string' && String(obj[key]).trim()) {
        return String(obj[key]).trim();
      }
    }
    const pretty = compactJson(obj);
    if (pretty) return pretty;
  }
  return stdout.trim().slice(0, 6_000);
}

function nodeFromUnknown(raw: unknown): GraphNode | null {
  if (typeof raw === 'string' && raw.trim()) {
    return {
      id: raw,
      name: raw,
      kind: guessKind(raw),
      filePath: looksLikePath(raw) ? raw : undefined,
    };
  }
  const obj = asRecord(raw);
  if (!obj) return null;
  const name = str(
    obj.name ?? obj.qualified_name ?? obj.qualifiedName ?? obj.id ?? obj.path,
  );
  if (!name) return null;
  const filePath = str(obj.file ?? obj.file_path ?? obj.filePath ?? obj.path);
  const kind = normalizeNodeKind(
    str(obj.kind ?? obj.type ?? obj.node_type) ?? filePath ?? name,
  );
  const id =
    str(obj.qualified_name ?? obj.qualifiedName ?? obj.id) ??
    (filePath ? `file:${filePath}` : `${kind}:${name}`);
  return {
    id,
    name,
    kind,
    filePath: filePath && looksLikePath(filePath) ? filePath : undefined,
    detail: str(obj.signature ?? obj.detail ?? obj.summary),
  };
}

function edgeFromUnknown(raw: unknown): GraphEdge | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const from = str(obj.from ?? obj.source ?? obj.src ?? obj.caller ?? obj.importer);
  const to = str(obj.to ?? obj.target ?? obj.dst ?? obj.callee ?? obj.imported);
  if (!from || !to) return null;
  return {
    from,
    to,
    kind: normalizeEdgeKind(str(obj.kind ?? obj.type ?? obj.edge_type) ?? 'unknown'),
  };
}

function normalizeNodeKind(raw: string): GraphNodeKind {
  const v = raw.toLowerCase();
  if (v.includes('file') || looksLikePath(raw)) return 'file';
  if (v.includes('func') || v.includes('method')) return 'function';
  if (v.includes('class')) return 'class';
  if (v.includes('mod')) return 'module';
  if (v.includes('type') || v.includes('interface')) return 'type';
  if (v.includes('test')) return 'test';
  return 'unknown';
}

function normalizeEdgeKind(raw: string): GraphEdgeKind {
  const v = raw.toLowerCase();
  if (v.includes('import')) return 'imports';
  if (v.includes('call')) return 'calls';
  if (v.includes('contain')) return 'contains';
  if (v.includes('inherit') || v.includes('extend') || v.includes('implement')) {
    return 'inherits';
  }
  if (v.includes('ref')) return 'references';
  if (v.includes('depend')) return 'depends_on';
  return 'unknown';
}

function guessKind(name: string): GraphNodeKind {
  return looksLikePath(name) ? 'file' : 'unknown';
}

function looksLikePath(s: string): boolean {
  return s.includes('/') || /\.\w{1,8}$/.test(s);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function compactJson(raw: unknown): string {
  if (raw == null) return '';
  try {
    return JSON.stringify(raw, null, 2).slice(0, 6_000);
  } catch {
    return '';
  }
}
