-- gitlem: the internal minimal git host (provider 'gitlem' on GitConnection,
-- document-backed repository rows — see src/lib/gitlem-store.ts).
ALTER TYPE "GitProvider" ADD VALUE 'gitlem';

CREATE TABLE "GitlemUser" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "apiToken" TEXT NOT NULL,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GitlemUser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GitlemUser_email_key" ON "GitlemUser"("email");
CREATE UNIQUE INDEX "GitlemUser_username_key" ON "GitlemUser"("username");
CREATE UNIQUE INDEX "GitlemUser_apiToken_key" ON "GitlemUser"("apiToken");
CREATE UNIQUE INDEX "GitlemUser_userId_key" ON "GitlemUser"("userId");

ALTER TABLE "GitlemUser"
  ADD CONSTRAINT "GitlemUser_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "GitlemRegistrationCode" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GitlemRegistrationCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GitlemRegistrationCode_email_idx" ON "GitlemRegistrationCode"("email");

CREATE TABLE "GitlemRepository" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "doc" TEXT NOT NULL,
  "defaultBranch" TEXT NOT NULL DEFAULT 'main',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GitlemRepository_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GitlemRepository_ownerId_name_key" ON "GitlemRepository"("ownerId", "name");

ALTER TABLE "GitlemRepository"
  ADD CONSTRAINT "GitlemRepository_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "GitlemUser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
