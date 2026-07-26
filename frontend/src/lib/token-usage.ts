/**
 * Token/cost formatting and the run-budget warning rule shared by the task
 * tokens badge and the console header. The backend owns the raw numbers
 * (Task.llmTokensUsed + the effective maxTokensPerRun); these helpers only
 * decide how they look and when they demand attention.
 */

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

/** Compact token count: 999 → '999', 12_500 → '12.5k', 2_500_000 → '2.5M'. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trimDecimal(n / 1000)}k`;
  return `${trimDecimal(n / 1_000_000)}M`;
}

/** Adaptive USD: $0.00, <$0.01 for sub-cent, $0.123 under a dollar, $7.00 above. */
export function formatCostUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export type TokenBudgetState = 'none' | 'ok' | 'warning' | 'exceeded';

/** Fraction of the run budget at which the badge switches to the warning style. */
export const BUDGET_WARNING_RATIO = 0.8;

/** Budget consumption state; 'none' when the task's config has no run budget. */
export function tokenBudgetState(used: number, max: number | null | undefined): TokenBudgetState {
  if (max == null || max <= 0) return 'none';
  if (used >= max) return 'exceeded';
  if (used >= max * BUDGET_WARNING_RATIO) return 'warning';
  return 'ok';
}
