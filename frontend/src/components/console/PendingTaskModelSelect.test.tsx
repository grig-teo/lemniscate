// @vitest-environment jsdom
/**
 * Locking tests for the pending-task model dropdown (right-side pane, bottom,
 * left-aligned control of the proposal/prompt detail editor). It reuses the
 * composer's LlmConfigSelect
 * with `allowDefault={false}` (no inherit option — the per-task override is
 * always a concrete config), shows the currently selected config, and PATCHes
 * /api/tasks/:id with { llmConfigId } on change.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '@/lib/hooks';
import { createTestQueryClient } from '@/lib/queries/test-helpers';
import { PendingTaskModelSelect } from '@/components/console/PendingTaskModelSelect';

const baseTask: Task = {
  id: 't1',
  repositoryId: 'r1',
  kind: 'proposal',
  title: 'T',
  status: 'pending',
  archivedAt: null,
  llmTokensUsed: 0,
  llmConfigId: 'cfg-2',
  createdAt: '',
  updatedAt: '',
};

const configs = [
  {
    id: 'cfg-1',
    name: 'OpenAI',
    baseUrl: '',
    model: 'gpt-4o',
    hasApiKey: true,
    apiPattern: 'openai' as const,
    provider: null,
    thinkingLevel: 'off' as const,
    temperature: 0,
    maxTokens: 0,
    contextWindow: 0,
    systemPromptExtra: null,
    timeoutSeconds: 0,
    maxRetries: 0,
    requestsPerMinute: 0,
    maxTokensPerRun: null,
    inputPricePerMillion: null,
    outputPricePerMillion: null,
    customHeaders: null,
    isDefault: false,
    enabled: true,
    createdAt: '',
    updatedAt: '',
  },
  {
    ...{},
    id: 'cfg-2',
    name: 'Anthropic',
    baseUrl: '',
    model: 'claude-sonnet-4-5',
    hasApiKey: true,
    apiPattern: 'anthropic' as const,
    provider: null,
    thinkingLevel: 'off' as const,
    temperature: 0,
    maxTokens: 0,
    contextWindow: 0,
    systemPromptExtra: null,
    timeoutSeconds: 0,
    maxRetries: 0,
    requestsPerMinute: 0,
    maxTokensPerRun: null,
    inputPricePerMillion: null,
    outputPricePerMillion: null,
    customHeaders: null,
    isDefault: true,
    enabled: true,
    createdAt: '',
    updatedAt: '',
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSelect(task: Task = baseTask) {
  const queryClient = createTestQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <PendingTaskModelSelect task={task} />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe('PendingTaskModelSelect', () => {
  it('shows the currently selected config in the trigger', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ configs })),
    );
    renderSelect();

    await waitFor(() => {
      const trigger = screen.getByRole('combobox', { name: 'Model' });
      expect(trigger.textContent).toContain('Anthropic');
      expect(trigger.textContent).toContain('claude-sonnet-4-5');
    });
  });

  it('falls back to effectiveLlmConfigId when llmConfigId is null (inherited default)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ configs })),
    );
    renderSelect({ ...baseTask, llmConfigId: null, effectiveLlmConfigId: 'cfg-2' });

    await waitFor(() => {
      const trigger = screen.getByRole('combobox', { name: 'Model' });
      expect(trigger.textContent).toContain('Anthropic');
      expect(trigger.textContent).toContain('claude-sonnet-4-5');
    });
  });
});