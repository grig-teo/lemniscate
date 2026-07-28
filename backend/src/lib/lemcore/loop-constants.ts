export const MAX_TURNS = 60;
export const MAX_TOOL_FAILURES = 2;
export const TRANSCRIPT_FILE = 'lemcore-transcript.json';
export const REVIEW_FILENAME = '.lemniscate-review.json';

export const LEMCORE_INSTRUCTIONS = [
  'You are the lemcore agent executor. Work in the current directory.',
  'Implement the task completely, including tests if the project has a test setup.',
  'Respect the repository\'s own rules (AGENTS.md, lint/size guards) and keep any repo-provided checks passing.',
  'Do NOT git commit, push, or create branches — git is handled externally.',
].join('\n');
