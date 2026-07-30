// @vitest-environment jsdom
/**
 * Faithful simulation: in a real browser the programmatic scrollTo DOES move
 * scrollTop. We patch the element so scrollTo updates scrollTop like a browser,
 * then verify follow stays engaged across many appends.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LemcoreRunView } from '@/components/console/LemcoreRunView';
import type { AgentStep } from '@/lib/agent-step';

afterEach(() => cleanup());

function makeSteps(count: number, prefix = 's'): AgentStep[] {
  return Array.from({ length: count }, (_, i) => ({
    stepId: `${prefix}-${i}`,
    eventKey: `${prefix}-${i}-e`,
    status: 'done' as const,
    kind: 'tool' as const,
    tool: 'bash',
    title: `${prefix} step ${i}`,
    detail: 'x'.repeat(400),
  }));
}

function renderView(steps: AgentStep[] = []) {
  return render(
    <LemcoreRunView steps={steps} running streamError={false} isLoading={false} isError={false} />,
  );
}

function scrollContainer(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[aria-live="polite"]');
  if (!el) throw new Error('scroll container not found');
  return el as HTMLElement;
}

/** Make the element behave like a real browser: scrollTo sets scrollTop and fires scroll. */
function makeBrowserLike(el: HTMLElement) {
  let sh = 1000;
  const ch = 200;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => sh, set: (v) => { sh = v; } });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => ch });
  el.scrollTo = ((x?: number | ScrollToOptions, y?: number) => {
    const top = typeof x === 'object' && x !== null ? (x.top ?? 0) : (y ?? 0);
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll', { bubbles: false }));
  }) as typeof el.scrollTo;
  return { setSh: (v: number) => { sh = v; } };
}

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}

describe('Faithful async follow', () => {
  it('auto-scrolls on every append when following', async () => {
    const { container, rerender } = renderView(makeSteps(3));
    const el = scrollContainer(container);
    const ctrl = makeBrowserLike(el);

    ctrl.setSh(600);
    el.scrollTop = 400; // user at bottom
    await flush();

    // append: content grows
    rerender(
      <LemcoreRunView steps={makeSteps(6)} running streamError={false} isLoading={false} isError={false} />,
    );
    ctrl.setSh(900);
    await flush();
    expect(el.scrollTop).toBe(900);

    // append again
    rerender(
      <LemcoreRunView steps={makeSteps(9)} running streamError={false} isLoading={false} isError={false} />,
    );
    ctrl.setSh(1200);
    await flush();
    expect(el.scrollTop).toBe(1200);
    expect(screen.queryByRole('button', { name: 'Jump to latest steps' })).toBeNull();
  });
});
