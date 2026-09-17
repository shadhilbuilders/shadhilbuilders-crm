-- MEDIA (2026-09-17): chat attachments.
-- Add media columns to OutboundMessage so the outbound cron can upload a
-- stored attachment to Meta's /media and send a media message.
-- Mirrors the schema change in prisma/schema.prisma (OutboundMessage).

ALTER TABLE "OutboundMessage"
  ADD COLUMN "mediaKey" TEXT,
  ADD COLUMN "mediaType" TEXT,
  ADD COLUMN "mediaFilename" TEXT;
