import { describe, expect, it } from 'vitest';
import {
  attachmentsData,
  imagePayloadSchema,
  parseImageDataUrl,
  parseTaskAttachments,
  parseTaskThinkingLevel,
  taskImagesSchema,
} from '../src/lib/task-attachments.js';

// Locking tests for the task prompt extras: per-task thinking level parsing
// and image attachment validation (shared by the tasks route zod schema and
// the worker's multimodal message building).

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

describe('parseImageDataUrl', () => {
  it('parses a valid base64 image data URL', () => {
    expect(parseImageDataUrl(PNG_DATA_URL)).toEqual({
      mediaType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUg==',
    });
  });

  it('accepts jpeg/webp/gif media types', () => {
    expect(parseImageDataUrl('data:image/jpeg;base64,/9j/4A')?.mediaType).toBe('image/jpeg');
    expect(parseImageDataUrl('data:image/webp;base64,UklGRg')?.mediaType).toBe('image/webp');
    expect(parseImageDataUrl('data:image/gif;base64,R0lGOD')?.mediaType).toBe('image/gif');
  });

  it('rejects non-data URLs, non-image types, and missing base64 payloads', () => {
    expect(parseImageDataUrl('https://example.com/x.png')).toBeNull();
    expect(parseImageDataUrl('data:text/plain;base64,aGk=')).toBeNull();
    expect(parseImageDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(parseImageDataUrl('data:image/png;base64,')).toBeNull();
    expect(parseImageDataUrl('data:image/png,iVBORw0KGgo')).toBeNull();
    expect(parseImageDataUrl('')).toBeNull();
  });
});

describe('imagePayloadSchema', () => {
  it('accepts a well-formed image payload', () => {
    const parsed = imagePayloadSchema.safeParse({ name: 'shot.png', dataUrl: PNG_DATA_URL });
    expect(parsed.success).toBe(true);
  });

  it('rejects a dataUrl that is not an image data URL', () => {
    expect(
      imagePayloadSchema.safeParse({ name: 'x', dataUrl: 'data:text/plain;base64,aGk=' }).success,
    ).toBe(false);
    expect(imagePayloadSchema.safeParse({ name: 'x', dataUrl: 'https://x/y.png' }).success).toBe(
      false,
    );
  });

  it('rejects empty names and oversized dataUrls', () => {
    expect(imagePayloadSchema.safeParse({ name: '', dataUrl: PNG_DATA_URL }).success).toBe(false);
    const huge = `data:image/png;base64,${'A'.repeat(3_000_000)}`;
    expect(imagePayloadSchema.safeParse({ name: 'x', dataUrl: huge }).success).toBe(false);
  });
});

describe('taskImagesSchema', () => {
  const image = { name: 'a.png', dataUrl: PNG_DATA_URL };

  it('accepts up to 3 images', () => {
    expect(taskImagesSchema.safeParse([image, image, image]).success).toBe(true);
  });

  it('rejects more than 3 images', () => {
    expect(taskImagesSchema.safeParse([image, image, image, image]).success).toBe(false);
  });
});

// Prisma create/update fragment shared by POST /tasks and POST /tasks/:id/start.
describe('attachmentsData', () => {
  const image = { name: 'a.png', dataUrl: PNG_DATA_URL };

  it('maps images to the attachments column', () => {
    expect(attachmentsData([image])).toEqual({ attachments: [image] });
  });

  it('returns no fragment when images are absent', () => {
    expect(attachmentsData(undefined)).toEqual({});
  });
});

describe('parseTaskAttachments', () => {
  it('returns [] for null/undefined/malformed stored values', () => {
    expect(parseTaskAttachments(null)).toEqual([]);
    expect(parseTaskAttachments(undefined)).toEqual([]);
    expect(parseTaskAttachments('nope')).toEqual([]);
    expect(parseTaskAttachments([{ name: 'x' }])).toEqual([]);
  });

  it('passes through valid stored attachments', () => {
    const stored = [{ name: 'a.png', dataUrl: PNG_DATA_URL }];
    expect(parseTaskAttachments(stored)).toEqual(stored);
  });
});

describe('parseTaskThinkingLevel', () => {
  it('passes through valid levels', () => {
    expect(parseTaskThinkingLevel('low')).toBe('low');
    expect(parseTaskThinkingLevel('medium')).toBe('medium');
    expect(parseTaskThinkingLevel('high')).toBe('high');
    expect(parseTaskThinkingLevel('max')).toBe('max');
  });

  it('returns undefined for null/unknown values', () => {
    expect(parseTaskThinkingLevel(null)).toBeUndefined();
    expect(parseTaskThinkingLevel(undefined)).toBeUndefined();
    expect(parseTaskThinkingLevel('off')).toBeUndefined();
    expect(parseTaskThinkingLevel('bogus')).toBeUndefined();
  });
});
