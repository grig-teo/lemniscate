// @vitest-environment jsdom
/**
 * Locking tests for scroll-position-aware auto-follow in the agent console:
 * new output only pins the view to the bottom while the user is already at
 * the bottom; scrolling up disengages follow mode and reveals a
 * "Jump to latest" button that re-engages it on demand.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ConsoleLog } from '@/components/console/ConsoleLog';
import type { LogLine } from '@/components/console/useTaskConsole';

// vitest runs with globals:false, so testing-library's auto-cleanup is not
// registered; unmount explicitly between tests.
afterEach(() => cleanup());

const idleHistory = { isLoading: false, isError: false, error: null };

function lines(prefix: string, count: number, offset = 0): LogLine[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `${prefix}-${offset + i}`,
    text: `${prefix} line ${offset + i}`,
  }));
}

function renderConsole(liveLogs: LogLine[] = []) {
  return render(
    <ConsoleLog
      historyQuery={idleHistory}
      historyLogs={[]}
      liveLogs={liveLogs}
      streamError={false}
    />,
  );
}

function scrollContainer(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[aria-live="polite"]');
  if (!el) throw new Error('scroll container not found');
  return el as HTMLElement;
}

/** jsdom reports 0 for layout metrics; pin them to simulate a full log. */
function mockScrollMetrics(
  el: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    value: metrics.clientHeight,
  });
  el.scrollTop = metrics.scrollTop;
}

async function scrollTo(el: HTMLElement, scrollTop: number) {
  el.scrollTop = scrollTop;
  await act(async () => {
    fireEvent.scroll(el);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function jumpButton(): HTMLElement | null {
  return screen.queryByRole('button', { name: 'Jump to latest logs' });
}

describe('ConsoleLog auto-follow', () => {
  it('pins to the bottom on new output while the user is at the bottom', () => {
    const { container, rerender } = renderConsole(lines('live', 3));
    const el = scrollContainer(container);
    mockScrollMetrics(el, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });

    rerender(
      <ConsoleLog
        historyQuery={idleHistory}
        historyLogs={[]}
        liveLogs={lines('live', 6)}
        streamError={false}
      />,
    );

    expect(el.scrollTop).toBe(el.scrollHeight);
    expect(jumpButton()).toBeNull();
  });

  it('keeps the scroll position and shows the jump button when scrolled up', async () => {
    const { container, rerender } = renderConsole(lines('live', 3));
    const el = scrollContainer(container);
    mockScrollMetrics(el, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });
    await scrollTo(el, 100);

    await waitFor(() => expect(jumpButton()).toBeTruthy());

    rerender(
      <ConsoleLog
        historyQuery={idleHistory}
        historyLogs={[]}
        liveLogs={lines('live', 9)}
        streamError={false}
      />,
    );

    expect(el.scrollTop).toBe(100);
    expect(jumpButton()).toBeTruthy();
  });

  it('counts entries that arrive while scrolled up and resets on jump', async () => {
    const { container, rerender } = renderConsole(lines('live', 3));
    const el = scrollContainer(container);
    mockScrollMetrics(el, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });
    await scrollTo(el, 100);

    rerender(
      <ConsoleLog
        historyQuery={idleHistory}
        historyLogs={[]}
        liveLogs={lines('live', 6)}
        streamError={false}
      />,
    );

    await waitFor(() => expect(jumpButton()?.textContent).toContain('3'));
  });

  it('resumes following and hides the button after clicking jump to latest', async () => {
    const { container, rerender } = renderConsole(lines('live', 3));
    const el = scrollContainer(container);
    mockScrollMetrics(el, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });
    await scrollTo(el, 100);
    await waitFor(() => expect(jumpButton()).toBeTruthy());

    await act(async () => {
      fireEvent.click(jumpButton() as HTMLElement);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(el.scrollTop).toBe(el.scrollHeight);
    await scrollTo(el, el.scrollHeight);
    await waitFor(() => expect(jumpButton()).toBeNull());

    rerender(
      <ConsoleLog
        historyQuery={idleHistory}
        historyLogs={[]}
        liveLogs={lines('live', 5)}
        streamError={false}
      />,
    );
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  it('re-engages follow mode when the user scrolls back to the bottom manually', async () => {
    const { container } = renderConsole(lines('live', 3));
    const el = scrollContainer(container);
    mockScrollMetrics(el, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });
    await scrollTo(el, 100);
    await waitFor(() => expect(jumpButton()).toBeTruthy());

    await scrollTo(el, 1000 - 200);

    await waitFor(() => expect(jumpButton()).toBeNull());
  });

  it('treats positions within the bottom threshold as still following', async () => {
    const { container } = renderConsole(lines('live', 3));
    const el = scrollContainer(container);
    mockScrollMetrics(el, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });
    await scrollTo(el, 1000 - 200 - 40);

    expect(jumpButton()).toBeNull();
  });

  it('opens scrolled to the bottom when the task already has a full log history', () => {
    const { container } = render(
      <ConsoleLog
        historyQuery={idleHistory}
        historyLogs={lines('history', 200)}
        liveLogs={[]}
        streamError={false}
      />,
    );
    const el = scrollContainer(container);
    mockScrollMetrics(el, { scrollHeight: 5000, clientHeight: 200, scrollTop: 0 });

    // First history paint must pin the view to the latest entry (the whole
    // list is delivered in one batch, so the user lands at the newest log).
    expect(el.scrollTop).toBe(el.scrollHeight);
    expect(jumpButton()).toBeNull();
  });
});
