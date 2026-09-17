-- MEDIA (2026-09-17): chat attachments on Message.
-- Add mediaType + mediaFilename to Message so the web pane can render
-- images inline vs documents as a download link (and inbound WhatsApp
-- media 2B can store the type for the same render). Mirrors the schema
-- change in prisma/schema.prisma (Message).

ALTER TABLE "Message"
  ADD COLUMN "mediaType" TEXT,
  ADD COLUMN "mediaFilename" TEXT;
