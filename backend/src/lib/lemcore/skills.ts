// Skill activation for the lemcore executor (phase 4): progressive
// disclosure. The system prompt gets one-line summaries only; the agent
// calls load_skill(name) to pull a skill's full SKILL.md content on demand
// instead of burning context up front.

import type { Skill } from '@prisma/client';
import type { ChatCompletionTool } from '../llm-client.js';

export interface LemcoreSkill {
  name: string;
  slug: string;
  content: string;
}

const SUMMARY_MAX_CHARS = 200;

export function toLemcoreSkills(skills: Skill[]): LemcoreSkill[] {
  return skills.map((s) => ({ name: s.name, slug: s.slug, content: s.content }));
}

/** First non-heading line of the SKILL.md, capped — the prompt summary. */
export function skillSummary(skill: LemcoreSkill): string {
  const firstLine =
    skill.content
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('#')) ?? skill.name;
  return firstLine.length > SUMMARY_MAX_CHARS
    ? `${firstLine.slice(0, SUMMARY_MAX_CHARS)}…`
    : firstLine;
}

export function buildSkillsPromptSection(skills: LemcoreSkill[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((s) => `- ${s.name} (${s.slug}): ${skillSummary(s)}`);
  return [
    '## Available skills',
    'The following skills are attached to this task. Call load_skill(name) to read',
    'the full instructions of a skill before applying it — only load what you need.',
    ...lines,
    '',
  ].join('\n');
}

export function loadSkillToolDefinition(): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: 'load_skill',
      description:
        'Load the full instructions (SKILL.md) of an attached skill by name or slug.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name or slug' },
        },
        required: ['name'],
      },
    },
  };
}

/** Resolves a load_skill call to the skill content, or an error message. */
export function resolveSkillContent(skills: LemcoreSkill[], name: string): string {
  const needle = name.trim().toLowerCase();
  const skill = skills.find(
    (s) => s.name.toLowerCase() === needle || s.slug.toLowerCase() === needle,
  );
  if (!skill) {
    const known = skills.map((s) => s.slug).join(', ');
    return `Error: unknown skill "${name}". Available skills: ${known}`;
  }
  return skill.content;
}
