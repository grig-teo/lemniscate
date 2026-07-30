// @vitest-environment jsdom
/**
 * Rendering tests for ConsoleLogLine: raw agent console lines surface as
 * structured UI rows (command chip, model metric, error banner, file row)
 * instead of an undifferentiated monospace dump.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ConsoleLogLine } from '@/components/console/ConsoleLogLine';

afterEach(() => cleanup());

describe('ConsoleLogLine', () => {
  it('renders `$ git …` echoes inside a command chip with the prompt', () => {
    const { container } = render(<ConsoleLogLine text="$ git config user.name lemniscate-agent" />);
    const code = container.querySelector('code');
    expect(code?.textContent).toBe('$ git config user.name lemniscate-agent');
  });

  it('renders `→ LLM call (model)` with the model as a badge', () => {
    render(<ConsoleLogLine text="→ LLM call (k3)" />);
    expect(screen.getByText('k3')).toBeTruthy();
    expect(screen.getByText(/Calling the model/)).toBeTruthy();
  });

  it('renders `← LLM done …` with compact duration and tokens', () => {
    render(<ConsoleLogLine text="← LLM done in 10.6s, ~12500 tokens" />);
    expect(screen.getByText('Model responded in 10.6s · ~12.5k tokens')).toBeTruthy();
  });

  it('renders `LLM retry …` as a rate-limit notice', () => {
    render(<ConsoleLogLine text="  LLM retry 2/5 in 4000ms (rate limited)" />);
    expect(screen.getByText('Rate limit')).toBeTruthy();
    expect(screen.getByText(/LLM retry 2\/5 in 4000ms/)).toBeTruthy();
  });

  it('renders `⇄ model switch …` as a model-switch notice', () => {
    render(
      <ConsoleLogLine text="⇄ model switch requested → k3 [Kimi-K3] — takes effect on the next LLM call" />,
    );
    expect(screen.getByText('Model switch')).toBeTruthy();
  });

  it('renders `error: …` lines without the prefix', () => {
    render(<ConsoleLogLine text="error: push access denied" />);
    expect(screen.getByText('push access denied')).toBeTruthy();
    expect(screen.queryByText(/error: push/)).toBeNull();
  });

  it('renders `✎ path (action)` with the path and action label', () => {
    render(<ConsoleLogLine text="✎ src/app.ts (modified)" />);
    expect(screen.getByText('src/app.ts')).toBeTruthy();
    expect(screen.getByText('(modified)')).toBeTruthy();
  });

  it('renders plain status lines as info rows with the full text', () => {
    render(<ConsoleLogLine text="scanning repository into codebase graph" />);
    expect(screen.getByText('scanning repository into codebase graph')).toBeTruthy();
  });
});
