-- SiteUpdateDelivery: "there is nobody to send to" is not "delivery failed".
--
-- The e2e run on a villa with no booking recorded FAILED, which reads as a
-- broken integration to whoever sees the staff row. The enum gains an honest
-- value; nothing else changes.
ALTER TYPE "SiteUpdateDeliveryStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_NO_BUYER';
