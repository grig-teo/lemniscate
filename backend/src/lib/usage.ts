// Token-usage surfacing — the single home for the rules behind the task DTO
// usage fields and GET /api/usage: effective-config resolution (task → repo →
// user default), prompt/completion cost estimation, and the windowed
// aggregation. Pure functions over pre-fetched rows; the routes own the
// queries, this module owns the semantics (unit-tested in tests/usage.test.ts).

export interface UsageConfigInfo {
  id: string;
  isDefault: boolean;
  maxTokensPerRun: number | null;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
}

// The llmConfig columns every usage query needs — one select, shared by the
// task routes and the usage route so the two never drift apart.
export const USAGE_CONFIG_SELECT = {
  id: true,
  isDefault: true,
  maxTokensPerRun: true,
  inputPricePerMillion: true,
  outputPricePerMillion: true,
} as const;

export interface UsageTaskRow {
  repositoryId: string;
  createdAt: Date;
  llmTokensUsed: number;
  llmPromptTokens: number | null;
  llmCompletionTokens: number | null;
  llmConfigId: string | null;
}

export interface UsageRepoInfo {
  id: string;
  name: string;
  fullName: string;
  llmConfigId: string | null;
}

// ---------------------------------------------------------------------------
// Effective config (mirrors findLlmConfig's resolution order over pre-fetched
// ENABLED configs: task → repo → user default → lowest id)
// ---------------------------------------------------------------------------

