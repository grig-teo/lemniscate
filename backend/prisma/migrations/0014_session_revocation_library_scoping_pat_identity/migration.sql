-- Session revocation (User.sessionVersion), per-user library scoping
-- (Skill.userId / McpServer.userId, NULL = global seeded entry) and the
-- PAT-identity uniqueness on GitConnection.

-- AlterTable
ALTER TABLE "McpServer" ADD COLUMN     "userId" TEXT;
ALTER TABLE "Skill" ADD COLUMN     "userId" TEXT;
ALTER TABLE "User" ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- Backfill library rows: seed-script rows stay NULL (global, readable by
-- everyone); every other pre-existing row is assigned to the earliest user.
-- Seed markers (scripts/seed-skills.ts): skills cloned from hermes-agent
-- carry source 'hermes'; the two seeded AGENTS.md templates and the five
-- seeded MCP servers are matched by their well-known slugs.
UPDATE "Skill"
SET "userId" = (SELECT "id" FROM "User" ORDER BY "createdAt" ASC LIMIT 1)
WHERE "source" <> 'hermes'
  AND "slug" NOT IN ('default-lemniscate-agents-md', 'hermes-agent-agents-md');

UPDATE "McpServer"
SET "userId" = (SELECT "id" FROM "User" ORDER BY "createdAt" ASC LIMIT 1)
WHERE "slug" NOT IN ('filesystem', 'fetch', 'memory', 'github', 'postgres');

-- Drop duplicate PAT identities (keeping one row per identity) so the
-- unique index below cannot fail on pre-existing data.
DELETE FROM "GitConnection" a
USING "GitConnection" b
WHERE a."provider" = b."provider"
  AND a."username" = b."username"
  AND a."baseUrl" IS NOT DISTINCT FROM b."baseUrl"
  AND a."id" > b."id";

-- CreateIndex (NULLS NOT DISTINCT: github/gitlab rows have NULL baseUrl and
-- must still be unique per identity — plain UNIQUE treats NULLs as distinct)
CREATE UNIQUE INDEX "GitConnection_provider_username_baseUrl_key" ON "GitConnection"("provider", "username", "baseUrl") NULLS NOT DISTINCT;
CREATE INDEX "McpServer_userId_idx" ON "McpServer"("userId");
CREATE INDEX "Skill_userId_idx" ON "Skill"("userId");

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpServer" ADD CONSTRAINT "McpServer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
