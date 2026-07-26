import { describe, expect, it } from 'vitest';

import { BUDGET_WARNING_RATIO, formatCostUsd, formatTokens, tokenBudgetState } from '@/lib/token-usage';

// Token/cost formatting and the run-budget warning rule (badge + console
// header read these; the backend owns the raw numbers).

describe('formatTokens', () => {
  it('passes small counts through', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('compacts thousands and millions with one trimmed decimal', () => {
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(12_500)).toBe('12.5k');
    expect(formatTokens(999_999)).toBe('1000k');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});

describe('formatCostUsd', () => {
  it('formats adaptive precision and floors sub-cent amounts', () => {
    expect(formatCostUsd(0)).toBe('$0.00');
    expect(formatCostUsd(0.004)).toBe('<$0.01');
    expect(formatCostUsd(0.123)).toBe('$0.123');
    expect(formatCostUsd(7)).toBe('$7.00');
  });
});

describe('tokenBudgetState', () => {
  it('is none without a budget', () => {
    expect(tokenBudgetState(1000, null)).toBe('none');
    expect(tokenBudgetState(1000, undefined)).toBe('none');
    expect(tokenBudgetState(1000, 0)).toBe('none');
  });

  it('warns at the 80% threshold and exceeds at the cap', () => {
    const at79 = Math.floor(1000 * BUDGET_WARNING_RATIO) - 1;
    expect(tokenBudgetState(at79, 1000)).toBe('ok');
    expect(tokenBudgetState(800, 1000)).toBe('warning');
    expect(tokenBudgetState(999, 1000)).toBe('warning');
    expect(tokenBudgetState(1000, 1000)).toBe('exceeded');
    expect(tokenBudgetState(1200, 1000)).toBe('exceeded');
  });
});
