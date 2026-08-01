import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChangesDialog, FileChangeRow, SummaryBar } from '@/components/console/ChangesDialog';
import type { ChangeSummary } from '@/lib/session-changes';

// Locking tests for the changes dialog's GitHub-style summary bar and file
// rows. The rows render collapsed by default; the diff line classification
// behind the expanded view is unit-tested in lib/session-changes.test.ts.
// (The repo's jsdom setup resolves a production React build, so DOM-render
// tests use renderToStaticMarkup throughout.)

function makeSummary(overrides: Partial<ChangeSummary> = {}): ChangeSummary {
  return { changes: [], count: 0, additions: 0, deletions: 0, ...overrides };
}

const DIFF = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n');

describe('ChangesDialog', () => {
  it('renders nothing server-side even when open (Radix portals to the DOM)', () => {
    const html = renderToStaticMarkup(
      <ChangesDialog
        open
        onOpenChange={() => undefined}
        branchName="lemniscate/x"
        summary={makeSummary({ count: 2 })}
      />,
    );
    expect(html).toBe('');
  });
});

describe('SummaryBar', () => {
  it('shows the files-changed count with GitHub-style +/− totals', () => {
    const html = renderToStaticMarkup(
      <SummaryBar summary={makeSummary({ count: 3, additions: 12, deletions: 4 })} />,
    );
    expect(html).toContain('3 files changed');
    expect(html).toContain('+12');
    expect(html).toContain('−4');
  });

  it('uses the singular label for exactly one file', () => {
    const html = renderToStaticMarkup(
      <SummaryBar summary={makeSummary({ count: 1, additions: 1, deletions: 0 })} />,
    );
    expect(html).toContain('1 file changed');
    expect(html).not.toContain('1 files changed');
  });
});

describe('FileChangeRow', () => {
  it('renders a collapsed row with the path, action letter and per-file totals', () => {
    const html = renderToStaticMarkup(
      <FileChangeRow change={{ path: 'src/a.ts', action: 'modified', diff: DIFF }} />,
    );
    expect(html).toContain('src/a.ts');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('+1');
    expect(html).toContain('−1');
    // Collapsed: no diff body yet.
    expect(html).not.toContain('+new');
  });

  it('sums the creation diff of a file created-then-modified in one session', () => {
    // Real backend creation preview: raw content, no '+' prefixes.
    const html = renderToStaticMarkup(
      <FileChangeRow
        change={{
          path: 'src/a.ts',
          action: 'modified',
          diff: DIFF,
          baseDiff: '--- /dev/null\n+++ b/src/a.ts\nfirst',
        }}
      />,
    );
    expect(html).toContain('+2');
    expect(html).toContain('−1');
  });

  it('marks created/modified/deleted files with their GitHub status letters', () => {
    const created = renderToStaticMarkup(
      <FileChangeRow change={{ path: 'a.ts', action: 'created' }} />,
    );
    const modified = renderToStaticMarkup(
      <FileChangeRow change={{ path: 'b.ts', action: 'modified' }} />,
    );
    const deleted = renderToStaticMarkup(
      <FileChangeRow change={{ path: 'c.ts', action: 'deleted' }} />,
    );
    expect(created).toContain('title="created"');
    expect(modified).toContain('title="modified"');
    expect(deleted).toContain('title="deleted"');
  });
});
