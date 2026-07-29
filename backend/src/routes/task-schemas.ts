import { z } from 'zod';
import { taskImagesSchema, taskThinkingLevelSchema } from '../lib/task-attachments.js';

// Zod schemas for the tasks API bodies/queries (see tasks.ts for the route
// registration and the SSE event contract).

export const listQuerySchema = z.object({
  repositoryId: z.string().min(1).optional(),
  // ?archived=true returns ONLY archived tasks; anything else excludes them.
  archived: z.enum(['true', 'false']).optional(),
});

const promptSchema = z.string().min(1).max(8000);

// Per-folder AGENTS.md attachment entry: uploaded content or an agents_md
// template skill id. Shared by the create, start and PATCH bodies.
const agentsMdFileSchema = z.object({
  folder: z.string().min(1).max(500),
  skillId: z.string().min(1).optional(),
  content: z.string().max(100_000).optional(),
});

// Library attachment fields on a task. Create: undefined = inherit the
// repository defaults; start/PATCH: undefined = leave the stored value
// untouched; an explicit empty array clears it.
const attachmentFieldsSchema = z.object({
  // Skill slugs injected into the agent's system prompt for this run.
  skills: z.array(z.string().min(1)).max(20).optional(),
  // MCP server slugs materialized as .mcp.json in the workdir.
  mcpServerSlugs: z.array(z.string().min(1)).max(20).optional(),
  // Per-folder AGENTS.md files written into the workdir.
  agentsMdFiles: z.array(agentsMdFileSchema).max(50).optional(),
});

export const createBodySchema = z
  .object({
    repositoryId: z.string().min(1),
    prompt: promptSchema,
    // Per-task override of the LLM config's thinkingLevel; omit to inherit.
    thinkingLevel: taskThinkingLevelSchema.optional(),
    // Explicit LLM config chosen in the composer; omit to inherit (repo → default).
    llmConfigId: z.string().min(1).optional(),
    // Image attachments sent to the agent as multimodal content (max 3).
    images: taskImagesSchema.optional(),
    // Save-for-later: create the task as pending without enqueueing it.
    later: z.boolean().optional(),
  })
  .merge(attachmentFieldsSchema)
  .strict();

// Optional edits applied when a pending task is started. Absent body
// (the left-nav play button) parses as {} and changes nothing.
export const startBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    prompt: promptSchema.optional(),
    images: taskImagesSchema.optional(),
  })
  .merge(attachmentFieldsSchema)
  .strict()
  .default({});
export type StartBody = z.infer<typeof startBodySchema>;

// PATCH /tasks/:id — save edits on a pending task without starting it.
// llmConfigId overrides the stored implementation config before START pins it
// (the bottom model dropdown of the proposal/prompt detail editor); omitted =
// leave the stored config untouched. The handler verifies ownership+enabled.
export const patchBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    prompt: promptSchema.optional(),
    images: taskImagesSchema.optional(),
    llmConfigId: z.string().min(1).optional(),
  })
  .merge(attachmentFieldsSchema)
  .strict();
export type PatchBody = z.infer<typeof patchBodySchema>;

// POST /tasks/:id/improve — the Improve button sends the editor's current
// title + prompt; the improved description is returned, never persisted.
export const improveBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    prompt: promptSchema,
  })
  .strict();
export type ImproveBody = z.infer<typeof improveBodySchema>;

// POST /tasks/:id/model — switch the LLM config of an in-flight task; the
// new id is picked up between LLM calls (applyPendingModelSwitch).
export const modelBodySchema = z
  .object({
    llmConfigId: z.string().min(1),
  })
  .strict();
export type ModelBody = z.infer<typeof modelBodySchema>;

export const idParamsSchema = z.object({ id: z.string().min(1) });
