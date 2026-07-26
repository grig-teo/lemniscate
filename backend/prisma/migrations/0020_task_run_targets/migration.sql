-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "changedPaths" JSONB;

-- AlterTable
ALTER TABLE "DeviceCommand" ADD COLUMN     "taskId" TEXT;

-- CreateIndex
CREATE INDEX "DeviceCommand_taskId_idx" ON "DeviceCommand"("taskId");
