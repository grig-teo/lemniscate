import { describe, expect, it } from 'vitest';
import {
  buildConflictResolutionMessages,
  buildFixUserPrompt,
  buildHermesCiFixPrompt,
  buildHermesConflictPrompt,
  buildHermesFixPrompt,
  buildHermesReviewPrompt,
  buildReviewMessages,
  hasConflictMarkers,
  HERMES_REVIEW_FILENAME,
  parsePrReview,
  parseResolvedFile,
  type PrReview,
} from '../src/lib/pr-review.js';

// Unit tests for the pure PR-review logic. Only src/lib/pr-review.ts is
// imported: it is deliberately free of config/prisma/redis imports so these
// tests run without any environment variables.

describe('parsePrReview', () => {
  it('parses a strict approve verdict', () => {
    const review = parsePrReview('{"verdict":"approve","summary":"looks good","issues":[]}');
    expect(review).toEqual({ verdict: 'approve', summary: 'looks good', issues: [] });
  });

  it('parses changes_requested with issues, tolerating surrounding prose', () => {
    const text = [
      'Here is my review:',
      '{"verdict":"changes_requested","summary":"needs fixes",',
      '"issues":[{"path":"src/a.ts","comment":"off by one"},{"comment":"add tests"}]}',
      'Hope that helps.',
    ].join('\n');
    const review = parsePrReview(text);
    expect(review.verdict).toBe('changes_requested');
    expect(review.issues).toHaveLength(2);
    expect(review.issues[0]).toEqual({ path: 'src/a.ts', comment: 'off by one' });
    expect(review.issues[1]).toEqual({ comment: 'add tests' });
  });

  it('rejects an unknown verdict', () => {
    expect(() =>
      parsePrReview('{"verdict":"maybe","summary":"x","issues":[]}'),
    ).toThrow(/invalid review/i);
  });

  it('rejects a response without a JSON object', () => {
    expect(() => parsePrReview('no json here')).toThrow(/did not contain a JSON object/);
  });

  it('rejects malformed JSON', () => {
    expect(() => parsePrReview('{"verdict": "approve", }')).toThrow(/malformed JSON/);
  });

  it('rejects missing required fields', () => {
    expect(() => parsePrReview('{"verdict":"approve"}')).toThrow(/invalid review/i);
  });
});

describe('hasConflictMarkers', () => {
  it('detects each marker kind at line start', () => {
    expect(hasConflictMarkers('a\n<<<<<<< HEAD\nb')).toBe(true);
    expect(hasConflictMarkers('a\n=======\nb')).toBe(true);
    expect(hasConflictMarkers('a\n>>>>>>> branch\nb')).toBe(true);
  });

  it('ignores marker-like text that is not at line start', () => {
    expect(hasConflictMarkers('x <<<<<<< HEAD')).toBe(false);
    expect(hasConflictMarkers('const a = 1;\nconst b = 2;')).toBe(false);
  });
});

describe('parseResolvedFile', () => {
  it('returns the resolved content', () => {
    const content = 'line1\nline2\n';
    expect(parseResolvedFile(JSON.stringify({ content }))).toBe(content);
  });

  it('rejects content still containing conflict markers', () => {
    const content = 'a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> branch\n';
    expect(() => parseResolvedFile(JSON.stringify({ content }))).toThrow(/conflict markers/);
  });

  it('rejects a non-object response', () => {
    expect(() => parseResolvedFile('just some text')).toThrow(/did not contain a JSON object/);
  });
});

