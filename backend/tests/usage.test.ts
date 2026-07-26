import { describe, expect, it } from 'vitest';
import {
  buildUsageReport,
  estimatedCostUsd,
  resolveEffectiveConfig,
  taskUsagePayload,
  type UsageConfigInfo,
  type UsageTaskRow,
} from '../src/lib/usage.js';

// Unit tests for the token-usage surfacing rules (single home: lib/usage.ts):
// effective-config resolution (task → repo → user default), prompt/completion
// cost estimation (absent, never guessed, when prices are unset), the task DTO
// usage fragment, and the /api/usage aggregation.

const priced: UsageConfigInfo = {
  id: 'cfg-priced',
  isDefault: false,
  maxTokensPerRun: 500_000,
  inputPricePerMillion: 2,
  outputPricePerMillion: 10,
};

const unpriced: UsageConfigInfo = {
  id: 'cfg-unpriced',
  isDefault: true,
  maxTokensPerRun: null,
  inputPricePerMillion: null,
  outputPricePerMillion: null,
};

function taskRow(overrides: Partial<UsageTaskRow> = {}): UsageTaskRow {
  return {
    repositoryId: 'repo-1',
    createdAt: new Date('2026-07-20T10:00:00Z'),
    llmTokensUsed: 1500,
    llmPromptTokens: 1000,
    llmCompletionTokens: 500,
    llmConfigId: null,
    ...overrides,
  };
}

describe('resolveEffectiveConfig', () => {
  it('prefers the task config over repo and default', () => {
    expect(resolveEffectiveConfig([priced, unpriced], 'cfg-priced', 'cfg-unpriced')).toBe(priced);
  });

  it('falls back to the repo config when the task has none', () => {
    expect(resolveEffectiveConfig([priced, unpriced], null, 'cfg-priced')).toBe(priced);
  });

  it('falls back to the user default, then to the lowest id', () => {
    expect(resolveEffectiveConfig([priced, unpriced], null, null)).toBe(unpriced);
    const noDefault = { ...unpriced, id: 'cfg-a', isDefault: false };
    expect(resolveEffectiveConfig([priced, noDefault], null, null)).toBe(noDefault);
  });

  it('skips an unknown task id and continues down the chain', () => {
    expect(resolveEffectiveConfig([unpriced], 'cfg-deleted', null)).toBe(unpriced);
  });

  it('returns null when the user has no enabled configs', () => {
    expect(resolveEffectiveConfig([], 'cfg-priced', null)).toBeNull();
  });
});

describe('estimatedCostUsd', () => {
  it('prices the prompt/completion split per million tokens', () => {
    expect(estimatedCostUsd(1_000_000, 500_000, priced)).toBe(7);
  });

  it('is null without a config or when either price is unset', () => {
    expect(estimatedCostUsd(1000, 500, null)).toBeNull();
    expect(estimatedCostUsd(1000, 500, unpriced)).toBeNull();
    expect(
      estimatedCostUsd(1000, 500, { inputPricePerMillion: 2, outputPricePerMillion: null }),
    ).toBeNull();
  });
});

describe('taskUsagePayload', () => {
  it('exposes the usage columns and the effective budget', () => {
    expect(taskUsagePayload(taskRow(), priced)).toEqual({
      llmTokensUsed: 1500,
      llmPromptTokens: 1000,
      llmCompletionTokens: 500,
      maxTokensPerRun: 500_000,
      estimatedCostUsd: 0.007,
    });
  });

  it('omits the cost when the split is unknown (pre-split rows)', () => {
    const payload = taskUsagePayload(
      taskRow({ llmPromptTokens: null, llmCompletionTokens: null }),
      priced,
    );
    expect(payload).toEqual({
      llmTokensUsed: 1500,
      llmPromptTokens: null,
      llmCompletionTokens: null,
      maxTokensPerRun: 500_000,
    });
    expect('estimatedCostUsd' in payload).toBe(false);
  });

  it('omits the cost when the config has no prices', () => {
    const payload = taskUsagePayload(taskRow(), unpriced);
    expect('estimatedCostUsd' in payload).toBe(false);
  });

  it('reports a null budget when no config resolves', () => {
    expect(taskUsagePayload(taskRow(), null).maxTokensPerRun).toBeNull();
  });
});

