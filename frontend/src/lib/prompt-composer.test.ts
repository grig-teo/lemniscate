import { describe, expect, it } from 'vitest';

import type { LlmConfig, Repository } from '@/lib/hooks';
import {
  clampTextareaHeight,
  estimateTokens,
  isAcceptedImage,
  MAX_IMAGE_BYTES,
  resolveContextWindow,
  ringTone,
} from '@/lib/prompt-composer';

// Locking tests for the task-composer pure helpers: the token estimator
// (chars/4, mirroring the backend heuristic), the context-window resolution
// order, the ring tone thresholds, the textarea height clamp, and the image
// attachment accept rules.

function makeConfig(id: string, over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    id,
    name: id,
    baseUrl: 'https://llm.example.com/v1',
    model: 'm',
    hasApiKey: true,
    thinkingLevel: 'off',
    temperature: 0.2,
    maxTokens: 4096,
    contextWindow: 128_000,
    systemPromptExtra: null,
    timeoutSeconds: 120,
    maxRetries: 3,
    requestsPerMinute: 60,
    maxTokensPerRun: 0,
    customHeaders: null,
    isDefault: false,
    enabled: true,
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

function makeRepo(id: string, llmConfigId?: string | null): Repository {
  return {
    id,
    connectionId: 'c1',
    externalId: id,
    name: id,
    fullName: `ann/${id}`,
    cloneUrl: '',
    defaultBranch: 'main',
    autoPropose: false,
    autoCreatePr: true,
    autoReviewPr: false,
    autoMergePr: false,
    llmConfigId: llmConfigId ?? null,
    connection: { provider: 'github', username: 'ann' },
  };
}

describe('estimateTokens', () => {
  it('estimates chars/4, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('resolveContextWindow', () => {
  const configs = [
    makeConfig('cfg-default', { isDefault: true, contextWindow: 32_000 }),
    makeConfig('cfg-repo', { contextWindow: 200_000 }),
  ];

  it("uses the selected repo's llmConfigId config when set", () => {
    const repos = [makeRepo('r1', 'cfg-repo')];
    expect(resolveContextWindow(configs, repos, 'r1')).toBe(200_000);
  });

  it("falls back to the user's default config when the repo has none", () => {
    const repos = [makeRepo('r1')];
    expect(resolveContextWindow(configs, repos, 'r1')).toBe(32_000);
  });

  it('falls back to the default when the repo config id is unknown', () => {
    const repos = [makeRepo('r1', 'cfg-gone')];
    expect(resolveContextWindow(configs, repos, 'r1')).toBe(32_000);
  });

  it('uses the default config when the repo is unknown, null when no config resolves', () => {
    expect(resolveContextWindow([], [makeRepo('r1')], 'r1')).toBeNull();
    expect(resolveContextWindow(configs, [], '')).toBe(32_000);
    expect(resolveContextWindow([makeConfig('c', { isDefault: false })], [], '')).toBeNull();
  });
});

describe('ringTone', () => {
  it('is muted up to 60%, amber up to 90%, red above', () => {
    expect(ringTone(0)).toBe('muted');
    expect(ringTone(0.6)).toBe('muted');
    expect(ringTone(0.61)).toBe('amber');
    expect(ringTone(0.9)).toBe('amber');
    expect(ringTone(0.91)).toBe('red');
    expect(ringTone(1.5)).toBe('red');
  });
});

describe('clampTextareaHeight', () => {
  it('clamps the scroll height between min and max', () => {
    expect(clampTextareaHeight(10, 76, 116)).toBe(76);
    expect(clampTextareaHeight(100, 76, 116)).toBe(100);
    expect(clampTextareaHeight(500, 76, 116)).toBe(116);
  });
});

describe('isAcceptedImage', () => {
  it('accepts png/jpeg/webp/gif within the size cap', () => {
    expect(isAcceptedImage({ type: 'image/png', size: 100 })).toBe(true);
    expect(isAcceptedImage({ type: 'image/jpeg', size: MAX_IMAGE_BYTES })).toBe(true);
    expect(isAcceptedImage({ type: 'image/webp', size: 1 })).toBe(true);
    expect(isAcceptedImage({ type: 'image/gif', size: 1 })).toBe(true);
  });

  it('rejects other types and oversized files', () => {
    expect(isAcceptedImage({ type: 'image/svg+xml', size: 10 })).toBe(false);
    expect(isAcceptedImage({ type: 'text/plain', size: 10 })).toBe(false);
    expect(isAcceptedImage({ type: 'image/png', size: MAX_IMAGE_BYTES + 1 })).toBe(false);
  });
});
