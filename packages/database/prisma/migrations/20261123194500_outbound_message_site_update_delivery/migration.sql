-- OutboundMessage -> SiteUpdateDelivery (2026-11-23).
--
-- The delivery row was written PENDING and nothing ever advanced it: the only
-- writer of that table was the save path, so every batch read "Sending to
-- buyer..." forever, whether Meta accepted the message or refused it. The
-- worker is the only place that knows the outcome, and it had no way back to
-- the delivery row, so this is the link.
--
-- ON DELETE SET NULL: removing a delivery row (cleanup of a bad batch) must not
-- take the buyer's message with it, and the unique index keeps it 1:1 - one
-- batch is one message by design (unique (organizationId, batchId)).
ALTER TABLE "OutboundMessage" ADD COLUMN "siteUpdateDeliveryId" TEXT;

CREATE UNIQUE INDEX "OutboundMessage_siteUpdateDeliveryId_key"
  ON "OutboundMessage"("siteUpdateDeliveryId");

ALTER TABLE "OutboundMessage"
  ADD CONSTRAINT "OutboundMessage_siteUpdateDeliveryId_fkey"
  FOREIGN KEY ("siteUpdateDeliveryId") REFERENCES "SiteUpdateDelivery"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
