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
            'callers_of | callees_of | imports_of | importers_of | references_to | children_of | file_summary',
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
