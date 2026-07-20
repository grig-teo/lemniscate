-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "GitProvider" AS ENUM ('github', 'gitverse', 'gitlab');

-- CreateEnum
CREATE TYPE "ThinkingLevel" AS ENUM ('off', 'low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "TaskKind" AS ENUM ('proposal', 'prompt');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('pending', 'queued', 'running', 'awaiting_review', 'done', 'failed');

-- CreateEnum
CREATE TYPE "TaskEventKind" AS ENUM ('log', 'diff', 'status');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "GitProvider" NOT NULL,
    "baseUrl" TEXT,
    "username" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,

    CONSTRAINT "GitConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeyEnc" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "thinkingLevel" "ThinkingLevel" NOT NULL DEFAULT 'off',
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "maxTokens" INTEGER NOT NULL,
    "contextWindow" INTEGER NOT NULL,
    "systemPromptExtra" TEXT,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 120,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "requestsPerMinute" INTEGER NOT NULL,
    "maxTokensPerRun" INTEGER,
    "customHeaders" JSONB NOT NULL DEFAULT '{}',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LlmConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "cloneUrl" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "autoPropose" BOOLEAN NOT NULL DEFAULT false,
    "autoCreatePr" BOOLEAN NOT NULL DEFAULT true,
    "llmConfigId" TEXT,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "kind" "TaskKind" NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'pending',
    "branchName" TEXT,
    "prUrl" TEXT,
    "llmConfigId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskEvent" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "TaskEventKind" NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "TaskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GitConnection_userId_idx" ON "GitConnection"("userId");

-- CreateIndex
CREATE INDEX "LlmConfig_userId_idx" ON "LlmConfig"("userId");

-- CreateIndex
CREATE INDEX "Repository_llmConfigId_idx" ON "Repository"("llmConfigId");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_connectionId_externalId_key" ON "Repository"("connectionId", "externalId");

-- CreateIndex
CREATE INDEX "Task_repositoryId_idx" ON "Task"("repositoryId");

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE INDEX "Task_llmConfigId_idx" ON "Task"("llmConfigId");

-- CreateIndex
CREATE INDEX "TaskEvent_taskId_createdAt_idx" ON "TaskEvent"("taskId", "createdAt");

-- AddForeignKey
ALTER TABLE "GitConnection" ADD CONSTRAINT "GitConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmConfig" ADD CONSTRAINT "LlmConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "GitConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_llmConfigId_fkey" FOREIGN KEY ("llmConfigId") REFERENCES "LlmConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_llmConfigId_fkey" FOREIGN KEY ("llmConfigId") REFERENCES "LlmConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

