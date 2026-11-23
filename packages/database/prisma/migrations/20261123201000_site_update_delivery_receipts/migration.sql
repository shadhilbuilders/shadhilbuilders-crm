-- Meta delivery receipts on the site-update row (2026-11-23).
--
-- The staff row reads SiteUpdateDelivery.status. Until now only the send path
-- wrote it, so a message the buyer had read still said "Sent to buyer". These
-- two values are what the webhook maps `delivered` and `read` onto.
--
-- Appended, never inserted: Postgres enum ordering is declaration order, and
-- nothing in the codebase compares these values with < or > (the webhook names
-- its allowed from-states explicitly instead, which survives a reorder).
ALTER TYPE "SiteUpdateDeliveryStatus" ADD VALUE IF NOT EXISTS 'DELIVERED';
ALTER TYPE "SiteUpdateDeliveryStatus" ADD VALUE IF NOT EXISTS 'READ';
