/**
 * Frontend mapping from backend TaskErrorCode strings to user-friendly
 * banner content. Each code produces a title, a short hint, and (when
 * applicable) a settings tab the user should visit to fix the issue.
 *
 * Codes mirror the backend enum in backend/src/lib/errors.ts.
 */

export type TaskErrorCode =
  | 'LLM_AUTH_FAILED'
  | 'LLM_RATE_LIMITED'
  | 'LLM_QUOTA_EXCEEDED'
  | 'LLM_TIMEOUT'
  | 'LLM_CONNECTION_FAILED'
  | 'LLM_SERVER_ERROR'
  | 'GIT_AUTH_FAILED'
  | 'GIT_PERMISSION_DENIED'
  | 'GIT_WORKFLOW_SCOPE'
  | 'UNKNOWN'
  | (string & {});

/** Settings dialog tab that addresses this error, or undefined. */
export type SettingsTab = 'llm' | 'git' | 'repos' | 'notifications' | 'usage';

export interface ErrorBannerInfo {
  title: string;
  hint: string;
  /** Settings tab the user can open to fix the issue; absent when no direct fix exists. */
  settingsTab?: SettingsTab;
}

const ERROR_BANNER_MAP: Record<string, ErrorBannerInfo> = {
  LLM_AUTH_FAILED: {
    title: 'LLM API key is invalid or unauthorized',
    hint: 'The LLM provider rejected the API key. Update the key or switch to a working config, then rerun the task.',
    settingsTab: 'llm',
  },
  LLM_RATE_LIMITED: {
    title: 'LLM rate limit reached',
    hint: 'Too many requests were sent to the LLM provider. Wait a moment and rerun, or reduce the requests-per-minute in the config.',
    settingsTab: 'llm',
  },
  LLM_QUOTA_EXCEEDED: {
    title: 'LLM quota or billing limit exceeded',
    hint: 'The LLM provider reports insufficient quota. Add billing credits on the provider side or switch to a different config.',
    settingsTab: 'llm',
  },
  LLM_TIMEOUT: {
    title: 'The LLM request timed out',
    hint: 'The provider did not respond within the timeout. Increase the timeout in the LLM config or retry.',
    settingsTab: 'llm',
  },
  LLM_CONNECTION_FAILED: {
    title: 'Cannot connect to the LLM endpoint',
    hint: 'The LLM base URL is unreachable (DNS, network, or firewall). Check the base URL and server availability.',
    settingsTab: 'llm',
  },
  LLM_SERVER_ERROR: {
    title: 'The LLM provider returned a server error',
    hint: 'The provider is experiencing issues (HTTP 5xx). Retry shortly; if it persists, check the provider status page.',
  },
  GIT_AUTH_FAILED: {
    title: 'Git authentication failed',
    hint: 'The repository token is missing or invalid. Reconnect the Git provider to refresh the token.',
    settingsTab: 'git',
  },
  GIT_PERMISSION_DENIED: {
    title: 'Git push permission denied',
    hint: 'The token does not have write access to this repository. Grant push permission or reconnect with the right scopes.',
    settingsTab: 'git',
  },
  GIT_WORKFLOW_SCOPE: {
    title: 'Missing GitHub "workflow" scope',
    hint: 'The task edited .github/workflows but the token lacks the workflow OAuth scope. Reconnect GitHub to grant it, then rerun.',
    settingsTab: 'git',
  },
};

const UNKNOWN_BANNER: ErrorBannerInfo = {
  title: 'Task failed with an unexpected error',
  hint: 'Check the console log below for details. If the issue persists, retry the task.',
};

/**
 * Resolves an error code (or null) to user-friendly banner content.
 * Unknown codes fall back to a generic message.
 */
export function getErrorBannerInfo(code: string | null | undefined): ErrorBannerInfo {
  if (code && ERROR_BANNER_MAP[code]) return ERROR_BANNER_MAP[code]!;
  return UNKNOWN_BANNER;
}

/**
 * Whether the code has a specific, actionable fix (vs. a generic fallback).
 * Drives whether the banner shows the settings link prominently.
 */
export function hasActionableError(code: string | null | undefined): boolean {
  return Boolean(code && code !== 'UNKNOWN' && ERROR_BANNER_MAP[code]);
}

// Custom event name for opening the settings dialog at a specific tab from
// anywhere in the app (e.g. the ErrorBanner). The SettingsDialog listens.
export const OPEN_SETTINGS_EVENT = 'lemniscate:open-settings';

/** Dispatches a global event to open the settings dialog at a tab. */
export function openSettingsTab(tab: SettingsTab): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { tab } }));
}
