import { z } from 'zod';
import { GITHUB_API, githubHeaders } from './git-providers.js';
import {
  apiRequest,
  encodeRepoPath,
  type PrChecksStatus,
  type PullRequestRefInput,
} from './pr-shared.js';

// GitHub CI-check signals for the auto-merge gate: combined commit status,
// check runs, and workflow runs.

const githubCombinedStatusSchema = z.object({ state: z.string(), total_count: z.number() });

const githubCheckRunsSchema = z.object({
  check_runs: z.array(z.object({ name: z.string().optional(), status: z.string(), conclusion: z.string().nullable() })),
});

const githubWorkflowRunsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      workflow_id: z.number(),
      name: z.string().optional(),
      status: z.string(),
      conclusion: z.string().nullable(),
    }),
  ),
});

export interface GitHubCombinedStatus {
  state: string;
  total_count: number;
}

export interface GitHubCheckRun {
  name?: string;
  status: string;
  conclusion: string | null;
}

export interface GitHubWorkflowRun {
  workflow_id: number;
  name?: string;
  status: string;
  conclusion: string | null;
}

// Conclusions that do not block a merge (GitHub Actions docs).
const CHECK_RUN_OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

function collectFailingCheckNames(
  checkRuns: GitHubCheckRun[],
  workflowRuns: GitHubWorkflowRun[],
): string[] {
  const names: string[] = [];
  for (const run of checkRuns) {
    if (checkRunOutcome(run) === 'failing') names.push(run.name ?? 'check');
  }
  for (const run of workflowRuns) {
    if (workflowRunOutcome(run) === 'failing') names.push(run.name ?? `workflow ${run.workflow_id}`);
  }
  return [...new Set(names)].slice(0, 20);
}

function checkRunOutcome(run: GitHubCheckRun): 'pending' | 'failing' | 'ok' {
  if (run.status !== 'completed') return 'pending';
  return CHECK_RUN_OK_CONCLUSIONS.has(run.conclusion ?? '') ? 'ok' : 'failing';
}

// Same mapping for workflow RUNS (the actions/runs API). This is the only
// signal that sees a workflow that fails at STARTUP (invalid YAML, a
// duplicated job key): such a run reports conclusion 'failure' but produces
// zero check runs and zero commit statuses — invisible to the other two
// signals, which read the branch as green and let red CI merge.
function workflowRunOutcome(run: GitHubWorkflowRun): 'pending' | 'failing' | 'ok' {
  if (run.status !== 'completed') return 'pending';
  return CHECK_RUN_OK_CONCLUSIONS.has(run.conclusion ?? '') ? 'ok' : 'failing';
}

// The runs API returns newest first; per workflow only the latest run
// matters (a re-run supersedes its earlier failed attempt).
function latestRunsPerWorkflow(runs: GitHubWorkflowRun[]): GitHubWorkflowRun[] {
  const seen = new Set<number>();
  return runs.filter((run) => {
    if (seen.has(run.workflow_id)) return false;
    seen.add(run.workflow_id);
    return true;
  });
}

// Gate signal = commit statuses (external CI) AND check runs (GitHub
// Actions) AND workflow runs (catches Actions startup failures, which
// produce neither of the first two). The combined-status endpoint alone
// never sees Actions runs — on an Actions-only repo it reports total_count
// 0, which must NOT read as green on its own. Failing beats pending beats
// green across all three signals; no signals at all (a repo genuinely
// without CI) still reads green.
export function githubChecksState(
  combined: GitHubCombinedStatus,
  checkRuns: GitHubCheckRun[],
  workflowRuns: GitHubWorkflowRun[] = [],
): PrChecksStatus['state'] {
  const outcomes = [...checkRuns.map(checkRunOutcome), ...workflowRuns.map(workflowRunOutcome)];
  if (outcomes.includes('failing')) return 'failing';
  if (combined.total_count > 0 && combined.state !== 'success' && combined.state !== 'pending') {
    return 'failing';
  }
  if (outcomes.includes('pending')) return 'pending';
  if (combined.total_count > 0 && combined.state === 'pending') return 'pending';
  return 'green';
}

// CI state of the PR head: commit statuses (external CI) plus check runs
// (GitHub Actions jobs) plus workflow runs (the only place a workflow that
// fails at startup — invalid file, no jobs — shows up). filter=latest so a
// re-run supersedes its earlier failed attempt.
export async function githubChecksStatus(
  token: string,
  input: PullRequestRefInput,
): Promise<PrChecksStatus> {
  const repoPath = encodeRepoPath(input.repoFullName);
  const ref = encodeURIComponent(input.headBranch);
  const headers = githubHeaders(token);
  const [statusRes, runsRes, workflowRunsRes] = await Promise.all([
    apiRequest('github', 'GET', `${GITHUB_API}/repos/${repoPath}/commits/${ref}/status`, headers, token),
    apiRequest(
      'github',
      'GET',
      `${GITHUB_API}/repos/${repoPath}/commits/${ref}/check-runs?filter=latest&per_page=100`,
      headers,
      token,
    ),
    // Tolerated separately: repos with Actions disabled answer non-2xx
    // here, which must not kill the other two signals.
    apiRequest(
      'github',
      'GET',
      `${GITHUB_API}/repos/${repoPath}/actions/runs?branch=${ref}&per_page=30`,
      headers,
      token,
    ).catch(() => null),
  ]);
  const combined = githubCombinedStatusSchema.parse(statusRes.body);
  const { check_runs } = githubCheckRunsSchema.parse(runsRes.body);
  const workflowRuns = workflowRunsRes
    ? latestRunsPerWorkflow(githubWorkflowRunsSchema.parse(workflowRunsRes.body).workflow_runs)
    : [];
  const state = githubChecksState(combined, check_runs, workflowRuns);
  return { supported: true, green: state === 'green', state, failingChecks: collectFailingCheckNames(check_runs, workflowRuns) };
}
