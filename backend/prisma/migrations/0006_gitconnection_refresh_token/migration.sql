-- AlterTable
ALTER TABLE "GitConnection" ADD COLUMN     "refreshTokenEnc" TEXT;
ALTER TABLE "GitConnection" ADD COLUMN     "tokenExpiresAt" TIMESTAMP(3);
