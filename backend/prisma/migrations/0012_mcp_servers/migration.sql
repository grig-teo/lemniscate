-- CreateTable
CREATE TABLE "McpServer" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "tags" TEXT[],
    "source" TEXT NOT NULL DEFAULT 'lemniscate',

    CONSTRAINT "McpServer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "McpServer_slug_key" ON "McpServer"("slug");
