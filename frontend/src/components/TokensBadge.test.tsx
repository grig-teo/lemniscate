import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { TokensBadge } from './TokensBadge';

// The token badge: hidden until a task burned tokens, neutral by default,
// amber at ≥80% of the run budget while running, red past the cap; shows the
// estimated cost when the backend provides one.

describe('TokensBadge', () => {
  it('renders nothing before any tokens were used', () => {
    expect(renderToStaticMarkup(<TokensBadge used={0} max={1000} running />)).toBe('');
  });

  it('renders the compact token count in a neutral style', () => {
    const html = renderToStaticMarkup(<TokensBadge used={12_500} max={null} running />);
    expect(html).toContain('12.5k');
    expect(html).not.toContain('amber');
    expect(html).not.toContain('destructive');
  });

  it('warns at 80% of the budget on a running task', () => {
    const html = renderToStaticMarkup(<TokensBadge used={850} max={1000} running />);
    expect(html).toContain('amber');
  });

  it('stays neutral at 80% once the task is no longer running', () => {
    const html = renderToStaticMarkup(<TokensBadge used={850} max={1000} running={false} />);
    expect(html).not.toContain('amber');
  });

  it('turns destructive at the cap on a running task', () => {
    const html = renderToStaticMarkup(<TokensBadge used={1001} max={1000} running />);
    expect(html).toContain('destructive');
  });

  it('appends the estimated cost when provided', () => {
    const html = renderToStaticMarkup(<TokensBadge used={1500} max={null} costUsd={0.007} />);
    expect(html).toContain('$0.01');
  });
});
