import { describe, expect, it } from 'vitest';

import { libraryObjectKey } from '../src/lib/library-storage.js';

describe('libraryObjectKey', () => {
  it('maps skills into the skills/ folder as markdown', () => {
    expect(libraryObjectKey('skill', 'code-review')).toBe('skills/code-review.md');
  });

  it('maps AGENTS.md templates into the agents-md/ folder', () => {
    expect(libraryObjectKey('agents_md', 'lemniscate-default')).toBe(
      'agents-md/lemniscate-default.md',
    );
  });

  it('maps MCP servers into the mcp-servers/ folder as JSON', () => {
    expect(libraryObjectKey('mcp_server', 'filesystem')).toBe('mcp-servers/filesystem.json');
  });
});
