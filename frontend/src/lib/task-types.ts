/**
 * Task-domain API contract types, split out of api-types.ts to keep each
 * module under the 300-line guard (AGENTS.md section 2). Re-exported from
 * api-types.ts, so existing imports stay valid.
 */

export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'awaiting_review'
  | 'reviewing_code'
  | 'waiting_ci'
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
  /** Structured error code for failed tasks (LLM_AUTH_FAILED, GIT_PERMISSION_DENIED, …). */
  errorCode?: string | null;
  branchName?: string | null;
  prUrl?: string | null;
  /** Manual follow-up: the task auto-queued (started) when this one reaches 'done'. */
  nextTaskId?: string | null;
  thinkingLevel?: TaskThinkingLevel | null;
  attachments?: TaskImage[] | null;
  /** Soft-archive timestamp; null = active. Archived tasks only appear in ?archived=true lists. */
  archivedAt: string | null;
  /** Cumulative LLM tokens across run/review/merge jobs of this task. */
  llmTokensUsed: number;
  /** Prompt/completion split; null for tasks that predate the split columns. */
  llmPromptTokens?: number | null;
  llmCompletionTokens?: number | null;
  /** Per-task LLM config override chosen in the composer / proposal detail; null = inherit (repo → user default). */
  llmConfigId?: string | null;
  /** Effective run budget (task config → repo config → user default); null = uncapped. */
  maxTokensPerRun?: number | null;
  /** Estimated USD at the effective config's prices; absent when unpriced or split unknown. */
  estimatedCostUsd?: number;
  /** Effective LLM config (task → repo → user default) backing this task. */
  effectiveLlmConfigId?: string | null;
  /** Effective config's display name — the console footer's active-model label. */
  llmConfigName?: string | null;
  /** Effective config's model id. */
  llmModel?: string | null;
  /** Effective config's context window — the session context indicator's 100%. */
  contextWindow?: number | null;
  createdAt: string;
  /**
   * Start of the current pipeline session (run → review → merge = one
   * session); the console elapsed timer anchors here so reruns/re-reviews
   * don't accumulate previous sessions' wall time. Null for tasks that
   * haven't run since the column existed — fall back to createdAt.
   */
  sessionStartedAt?: string | null;
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

export type TaskEventKind = 'log' | 'diff' | 'status' | 'agent_step' | (string & {});

export type TaskEventItem = {
  id: string;
  kind: TaskEventKind;
  payload: unknown;
  createdAt: string;
};
