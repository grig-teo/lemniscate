-- lemcore phases 10-12: fleet execution, learning layer, platform GA.

-- Phase 11: pgvector extension for the semantic code index. The extension
-- is created by the API startup (scripts/ensure-pgvector.ts) when the DB
-- role allows it; migrations stay pure-SQL and non-fatal without it.
ALTER TYPE "TaskEventKind" ADD VALUE 'retrospective';

ALTER TABLE "Repository"
  ADD COLUMN "deviceRouteId" TEXT,
  ADD COLUMN "deviceRouteWhen" TEXT NOT NULL DEFAULT 'on-demand',
  ADD COLUMN "semanticIndex" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "orgId" TEXT;

ALTER TABLE "LlmConfig" ADD COLUMN "orgId" TEXT;
ALTER TABLE "DeviceCommand" ADD COLUMN "lemcoreRunId" TEXT;

CREATE TABLE "ApiToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "scopes" JSONB NOT NULL,
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");
CREATE INDEX "ApiToken_userId_idx" ON "ApiToken"("userId");
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Webhook" (
  "id" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "secretEnc" TEXT NOT NULL,
  "events" JSONB NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Webhook_repositoryId_idx" ON "Webhook"("repositoryId");
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_repositoryId_fkey"
  FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WebhookDelivery" (
  "id" TEXT NOT NULL,
  "webhookId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "responseStatus" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" TIMESTAMP(3),
  CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WebhookDelivery_webhookId_idx" ON "WebhookDelivery"("webhookId");
CREATE INDEX "WebhookDelivery_status_idx" ON "WebhookDelivery"("status");
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_webhookId_fkey"
  FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Organization" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'shared',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

CREATE TABLE "OrgMember" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'member',
  CONSTRAINT "OrgMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrgMember_orgId_userId_key" ON "OrgMember"("orgId", "userId");
CREATE INDEX "OrgMember_userId_idx" ON "OrgMember"("userId");
ALTER TABLE "OrgMember" ADD CONSTRAINT "OrgMember_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrgMember" ADD CONSTRAINT "OrgMember_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OauthIdentity" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerSub" TEXT NOT NULL,
  "email" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OauthIdentity_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OauthIdentity_provider_providerSub_key"
  ON "OauthIdentity"("provider", "providerSub");
CREATE INDEX "OauthIdentity_userId_idx" ON "OauthIdentity"("userId");
ALTER TABLE "OauthIdentity" ADD CONSTRAINT "OauthIdentity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UsageSnapshot" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "tasksRun" INTEGER NOT NULL DEFAULT 0,
  "tokensUsed" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UsageSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UsageSnapshot_userId_month_key" ON "UsageSnapshot"("userId", "month");
ALTER TABLE "UsageSnapshot" ADD CONSTRAINT "UsageSnapshot_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MarketplaceListing" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "tags" TEXT[] NOT NULL,
  "payloadKey" TEXT NOT NULL,
  "publisherId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "installCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketplaceListing_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MarketplaceListing_slug_key" ON "MarketplaceListing"("slug");
CREATE INDEX "MarketplaceListing_status_kind_idx" ON "MarketplaceListing"("status", "kind");
ALTER TABLE "MarketplaceListing" ADD CONSTRAINT "MarketplaceListing_publisherId_fkey"
  FOREIGN KEY ("publisherId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MarketplaceInstall" (
  "id" TEXT NOT NULL,
  "listingId" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketplaceInstall_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MarketplaceInstall_listingId_repositoryId_key"
  ON "MarketplaceInstall"("listingId", "repositoryId");
ALTER TABLE "MarketplaceInstall" ADD CONSTRAINT "MarketplaceInstall_listingId_fkey"
  FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketplaceInstall" ADD CONSTRAINT "MarketplaceInstall_repositoryId_fkey"
  FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Repository" ADD CONSTRAINT "Repository_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LlmConfig" ADD CONSTRAINT "LlmConfig_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Migration path: every existing user becomes the owner of a personal org.
-- The User table carries no display name, so the personal org gets a static
-- name (the slug 'user-<id>' still uniquely identifies the owner).
INSERT INTO "Organization" ("id", "slug", "name", "kind", "createdAt")
SELECT 'porg-' || u."id", 'user-' || u."id", 'Personal workspace', 'personal', NOW()
FROM "User" u;

INSERT INTO "OrgMember" ("id", "orgId", "userId", "role")
SELECT 'pmem-' || u."id", 'porg-' || u."id", u."id", 'owner'
FROM "User" u;
