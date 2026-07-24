import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertPushAccess: vi.fn(),
  llmFindFirst: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('../src/lib/llm-client.js', () => ({ chatCompletions: vi.fn() }));
vi.mock('../src/lib/agent-git.js', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/prisma.js', () => ({
  prisma: { llmConfig: { findFirst: mocks.llmFindFirst } },
}));
vi.mock('../src/lib/crypto.js', () => ({ decrypt: vi.fn(() => 'sk-test') }));
vi.mock('../src/lib/git-providers.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/git-providers.js')>();
  return { ...original, assertRepoPushAccess: mocks.assertPushAccess };
});
vi.mock('../src/lib/token-refresh.js', () => ({
  withGitlabRefreshRetry: vi.fn((_connection: unknown, fn: (t: string) => unknown) =>
    fn('provider-token'),
  ),
}));
vi.mock('../src/lib/task-attachments.js', () => ({ parseTaskThinkingLevel: vi.fn(() => null) }));

import { prepareAgentRuntime } from '../src/lib/agent-runtime.js';

// SSRF hardening of the worker's runtime construction: the repository clone
// URL and the resolved LLM baseUrl must be public http(s) before any clone
// or LLM call happens. IP literals keep these tests DNS-free.

const PUBLIC_REPO_URL = 'https://93.184.216.34/acme/repo.git';

function makeRepository(overrides: Record<string, unknown> = {}) {
  return {
    id: 'repo-1',
    fullName: 'acme/repo',
    cloneUrl: PUBLIC_REPO_URL,
    defaultBranch: 'main',
    llmConfigId: null,
    connection: {
      id: 'conn-1',
      userId: 'user-1',
      provider: 'github',
      baseUrl: null,
      tokenType: 'pat',
      accessTokenEnc: 'enc',
    },
    ...overrides,
  } as never;
}

function stubLlmConfig(baseUrl = 'https://93.184.216.34/v1'): void {
  mocks.llmFindFirst.mockResolvedValue({
    id: 'llm-1',
    userId: 'user-1',
    baseUrl,
    apiKeyEnc: 'enc',
    model: 'model-x',
    thinkingLevel: 'off',
    customHeaders: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPushAccess.mockResolvedValue(undefined);
  stubLlmConfig();
});

describe('prepareAgentRuntime URL safety', () => {
  it('rejects a non-http(s) clone URL before cloning', async () => {
    const repository = makeRepository({ cloneUrl: 'ssh://git@github.com/acme/repo.git' });
    await expect(prepareAgentRuntime(null, repository, [])).rejects.toThrow(/scheme/i);
  });

  it('rejects a clone URL that targets a private address', async () => {
    const repository = makeRepository({ cloneUrl: 'http://127.0.0.1:3000/acme/repo.git' });
    await expect(prepareAgentRuntime(null, repository, [])).rejects.toThrow(/private/i);
  });

  it('rejects an LLM baseUrl that targets a private address', async () => {
    stubLlmConfig('http://169.254.169.254/v1');
    await expect(prepareAgentRuntime(null, makeRepository(), [])).rejects.toThrow(/private/i);
  });

  it('returns a tokenless clone URL and per-invocation git auth', async () => {
    const secrets: string[] = [];
    const repository = makeRepository({
      cloneUrl: 'https://oauth2:embedded-t0k@93.184.216.34/acme/repo.git',
    });
    const ctx = await prepareAgentRuntime(null, repository, secrets);
    expect(ctx.cloneUrl).toBe(PUBLIC_REPO_URL);
    expect(ctx.cloneUrl).not.toContain('embedded-t0k');
    expect(ctx.gitAuth).toEqual({ username: 'oauth2', token: 'provider-token' });
    expect(secrets).toContain('provider-token');
  });
});
