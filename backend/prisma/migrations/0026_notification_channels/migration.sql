-- Outbound notification channels: per-user webhook/email targets subscribed
-- to event kinds, plus a delivery audit log. Replaces the single per-user
-- webhook columns on "User" (migrated below into a 'webhook' channel row
-- subscribed to every event kind, preserving the encrypted HMAC secret).

-- CreateTable
CREATE TABLE "NotificationSetting" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "secretEnc" TEXT,
    "events" TEXT[] NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "settingId" TEXT NOT NULL,
    "notificationId" TEXT,
    "event" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastStatusCode" INTEGER,
    "lastError" TEXT,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationSetting_userId_idx" ON "NotificationSetting"("userId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_settingId_createdAt_idx" ON "NotificationDelivery"("settingId", "createdAt");

-- Migrate the legacy per-user webhook (User.webhookUrl/webhookSecretEnc)
-- into a channel row subscribed to all event kinds. cuid() is generated
-- client-side by Prisma, so the row id comes from md5(random()).
INSERT INTO "NotificationSetting"
    ("id", "userId", "channel", "target", "secretEnc", "events", "enabled", "createdAt", "updatedAt")
SELECT
    md5(random()::text || clock_timestamp()::text),
    "id",
    'webhook',
    "webhookUrl",
    "webhookSecretEnc",
    ARRAY['pr_opened','pr_merged','pr_closed','run_failed','budget_exceeded','task_completed','merge_gate_failed','job_failed'],
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "User"
WHERE "webhookUrl" IS NOT NULL;

-- AlterTable: drop the replaced columns.
ALTER TABLE "User" DROP COLUMN "webhookUrl";
ALTER TABLE "User" DROP COLUMN "webhookSecretEnc";

-- AddForeignKey
ALTER TABLE "NotificationSetting" ADD CONSTRAINT "NotificationSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_settingId_fkey" FOREIGN KEY ("settingId") REFERENCES "NotificationSetting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
