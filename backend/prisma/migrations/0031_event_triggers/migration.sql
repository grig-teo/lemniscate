-- EventTrigger: maps an inbound webhook event kind (ci_failed, issue_opened)
-- to a task prompt. When the webhook receiver gets a matching event for a
-- repository, it creates + enqueues a prompt task using taskPrompt.

CREATE TABLE "EventTrigger" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "taskPrompt" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventTrigger_pkey" PRIMARY KEY ("id")
);

-- Create index for repositoryId lookups during webhook dispatch.
CREATE INDEX "EventTrigger_repositoryId_idx" ON "EventTrigger"("repositoryId");

-- One trigger per event kind per repository.
CREATE UNIQUE INDEX "EventTrigger_repositoryId_eventKind_key" ON "EventTrigger"("repositoryId", "eventKind");

-- Foreign key: cascade delete when the repository is deleted.
ALTER TABLE "EventTrigger" ADD CONSTRAINT "EventTrigger_repositoryId_fkey"
    FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
