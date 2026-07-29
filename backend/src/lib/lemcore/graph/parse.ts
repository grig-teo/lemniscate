// Parse code-review-graph CLI JSON into our graph model. Defensive: the
// upstream schema is not version-pinned, so we accept several shapes.

import type {
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphNodeKind,
  GraphQueryResult,
  GraphStats,
} from './types.js';

export function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some CLIs print banners before JSON — try the last {...} block.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
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

export function statsFromStatus(raw: unknown, files: string[]): GraphStats {
  const obj = asRecord(raw) ?? {};
  const fileCount = num(obj.files ?? obj.file_count ?? obj.fileCount) ?? files.length;
  const nodeCount = num(obj.nodes ?? obj.node_count ?? obj.nodeCount) ?? fileCount;
  const edgeCount = num(obj.edges ?? obj.edge_count ?? obj.edgeCount) ?? 0;
  return {
    fileCount,
    nodeCount,
    edgeCount,
    summaryTokens: 0,
    rawDumpTokens: Math.max(fileCount * 400, 4_000),
  };
}

export function nodesFromUnknown(raw: unknown): GraphNode[] {
  if (Array.isArray(raw)) return raw.flatMap((item) => nodeFromUnknown(item) ?? []);
  const obj = asRecord(raw);
  if (!obj) return [];
  for (const key of ['nodes', 'results', 'items', 'matches', 'entities']) {
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

export function filesFromUnknown(raw: unknown): string[] {
  const obj = asRecord(raw);
  if (!obj) return [];
  for (const key of ['files', 'file_paths', 'paths', 'changed_files']) {
    if (Array.isArray(obj[key])) {
      return obj[key]
        .map((v) => (typeof v === 'string' ? v : asRecord(v)?.path))
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
    }
  }
  const nodes = nodesFromUnknown(raw);
  const fromNodes = nodes
    .map((n) => n.filePath)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return unique(fromNodes);
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
      if (typeof obj[key] === 'string' && obj[key].trim()) return String(obj[key]).trim();
    }
    const pretty = compactJson(obj);
    if (pretty) return pretty;
  }
  return stdout.trim().slice(0, 6_000);
}

function nodeFromUnknown(raw: unknown): GraphNode | null {
  if (typeof raw === 'string' && raw.trim()) {
    return { id: raw, name: raw, kind: guessKind(raw), filePath: looksLikePath(raw) ? raw : undefined };
  }
  const obj = asRecord(raw);
  if (!obj) return null;
  const name = str(obj.name ?? obj.qualified_name ?? obj.qualifiedName ?? obj.id ?? obj.path);
  if (!name) return null;
  const filePath = str(obj.file ?? obj.file_path ?? obj.filePath ?? obj.path);
  const kind = normalizeNodeKind(str(obj.kind ?? obj.type ?? obj.node_type) ?? filePath ?? name);
  const id = str(obj.id) ?? (filePath ? `file:${filePath}` : `${kind}:${name}`);
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
  if (v.includes('inherit') || v.includes('extend') || v.includes('implement')) return 'inherits';
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
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
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
