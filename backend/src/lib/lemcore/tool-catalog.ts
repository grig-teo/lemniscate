import type { ChatCompletionTool } from '../llm-client.js';

export function getAvailableTools(): ChatCompletionTool[] {
  return [
    fnTool(
      'read_file',
      'Read a file from the repository.',
      {
        path: { type: 'string', description: 'Relative path to the file' },
        offset: { type: 'number', description: 'Line offset (0-indexed)' },
        limit: { type: 'number', description: 'Max number of lines' },
      },
      ['path'],
    ),
    fnTool(
      'write_file',
      'Write (overwrite) a file in the repository.',
      {
        path: { type: 'string', description: 'Relative path to write' },
        content: { type: 'string', description: 'Full file content' },
      },
      ['path', 'content'],
    ),
    fnTool(
      'edit_file',
      'Replace exactly one occurrence of search text with replace text.',
      {
        path: { type: 'string', description: 'Relative path to the file' },
        search: { type: 'string', description: 'Exact text to find' },
        replace: { type: 'string', description: 'Replacement text' },
      },
      ['path', 'search', 'replace'],
    ),
    fnTool(
      'multi_edit',
      'Apply multiple search/replace pairs to one file in a single call. Each pair requires exactly one match. Use for multi-spot refactors.',
      {
        path: { type: 'string', description: 'Relative path to the file' },
        edits: {
          type: 'array',
          description: 'Array of {search, replace} pairs, applied sequentially',
          items: {
            type: 'object',
            properties: {
              search: { type: 'string', description: 'Exact text to find' },
              replace: { type: 'string', description: 'Replacement text' },
            },
            required: ['search', 'replace'],
          },
        },
      },
      ['path', 'edits'],
    ),
    fnTool(
      'bash',
      'Run a shell command. Captures stdout and stderr. 120s timeout.',
      {
        command: { type: 'string', description: 'Shell command to run' },
      },
      ['command'],
    ),
    fnTool(
      'grep',
      'Search for a pattern in files using ripgrep.',
      {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory or file to search (default: workdir)' },
        glob: { type: 'string', description: 'Glob pattern to filter files' },
      },
      ['pattern'],
    ),
    fnTool(
      'glob',
      'List files matching a pattern (max 200 results).',
      {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "*.ts")' },
      },
      ['pattern'],
    ),
    fnTool(
      'list_dir',
      'List the contents of a directory (files and subdirectories). Prefer over bash ls.',
      {
        path: { type: 'string', description: 'Relative directory path (default: workdir root)' },
      },
      [],
    ),
    fnTool(
      'web_search',
      'Search the web for information.',
      {
        query: { type: 'string', description: 'Search query' },
      },
      ['query'],
    ),
    fnTool(
      'graph_query',
      'Query the scan-session codebase graph (callers, callees, imports). Prefer over bulk file reads.',
      {
        pattern: {
          type: 'string',
          description:
            'callers_of | callees_of | imports_of | importers_of | children_of | tests_for | inheritors_of | file_summary',
        },
        target: {
          type: 'string',
          description: 'Symbol name, qualified name, or file path',
        },
      },
      ['pattern', 'target'],
    ),
    fnTool(
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
    ),
    fnTool(
      'graph_neighbors',
      'Expand the dependency neighborhood around a file or symbol in the codebase graph.',
      {
        center: { type: 'string', description: 'File path or symbol' },
        depth: { type: 'number', description: 'Max hop depth (default from scan config)' },
      },
      ['center'],
    ),
    fnTool(
      'graph_search',
      'Search symbols/files in the scan-session codebase graph.',
      {
        query: { type: 'string', description: 'Search string' },
      },
      ['query'],
    ),
    fnTool(
      'load_skill',
      'Load the full instructions (SKILL.md) of an attached skill by name or slug. Call this before applying a skill — only load what you need.',
      {
        name: { type: 'string', description: 'Skill name or slug' },
      },
      ['name'],
    ),
    fnTool(
      'undo_edit',
      'Revert the most recent edit to a file (restore the pre-edit checkpoint). Use when a lint or test fails after an edit.',
      { path: { type: 'string', description: 'Relative path to the file' } },
      ['path'],
    ),
    fnTool(
      'todo_write',
      'Write or update a TODO list for the current task. The list is re-injected as a reminder every turn. Use this to track multi-step work.',
      {
        content: {
          type: 'string',
          description:
            'The full TODO list (markdown checkboxes or plain lines). Replaces the previous list.',
        },
      },
      ['content'],
    ),
  ];
}

function fnTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required },
    },
  };
}
