import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EstimatedTimeBadge } from './EstimatedTimeBadge';

// The time-estimate badge: hidden until the Improve flow returns an LLM
// estimate, then shown next to the priority/effort labels in the
// prompt/proposal detail pane.

describe('EstimatedTimeBadge', () => {
  it('renders nothing without an estimate', () => {
    expect(renderToStaticMarkup(<EstimatedTimeBadge estimatedTime={null} />)).toBe('');
    expect(renderToStaticMarkup(<EstimatedTimeBadge estimatedTime={undefined} />)).toBe('');
    expect(renderToStaticMarkup(<EstimatedTimeBadge estimatedTime="" />)).toBe('');
  });

  it('renders the estimate with a clock icon', () => {
    const html = renderToStaticMarkup(<EstimatedTimeBadge estimatedTime="about 2 hours" />);
    expect(html).toContain('about 2 hours');
    expect(html).toContain('<svg'); // Clock icon
    expect(html).toContain('LLM-generated time estimate');
  });
});
