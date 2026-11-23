-- SiteUpdateDelivery: an operator can switch the buyer-facing WhatsApp leg off
-- with SITE_UPDATE_WHATSAPP=off. The skip is recorded as its own outcome rather
-- than folded into SKIPPED_NO_TEMPLATE, so "we chose not to send" never reads as
-- "nobody approved a template", and the skipped batches stay visible for a
-- re-send once the flag goes back on.
ALTER TYPE "SiteUpdateDeliveryStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_DISABLED';
