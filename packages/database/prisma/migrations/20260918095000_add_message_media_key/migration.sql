-- MEDIA (2026-09-18): provider-neutral storage key on Message.
--
-- Message.mediaUrl holds a fully-derived URL (today `/api/bff/media/<key>`),
-- which BAKES the storage provider into every row - switching ImageKit -> R2
-- would mean rewriting all rows. mediaKey stores the provider-neutral key
-- (ImageKit filePath / R2 object key / local disk path) instead; the display
-- URL is derived per request by src/storage/media-display.ts. Mirrors
-- OutboundMessage.mediaKey (which the outbound cron already uses to read the
-- bytes back for Meta's /media upload).
--
-- Nullable and NOT backfilled: existing rows keep mediaUrl and resolve through
-- the legacy branch of resolveMediaDisplayUrl() exactly as before, so this
-- migration is safe on a populated table.
--
-- Hand-authored deliberately: `prisma migrate dev` also wanted to drop/recreate
-- ~40 unrelated organizationId foreign keys and an Organization.updatedAt
-- default, because the live dev DB had already drifted from schema.prisma.
-- That churn is not part of this change, so only the intended column is here.
-- (The drift is pre-existing; reconcile it separately.)

ALTER TABLE "Message"
  ADD COLUMN "mediaKey" TEXT;
