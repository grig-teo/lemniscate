// @vitest-environment jsdom
/**
 * Follow/sticky-scroll behavior for the lemcore run view.
 *
 * In a real browser, programmatic `scrollTo` moves `scrollTop` and fires a
 * `scroll` event. jsdom does neither, so we make the scroll container
 * "browser-like": `scrollTo` sets `scrollTop` and dispatches `scroll`, and
 * direct user scrolls dispatch `scroll` too. This lets us exercise the full
 * engage/disengage/re-engage lifecycle of `useFollowLatest`.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

interface BrowserLikeCtrl {
  setSh: (v: number) => void;
}

/** Make the element behave like a real browser: scrollTo sets scrollTop and fires scroll. */
function makeBrowserLike(el: HTMLElement): BrowserLikeCtrl {
  let sh = 1000;
  const ch = 200;
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => sh,
    set: (v: number) => {
      sh = v;
    },
  });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => ch });
  el.scrollTo = (((x?: number | ScrollToOptions, y?: number) => {
    const top = typeof x === 'object' && x !== null ? (x.top ?? 0) : (y ?? 0);
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll', { bubbles: false }));
  }) as unknown) as typeof el.scrollTo;
  return { setSh: (v: number) => void (sh = v) };
}

/** Move scrollTop (user drag/wheel) and notify the listener. */
function userScrollTo(el: HTMLElement, top: number) {
  el.scrollTop = top;
  el.dispatchEvent(new Event('scroll', { bubbles: false }));
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

/**
 * Append new content: in a real browser the DOM grows (scrollHeight increases)
 * *before* the follow effect re-runs, so the effect reads the new height. We
 * mirror that by setting the taller height first, then rerendering.
 */
const appendSteps = (
  rerender: (ui: React.ReactElement) => void,
  ctrl: BrowserLikeCtrl,
  count: number,
  newHeight: number,
) => {
  ctrl.setSh(newHeight);
  rerender(
    <LemcoreRunView steps={makeSteps(count)} running streamError={false} isLoading={false} isError={false} />,
  );
};

const jumpButton = () => screen.queryByRole('button', { name: 'Jump to latest steps' });

describe('Faithful async follow', () => {
  it('auto-scrolls on every append while following (pinned at bottom)', async () => {
    const { container, rerender } = renderView(makeSteps(3));
    const el = scrollContainer(container);
    const ctrl = makeBrowserLike(el);

    ctrl.setSh(600);
    userScrollTo(el, 400); // near bottom (600 - 400 - 200 == 0 <= 40)
    await flush();

    appendSteps(rerender, ctrl, 6, 900);
    await flush();
    expect(el.scrollTop).toBe(900);

    appendSteps(rerender, ctrl, 9, 1200);
    await flush();
    expect(el.scrollTop).toBe(1200);
    expect(jumpButton()).toBeNull();
  });

  it('disengages follow when the user scrolls up and reveals the jump button', async () => {
    const { container, rerender } = renderView(makeSteps(6));
    const el = scrollContainer(container);
    const ctrl = makeBrowserLike(el);

    // Start pinned at the bottom.
    ctrl.setSh(900);
    userScrollTo(el, 700); // 900 - 700 - 200 == 0 -> following
    await flush();
    expect(jumpButton()).toBeNull();

    // User scrolls up to read history (far from bottom).
    userScrollTo(el, 100); // 900 - 100 - 200 == 600 > 40 -> disengage
    await flush();
    expect(jumpButton()).not.toBeNull();

    // New output arrives while scrolled up: view must NOT auto-scroll.
    appendSteps(rerender, ctrl, 9, 1200);
    await flush();
    expect(el.scrollTop).toBe(100); // unchanged
    expect(jumpButton()).not.toBeNull();
  });

  it('re-engages follow via the jump button and pins again on subsequent appends', async () => {
    const { container, rerender } = renderView(makeSteps(6));
    const el = scrollContainer(container);
    const ctrl = makeBrowserLike(el);

    ctrl.setSh(900);
    userScrollTo(el, 700); // following
    await flush();

    userScrollTo(el, 100); // scroll up -> disengage
    await flush();
    expect(jumpButton()).not.toBeNull();

    appendSteps(rerender, ctrl, 9, 1200);
    await flush();
    expect(el.scrollTop).toBe(100); // still parked at old position

    // Click "Jump to latest steps": pins to bottom, re-enables follow.
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest steps' }));
    await flush();
    expect(el.scrollTop).toBe(1200); // jumped to bottom
    expect(jumpButton()).toBeNull(); // button hidden again

    // A further append must auto-scroll now that follow is re-engaged.
    appendSteps(rerender, ctrl, 12, 1500);
    await flush();
    expect(el.scrollTop).toBe(1500);
    expect(jumpButton()).toBeNull();
  });
});
