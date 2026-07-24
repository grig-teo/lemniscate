import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decrypt } from '../lib/crypto.js';
import { chatCompletions } from '../lib/llm-client.js';
import { extractJsonObject } from '../lib/llm-json.js';
import { prisma } from '../lib/prisma.js';
import { sanitizeFolder } from '../lib/repo-init.js';
import { requireAuth, authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';

// Library-wide helpers that are not tied to one library kind. Currently:
// POST /api/library/structure-preview — a lightweight LLM call that turns the
// user's first project prompt into a proposed folder tree, so the create
// dialog can offer per-folder AGENTS.md assignment. Nothing is committed
// anywhere; the call never touches a git repository.

const previewBodySchema = z.object({ prompt: z.string().min(1).max(8000) });

const MAX_FOLDERS = 30;

const SYSTEM_PROMPT = [
  'You design software project structures.',
  'Reply with JSON only: {"folders": ["src", "src/api", "docs", ...]}.',
  'Directories only (no files), at most two levels deep, at most 30 entries,',
  'relative paths without leading slash. No explanations.',
].join(' ');

// Normalizes the LLM's folder list: slash-prefixed, deduped, root first,
// traversal and file-like entries dropped. Any garbage degrades to ['/'].
// Exported for unit tests (no LLM on dev hosts).
export function sanitizeStructureFolders(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { folders?: unknown }).folders)) {
    return ['/'];
  }
  const folders = new Set<string>(['/']);
  for (const entry of (raw as { folders: unknown[] }).folders) {
    if (typeof entry !== 'string') continue;
    if (entry.includes('.') && !entry.includes('/')) continue; // file-like
    let prefix: string;
    try {
      prefix = sanitizeFolder(entry);
    } catch {
      continue;
    }
    if (prefix === '' || prefix.includes('..')) continue;
    folders.add(`/${prefix}`);
    if (folders.size >= MAX_FOLDERS) break;
  }
  return [...folders];
}

async function requestStructureFolders(prompt: string, userId: string): Promise<string[] | null> {
  const cfg = await prisma.llmConfig.findFirst({
    where: { userId, isDefault: true, enabled: true },
  });
  if (!cfg) return null;
  const result = await chatCompletions({
    baseUrl: cfg.baseUrl,
    apiKey: decrypt(cfg.apiKeyEnc),
    model: cfg.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    maxTokens: Math.min(cfg.maxTokens, 2000),
    timeoutSeconds: cfg.timeoutSeconds,
    maxRetries: 1,
    customHeaders: {},
  });
  return sanitizeStructureFolders(extractJsonObject(result.content));
}

async function structurePreview(request: FastifyRequest, reply: FastifyReply) {
  const userId = authenticatedUserId(request);
  const body = parseOrReply(previewBodySchema, request.body, reply, 'Invalid body');
  if (body === null) return;
  try {
    const folders = await requestStructureFolders(body.prompt, userId);
    if (folders === null) {
      return reply.code(400).send({ error: 'No default LLM config — set one in Settings first' });
    }
    return { folders };
  } catch (err) {
    request.log.warn({ err }, 'structure preview failed, falling back to root only');
    return { folders: ['/'] };
  }
}

export default async function libraryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.post('/structure-preview', structurePreview);
}
