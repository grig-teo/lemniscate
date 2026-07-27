-- AlterTable
ALTER TABLE "Repository" ADD COLUMN "autoAddressReview" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "lastAddressedReviewId" TEXT;
