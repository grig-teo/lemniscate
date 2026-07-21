-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tags" TEXT[],
    "source" TEXT NOT NULL DEFAULT 'hermes',
    "kind" TEXT NOT NULL DEFAULT 'skill',

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Skill_slug_key" ON "Skill"("slug");

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN "skillSlugs" JSONB;
ALTER TABLE "Repository" ADD COLUMN "agentsMdSkillId" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "skills" JSONB;
