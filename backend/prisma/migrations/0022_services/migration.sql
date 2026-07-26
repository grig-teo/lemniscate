-- Services: one deployable app per repository, routed by Traefik at
-- apps.grig-teo.space/<connection.username>/<service.name>.

-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('stopped', 'deploying', 'online', 'failed');

-- CreateEnum
CREATE TYPE "DeployStatus" AS ENUM ('queued', 'building', 'starting', 'checking', 'online', 'failed');

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 80,
    "envEnc" TEXT,
    "autoDeploy" BOOLEAN NOT NULL DEFAULT true,
    "status" "ServiceStatus" NOT NULL DEFAULT 'stopped',
    "activeContainer" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "taskId" TEXT,
    "commitSha" TEXT NOT NULL,
    "status" "DeployStatus" NOT NULL DEFAULT 'queued',
    "log" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Service_repositoryId_key" ON "Service"("repositoryId");

-- CreateIndex
CREATE INDEX "Deployment_serviceId_idx" ON "Deployment"("serviceId");

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
