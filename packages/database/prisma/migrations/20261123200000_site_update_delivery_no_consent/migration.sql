-- SiteUpdateDelivery: the marketing templates were approved as MARKETING, so a
-- send to a buyer with no opt-in must be recorded as skipped-for-consent rather
-- than folded into a reason string staff cannot filter on.
ALTER TYPE "SiteUpdateDeliveryStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_NO_CONSENT';
