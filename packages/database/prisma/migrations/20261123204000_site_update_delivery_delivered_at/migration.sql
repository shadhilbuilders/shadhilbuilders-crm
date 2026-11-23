-- When the message reached the buyer's phone (2026-11-23).
--
-- Paired with readAt: the gap between them is how long the buyer sat on the
-- update, which is what tells a staff member whether to call again or wait.
--
-- Nullable and never backfilled for the same reason readAt is not: a row from
-- before this column has no evidence of a delivery time, and updatedAt is when
-- our own row changed, not when the phone rang.
ALTER TABLE "SiteUpdateDelivery" ADD COLUMN "deliveredAt" TIMESTAMP(3);
