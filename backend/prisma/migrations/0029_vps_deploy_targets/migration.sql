-- VPS deployment targets: a reusable SSH connection profile per user, plus a
-- per-service choice of where to deploy (the platform apps network, or the
-- user's own VPS over SSH).

-- CreateEnum
CREATE TYPE "DeployTarget" AS ENUM ('lemniscate', 'vps');

-- CreateTable
CREATE TABLE "VpsTarget" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "authMethod" TEXT NOT NULL DEFAULT 'password',
    "secretEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VpsTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VpsTarget_userId_idx" ON "VpsTarget"("userId");

-- AddForeignKey
ALTER TABLE "VpsTarget" ADD CONSTRAINT "VpsTarget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing services deploy on Lemniscate (the only target that existed
-- before this migration) — the column defaults to 'lemniscate'.
ALTER TABLE "Service" ADD COLUMN "deployTarget" "DeployTarget" NOT NULL DEFAULT 'lemniscate';
ALTER TABLE "Service" ADD COLUMN "vpsTargetId" TEXT;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_vpsTargetId_fkey" FOREIGN KEY ("vpsTargetId") REFERENCES "VpsTarget"("id") ON DELETE SET NULL ON UPDATE CASCADE;
