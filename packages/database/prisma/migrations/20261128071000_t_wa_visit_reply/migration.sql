-- T-WA-VISIT-REPLY (2026-11-28): the customer's WhatsApp "YES" gets a place to
-- land. Two nullable columns, no new table, so no GRANT and no RLS work: column
-- privileges ride on the table's existing grants and RLS is row-level. The
-- webhook's write goes through site_visit_update_cron_service (org-scoped,
-- role=CRON_SERVICE AND user_id='cron-service'), which already exists.
--
-- Absence means "the customer never acknowledged", never "no" - most visits are
-- confirmed in a phone call, and every row that predates this column has no
-- acknowledgement to record.

-- AlterTable
ALTER TABLE "SiteVisit" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedVia" TEXT;
