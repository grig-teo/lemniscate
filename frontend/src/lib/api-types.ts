/**
 * API contract types shared by the settings dialog, the login page, and the
 * shell panes. All shapes mirror the backend API contract — payloads are
 * camelCase and LLM configs never include `apiKey` in responses (`hasApiKey`
 * flags whether one is stored).
 *
 * Device-domain types live next to their hooks in queries/devices.ts; service
 * types in lib/services.ts.
 */

export type Me = {
  id: string;
  createdAt: string;
};

export type GitProvider = 'github' | 'gitlab' | 'gitverse' | 'gitee';

export type Connection = {
  id: string;
  provider: GitProvider;
  username: string;
  baseUrl: string | null;
  /** Set when disconnected — the row is kept, only the token was scrubbed. */
  disconnectedAt?: string | null;
};

export type ConnectionPayload = {
  provider: GitProvider;
  token: string;
  baseUrl?: string;
};

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** LLM config as returned by the API — `apiKey` is never included. */
export type LlmConfig = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  thinkingLevel: ThinkingLevel;
  temperature: number;
  maxTokens: number;
  contextWindow: number;
  systemPromptExtra: string | null;
  timeoutSeconds: number;
  maxRetries: number;
  requestsPerMinute: number;
  maxTokensPerRun: number;
  /** Optional USD prices per million tokens; both set = cost estimates on. */
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  customHeaders: Record<string, string> | null;
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Create/update payload; unset optional fields fall back to server defaults. */
export type LlmConfigPayload = {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  thinkingLevel?: ThinkingLevel;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  systemPromptExtra?: string;
  timeoutSeconds?: number;
  maxRetries?: number;
  requestsPerMinute?: number;
  maxTokensPerRun?: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  customHeaders?: Record<string, string>;
  isDefault?: boolean;
  enabled?: boolean;
};

export type LlmTestResult = {
  ok: boolean;
  latencyMs?: number;
  modelEcho?: string;
  reply?: string;
  /** Set when the reply hit the probe token budget (thinking models). */
  truncated?: boolean;
  error?: string;
};

export type Repository = {
  id: string;
  connectionId: string;
  externalId: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  autoPropose: boolean;
  autoCreatePr: boolean;
  autoReviewPr: boolean;
  autoMergePr: boolean;
  autoRunProposals: boolean;
  hidden: boolean;
  /** True for near-empty (README-only) repositories — the composer invites a from-scratch app prompt. */
  bare: boolean;
  /** Detected app platform ('android'|'ios'|'web'|'desktop'|'unknown'); null until first detection. */
  platform?: string | null;
  llmConfigId?: string | null;
  /** LLM config for the review-pr job; null = standard task → repo → user-default resolution. */
  reviewLlmConfigId?: string | null;
  /** Repository-level skill slugs injected into the agent's system prompt. */
  skillSlugs?: string[];
  /** AGENTS.md template skill applied when the repo root has no AGENTS.md. */
  agentsMdSkillId?: string | null;
  connection: {
    provider: GitProvider;
    username: string;
  };
};

/** GET /api/skills list item — full content only comes from GET /api/skills/:slug. */
export type Skill = {
  id: string;
  slug: string;
  name: string;
  category: string;
  description: string;
  tags: string[];
  kind: 'skill' | 'agents_md';
  /** Owner id; null = global library entry (read-only). */
  userId: string | null;
};

/** GET /api/skills/:slug — list fields plus the full markdown content. */
export type SkillDetail = Skill & {
  content: string;
};

/** GET /api/skills/categories item. */
export type SkillCategory = {
  name: string;
  count: number;
};

export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'awaiting_review'
  | 'done'
  | 'failed'
  | 'closed'
  | (string & {});

/** Per-task thinking-level override accepted by POST /api/tasks. */
export type TaskThinkingLevel = 'low' | 'medium' | 'high' | 'max';

/** Image attachment sent with a prompt task (data URL, max 3 per task). */
export type TaskImage = {
  name: string;
  dataUrl: string;
};

export type Task = {
  id: string;
  repositoryId: string;
  kind: string;
  title: string;
  /** Proposal category label ('security', 'ux/ui', …); null for prompt tasks. */
  category?: string | null;
  /** Proposal priority ('critical'|'high'|'medium'|'low') and effort ('small'|'medium'|'large'). */
  priority?: string | null;
  effort?: string | null;
  status: TaskStatus;
  /** Full prompt — only included by GET /api/tasks/:id, not by list endpoints. */
  prompt?: string;
  branchName?: string | null;
  prUrl?: string | null;
  thinkingLevel?: TaskThinkingLevel | null;
  attachments?: TaskImage[] | null;
  /** Soft-archive timestamp; null = active. Archived tasks only appear in ?archived=true lists. */
  archivedAt: string | null;
  /** Cumulative LLM tokens across run/review/merge jobs of this task. */
  llmTokensUsed: number;
  /** Prompt/completion split; null for tasks that predate the split columns. */
  llmPromptTokens?: number | null;
  llmCompletionTokens?: number | null;
  /** Effective run budget (task config → repo config → user default); null = uncapped. */
  maxTokensPerRun?: number | null;
  /** Estimated USD at the effective config's prices; absent when unpriced or split unknown. */
  estimatedCostUsd?: number;
  createdAt: string;
  updatedAt: string;
};

/** POST /api/tasks body; optional fields are omitted when unset. */
export type CreateTaskBody = {
  repositoryId: string;
  prompt: string;
  thinkingLevel?: TaskThinkingLevel;
  llmConfigId?: string;
  images?: TaskImage[];
  /** Save for later: create the task as pending without enqueueing it. */
  later?: boolean;
  /** Explicit skill slugs; omitted = inherit the repository's selection. */
  skills?: string[];
  /** MCP server slugs materialized as .mcp.json for this run. */
  mcpServerSlugs?: string[];
  /** Per-folder AGENTS.md assignments (template skillId or uploaded content). */
  agentsMdFiles?: { folder: string; skillId?: string; content?: string }[];
};

/** POST /api/tasks/:id/start body — proposal edits applied before queueing. */
export type StartTaskBody = {
  title?: string;
  prompt?: string;
  images?: TaskImage[];
};

export type TaskEventKind = 'log' | 'diff' | 'status' | (string & {});

export type TaskEventItem = {
  id: string;
  kind: TaskEventKind;
  payload: unknown;
  createdAt: string;
};

export type UsagePeriod = '7d' | '30d';

/** Token totals for one bucket; estimatedCostUsd is absent when unpriced. */
export type UsageBucket = {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd?: number;
};

export type UsageRepositoryBucket = UsageBucket & {
  repositoryId: string;
  name: string;
  fullName: string;
};

export type UsageDayBucket = UsageBucket & {
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
};

export type UsageReport = {
  period: UsagePeriod;
  since: string;
  /** Backend-attribution note (cumulative per task, attributed to createdAt). */
  semantics: string;
  totals: UsageBucket;
  byRepository: UsageRepositoryBucket[];
  byDay: UsageDayBucket[];
};
