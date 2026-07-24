import { describe, expect, it } from 'vitest';

import {
  buildMcpConfig,
  parseArgsLine,
  parseEnvLines,
  parseSkillMarkdown,
  slugify,
} from './library-upload';

describe('slugify', () => {
  it('kebab-cases names per the backend rule', () => {
    expect(slugify('My Cool Skill!')).toBe('my-cool-skill');
    expect(slugify('--weird__name--')).toBe('weird-name');
    expect(slugify('already-fine')).toBe('already-fine');
  });
});

describe('parseSkillMarkdown', () => {
  it('parses frontmatter name/description and keeps the body', () => {
    const parsed = parseSkillMarkdown(
      'SKILL.md',
      '---\nname: Code Review\ndescription: Reviews code.\n---\n\nDo the review.\n',
    );
    expect(parsed).toEqual({
      slug: 'code-review',
      name: 'Code Review',
      description: 'Reviews code.',
      content: 'Do the review.',
    });
  });

  it('falls back to the file name without frontmatter', () => {
    const parsed = parseSkillMarkdown('my-skill.md', 'Just do it.\n');
    expect(parsed).toEqual({
      slug: 'my-skill',
      name: 'my-skill',
      description: '',
      content: 'Just do it.',
    });
  });
});

describe('parseEnvLines', () => {
  it('parses KEY=VALUE lines and skips junk', () => {
    expect(parseEnvLines('A=1\n# comment\nbroken\nB=two=2\n\n')).toEqual({ A: '1', B: 'two=2' });
  });
});

describe('parseArgsLine', () => {
  it('splits on whitespace, honoring double quotes', () => {
    expect(parseArgsLine('-y pkg "two words" --flag')).toEqual(['-y', 'pkg', 'two words', '--flag']);
  });
});

describe('buildMcpConfig', () => {
  it('builds the .mcp.json fragment, omitting env when empty', () => {
    expect(buildMcpConfig({ command: 'npx', args: '-y server', env: '' })).toEqual({
      command: 'npx',
      args: ['-y', 'server'],
    });
  });

  it('includes env when provided', () => {
    expect(buildMcpConfig({ command: 'uvx', args: 'fetch', env: 'TOKEN=abc' })).toEqual({
      command: 'uvx',
      args: ['fetch'],
      env: { TOKEN: 'abc' },
    });
  });
});
