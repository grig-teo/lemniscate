// Structured error classification for task failures. The agent loop catches
// exceptions (LLM HTTP errors, git push rejections, network timeouts) and
// classifies them into a TaskErrorCode stored on the task record. The
// frontend maps each code to a user-friendly banner with an actionable hint.
//
// This module is the single source of truth for error-code mapping
// (AGENTS.md §6). It must stay free of config/prisma/redis imports so it
// can be used in any context (including config-free tests).

export enum TaskErrorCode {
  // LLM provider errors
  LLM_AUTH_FAILED = 'LLM_AUTH_FAILED',
  LLM_RATE_LIMITED = 'LLM_RATE_LIMITED',
  LLM_QUOTA_EXCEEDED = 'LLM_QUOTA_EXCEEDED',
  LLM_TIMEOUT = 'LLM_TIMEOUT',
  LLM_CONNECTION_FAILED = 'LLM_CONNECTION_FAILED',
  LLM_SERVER_ERROR = 'LLM_SERVER_ERROR',
  // Git provider errors
  GIT_AUTH_FAILED = 'GIT_AUTH_FAILED',
  GIT_PERMISSION_DENIED = 'GIT_PERMISSION_DENIED',
  GIT_WORKFLOW_SCOPE = 'GIT_WORKFLOW_SCOPE',
  // Catch-all
  UNKNOWN = 'UNKNOWN',
}

// LlmError is fetch-based (see llm-client.ts). It carries a `kind` and an
// optional `status`. We duck-type it here to avoid a circular import —
// llm-client.ts is a leaf module, but errors.ts stays dependency-free.
interface LlmErrorLike {
  kind: string;
  status?: number;
  message: string;
}

function isLlmErrorLike(err: unknown): err is LlmErrorLike {
  return err instanceof Error && 'kind' in err && typeof (err as LlmErrorLike).kind === 'string';
}

// Classifies a caught exception into a structured TaskErrorCode, or
// TaskErrorCode.UNKNOWN when no signature matches. The classification is
// deliberately conservative: it only matches well-known, stable signatures
// from the LLM client (LlmError) and git child-process stderr.
export function classifyError(err: unknown): TaskErrorCode {
  if (isLlmErrorLike(err)) {
    return classifyLlmError(err);
  }
  const message = err instanceof Error ? err.message : String(err);
  return classifyByMessage(message);
}

// LlmError instances have a structured `kind` + `status` we can match
// directly, without falling back to message inspection.
function classifyLlmError(err: LlmErrorLike): TaskErrorCode {
  if (err.kind === 'timeout') return TaskErrorCode.LLM_TIMEOUT;
  if (err.kind === 'network') return TaskErrorCode.LLM_CONNECTION_FAILED;
  if (err.kind === 'http') return classifyLlmHttpStatus(err.status, err.message);
  // 'protocol' and any future kind.
  return TaskErrorCode.UNKNOWN;
}

// Maps an LLM HTTP status to a code, with message-based overrides for
// quota detection (OpenAI returns 429 with "insufficient_quota").
function classifyLlmHttpStatus(status: number | undefined, message: string): TaskErrorCode {
  if (status === 401 || status === 403) return TaskErrorCode.LLM_AUTH_FAILED;
  if (status === 402) return TaskErrorCode.LLM_QUOTA_EXCEEDED;
  if (status === 429) {
    return /insufficient_quota|quota|billing/i.test(message)
      ? TaskErrorCode.LLM_QUOTA_EXCEEDED
      : TaskErrorCode.LLM_RATE_LIMITED;
  }
  if (status !== undefined && status >= 500) return TaskErrorCode.LLM_SERVER_ERROR;
  // Non-retryable 4xx that aren't auth/quota — surface as the raw error.
  return TaskErrorCode.UNKNOWN;
}

// Fallback classifier for plain Error instances (git child-process stderr,
// rethrown exceptions that lost their LlmError wrapper, etc.). Checks the
// most specific signatures first.
function classifyByMessage(message: string): TaskErrorCode {
  // Git workflow scope — must be checked before the generic permission
  // denied pattern, because the workflow rejection message also contains
  // "permission" wording.
  if (/without `workflow` scope|refusing to allow an oauth app to create or update workflow/i.test(message)) {
    return TaskErrorCode.GIT_WORKFLOW_SCOPE;
  }

  // Git auth failures (clone/push credential rejection — missing or
  // invalid token).
  if (/authentication failed|could not read username|invalid username or token/i.test(message)) {
    return TaskErrorCode.GIT_AUTH_FAILED;
  }

  // Git permission denied (push rejected by the host — 403 / access denied).
  if (/permission.*denied|403 forbidden|access denied|requested url returned error: 403/i.test(message)) {
    return TaskErrorCode.GIT_PERMISSION_DENIED;
  }

  // LLM auth (plain Error that escaped the LlmError wrapper).
  if (/incorrect api key|invalid api key|api key.*invalid|api key.*revoked/i.test(message)) {
    return TaskErrorCode.LLM_AUTH_FAILED;
  }

  // LLM timeout.
  if (/timed?\s*out|timeout/i.test(message)) {
    return TaskErrorCode.LLM_TIMEOUT;
  }

  // LLM connection failures (DNS, refused, reset).
  if (/econnrefused|enotfound|econnreset|eai_again|fetch failed|network error/i.test(message)) {
    return TaskErrorCode.LLM_CONNECTION_FAILED;
  }

  return TaskErrorCode.UNKNOWN;
}
