import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

// Shared zod body/query/params parsing for route handlers. On failure it
// sends a 400 with the given message (optionally the zod issue list) and
// returns null, so handlers bail out with a bare `return` — one home for a
// pattern that was copy-pasted across every route file.
//
// Failures are logged with only path/code/message per issue — never the
// rejected values, which can contain secrets (e.g. apiKey fields).
export function parseOrReply<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
  reply: FastifyReply,
  message: string,
  options: { includeIssues?: boolean; request?: FastifyRequest } = {},
): z.infer<S> | null {
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  options.request?.log.warn(
    {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    },
    `request validation failed: ${message}`,
  );
  const body = options.includeIssues
    ? { error: message, issues: parsed.error.issues }
    : { error: message };
  void reply.code(400).send(body);
  return null;
}

const DEFAULT_PAGE_SIZE = 5;

export interface PageQuery {
  skip: number;
  take: number;
  page: number;
  pageSize: number;
}

// Shared list-pagination parsing: null when the caller sent no pagination
// params (endpoint then keeps its legacy unpaginated shape), otherwise the
// skip/take pair for Prisma plus the normalized page metadata.
export function parsePageQuery(query: { page?: number; pageSize?: number }): PageQuery | null {
  if (query.page === undefined && query.pageSize === undefined) return null;
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  return { skip: (page - 1) * pageSize, take: pageSize, page, pageSize };
}
