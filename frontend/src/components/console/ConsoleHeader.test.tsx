import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ChangesBadge } from '@/components/console/ConsoleHeader';
import type { ChangeSummary } from '@/lib/session-changes';

function makeSummary(overrides: Partial<ChangeSummary> = {}): ChangeSummary {
  return {
    changes: [],
    count: 0,
    additions: 0,
    deletions: 0,
    ...overrides,
  };
}

describe('ChangesBadge', () => {
  it('renders nothing while the session has no recorded changes', () => {
    const html = renderToStaticMarkup(
      <ChangesBadge summary={makeSummary()} onOpen={() => undefined} />,
    );
    expect(html).toBe('');
  });

  it('shows the changes count with the +/− totals, GitHub-style', () => {
    const html = renderToStaticMarkup(
      <ChangesBadge summary={makeSummary({ count: 3, additions: 12, deletions: 4 })} onOpen={() => undefined} />,
    );
    expect(html).toContain('3 changes');
    expect(html).toContain('+12');
    expect(html).toContain('−4');
  });

  it('uses the singular label for exactly one change', () => {
    const html = renderToStaticMarkup(
      <ChangesBadge summary={makeSummary({ count: 1, additions: 1, deletions: 0 })} onOpen={() => undefined} />,
    );
    expect(html).toContain('1 change');
    expect(html).not.toContain('1 changes');
  });

  it('is a button that opens the changes dialog', () => {
    const onOpen = vi.fn();
    const html = renderToStaticMarkup(<ChangesBadge summary={makeSummary({ count: 2 })} onOpen={onOpen} />);
    expect(html).toContain('<button');
    expect(html).toContain('View changes');
  });
});
