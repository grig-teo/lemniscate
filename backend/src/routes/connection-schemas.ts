import { z } from 'zod';
import type { Prisma } from '@prisma/client';

// Zod schemas and shared selects for the connections API (see connections.ts
// for the route registration).

export const connectBodySchema = z.object({
  provider: z.enum(['github', 'gitverse', 'gitlab', 'gitee', 'gitlem']),
  token: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

// POST /connections/:id/repositories body. Exported for tests.
export const createRepoBodySchema = z.object({
  name: z.string().min(1).max(100),
  private: z.boolean().optional(),
  // Slugs of skills injected into the agent's system prompt for tasks on
  // this repository AND committed as .agents/skills/<slug>/SKILL.md files;
  // existence validated against the Skill table below.
  skillSlugs: z.array(z.string().min(1)).max(20).optional(),
  // AGENTS.md assignments per folder: '/' is the root file, nested folders
  // get <folder>/AGENTS.md. `content` (uploaded custom text) wins over
  // `skillId` (an agents_md template). When omitted entirely, the legacy
  // agentsMdContent/agentsMdSkillId pair below seeds the root file.
  agentsMdFiles: z
    .array(
      z.object({
        folder: z.string().min(1).max(500),
        skillId: z.string().min(1).optional(),
        content: z.string().max(100_000).optional(),
      }),
    )
    .max(50)
    .optional(),
  // AGENTS.md template skill (kind 'agents_md') committed as AGENTS.md on
  // creation; null means "no template".
  agentsMdSkillId: z.string().min(1).nullable().optional(),
  // Uploaded custom AGENTS.md text; wins over agentsMdSkillId.
  agentsMdContent: z.string().max(100_000).optional(),
  // Slugs of McpServer rows assembled into a root .mcp.json.
  mcpServerSlugs: z.array(z.string().min(1)).max(20).optional(),
  // First project prompt: after creation + seeding, a prompt task is
  // created on the new repository and started immediately.
  initPrompt: z.string().min(1).max(8000).optional(),
  // Seed the repo with a README.md (default: yes).
  readme: z.boolean().default(true),
});

export type CreateRepoBody = z.infer<typeof createRepoBodySchema>;

export const idParamsSchema = z.object({ id: z.string().min(1) });

// Never leak the encrypted (or decrypted) token to clients.
export const connectionSelect = {
  id: true,
  provider: true,
  baseUrl: true,
  username: true,
  disconnectedAt: true,
} as const;

export type ConnectionView = Prisma.GitConnectionGetPayload<{
  select: typeof connectionSelect;
}>;
