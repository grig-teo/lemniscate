import { describe, expect, it } from 'vitest';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { parseOrReply } from '../src/routes/helpers.js';

// Locking tests for the shared zod-parse-or-400 helper used across routes.

function fakeReply() {
  const sent: { code?: number; body?: unknown } = {};
  const reply = {
    code(c: number) {
      sent.code = c;
      return reply;
    },
    send(b: unknown) {
      sent.body = b;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, sent };
}

const schema = z.object({ name: z.string().min(1) }).strict();

describe('parseOrReply', () => {
  it('returns parsed data on success without touching the reply', () => {
    const { reply, sent } = fakeReply();
    expect(parseOrReply(schema, { name: 'x' }, reply, 'Invalid body')).toEqual({ name: 'x' });
    expect(sent.code).toBeUndefined();
  });

  it('sends 400 with the message and returns null on failure', () => {
    const { reply, sent } = fakeReply();
    expect(parseOrReply(schema, {}, reply, 'Invalid body')).toBeNull();
    expect(sent.code).toBe(400);
    expect(sent.body).toEqual({ error: 'Invalid body' });
  });

  it('includes zod issues when asked', () => {
    const { reply, sent } = fakeReply();
    parseOrReply(schema, {}, reply, 'Invalid body', { includeIssues: true });
    const body = sent.body as { error: string; issues: unknown[] };
    expect(body.error).toBe('Invalid body');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });
});
