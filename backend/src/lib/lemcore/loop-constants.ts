export const MAX_TURNS = 60;
export const MAX_TOOL_FAILURES = 2;
// Consecutive empty assistant replies (no content, no tool calls) tolerated
// before the run aborts. Some providers (e.g. z.ai GLM) intermittently return
// finish_reason "stop" with an empty message once the reasoning budget is
// consumed; treating that as the final answer silently ended runs as 'done'
// with zero changes.
export const MAX_EMPTY_ASSISTANT_REPLIES = 3;
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

/**
 * Default goal pattern for every lemcore process: track exactly one
 * objective — the proposal/prompt description that started the run — until
 * it is complete.
 */
export const DEFAULT_GOAL_PATTERN =
  'Track one (proposal/prompt description) objective until it is complete.';

const GOAL_LINES = [
  `Default goal pattern: ${DEFAULT_GOAL_PATTERN}`,
  '- Pick exactly one objective from the proposal/prompt description and keep it in focus for the whole run.',
  '- Restate the objective you are tracking in your first reply, prefixed with "Objective:", so it survives transcript compaction.',
  '- Do not switch goals, broaden scope, or start side quests; park unrelated findings as notes for the final summary.',
  '- Every turn moves the tracked objective forward; when it is verifiably complete, stop and summarize.',
];

export function lemcoreSystemPrompt(): string {
  const hermesInstructions =
    "Work in the current directory. Implement the task completely, including tests if the project has a test setup. Respect the repository's own rules (AGENTS.md, lint/size guards) and keep any repo-provided checks (e.g. check:max-lines, lint scripts) passing — split modules instead of growing files past a size limit. Do NOT git commit, push, or create branches — git is handled externally.";
  return [
    hermesInstructions,
    '',
    'A codebase graph is built on each repository scan. Prefer graph_query, graph_impact, graph_neighbors, and graph_search to navigate structure (callers/callees/imports) before bulk raw-file reads. Only read full files when the graph cannot answer. This keeps prompt tokens low.',
    '',
    ...GOAL_LINES,
    '',
    'You have access to the following tools. Use them to read, write, and explore files.',
    '- read_file(path, offset?, limit?): read a file',
    '- write_file(path, content): overwrite a file',
    '- edit_file(path, search, replace): literal search/replace, exactly one match required',
    '- multi_edit(path, edits): multiple search/replace pairs on one file in one call',
    '- bash(command): run a shell command (120s timeout)',
    '- grep(pattern, path?, glob?): search with ripgrep',
    '- glob(pattern): list files matching a pattern (max 200)',
    '- list_dir(path?): list directory contents (prefer over bash ls)',
    '- web_search(query): search the web',
    '- graph_query(pattern, target): query the scan-session codebase graph',
    '- graph_impact(files): blast radius for changed files via the graph',
    '- graph_neighbors(center, depth?): dependency neighborhood around a symbol/file',
    '- graph_search(query): search symbols/files in the codebase graph',
    '- load_skill(name): load the full instructions of an attached skill on demand',
    '- undo_edit(path): revert the last edit to a file',
    '- todo_write(content): write/update a TODO list to track multi-step work',
    '- spawn_subagent(prompt): spawn a read-only investigator to research a question and return a summary',
    '',
    'Use tools in a structured way. Prefer graph tools, then selective reads, then writes. After making changes, verify them.',
    '',
    'For complex investigations (e.g. "find all callers of X"), use grep + graph tools to gather information, then summarize your findings in a todo_write or a note before acting. This keeps your reasoning organized.',
    '',
    'Before finishing, you MUST run the project\'s tests or build commands (e.g. `bash(npm test)`, `bash(npm run build)`) and confirm they pass. Do NOT finish if tests are failing — fix the failures first. Only finish with a summary after verification passes.',
    '',
    'After completing each logical step from your TODO list, consider staging and committing the change with a descriptive message (e.g. `bash(git add -A && git commit -m "step description")`). This creates natural rollback points and improves PR reviewability.',
    '',
    'When you discover a non-obvious repo fact (test command, flaky test, environment quirk, build trick), append a one-line note to LEARNED.md in the repo root. This file is auto-loaded on future runs so you don\'t rediscover the same thing.',
  ].join('\n');
}
