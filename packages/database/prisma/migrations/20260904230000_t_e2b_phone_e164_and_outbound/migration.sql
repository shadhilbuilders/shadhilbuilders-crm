-- CreateEnum
CREATE TYPE "OutboundSendType" AS ENUM ('FREEFORM', 'TEMPLATE');
-- CreateEnum
CREATE TYPE "OutboundStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');
-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "phoneE164" TEXT;
-- CreateTable
CREATE TABLE "OutboundMessage" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "sendType" "OutboundSendType" NOT NULL DEFAULT 'FREEFORM',
    "templateName" TEXT,
    "templateVars" JSONB,
    "freeformBody" TEXT,
    "status" "OutboundStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "wamid" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_messageId_key" ON "OutboundMessage"("messageId");
-- CreateIndex
CREATE INDEX "OutboundMessage_status_lastAttemptAt_idx" ON "OutboundMessage"("status", "lastAttemptAt");
-- CreateIndex
CREATE INDEX "OutboundMessage_leadId_idx" ON "OutboundMessage"("leadId");
-- CreateIndex
CREATE INDEX "OutboundMessage_wamid_idx" ON "OutboundMessage"("wamid");
-- CreateIndex
CREATE UNIQUE INDEX "Lead_phoneE164_key" ON "Lead"("phoneE164");
-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill phoneE164 from the existing `phone` column for all current
-- leads. The to_e164() helper (apps/backend/src/whatsapp/to-e164.ts)
-- normalizes by stripping spaces, dashes, parens, dots, and the leading
-- '+'. We mirror that logic in raw SQL here to avoid a Node roundtrip
-- in the migration. Edge cases:
--   - null phone → leave phoneE164 as null
--   - already-E.164 (e.g. "919876543210") → passes through unchanged
--   - "98765 43210" → "919876543210" only if leading 0 is present and
--     country code is missing. India is the only market right now; this
--     migration assumes all leads without a leading + or country code
--     are Indian (+91). Review before expanding to other markets.
UPDATE "Lead"
SET "phoneE164" = CASE
  WHEN "phone" IS NULL THEN NULL
  WHEN "phone" ~ '^\+' THEN regexp_replace("phone", '[^0-9]', '', 'g')
  WHEN length(regexp_replace("phone", '[^0-9]', '', 'g')) = 10
    THEN '91' || regexp_replace("phone", '[^0-9]', '', 'g')
  WHEN length(regexp_replace("phone", '[^0-9]', '', 'g')) = 12
    THEN regexp_replace("phone", '[^0-9]', '', 'g')
  ELSE regexp_replace("phone", '[^0-9]', '', 'g')
END
WHERE "phoneE164" IS NULL;
