// Platform-agnostic loop constants for @lemniscate/core.

export const CORE_MAX_TURNS = 60;
export const CORE_MAX_TOOL_FAILURES = 2;
/** Basename only — never store under the git clone (see transcriptPath). */
export const TRANSCRIPT_FILE = 'lemcore-transcript.json';
export const REVIEW_FILENAME = '.lemniscate-review.json';

/**
 * Resume transcript lives *beside* the clone, not inside it, so it never
 * shows up in `git status` / commits / PRs. workdir is typically
 * `$AGENT_WORKDIR/<taskId>` → transcript is `$AGENT_WORKDIR/<taskId>.lemcore-transcript.json`.
 */
export function transcriptPath(workdir: string): string {
  return `${workdir.replace(/[/\\]+$/, '')}.${TRANSCRIPT_FILE}`;
}

const TOOL_LINES = [
  '- read_file(path, offset?, limit?): read a file',
  '- write_file(path, content): overwrite a file',
  '- edit_file(path, search, replace): literal search/replace, exactly one match required',
  '- bash(command): run a shell command (120s timeout)',
  '- grep(pattern, path?, glob?): search with ripgrep',
  '- glob(pattern): list files matching a pattern (max 200)',
  '- web_search(query): search the web',
  '- graph_query(pattern, target): query the scan-session codebase graph',
  '- graph_impact(files): blast radius for changed files via the graph',
  '- graph_neighbors(center, depth?): dependency neighborhood around a symbol/file',
  '- graph_search(query): search symbols/files in the codebase graph',
];

/**
 * Base system prompt. `extraTools` lists host-provided tools (load_skill,
 * spawn_subagent, MCP tools, plugin tools) appended to the built-in roster.
 */
export function lemcoreSystemPrompt(workdir?: string, extraTools: string[] = []): string {
  const cwd = workdir ? ` (${workdir})` : '';
  return [
    `Work in the current directory${cwd}. Implement the task completely, including tests if the project has a test setup. Respect the repository's own rules (AGENTS.md, lint/size guards) and keep any repo-provided checks (e.g. check:max-lines, lint scripts) passing — split modules instead of growing files past a size limit. Do NOT git commit, push, or create branches — git is handled externally.`,
    '',
    'A codebase graph is built on each repository scan. Prefer graph_query, graph_impact, graph_neighbors, and graph_search to navigate structure (callers/callees/imports) before bulk raw-file reads. Only read full files when the graph cannot answer. This keeps prompt tokens low.',
    '',
    'You have access to the following tools. Use them to read, write, and explore files.',
    ...TOOL_LINES,
    ...extraTools,
    '',
    'Use tools in a structured way. Prefer graph tools, then selective reads, then writes. After making changes, verify them.',
  ].join('\n');
}
