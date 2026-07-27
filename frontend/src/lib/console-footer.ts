/**
 * Display rules for the agent console footer status bar (the bar shown while
 * a task is running or reviewing code): the session context indicator's
 * thresholds and the rate-limit window labels. The backend owns the raw
 * numbers (Task.llmTokensUsed + the effective contextWindow, and the quota
 * snapshot from GET /api/llm-configs/:id/quota); these helpers only decide
 * how they look. Unit-tested in console-footer.test.ts.
 */
import type { LlmQuotaInfo, QuotaWindow } from '@/lib/api-types';
import { formatTokens } from '@/lib/token-usage';

export type ContextUsageLevel = 'ok' | 'warning' | 'critical';

/** Context-window fill ratios where the indicator turns amber, then red. */
export const CONTEXT_WARNING_RATIO = 0.6;
export const CONTEXT_CRITICAL_RATIO = 0.85;

/** Fill level of the session's context window (green <60%, amber 60–85%, red >85%). */
export function contextUsageLevel(used: number, contextWindow: number): ContextUsageLevel {
  if (contextWindow <= 0) return 'ok';
  const fraction = used / contextWindow;
  if (fraction > CONTEXT_CRITICAL_RATIO) return 'critical';
  if (fraction >= CONTEXT_WARNING_RATIO) return 'warning';
  return 'ok';
}

/** '48.2k / 200k tokens' — the session context indicator label. */
export function contextUsageLabel(used: number, contextWindow: number): string {
  return `${formatTokens(used)} / ${formatTokens(contextWindow)} tokens`;
}

/** 'resets in 2h 5m' countdown; null for missing/malformed/past reset times. */
export function resetCountdownLabel(resetsAt: string | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt) - now;
  if (Number.isNaN(ms) || ms <= 0) return null;
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return 'resets in <1m';
  if (totalMinutes < 60) return `resets in ${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes === 0 ? `resets in ${hours}h` : `resets in ${hours}h ${minutes}m`;
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * One quota window as a footer line ('5-hour: 42,000/100,000 left · resets in
 * 5h'); 'n/a' when the provider sent a window without a remaining count, and
 * null when the window itself is absent (the footer skips it entirely).
 */
export function quotaWindowLabel(window: QuotaWindow | null, now = Date.now()): string | null {
  if (!window) return null;
  if (window.remaining == null) return `${window.label}: n/a`;
  const limit = window.limit != null ? `/${window.limit.toLocaleString()}` : '';
  const reset = resetCountdownLabel(window.resetsAt, now);
  return `${window.label}: ${window.remaining.toLocaleString()}${limit} left${reset ? ` · ${reset}` : ''}`;
}

/** Both windows of a quota snapshot as footer lines; empty when there is no snapshot. */
export function quotaLines(quota: LlmQuotaInfo | null | undefined, now = Date.now()): string[] {
  if (!quota) return [];
  return [quotaWindowLabel(quota.shortWindow, now), quotaWindowLabel(quota.weekly, now)].filter(
    (line): line is string => line !== null,
  );
}
