import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

// Shared zod body/query/params parsing for route handlers. On failure it
// sends a 400 with the given message (optionally the zod issue list) and
// returns null, so handlers bail out with a bare `return` — one home for a
// pattern that was copy-pasted across every route file.
export function parseOrReply<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
  reply: FastifyReply,
  message: string,
  options: { includeIssues?: boolean } = {},
): z.infer<S> | null {
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  const body = options.includeIssues
    ? { error: message, issues: parsed.error.issues }
    : { error: message };
  void reply.code(400).send(body);
  return null;
}
