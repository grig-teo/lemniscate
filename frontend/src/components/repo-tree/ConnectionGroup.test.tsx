import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ConnectionGroup } from '@/components/repo-tree/ConnectionGroup';

const group = {
  connectionId: 'c1',
  provider: 'github',
  username: 'octo',
  repos: [],
};

function renderGroup(syncError: string | null) {
  return renderToStaticMarkup(
    <ConnectionGroup
      group={group}
      syncing={false}
      syncError={syncError}
      onSync={() => undefined}
      expanded={{}}
      onToggleRepo={() => undefined}
    />,
  );
}

describe('ConnectionGroup sync error', () => {
  it('renders the sync failure inline with an alert role', () => {
    const html = renderGroup('OAuth token expired');
    expect(html).toContain('Sync failed: OAuth token expired');
    expect(html).toContain('role="alert"');
  });

  it('renders no error block when the last sync did not fail', () => {
    expect(renderGroup(null)).not.toContain('Sync failed');
  });
});
