-- AlterTable
ALTER TABLE "Repository" ADD COLUMN "reviewLlmConfigId" TEXT;

-- CreateIndex
CREATE INDEX "Repository_reviewLlmConfigId_idx" ON "Repository"("reviewLlmConfigId");

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_reviewLlmConfigId_fkey" FOREIGN KEY ("reviewLlmConfigId") REFERENCES "LlmConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;
