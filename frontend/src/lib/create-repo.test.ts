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
    agentsMdSkillId: null,
    agentsMdContent: null,
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

  it('omits agentsMdSkillId when no template is picked', () => {
    expect(buildCreateRepoBody(makeState())).not.toHaveProperty('agentsMdSkillId');
  });

  it('includes agentsMdSkillId when a template is picked', () => {
    expect(buildCreateRepoBody(makeState({ agentsMdSkillId: 'skill-1' })).agentsMdSkillId).toBe(
      'skill-1',
    );
  });

  it('omits agentsMdContent when nothing was uploaded', () => {
    expect(buildCreateRepoBody(makeState())).not.toHaveProperty('agentsMdContent');
  });

  it('lets an uploaded file win over a picked template', () => {
    const body = buildCreateRepoBody(
      makeState({ agentsMdSkillId: 'skill-1', agentsMdContent: '# Custom' }),
    );
    expect(body.agentsMdContent).toBe('# Custom');
    expect(body).not.toHaveProperty('agentsMdSkillId');
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
