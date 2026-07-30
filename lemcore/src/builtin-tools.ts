// Built-in lemcore tools in ToolDefinition form (Phase 9 §8 registry shape).
// Single source of truth for the OpenAI tool specs offered to the model:
// the core loop (CLI) and the backend loop both consume builtinTools().

import type { ToolDefinition } from './ports.js';
import {
  toolReadFile,
  toolWriteFile,
  toolEditFile,
  toolBash,
  toolGrep,
  toolGlob,
  toolWebSearch,
} from './tools.js';
import {
  toolGraphImpact,
  toolGraphNeighbors,
  toolGraphQuery,
  toolGraphSearch,
} from './graph-tools.js';

const str = (v: unknown): string => String(v ?? '');
const num = (v: unknown): number | undefined => (v !== undefined ? Number(v) : undefined);

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter(Boolean);
}

function definition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  mutating: boolean,
  run: ToolDefinition['run'],
): ToolDefinition {
  return {
    name,
    description,
    schema: { type: 'object', properties, required },
    mutating,
    run,
  };
}

/** All built-in tools. `secrets` are redacted from outputs by the runners. */
export function builtinTools(secrets: string[]): ToolDefinition[] {
  return [
    definition(
      'read_file',
      'Read a file from the repository.',
      {
        path: { type: 'string', description: 'Relative path to the file' },
        offset: { type: 'number', description: 'Line offset (0-indexed)' },
        limit: { type: 'number', description: 'Max number of lines' },
      },
      ['path'],
      false,
      (args, ctx) => toolReadFile(ctx.workdir, str(args.path), num(args.offset), num(args.limit), secrets),
    ),
    definition(
      'write_file',
      'Write (overwrite) a file in the repository.',
      {
        path: { type: 'string', description: 'Relative path to write' },
        content: { type: 'string', description: 'Full file content' },
      },
      ['path', 'content'],
      true,
      (args, ctx) => toolWriteFile(ctx.workdir, str(args.path), str(args.content), secrets),
    ),
    definition(
      'edit_file',
      'Replace exactly one occurrence of search text with replace text.',
      {
        path: { type: 'string', description: 'Relative path to the file' },
        search: { type: 'string', description: 'Exact text to find' },
        replace: { type: 'string', description: 'Replacement text' },
      },
      ['path', 'search', 'replace'],
      true,
      (args, ctx) =>
        toolEditFile(ctx.workdir, str(args.path), str(args.search), str(args.replace), secrets),
    ),
    definition(
      'bash',
      'Run a shell command. Captures stdout and stderr. 120s timeout.',
      { command: { type: 'string', description: 'Shell command to run' } },
      ['command'],
      true,
      (args, ctx) => toolBash(ctx.workdir, str(args.command), secrets),
    ),
    definition(
      'grep',
      'Search for a pattern in files using ripgrep.',
      {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory or file to search (default: workdir)' },
        glob: { type: 'string', description: 'Glob pattern to filter files' },
      },
      ['pattern'],
      false,
      (args, ctx) =>
        toolGrep(
          ctx.workdir,
          str(args.pattern),
          args.path !== undefined ? str(args.path) : undefined,
          args.glob !== undefined ? str(args.glob) : undefined,
          secrets,
        ),
    ),
    definition(
      'glob',
      'List files matching a pattern (max 200 results).',
      { pattern: { type: 'string', description: 'Glob pattern (e.g. "*.ts")' } },
      ['pattern'],
      false,
      (args, ctx) => toolGlob(ctx.workdir, str(args.pattern), secrets),
    ),
    definition(
      'web_search',
      'Search the web for information.',
      { query: { type: 'string', description: 'Search query' } },
      ['query'],
      false,
      (args) => toolWebSearch(str(args.query), secrets),
    ),
    definition(
      'graph_query',
      'Query the scan-session codebase graph (callers, callees, imports). Prefer over bulk file reads.',
      {
        pattern: {
          type: 'string',
          description:
            'callers_of | callees_of | imports_of | importers_of | children_of | tests_for | inheritors_of | file_summary',
        },
        target: { type: 'string', description: 'Symbol name, qualified name, or file path' },
      },
      ['pattern', 'target'],
      false,
      (args, ctx) => toolGraphQuery(ctx.workdir, str(args.pattern), str(args.target)),
    ),
    definition(
      'graph_impact',
      'Blast radius for changed files via the codebase graph (dependent files/symbols).',
      {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Repo-relative file paths',
        },
      },
      ['files'],
      false,
      (args, ctx) => toolGraphImpact(ctx.workdir, strArray(args.files)),
    ),
    definition(
      'graph_neighbors',
      'Expand the dependency neighborhood around a file or symbol in the codebase graph.',
      {
        center: { type: 'string', description: 'File path or symbol' },
        depth: { type: 'number', description: 'Max hop depth (default from scan config)' },
      },
      ['center'],
      false,
      (args, ctx) => toolGraphNeighbors(ctx.workdir, str(args.center), num(args.depth)),
    ),
    definition(
      'graph_search',
      'Search symbols/files in the scan-session codebase graph.',
      { query: { type: 'string', description: 'Search string' } },
      ['query'],
      false,
      (args, ctx) => toolGraphSearch(ctx.workdir, str(args.query)),
    ),
  ];
}

// Extra read-only tools available to the model (load_skill, spawn_subagent)
// are host-provided and registered on the ToolRegistry by the host adapter.