describe('buildUsageReport', () => {
  const repos = [
    { id: 'repo-1', name: 'alpha', fullName: 'me/alpha', llmConfigId: null },
    { id: 'repo-2', name: 'beta', fullName: 'me/beta', llmConfigId: null },
  ];
  const since = new Date('2026-07-01T00:00:00Z');

  it('totals the window and groups by repository and UTC day', () => {
    const report = buildUsageReport({
      tasks: [
        taskRow({ llmTokensUsed: 3000, llmPromptTokens: 2000, llmCompletionTokens: 1000 }),
        taskRow({ createdAt: new Date('2026-07-21T01:00:00Z') }),
        taskRow({ repositoryId: 'repo-2', llmTokensUsed: 500, llmPromptTokens: 400, llmCompletionTokens: 100 }),
      ],
      repositories: repos,
      configs: [unpriced],
      period: '30d',
      since,
    });
    expect(report.period).toBe('30d');
    expect(report.since).toBe(since.toISOString());
    expect(report.totals).toEqual({ totalTokens: 5000, promptTokens: 3400, completionTokens: 1600 });
    expect(report.byRepository.map((b) => [b.repositoryId, b.totalTokens])).toEqual([
      ['repo-1', 4500],
      ['repo-2', 500],
    ]);
    expect(report.byRepository[0]).toMatchObject({ name: 'alpha', fullName: 'me/alpha' });
    expect(report.byDay.map((b) => [b.day, b.totalTokens])).toEqual([
      ['2026-07-20', 3500],
      ['2026-07-21', 1500],
    ]);
  });

  it('estimates cost only for priced tasks and drops the key when nothing is priced', () => {
    const pricedTask = taskRow({
      llmPromptTokens: 1_000_000,
      llmCompletionTokens: 500_000,
      llmTokensUsed: 1_500_000,
      llmConfigId: 'cfg-priced',
    });
    const unpricedTask = taskRow({ repositoryId: 'repo-2' });
    const report = buildUsageReport({
      tasks: [pricedTask, unpricedTask],
      repositories: repos,
      configs: [priced, unpriced],
      period: '7d',
      since,
    });
    expect(report.totals.estimatedCostUsd).toBe(7);
    expect(report.byRepository.find((b) => b.repositoryId === 'repo-1')?.estimatedCostUsd).toBe(7);
    expect('estimatedCostUsd' in (report.byRepository.find((b) => b.repositoryId === 'repo-2') ?? {})).toBe(false);

    const noPrices = buildUsageReport({
      tasks: [unpricedTask],
      repositories: repos,
      configs: [unpriced],
      period: '7d',
      since,
    });
    expect('estimatedCostUsd' in noPrices.totals).toBe(false);
  });

  it('treats pre-split rows as token-only (they never contribute cost)', () => {
    const legacy = taskRow({ llmPromptTokens: null, llmCompletionTokens: null, llmConfigId: 'cfg-priced' });
    const report = buildUsageReport({
      tasks: [legacy],
      repositories: repos,
      configs: [priced],
      period: '7d',
      since,
    });
    expect(report.totals.totalTokens).toBe(1500);
    expect(report.totals.promptTokens).toBe(0);
    expect('estimatedCostUsd' in report.totals).toBe(false);
  });

  it('returns zeroed totals and empty groups for a quiet window', () => {
    const report = buildUsageReport({
      tasks: [],
      repositories: repos,
      configs: [priced],
      period: '7d',
      since,
    });
    expect(report.totals).toEqual({ totalTokens: 0, promptTokens: 0, completionTokens: 0 });
    expect(report.byRepository).toEqual([]);
    expect(report.byDay).toEqual([]);
  });
});
