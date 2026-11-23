-- When the buyer read the site update (2026-11-23).
--
-- READ says it happened; this says when. Meta's status payload carries its own
-- timestamp, so the stamp is when the phone opened the message, not when our
-- webhook happened to process it.
--
-- Nullable and never backfilled: rows delivered before this column exist have
-- no evidence of a read time, and inventing one from updatedAt would be a lie
-- the staff row repeats to a buyer.
ALTER TABLE "SiteUpdateDelivery" ADD COLUMN "readAt" TIMESTAMP(3);
