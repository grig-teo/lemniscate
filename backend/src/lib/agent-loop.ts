// The agent loop: executes 'run-task' jobs end to end (clone → LLM-proposed
// code changes → branch → commit → push → pull request), 'review-pr' jobs
// (LLM review → fix iterations → optional auto-merge with conflict
// resolution), and 'generate-proposals' jobs (LLM suggests up to 3
// improvement tasks).
//
// The implementation is split into focused modules (AGENTS.md §2):
//   agent-run.ts        'run-task' job
//   agent-review.ts     'review-pr' job
//   agent-proposals.ts  'generate-proposals' job
//   agent-git.ts        shared git/workdir/event plumbing
//   agent-runtime.ts    LLM runtime (throttle + token budget) + job context
//   agent-prompts.ts    prompt builders, response schemas, slug helpers
//   repo-context.ts     file tree + key file budgeting
//
// This module only preserves the historical import path
// (src/lib/agent-loop.js) for the worker.

export { runTask } from './agent-run.js';
export { reviewTask } from './agent-review.js';
export { generateProposals } from './agent-proposals.js';
