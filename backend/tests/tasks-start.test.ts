import { describe, expect, it } from 'vitest';
import { buildStartUpdate, startBlocker, startBodySchema } from '../src/routes/tasks.js';

// Locking tests for POST /tasks/:id/start eligibility: only pending proposal
// tasks can be started (queued → enqueued) by the user.

describe('startBlocker', () => {
  it('allows a pending proposal task', () => {
    expect(startBlocker({ kind: 'proposal', status: 'pending' })).toBeNull();
  });

  it('rejects prompt tasks even when pending', () => {
    expect(startBlocker({ kind: 'prompt', status: 'pending' })).toBe(
      'only proposal tasks can be started',
    );
  });

  it.each(['queued', 'running', 'awaiting_review', 'done', 'failed'])(
    'rejects proposal tasks that are %s',
    (status) => {
      expect(startBlocker({ kind: 'proposal', status })).toBe(`task is ${status}, not pending`);
    },
  );
});

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const IMAGE = { name: 'shot.png', dataUrl: PNG_DATA_URL };

// The optional start body lets a proposal be edited at implement time;
// every field is optional and unknown keys are rejected.
describe('startBodySchema', () => {
  it('accepts an absent/empty body', () => {
    expect(startBodySchema.parse(undefined)).toEqual({});
    expect(startBodySchema.parse({})).toEqual({});
  });

  it('accepts title, prompt, and images edits', () => {
    expect(startBodySchema.parse({ title: 'T', prompt: 'P', images: [IMAGE] })).toEqual({
      title: 'T',
      prompt: 'P',
      images: [IMAGE],
    });
  });

  it('rejects out-of-range fields and unknown keys', () => {
    expect(startBodySchema.safeParse({ title: '' }).success).toBe(false);
    expect(startBodySchema.safeParse({ title: 'x'.repeat(201) }).success).toBe(false);
    expect(startBodySchema.safeParse({ prompt: '' }).success).toBe(false);
    expect(startBodySchema.safeParse({ prompt: 'x'.repeat(8001) }).success).toBe(false);
    expect(startBodySchema.safeParse({ images: [IMAGE, IMAGE, IMAGE, IMAGE] }).success).toBe(false);
    expect(startBodySchema.safeParse({ status: 'done' }).success).toBe(false);
  });
});

// The start update always queues the task and applies only the fields the
// caller actually sent; omitted fields stay out of the update entirely.
describe('buildStartUpdate', () => {
  it('only queues the task when no edits are sent', () => {
    expect(buildStartUpdate({})).toEqual({ status: 'queued' });
  });

  it('passes title and prompt through alongside the status change', () => {
    expect(buildStartUpdate({ title: 'New title', prompt: 'New prompt' })).toEqual({
      status: 'queued',
      title: 'New title',
      prompt: 'New prompt',
    });
  });

  it('maps images to the attachments column', () => {
    expect(buildStartUpdate({ images: [IMAGE] })).toEqual({
      status: 'queued',
      attachments: [IMAGE],
    });
  });

  it('omits fields that were not sent', () => {
    const update = buildStartUpdate({ title: 'Only title' });
    expect(update).not.toHaveProperty('prompt');
    expect(update).not.toHaveProperty('attachments');
  });
});
