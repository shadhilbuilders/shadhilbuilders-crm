-- CreateEnum
CREATE TYPE "WhatsappUnknownContactStatus" AS ENUM ('PENDING', 'CONVERTED', 'SPAM');
-- CreateTable
CREATE TABLE "WhatsappUnknownContact" (
    "id" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "firstMessageAt" TIMESTAMP(3) NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 1,
    "firstMessageBody" TEXT,
    "status" "WhatsappUnknownContactStatus" NOT NULL DEFAULT 'PENDING',
    "convertedToLeadId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WhatsappUnknownContact_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "WhatsappUnknownContact_phoneE164_key" ON "WhatsappUnknownContact"("phoneE164");
-- CreateIndex
CREATE UNIQUE INDEX "WhatsappUnknownContact_convertedToLeadId_key" ON "WhatsappUnknownContact"("convertedToLeadId");
-- CreateIndex
CREATE INDEX "WhatsappUnknownContact_status_idx" ON "WhatsappUnknownContact"("status");
-- CreateIndex
CREATE INDEX "WhatsappUnknownContact_lastMessageAt_idx" ON "WhatsappUnknownContact"("lastMessageAt");
