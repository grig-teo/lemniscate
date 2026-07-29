export const MAX_TURNS = 60;
export const MAX_TOOL_FAILURES = 2;
export const TRANSCRIPT_FILE = 'lemcore-transcript.json';
export const REVIEW_FILENAME = '.lemniscate-review.json';

export function lemcoreSystemPrompt(): string {
  const hermesInstructions =
    "Work in the current directory. Implement the task completely, including tests if the project has a test setup. Respect the repository's own rules (AGENTS.md, lint/size guards) and keep any repo-provided checks (e.g. check:max-lines, lint scripts) passing — split modules instead of growing files past a size limit. Do NOT git commit, push, or create branches — git is handled externally.";
  return [
    hermesInstructions,
    '',
    'You have access to the following tools. Use them to read, write, and explore files.',
    '- read_file(path, offset?, limit?): read a file',
    '- write_file(path, content): overwrite a file',
    '- edit_file(path, search, replace): literal search/replace, exactly one match required',
    '- bash(command): run a shell command (120s timeout)',
    '- grep(pattern, path?, glob?): search with ripgrep',
    '- glob(pattern): list files matching a pattern (max 200)',
    '- web_search(query): search the web',
    '',
    'Use tools in a structured way. Prefer reading before writing. After making changes, verify them.',
  ].join('\n');
}
