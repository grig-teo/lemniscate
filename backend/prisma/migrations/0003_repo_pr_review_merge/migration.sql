-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "autoReviewPr" BOOLEAN DEFAULT false;
ALTER TABLE "Repository" ADD COLUMN     "autoMergePr" BOOLEAN DEFAULT false;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "llmTokensUsed" INTEGER DEFAULT 0;