describe('prompt builders', () => {
  it('buildReviewMessages includes task and diff, demands strict JSON', () => {
    const [system, user] = buildReviewMessages({
      taskTitle: 'Fix bug',
      taskPrompt: 'Details here',
      diff: '--- a/x\n+++ b/x',
    });
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('STRICT JSON');
    expect(system?.content).toContain('"approve"|"changes_requested"');
    expect(user?.content).toContain('Fix bug');
    expect(user?.content).toContain('Details here');
    expect(user?.content).toContain('--- a/x');
  });

  it('buildFixUserPrompt enumerates review issues', () => {
    const review: PrReview = {
      verdict: 'changes_requested',
      summary: 'needs work',
      issues: [
        { path: 'src/a.ts', comment: 'broken' },
        { comment: 'general note' },
      ],
    };
    const prompt = buildFixUserPrompt({ taskTitle: 'T', taskPrompt: null, review });
    expect(prompt).toContain('1. `src/a.ts`: broken');
    expect(prompt).toContain('2. general note');
    expect(prompt).toContain('needs work');
  });

  it('buildConflictResolutionMessages embeds the file and forbids markers', () => {
    const [system, user] = buildConflictResolutionMessages({
      path: 'src/a.ts',
      conflictedContent: '<<<<<<< HEAD\nx\n',
      baseBranch: 'main',
      headBranch: 'lemniscate/fix',
    });
    expect(system?.content).toContain('lemniscate/fix');
    expect(system?.content).toContain('main');
    expect(system?.content).toContain('STRICT JSON');
    expect(user?.content).toContain('src/a.ts');
    expect(user?.content).toContain('<<<<<<< HEAD');
  });
});

describe('hermes prompt builders', () => {
  it('review prompt names the branches, the two-dot diff, and the verdict file', () => {
    const prompt = buildHermesReviewPrompt({
      taskTitle: 'Add tests',
      taskPrompt: 'cover the payments module',
      baseBranch: 'main',
      headBranch: 'lemniscate/add-tests',
      systemPromptExtra: null,
    });
    expect(prompt).toContain('Add tests');
    expect(prompt).toContain('cover the payments module');
    expect(prompt).toContain('git diff origin/main HEAD');
    expect(prompt).toContain('origin/main');
    expect(prompt).toContain(HERMES_REVIEW_FILENAME);
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain('Do NOT git commit, push, or create branches');
  });

  it('review prompt appends the owner instructions when present', () => {
    const prompt = buildHermesReviewPrompt({
      taskTitle: 't',
      taskPrompt: null,
      baseBranch: 'main',
      headBranch: 'b',
      systemPromptExtra: 'keep diffs small',
    });
    expect(prompt).toContain('keep diffs small');
  });

  it('fix prompt lists numbered review issues with paths', () => {
    const review: PrReview = {
      verdict: 'changes_requested',
      summary: 'needs fixes',
      issues: [
        { path: 'src/a.ts', comment: 'off by one' },
        { comment: 'add tests' },
      ],
    };
    const prompt = buildHermesFixPrompt({
      taskTitle: 'Add tests',
      taskPrompt: null,
      review,
      systemPromptExtra: null,
    });
    expect(prompt).toContain('needs fixes');
    expect(prompt).toContain('1. `src/a.ts`: off by one');
    expect(prompt).toContain('2. add tests');
    expect(prompt).toContain('Do NOT git commit, push, or create branches');
  });

  it('conflict prompt lists the conflicted files and forbids git add', () => {
    const prompt = buildHermesConflictPrompt({
      baseBranch: 'main',
      headBranch: 'lemniscate/x',
      conflictedPaths: ['src/a.ts', 'src/b.ts'],
      systemPromptExtra: null,
    });
    expect(prompt).toContain("Merging branch 'lemniscate/x' into 'main'");
    expect(prompt).toContain('- src/a.ts');
    expect(prompt).toContain('- src/b.ts');
    expect(prompt).toContain('<<<<<<<');
    expect(prompt).toContain('Do NOT git commit, push, or run git add');
  });

  it('ci-fix prompt names the failing branch and demands local verification', () => {
    const prompt = buildHermesCiFixPrompt({
      taskTitle: 'Add tests',
      baseBranch: 'main',
      headBranch: 'lemniscate/add-tests',
      systemPromptExtra: null,
    });
    expect(prompt).toContain('Add tests');
    expect(prompt).toContain("'lemniscate/add-tests'");
    expect(prompt).toContain('FAILING');
    expect(prompt).toContain('.github/workflows');
    expect(prompt).toContain('until they pass locally');
    expect(prompt).toContain('Do NOT git commit, push, or create branches');
  });
});
