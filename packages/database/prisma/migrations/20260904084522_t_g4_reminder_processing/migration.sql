-- AlterEnum
ALTER TYPE "ReminderStatus" ADD VALUE 'PROCESSING';

-- AlterTable
ALTER TABLE "Reminder" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedBy" TEXT;

-- CreateIndex
CREATE INDEX "Reminder_status_scheduledFor_idx" ON "Reminder"("status", "scheduledFor");