export function resolveEffectiveConfig(
  configs: UsageConfigInfo[],
  taskLlmConfigId: string | null,
  repoLlmConfigId: string | null,
): UsageConfigInfo | null {
  for (const id of [taskLlmConfigId, repoLlmConfigId]) {
    if (!id) continue;
    const found = configs.find((cfg) => cfg.id === id);
    if (found) return found;
  }
  const fallback = configs.find((cfg) => cfg.isDefault);
  if (fallback) return fallback;
  return [...configs].sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

// ---------------------------------------------------------------------------
// Cost estimation — absent, never guessed, when prices are unset
// ---------------------------------------------------------------------------

type Priced = Pick<UsageConfigInfo, 'inputPricePerMillion' | 'outputPricePerMillion'>;

// USD for a prompt/completion split at the config's per-million prices; null
// when either price is unset (a partial price would produce a wrong number,
// so the cost field is omitted entirely instead).
export function estimatedCostUsd(
  promptTokens: number,
  completionTokens: number,
  cfg: Priced | null,
): number | null {
  if (!cfg || cfg.inputPricePerMillion == null || cfg.outputPricePerMillion == null) {
    return null;
  }
  return (promptTokens * cfg.inputPricePerMillion + completionTokens * cfg.outputPricePerMillion) / 1_000_000;
}

// Float noise guard for serialized costs (6 decimals = sub-micro-dollar).
function roundCost(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Task DTO fragment
// ---------------------------------------------------------------------------

export interface TaskUsagePayload {
  llmTokensUsed: number;
  llmPromptTokens: number | null;
  llmCompletionTokens: number | null;
  /** Effective run budget from the resolved config; null when uncapped. */
  maxTokensPerRun: number | null;
  /** Present only when the split is known AND the config has both prices. */
  estimatedCostUsd?: number;
}

interface TaskUsageColumns {
  llmTokensUsed: number;
  llmPromptTokens: number | null;
  llmCompletionTokens: number | null;
}

export function taskUsagePayload(
  task: TaskUsageColumns,
  cfg: UsageConfigInfo | null,
): TaskUsagePayload {
  const splitKnown = task.llmPromptTokens != null && task.llmCompletionTokens != null;
  const cost = splitKnown
    ? estimatedCostUsd(task.llmPromptTokens as number, task.llmCompletionTokens as number, cfg)
    : null;
  return {
    llmTokensUsed: task.llmTokensUsed,
    llmPromptTokens: task.llmPromptTokens,
    llmCompletionTokens: task.llmCompletionTokens,
    maxTokensPerRun: cfg?.maxTokensPerRun ?? null,
    ...(cost != null ? { estimatedCostUsd: roundCost(cost) } : {}),
  };
}

/** Task row + its usage fragment, resolved against the repo's config fallback. */
export function serializeTaskWithUsage<T extends TaskUsageColumns & { llmConfigId: string | null }>(
  task: T,
  repoLlmConfigId: string | null,
  configs: UsageConfigInfo[],
): T & TaskUsagePayload {
  const cfg = resolveEffectiveConfig(configs, task.llmConfigId, repoLlmConfigId);
  return { ...task, ...taskUsagePayload(task, cfg) };
}

// ---------------------------------------------------------------------------
// /api/usage aggregation
// ---------------------------------------------------------------------------

// Attribution semantics, also returned by the endpoint: llmTokensUsed is
// cumulative PER TASK, so a period bucket attributes a task's whole total to
// the day the task was CREATED — an approximation, not per-event deltas.
export const USAGE_SEMANTICS =
  'llmTokensUsed is cumulative per task; buckets attribute each task\'s cumulative usage to the day it was created (createdAt), not to when the tokens were spent. Costs are estimates from each task\'s effective LLM config prices; tasks that ran before the prompt/completion split existed contribute tokens but no cost.';

export interface UsageBucket {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd?: number;
}

export interface UsageRepositoryBucket extends UsageBucket {
  repositoryId: string;
  name: string;
  fullName: string;
}

export interface UsageDayBucket extends UsageBucket {
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
}

export interface UsageReport {
  period: '7d' | '30d';
  since: string;
  semantics: string;
  totals: UsageBucket;
  byRepository: UsageRepositoryBucket[];
  byDay: UsageDayBucket[];
}

interface BucketAcc {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  priced: boolean;
}

function emptyAcc(): BucketAcc {
  return { totalTokens: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, priced: false };
}

function addTask(acc: BucketAcc, task: UsageTaskRow, cfg: UsageConfigInfo | null): void {
  acc.totalTokens += task.llmTokensUsed;
  const splitKnown = task.llmPromptTokens != null && task.llmCompletionTokens != null;
  if (!splitKnown) return;
  acc.promptTokens += task.llmPromptTokens as number;
  acc.completionTokens += task.llmCompletionTokens as number;
  const cost = estimatedCostUsd(task.llmPromptTokens as number, task.llmCompletionTokens as number, cfg);
  if (cost == null) return;
  acc.costUsd += cost;
  acc.priced = true;
}

function toBucket(acc: BucketAcc): UsageBucket {
  return {
    totalTokens: acc.totalTokens,
    promptTokens: acc.promptTokens,
    completionTokens: acc.completionTokens,
    ...(acc.priced ? { estimatedCostUsd: roundCost(acc.costUsd) } : {}),
  };
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function buildUsageReport(args: {
  tasks: UsageTaskRow[];
  repositories: UsageRepoInfo[];
  configs: UsageConfigInfo[];
  period: '7d' | '30d';
  since: Date;
}): UsageReport {
  const reposById = new Map(args.repositories.map((repo) => [repo.id, repo]));
  const totals = emptyAcc();
  const byRepo = new Map<string, BucketAcc>();
  const byDay = new Map<string, BucketAcc>();

  for (const task of args.tasks) {
    const repo = reposById.get(task.repositoryId);
    const cfg = resolveEffectiveConfig(args.configs, task.llmConfigId, repo?.llmConfigId ?? null);
    addTask(totals, task, cfg);
    const repoAcc = byRepo.get(task.repositoryId) ?? emptyAcc();
    addTask(repoAcc, task, cfg);
    byRepo.set(task.repositoryId, repoAcc);
    const day = utcDay(task.createdAt);
    const dayAcc = byDay.get(day) ?? emptyAcc();
    addTask(dayAcc, task, cfg);
    byDay.set(day, dayAcc);
  }

  const byRepository: UsageRepositoryBucket[] = Array.from(byRepo.entries())
    .map(([repositoryId, acc]) => ({
      repositoryId,
      name: reposById.get(repositoryId)?.name ?? 'unknown',
      fullName: reposById.get(repositoryId)?.fullName ?? 'unknown',
      ...toBucket(acc),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const byDayBuckets: UsageDayBucket[] = Array.from(byDay.entries())
    .map(([day, acc]) => ({ day, ...toBucket(acc) }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    period: args.period,
    since: args.since.toISOString(),
    semantics: USAGE_SEMANTICS,
    totals: toBucket(totals),
    byRepository,
    byDay: byDayBuckets,
  };
}
