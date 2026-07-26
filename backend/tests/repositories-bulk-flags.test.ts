import { describe, expect, it } from 'vitest';
import {
  autoMergeViolation,
  buildBulkFlagsUpdate,
  bulkFlagsSchema,
} from '../src/routes/repositories.js';

// Locking tests for POST /repositories/flags: body schema, update-data
// mapping, and the single-source autoMerge-requires-review rule.

describe('bulkFlagsSchema', () => {
  it('accepts a body with all three flags', () => {
    const parsed = bulkFlagsSchema.safeParse({
      autoCreatePr: true,
      autoReviewPr: false,
      autoMergePr: false,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an optional reviewLlmConfigId, including an explicit null', () => {
    const base = { autoCreatePr: true, autoReviewPr: true, autoMergePr: false };
    expect(bulkFlagsSchema.safeParse({ ...base, reviewLlmConfigId: 'cfg-1' }).success).toBe(true);
    expect(bulkFlagsSchema.safeParse({ ...base, reviewLlmConfigId: null }).success).toBe(true);
  });

  it('rejects missing or extra fields', () => {
    expect(
      bulkFlagsSchema.safeParse({ autoCreatePr: true, autoReviewPr: true }).success,
    ).toBe(false);
    expect(
      bulkFlagsSchema.safeParse({
        autoCreatePr: true,
        autoReviewPr: true,
        autoMergePr: true,
        hidden: true,
      }).success,
    ).toBe(false);
  });
});

describe('buildBulkFlagsUpdate', () => {
  it('maps all three flags into the update object', () => {
    expect(
      buildBulkFlagsUpdate({ autoCreatePr: true, autoReviewPr: false, autoMergePr: false }),
    ).toEqual({ autoCreatePr: true, autoReviewPr: false, autoMergePr: false });
  });

  it('includes reviewLlmConfigId only when it was sent', () => {
    const base = { autoCreatePr: true, autoReviewPr: true, autoMergePr: false };
    expect(buildBulkFlagsUpdate(base)).toEqual(base);
    expect(buildBulkFlagsUpdate({ ...base, reviewLlmConfigId: 'cfg-1' })).toEqual({
      ...base,
      reviewLlmConfigId: 'cfg-1',
    });
    expect(buildBulkFlagsUpdate({ ...base, reviewLlmConfigId: null })).toEqual({
      ...base,
      reviewLlmConfigId: null,
    });
  });
});

describe('autoMergeViolation', () => {
  it('rejects merge without review', () => {
    expect(autoMergeViolation({ autoMergePr: true, autoReviewPr: false })).toBe(true);
  });

  it('allows merge on top of an enabled review', () => {
    expect(autoMergeViolation({ autoMergePr: true, autoReviewPr: true })).toBe(false);
    expect(autoMergeViolation({ autoMergePr: false, autoReviewPr: false })).toBe(false);
  });

  it('locks PATCH semantics: unsent merge flag never violates', () => {
    expect(autoMergeViolation({ autoReviewPr: false })).toBe(false);
  });
});
