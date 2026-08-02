import { describe, expect, it } from 'vitest';

import {
  extractSymbols,
  pageRank,
  buildRepoMap,
} from '../src/lib/lemcore/repo-map.js';
import type { LemcoreCodebaseGraph } from '../src/lib/lemcore/graph/types.js';

describe('extractSymbols', () => {
  it('extracts TS function, class, and const definitions', () => {
    const syms = extractSymbols('src/a.ts', [
      'export function foo() {}',
      'class Bar {}',
      'const baz = () => {}',
      'export type Q = number;',
    ].join('\n'));
    expect(syms).toContain('foo');
    expect(syms).toContain('Bar');
    expect(syms).toContain('baz');
    // type aliases are excluded — they're structural, not navigable targets.
    expect(syms).not.toContain('Q');
  });

  it('extracts Python def and class definitions', () => {
    const syms = extractSymbols('src/app.py', [
      'def handler(event):',
      'class App:',
      '    def run(self):',
    ].join('\n'));
    expect(syms).toContain('handler');
    expect(syms).toContain('App');
    expect(syms).toContain('run');
  });

  it('extracts Go func definitions', () => {
    const syms = extractSymbols('main.go', [
      'func main() {}',
      'func (s *Server) Start() {}',
    ].join('\n'));
    expect(syms).toContain('main');
    expect(syms).toContain('Start');
  });

  it('returns an empty list for unsupported file types', () => {
    expect(extractSymbols('README.md', '# hello\nworld')).toEqual([]);
    expect(extractSymbols('config.json', '{"a":1}')).toEqual([]);
  });

  it('deduplicates symbols within a file', () => {
    const syms = extractSymbols('a.ts', 'function dup() {}\nfunction dup() {}');
    expect(syms.filter((s) => s === 'dup')).toHaveLength(1);
  });
});

describe('pageRank', () => {
  it('ranks the most-connected node highest in a diamond graph', () => {
    // a -> hub -> {c, d}; hub is the most central node.
    const edges = [
      { from: 'a', to: 'hub', kind: 'imports' as const },
      { from: 'hub', to: 'c', kind: 'imports' as const },
      { from: 'hub', to: 'd', kind: 'imports' as const },
    ];
    const ids = ['a', 'hub', 'c', 'd'];
    const ranks = pageRank(ids, edges, 30, 0.85);
    const ranked = [...ranks.entries()].sort((x, y) => y[1] - x[1]);
    expect(ranked[0]![0]).toBe('hub');
  });

  it('returns equal ranks for disconnected nodes', () => {
    const ranks = pageRank(['x', 'y'], [], 20, 0.85);
    expect(Math.abs(ranks.get('x')! - ranks.get('y')!)).toBeLessThan(0.01);
  });
});

describe('buildRepoMap', () => {
  it('produces a compact ranked map ordered by PageRank centrality', () => {
    const graph: LemcoreCodebaseGraph = {
      source: 'fallback',
      ready: true,
      builtAt: '2026-01-01',
      repoRoot: '/x',
      nodes: [
        { id: 'file:src/core.ts', name: 'src/core.ts', kind: 'file', filePath: 'src/core.ts' },
        { id: 'file:src/a.ts', name: 'src/a.ts', kind: 'file', filePath: 'src/a.ts' },
        { id: 'file:src/b.ts', name: 'src/b.ts', kind: 'file', filePath: 'src/b.ts' },
        { id: 'file:src/c.ts', name: 'src/c.ts', kind: 'file', filePath: 'src/c.ts' },
      ],
      // core is imported by a, b, AND c — highest in-degree, highest PageRank.
      edges: [
        { from: 'file:src/a.ts', to: 'file:src/core.ts', kind: 'imports' },
        { from: 'file:src/b.ts', to: 'file:src/core.ts', kind: 'imports' },
        { from: 'file:src/c.ts', to: 'file:src/core.ts', kind: 'imports' },
      ],
      files: ['src/core.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts'],
      stats: { fileCount: 4, nodeCount: 4, edgeCount: 3, summaryTokens: 40, rawDumpTokens: 400 },
    };

    const map = buildRepoMap(graph, {
      fileSymbols: new Map([
        ['src/core.ts', ['handleRequest', 'Router']],
        ['src/a.ts', ['renderA']],
        ['src/b.ts', ['renderB']],
        ['src/c.ts', ['renderC']],
      ]),
    });

    expect(map).toContain('Repo map');
    // core.ts has the highest PageRank (imported by 3 files) → appears first.
    const firstFileLine = map.split('\n').find((l) => l.startsWith('- ')) ?? '';
    expect(firstFileLine).toContain('src/core.ts');
    expect(map).toContain('handleRequest');
    expect(map).toContain('Router');
  });

  it('stays under a reasonable char budget', () => {
    const files = Array.from({ length: 100 }, (_, i) => `src/file${i}.ts`);
    const graph: LemcoreCodebaseGraph = {
      source: 'fallback',
      ready: true,
      builtAt: '2026-01-01',
      repoRoot: '/x',
      nodes: files.map((f) => ({ id: `file:${f}`, name: f, kind: 'file' as const, filePath: f })),
      edges: [],
      files,
      stats: { fileCount: files.length, nodeCount: files.length, edgeCount: 0, summaryTokens: 40, rawDumpTokens: 4000 },
    };
    const map = buildRepoMap(graph);
    expect(map.length).toBeLessThan(2_500);
  });

  it('returns an empty marker when the graph has no files', () => {
    const graph: LemcoreCodebaseGraph = {
      source: 'fallback', ready: true, builtAt: '', repoRoot: '/x',
      nodes: [], edges: [], files: [],
      stats: { fileCount: 0, nodeCount: 0, edgeCount: 0, summaryTokens: 0, rawDumpTokens: 0 },
    };
    expect(buildRepoMap(graph).trim()).toBe('');
  });
});
