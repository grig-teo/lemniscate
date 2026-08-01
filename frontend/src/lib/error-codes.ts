/**
 * Frontend mapping from backend TaskErrorCode strings to user-friendly
 * banner content. Each code produces a title/hint message id (resolved via
 * react-intl so the banner is translatable) and (when applicable) a
 * settings tab the user should visit to fix the issue.
 *
 * Codes mirror the backend enum in backend/src/lib/errors.ts. The actual
 * copy lives in the locale catalogs as `error.<CODE>.title` /
 * `error.<CODE>.hint` — see frontend/src/locales/en.json.
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
  | 'PROPOSAL_GENERATION_FAILED'
  | 'UNKNOWN'
  | (string & {});

/** Settings dialog tab that addresses this error, or undefined. */
export type SettingsTab = 'agent' | 'llm' | 'git' | 'repos' | 'notifications' | 'usage' | 'vps';

export interface ErrorBannerInfo {
  /** The error code this banner describes (falls back to 'UNKNOWN'). */
  code: string;
  /** react-intl message id for the banner title: `error.<CODE>.title`. */
  titleId: string;
  /** react-intl message id for the banner hint: `error.<CODE>.hint`. */
  hintId: string;
  /** Settings tab the user can open to fix the issue; absent when no direct fix exists. */
  settingsTab?: SettingsTab;
}

const ERROR_CODES = [
  'LLM_AUTH_FAILED',
  'LLM_RATE_LIMITED',
  'LLM_QUOTA_EXCEEDED',
  'LLM_TIMEOUT',
  'LLM_CONNECTION_FAILED',
  'LLM_SERVER_ERROR',
  'GIT_AUTH_FAILED',
  'GIT_PERMISSION_DENIED',
  'GIT_WORKFLOW_SCOPE',
  'PROPOSAL_GENERATION_FAILED',
] as const;

const SETTINGS_TAB_BY_CODE: Partial<Record<string, SettingsTab>> = {
  LLM_AUTH_FAILED: 'llm',
  LLM_RATE_LIMITED: 'llm',
  LLM_QUOTA_EXCEEDED: 'llm',
  LLM_TIMEOUT: 'llm',
  LLM_CONNECTION_FAILED: 'llm',
  GIT_AUTH_FAILED: 'git',
  GIT_PERMISSION_DENIED: 'git',
  GIT_WORKFLOW_SCOPE: 'git',
  PROPOSAL_GENERATION_FAILED: 'llm',
};

function bannerFor(code: string): ErrorBannerInfo {
  return {
    code,
    titleId: `error.${code}.title`,
    hintId: `error.${code}.hint`,
    settingsTab: SETTINGS_TAB_BY_CODE[code],
  };
}

const ERROR_BANNER_MAP: Record<string, ErrorBannerInfo> = Object.fromEntries(
  ERROR_CODES.map((code) => [code, bannerFor(code)]),
);

const UNKNOWN_BANNER: ErrorBannerInfo = bannerFor('UNKNOWN');

/**
 * Resolves an error code (or null) to user-friendly banner message ids.
 * Unknown codes fall back to the generic 'UNKNOWN' messages.
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
