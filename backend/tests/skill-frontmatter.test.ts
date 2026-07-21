import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatter } from '../src/lib/skill-frontmatter.js';

// Locking tests for the SKILL.md frontmatter parser used by the skills seed
// script. Fixtures mirror real files from NousResearch/hermes-agent.

describe('parseSkillFrontmatter', () => {
  it('parses quoted values and an inline tags list', () => {
    const raw = [
      '---',
      'name: apple-reminders',
      'description: "Apple Reminders via remindctl: add, list, complete."',
      'version: 1.0.0',
      'platforms: [macos]',
      'metadata:',
      '  hermes:',
      '    tags: [Reminders, tasks, todo, macOS, Apple]',
      '---',
      '',
      '# Apple Reminders',
      '',
      'Use `remindctl`.',
      '',
    ].join('\n');
    expect(parseSkillFrontmatter(raw)).toEqual({
      name: 'apple-reminders',
      description: 'Apple Reminders via remindctl: add, list, complete.',
      tags: ['Reminders', 'tasks', 'todo', 'macOS', 'Apple'],
      content: '# Apple Reminders\n\nUse `remindctl`.',
    });
  });

  it('parses block-list tags', () => {
    const raw = [
      '---',
      'name: comfyui',
      'description: "Generate images with ComfyUI."',
      'metadata:',
      '  hermes:',
      '    tags:',
      '      - comfyui',
      '      - image-generation',
      '---',
      '# ComfyUI',
    ].join('\n');
    expect(parseSkillFrontmatter(raw)).toEqual({
      name: 'comfyui',
      description: 'Generate images with ComfyUI.',
      tags: ['comfyui', 'image-generation'],
      content: '# ComfyUI',
    });
  });

  it('parses unquoted scalars and ignores deeper unrelated keys', () => {
    const raw = [
      '---',
      'name: 1password',
      'description: Set up and use 1Password CLI (op).',
      'metadata:',
      '  hermes:',
      '    tags: [security, secrets, 1password, op, cli]',
      '    category: security',
      'setup:',
      '  collect_secrets:',
      '    - env_var: OP_SERVICE_ACCOUNT_TOKEN',
      '      secret: true',
      '---',
      'body',
    ].join('\n');
    expect(parseSkillFrontmatter(raw)).toEqual({
      name: '1password',
      description: 'Set up and use 1Password CLI (op).',
      tags: ['security', 'secrets', '1password', 'op', 'cli'],
      content: 'body',
    });
  });

  it('parses inline lists with quoted items', () => {
    const raw = [
      '---',
      'name: x',
      'description: d',
      'metadata:',
      '  hermes:',
      '    tags: ["python3", \'a, b\', plain]',
      '---',
      'body',
    ].join('\n');
    expect(parseSkillFrontmatter(raw)?.tags).toEqual(['python3', 'a, b', 'plain']);
  });

  it('returns empty tags when metadata.hermes.tags is absent', () => {
    const raw = ['---', 'name: x', 'description: d', '---', 'body'].join('\n');
    expect(parseSkillFrontmatter(raw)).toEqual({
      name: 'x',
      description: 'd',
      tags: [],
      content: 'body',
    });
  });

  it('returns null without a frontmatter block', () => {
    expect(parseSkillFrontmatter('# Just markdown\n')).toBeNull();
    expect(parseSkillFrontmatter('')).toBeNull();
  });

  it('returns null when name or description is missing', () => {
    expect(parseSkillFrontmatter('---\ndescription: d\n---\nbody')).toBeNull();
    expect(parseSkillFrontmatter('---\nname: x\n---\nbody')).toBeNull();
  });

  it('returns null for an unterminated frontmatter block', () => {
    expect(parseSkillFrontmatter('---\nname: x\ndescription: d\n')).toBeNull();
  });
});
