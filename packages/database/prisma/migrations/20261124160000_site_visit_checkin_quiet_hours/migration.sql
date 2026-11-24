-- Quiet hours for the completed-visit check-in (2026-11-24).
--
--   SiteVisit.checkinDueAt     when the check-in may go out: the completion time
--                              inside 08:00-20:00 IST, the next 08:00 outside it
--   SiteVisit.checkinQueuedAt  the claim: non-null means the check-in already
--                              produced its outbox row, or was dropped as too
--                              late to be worth sending
--
-- Both stay NULL on visits completed before this column existed, so nothing is
-- sent retroactively to buyers whose visit is long over.
--
-- No new policies and no new GRANTs. site_visit_select_cron_service and
-- site_visit_update_cron_service (20261009050000_visit_reminders),
-- message_insert_cron_service (20260905000100_t_e2b_inbound_rls_and_grants) and
-- outbound_cron_service_insert already cover the sweep, and table-level
-- privileges cover the new columns.

ALTER TABLE "SiteVisit" ADD COLUMN "checkinDueAt" TIMESTAMP(3);
ALTER TABLE "SiteVisit" ADD COLUMN "checkinQueuedAt" TIMESTAMP(3);

-- The sweep's scan: completed visits with a check-in owed and not yet claimed.
-- Partial, because the overwhelming majority of visits will never match.
CREATE INDEX "SiteVisit_checkin_due_idx"
  ON "SiteVisit" ("checkinDueAt")
  WHERE "checkinQueuedAt" IS NULL AND "status" = 'COMPLETED';
