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
