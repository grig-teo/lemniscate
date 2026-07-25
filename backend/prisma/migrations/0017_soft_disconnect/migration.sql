-- AlterTable
ALTER TABLE "GitConnection" ADD COLUMN "disconnectedAt" TIMESTAMP(3),
ALTER COLUMN "accessTokenEnc" DROP NOT NULL;
