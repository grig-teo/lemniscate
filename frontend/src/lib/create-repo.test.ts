import { describe, expect, it } from 'vitest';

import {
  AGENTS_MD_MAX_CHARS,
  buildCreateRepoBody,
  formatFileSize,
  readAgentsMdFile,
  type CreateRepoFormState,
} from '@/lib/create-repo';

function makeState(overrides: Partial<CreateRepoFormState> = {}): CreateRepoFormState {
  return {
    name: 'my-project',
    isPrivate: true,
    readme: true,
    skillSlugs: [],
    mcpServerSlugs: [],
    initPrompt: '',
    agentsMdFiles: [],
    ...overrides,
  };
}

describe('buildCreateRepoBody', () => {
  it('builds a minimal body with name, private and readme', () => {
    expect(buildCreateRepoBody(makeState())).toEqual({
      name: 'my-project',
      private: true,
      readme: true,
    });
  });

  it('trims the repository name', () => {
    expect(buildCreateRepoBody(makeState({ name: '  spaced  ' })).name).toBe('spaced');
  });

  it('omits skillSlugs when none are selected', () => {
    expect(buildCreateRepoBody(makeState())).not.toHaveProperty('skillSlugs');
  });

  it('includes skillSlugs when at least one is selected', () => {
    expect(buildCreateRepoBody(makeState({ skillSlugs: ['a', 'b'] })).skillSlugs).toEqual([
      'a',
      'b',
    ]);
  });

  it('omits mcpServerSlugs when none are selected', () => {
    expect(buildCreateRepoBody(makeState())).not.toHaveProperty('mcpServerSlugs');
  });

  it('includes mcpServerSlugs when at least one is selected', () => {
    expect(buildCreateRepoBody(makeState({ mcpServerSlugs: ['filesystem'] })).mcpServerSlugs).toEqual([
      'filesystem',
    ]);
  });

  it('omits initPrompt when blank and trims it otherwise', () => {
    expect(buildCreateRepoBody(makeState())).not.toHaveProperty('initPrompt');
    expect(buildCreateRepoBody(makeState({ initPrompt: '  scaffold it  ' })).initPrompt).toBe(
      'scaffold it',
    );
  });

  it('omits agentsMdFiles when nothing is assigned', () => {
    expect(buildCreateRepoBody(makeState())).not.toHaveProperty('agentsMdFiles');
  });

  it('drops assignments with neither skillId nor content', () => {
    expect(
      buildCreateRepoBody(makeState({ agentsMdFiles: [{ folder: '/src' }] })),
    ).not.toHaveProperty('agentsMdFiles');
  });

  it('lets an uploaded file win over a picked template within one folder', () => {
    const body = buildCreateRepoBody(
      makeState({
        agentsMdFiles: [{ folder: '/', skillId: 'skill-1', content: '# Custom' }],
      }),
    );
    expect(body.agentsMdFiles).toEqual([{ folder: '/', content: '# Custom' }]);
  });

  it('keeps per-folder template assignments', () => {
    const body = buildCreateRepoBody(
      makeState({
        agentsMdFiles: [
          { folder: '/', skillId: 'skill-1' },
          { folder: '/src/api', skillId: 'skill-2' },
        ],
      }),
    );
    expect(body.agentsMdFiles).toEqual([
      { folder: '/', skillId: 'skill-1' },
      { folder: '/src/api', skillId: 'skill-2' },
    ]);
  });

  it('forwards readme=false when the checkbox is unchecked', () => {
    expect(buildCreateRepoBody(makeState({ readme: false })).readme).toBe(false);
  });
});

describe('readAgentsMdFile', () => {
  function makeFile(name: string, content: string) {
    return { name, size: content.length, text: () => Promise.resolve(content) };
  }

  it('returns the file name, byte size and full content under the cap', async () => {
    const result = await readAgentsMdFile(makeFile('AGENTS.md', '# Rules'));
    expect(result).toEqual({ name: 'AGENTS.md', size: 7, content: '# Rules', truncated: false });
  });

  it('truncates content past the character cap', async () => {
    const long = 'x'.repeat(AGENTS_MD_MAX_CHARS + 10);
    const result = await readAgentsMdFile(makeFile('big.md', long));
    expect(result.content).toHaveLength(AGENTS_MD_MAX_CHARS);
    expect(result.truncated).toBe(true);
  });

  it('does not flag content exactly at the cap as truncated', async () => {
    const exact = 'x'.repeat(AGENTS_MD_MAX_CHARS);
    const result = await readAgentsMdFile(makeFile('exact.md', exact));
    expect(result.truncated).toBe(false);
    expect(result.content).toHaveLength(AGENTS_MD_MAX_CHARS);
  });
});

describe('formatFileSize', () => {
  it('formats bytes below one kilobyte', () => {
    expect(formatFileSize(512)).toBe('512 B');
  });

  it('formats kilobytes with one decimal', () => {
    expect(formatFileSize(2048)).toBe('2.0 KB');
  });
});
