import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Task, TaskStatus } from '@/lib/hooks';

import { TokenSplitIndicator } from '@/components/console/ConsoleFooterStatusBar';

// Locking tests for the footer's right-side pane — the LLM token split
// indicator. It surfaces the prompt/completion split the worker persists after
// every provider call (tokens SENT vs RECEIVED), hiding itself until a split
// exists so the bar doesn't grow an empty right cluster. The footer itself is
// only mounted while a task is running or reviewing code (ConsolePane gates on
// `isRunningStatus`), so only those statuses matter here — but the indicator is
// a pure function of the task row, so the status field is irrelevant to it.

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    repositoryId: 'r1',
    kind: 'prompt',
    title: 'Working on something',
    status: 'running' as TaskStatus,
    archivedAt: null,
    llmTokensUsed: 0,
    createdAt: '2026-07-29T00:00:00Z',
    updatedAt: '2026-07-29T00:00:00Z',
    ...overrides,
  };
}

describe('TokenSplitIndicator', () => {
  it('renders nothing until the task has a recorded token split', () => {
    const html = renderToStaticMarkup(<TokenSplitIndicator task={makeTask()} />);
    expect(html).toBe('');
  });

  it('hides itself for legacy tasks where both split columns are null', () => {
    const html = renderToStaticMarkup(
      <TokenSplitIndicator task={makeTask({ llmPromptTokens: null, llmCompletionTokens: null })} />,
    );
    expect(html).toBe('');
  });

  it('shows the compact prompt/completion counts labelled sent/received', () => {
    const html = renderToStaticMarkup(
      <TokenSplitIndicator task={makeTask({ llmPromptTokens: 12_500, llmCompletionTokens: 500 })} />,
    );
    expect(html).toContain('data-testid="console-footer-token-split"');
    expect(html).toContain('12.5k');
    expect(html).toContain('500');
    expect(html).toContain('sent');
    expect(html).toContain('received');
  });

  it('explains the split in the title tooltip with full, un-compacted counts', () => {
    const html = renderToStaticMarkup(
      <TokenSplitIndicator task={makeTask({ llmPromptTokens: 12_500, llmCompletionTokens: 500 })} />,
    );
    expect(html).toContain('12,500 tokens');
    expect(html).toContain('500 tokens');
    expect(html).toContain('prompt');
    expect(html).toContain('completion');
  });

  it('fills the missing side with 0 instead of dropping it', () => {
    const html = renderToStaticMarkup(
      <TokenSplitIndicator task={makeTask({ llmPromptTokens: 1000, llmCompletionTokens: null })} />,
    );
    expect(html).toContain('1k');
    expect(html).toContain('0');
    expect(html).toContain('not recorded');
  });

  it('renders identically for a code-reviewing task (status is irrelevant to it)', () => {
    const running = renderToStaticMarkup(
      <TokenSplitIndicator task={makeTask({ status: 'running', llmPromptTokens: 800, llmCompletionTokens: 200 })} />,
    );
    const reviewing = renderToStaticMarkup(
      <TokenSplitIndicator
        task={makeTask({ status: 'reviewing_code', llmPromptTokens: 800, llmCompletionTokens: 200 })}
      />,
    );
    expect(running).toBe(reviewing);
  });
});