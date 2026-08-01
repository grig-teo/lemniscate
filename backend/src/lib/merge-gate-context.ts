import type { GitAuth } from './agent-git.js';
import type { LlmRuntime, TaskWithRepo } from './agent-runtime.js';

// Everything one merge-gate action needs: the loaded task, its runtime, and
// the git/enqueue parameters shared by the CI-fix and conflict-resolution
// paths (previously threaded as 7-10 positional parameters per function).
export interface GateContext {
  task: TaskWithRepo;
  rt: LlmRuntime;
  headBranch: string;
  attempt: number;
  ciFixes: number;
  workdir: string;
  cloneUrl: string;
  secrets: string[];
  auth: GitAuth;
  failingChecks?: string[];
}
